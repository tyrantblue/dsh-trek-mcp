/**
 * Settings API tests: first-run boot without credentials, the secret-free
 * config view, connection testing and the persisted save.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'

import { apply } from '../broker.js'

const TOKEN_PORT = 17903
const BROKER_PORT = 17904
const API_PORT = 17905
const EMPTY_BROKER_PORT = 17906
const EMPTY_API_PORT = 17907

const providedSecret = 'trekcs_0123456789abcdef'

const tokenServer = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (url.pathname !== '/oauth/token') {
    res.writeHead(404).end()
    return
  }
  const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
  if (body.get('client_secret') !== providedSecret) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid_client', error_description: 'Invalid client credentials' }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ access_token: 'issued-token', token_type: 'Bearer', expires_in: 3600 }))
})

await new Promise((resolve) => tokenServer.listen(TOKEN_PORT, '127.0.0.1', resolve))

function createHarness(config) {
  const cleanups = []
  const captured = { route: undefined, saved: undefined }
  const ctx = {
    logger: { info() {}, warn() {}, error: console.error },
    effect: (callback) => {
      const dispose = callback()
      cleanups.push(dispose)
      return dispose
    },
    fiber: { entry: { id: 'trek-mcp-broker' } },
    get: (name) =>
      name === 'configEditor'
        ? {
            edit: async (_entry, change) => {
              captured.saved = change({ ...config })
            },
          }
        : undefined,
    webServer: {
      register: (route) => {
        captured.route = route
        return () => {}
      },
    },
  }
  return { ctx, cleanups, captured }
}

async function startApi(route, port) {
  const server = createServer((req, res) => route.handler(req, res))
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const call = async (path, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/trek-mcp${path}`, {
      method: options.method ?? 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    })
    const body = await response.json().catch(() => undefined)
    return { status: response.status, body }
  }
  return { server, call }
}

// ── an unconfigured install boots and stays reachable ───────────────────────
const emptyHarness = createHarness({
  endpoint: 'http://127.0.0.1:3000/mcp',
  clientId: '',
  clientSecret: '',
  listenPort: EMPTY_BROKER_PORT,
})
test('a fresh install boots without credentials', async () => {
  await apply(emptyHarness.ctx, {
    endpoint: 'http://127.0.0.1:3000/mcp',
    clientId: '',
    clientSecret: '',
    listenPort: EMPTY_BROKER_PORT,
  })
  const api = await startApi(emptyHarness.captured.route, EMPTY_API_PORT)
  const config = await api.call('/config')
  assert.equal(config.status, 200)
  assert.equal(config.body.configured, false)
  assert.equal(config.body.hasSecret, false)
  await new Promise((resolve) => api.server.close(resolve))
  for (const dispose of emptyHarness.cleanups.reverse()) await dispose?.()
})

// ── configured install: view, test, save ────────────────────────────────────
const harness = createHarness({
  endpoint: `http://127.0.0.1:${TOKEN_PORT}/mcp`,
  tokenUrl: `http://127.0.0.1:${TOKEN_PORT}/oauth/token`,
  clientId: 'client-id-from-trek',
  clientSecret: providedSecret,
  listenPort: BROKER_PORT,
})
await apply(harness.ctx, {
  endpoint: `http://127.0.0.1:${TOKEN_PORT}/mcp`,
  tokenUrl: `http://127.0.0.1:${TOKEN_PORT}/oauth/token`,
  clientId: 'client-id-from-trek',
  clientSecret: providedSecret,
  listenPort: BROKER_PORT,
})
const api = await startApi(harness.captured.route, API_PORT)

after(async () => {
  await new Promise((resolve) => api.server.close(resolve))
  for (const dispose of harness.cleanups.reverse()) await dispose?.()
  for (const dispose of emptyHarness.cleanups.reverse()) await dispose?.()
  await new Promise((resolve) => tokenServer.close(resolve))
})

test('the config view never returns the client secret', async () => {
  const response = await api.call('/config')
  assert.equal(response.status, 200)
  assert.equal(response.body.configured, true)
  assert.equal(response.body.hasSecret, true)
  assert.equal(response.body.clientSecret, undefined)
  assert.equal(response.body.clientId, 'client-id-from-trek')
})

test('test connection mints a token and reports its lifetime', async () => {
  const good = await api.call('/test', {
    method: 'POST',
    body: { endpoint: `http://127.0.0.1:${TOKEN_PORT}/mcp`, clientId: 'client-id-from-trek', clientSecret: providedSecret },
  })
  assert.equal(good.status, 200)
  assert.equal(good.body.ok, true)
  assert.equal(good.body.expiresIn, 3600)

  const bad = await api.call('/test', {
    method: 'POST',
    body: { endpoint: `http://127.0.0.1:${TOKEN_PORT}/mcp`, clientId: 'client-id-from-trek', clientSecret: 'wrong' },
  })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error, /Invalid client credentials/)
})

test('save persists endpoint and credentials, keeping the secret when blank', async () => {
  const response = await api.call('/config', {
    method: 'PUT',
    body: {
      endpoint: `https://trek.example.com/mcp`,
      tokenUrl: '',
      clientId: 'new-client-id',
      clientSecret: providedSecret,
      scope: 'trips:read weather:read',
    },
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.saved, true)
  await new Promise((resolve) => setTimeout(resolve, 100))

  assert.equal(harness.captured.saved.endpoint, 'https://trek.example.com/mcp')
  assert.equal(harness.captured.saved.tokenUrl, 'https://trek.example.com/oauth/token')
  assert.equal(harness.captured.saved.clientId, 'new-client-id')
  assert.equal(harness.captured.saved.clientSecret, providedSecret)
  assert.equal(harness.captured.saved.scope, 'trips:read weather:read')
  assert.equal(harness.captured.saved.listenPort, BROKER_PORT, 'listenPort is preserved')

  const keeps = await api.call('/config', {
    method: 'PUT',
    body: { endpoint: `http://127.0.0.1:${TOKEN_PORT}/mcp`, clientId: 'new-client-id', clientSecret: '' },
  })
  assert.equal(keeps.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(harness.captured.saved.clientSecret, providedSecret, 'an empty field keeps the stored secret')
})
