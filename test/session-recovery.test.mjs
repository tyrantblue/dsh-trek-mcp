/**
 * Broker transport tests: session mapping and recovery.
 *
 * The mock TREK below speaks just enough Streamable HTTP MCP to exercise the
 * proxy: initialize hands out a session, other requests need it, and a killed
 * session answers 404 `Session not found` exactly like TREK does after its idle
 * timeout (MCP_SESSION_TTL). The proxy must hide that from the client.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { after, test } from 'node:test'

import { apply } from '../broker.js'

const UPSTREAM_PORT = 17901
const BROKER_PORT = 17902

const state = { session: null, initializes: 0, initializedNotifications: 0, killed: false }

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

const upstream = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/oauth/token') {
    await readBody(req)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 }))
    return
  }

  const body = await readBody(req)
  let message = {}
  try {
    message = JSON.parse(body.toString('utf8'))
  } catch {
    // fall through to the session check
  }
  const session = req.headers['mcp-session-id']

  if (message.method === 'initialize') {
    state.initializes += 1
    state.session = `upstream-${state.initializes}`
    state.killed = false
    res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': state.session })
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mock-trek', version: '1' } },
      }),
    )
    return
  }
  if (message.method === 'notifications/initialized') {
    state.initializedNotifications += 1
    res.writeHead(202).end()
    return
  }
  if (state.killed || !session || session !== state.session) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'Session not found' }))
    return
  }
  if (message.method === 'tools/list') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'list_trips' }] } }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, result: {} }))
})

const cleanups = []
const ctx = {
  logger: { info() {}, warn() {}, error: console.error },
  effect: (callback) => {
    const dispose = callback()
    cleanups.push(dispose)
    return dispose
  },
  fiber: { entry: {} },
  get: () => undefined,
  webServer: { register: () => () => {} },
}

await new Promise((resolve) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', resolve))
await apply(ctx, {
  endpoint: `http://127.0.0.1:${UPSTREAM_PORT}/mcp`,
  tokenUrl: `http://127.0.0.1:${UPSTREAM_PORT}/oauth/token`,
  clientId: 'test-client',
  clientSecret: 'test-secret',
  listenPort: BROKER_PORT,
})

const endpoint = `http://127.0.0.1:${BROKER_PORT}/mcp`

async function rpc(method, { session, params, id = 1 } = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text.split('data: ').pop())
  } catch {
    json = undefined
  }
  return { status: response.status, session: response.headers.get('mcp-session-id'), json }
}

after(async () => {
  for (const dispose of cleanups.reverse()) {
    try {
      await dispose?.()
    } catch {
      // best effort
    }
  }
  await new Promise((resolve) => upstream.close(resolve))
})

test('initialize maps the client onto a proxy-owned session id', async () => {
  const init = await rpc('initialize', {
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })
  assert.equal(init.status, 200)
  assert.equal(typeof init.session, 'string')
  assert.notEqual(init.session, 'upstream-1')
  assert.equal(state.initializes, 1)
})

test('a stale upstream session is re-initialized transparently', async () => {
  const before = state.initializes
  const init = await rpc('initialize', {
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })
  const session = init.session
  const first = await rpc('tools/list', { session })
  assert.equal(first.status, 200)
  assert.equal(first.json.result.tools[0].name, 'list_trips')
  assert.equal(state.initializedNotifications, 1, 'proxy acknowledges the session it created')

  state.killed = true // TREK reaped the idle session
  const recovered = await rpc('tools/list', { session })
  assert.equal(recovered.status, 200)
  assert.equal(recovered.json.result.tools[0].name, 'list_trips')
  assert.equal(recovered.session, session, 'the client keeps its session id')
  assert.equal(state.initializes, before + 2, 'one fresh upstream session')
})

test('an unknown client session id gets its own upstream session', async () => {
  const before = state.initializes
  const response = await rpc('tools/list', { session: 'session-from-a-restarted-proxy' })
  assert.equal(response.status, 200)
  assert.equal(state.initializes, before + 1)
})

test('DELETE closes the mapped upstream session', async () => {
  const init = await rpc('initialize', {
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })
  const deleted = await fetch(endpoint, { method: 'DELETE', headers: { 'mcp-session-id': init.session } })
  assert.equal(deleted.status, 200)
})
