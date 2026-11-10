/**
 * TREK MCP broker — Host half of the `dsh-trek-mcp` bundle.
 *
 * Two jobs:
 *
 * 1. **Credentials.** TREK issues scoped tokens to a **machine OAuth client**
 *    through the `client_credentials` grant. The client id, the client secret
 *    and the MCP endpoint are configuration; this plugin exchanges them for a
 *    one-hour access token, renews it shortly before expiry (and once more on a
 *    401) and keeps it in process memory only.
 *
 * 2. **Transport.** `@deepseek-ai/dsh-mcp-client` only supports a fixed header
 *    map, so this plugin also runs a loopback Streamable-HTTP proxy:
 *
 *      dsh-mcp-client → http://127.0.0.1:<listenPort>/mcp → TREK /mcp
 *
 *    It forwards methods, headers (`Mcp-Session-Id`, `MCP-Protocol-Version`,
 *    `Content-Type`) and response streams (SSE included) byte for byte, so the
 *    whole MCP protocol stays inside the official client plugin.
 *
 * The settings page (`./client.js`) edits endpoint / client id / client secret
 * through `/api/trek-mcp/config`; a save is written to this row's config with
 * the config editor (the profile patch, not this file) and the row restarts
 * with the new values. The client secret is never returned by the API.
 *
 * Configuration (bundle patch defaults, overridable from the UI):
 *
 *   - id: trek-mcp-broker
 *     name: '@local/trek-mcp/broker'
 *     config:
 *       endpoint: http://127.0.0.1:3000/mcp
 *       tokenUrl: http://127.0.0.1:3000/oauth/token   # optional
 *       clientId: '<uuid from TREK>'
 *       clientSecret: 'trekcs_…'                       # or TREK_MCP_CLIENT_SECRET
 *       listenPort: 17890
 *       scope: ''                                      # optional, space separated
 */

import { randomUUID } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const BROKER_VERSION = '1.0.0'

/** Endpoint assumed on a fresh install (TREK's docker default). */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:3000/mcp'

/** Refresh a token this long before it expires. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000
/** Largest MCP request body forwarded; TREK's upload tool caps at 10 MB base64. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** Same-origin JSON API the settings page talks to. */
const API_PREFIX = '/api/trek-mcp'
/** Body cap for that API. */
const MAX_API_BODY_BYTES = 64 * 1024
/** Headers owned by this hop; never forwarded from the caller. */
const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'authorization',
  'content-length',
  // Ask TREK for identity encoding so streamed responses can be piped as-is.
  'accept-encoding',
])
/** Hop-by-hop response headers; Node writes its own framing. */
const DROP_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade'])

export const name = 'trek-mcp-broker'
export const inject = ['webServer']

/**
 * Start the broker and its settings API.
 *
 * Activation fails closed on a bad endpoint or rejected credentials, so the
 * Loader reports the row as failed instead of serving unauthenticated tools.
 */
export async function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  const logger = ctx.logger ?? console
  const broker = createBroker(cfg, logger)

  // The settings API goes up first: a bad client secret must not lock the user
  // out of the very page that repairs it. The MCP side stays closed until the
  // proxy is listening and a token is available.
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: createApiHandler(ctx, cfg, logger),
      }),
    'trek-mcp-broker: api routes',
  )

  try {
    await broker.start()
    ctx.effect(() => () => broker.stop())
  } catch (err) {
    logger.error(`trek-mcp-broker: could not start: ${err.message}`)
  }

  logger.info(
    `trek-mcp-broker: proxying http://127.0.0.1:${cfg.listenPort}/mcp → ${cfg.endpoint.href} ` +
      (cfg.configured ? `(machine client ${cfg.clientId.slice(0, 8)}…)` : '(not configured yet)'),
  )

}

/* ────────────────────────────── configuration ───────────────────────────── */

function normalizeConfig(config) {
  const raw = config ?? {}
  const endpoint = parseUrl(
    typeof raw.endpoint === 'string' && raw.endpoint.trim() !== '' ? raw.endpoint : DEFAULT_ENDPOINT,
    'endpoint',
  )
  const tokenUrl = raw.tokenUrl ? parseUrl(raw.tokenUrl, 'tokenUrl') : new URL('/oauth/token', endpoint)
  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : ''
  const textSecret = typeof raw.clientSecret === 'string' ? raw.clientSecret.trim() : ''
  const envSecret = typeof process.env.TREK_MCP_CLIENT_SECRET === 'string' ? process.env.TREK_MCP_CLIENT_SECRET.trim() : ''
  const clientSecret = textSecret || envSecret
  const listenPort = Number(raw.listenPort ?? 17890)
  const scope = typeof raw.scope === 'string' ? raw.scope.trim() : ''

  // A fresh install boots without credentials on purpose: the settings page
  // (same plugin) must be reachable to enter them, so /mcp answers 502 until
  // then instead of failing the row.
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error(`trek-mcp-broker: listenPort must be a TCP port, got ${String(raw.listenPort)}`)
  }
  return {
    endpoint,
    tokenUrl,
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
    secretFromEnv: !textSecret && Boolean(envSecret),
    listenPort,
    scope,
  }
}

function parseUrl(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`trek-mcp-broker: ${field} is required (an http(s) URL)`)
  }
  let url
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error(`trek-mcp-broker: ${field} is not a valid URL: ${value}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`trek-mcp-broker: ${field} must be http or https, got ${url.protocol}`)
  }
  return url
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`trek-mcp-broker: ${field} is required`)
  }
  return value.trim()
}

/* ─────────────────────────────── token minting ──────────────────────────── */

/**
 * Exchange client credentials for an access token.
 *
 * @param {{ tokenUrl: URL, clientId: string, clientSecret: string, scope: string }} options
 * @returns {Promise<{ value: string, expiresAt: number, expiresIn: number }>}
 */
async function mintToken({ tokenUrl, clientId, clientSecret, scope }) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  })
  if (scope) body.set('scope', scope)

  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  // A loopback TREK behind FORCE_HTTPS answers plain HTTP with a redirect;
  // telling it the edge hop was TLS serves the token endpoint inline.
  if (tokenUrl.protocol === 'http:') headers['x-forwarded-proto'] = 'https'

  let response
  try {
    response = await fetch(tokenUrl, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) })
  } catch (err) {
    throw new Error(`TREK token endpoint unreachable (${tokenUrl.href}): ${err.message}`)
  }

  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`TREK token endpoint returned non-JSON (HTTP ${response.status})`)
  }
  if (!response.ok || typeof payload.access_token !== 'string' || payload.access_token === '') {
    const detail = payload.error_description ?? payload.error ?? 'no access_token'
    throw new Error(`TREK token request rejected (HTTP ${response.status}): ${detail}`)
  }
  const expiresIn = Number.isFinite(Number(payload.expires_in)) ? Number(payload.expires_in) : 3600
  return { value: payload.access_token, expiresAt: Date.now() + expiresIn * 1000, expiresIn }
}

/* ──────────────────────────────── broker ────────────────────────────────── */

function createBroker(cfg, logger) {
  const state = { token: '', expiresAt: 0, pending: null }
  const sockets = new Set()
  /**
   * Downstream `Mcp-Session-Id` → the TREK session behind it.
   *
   * dsh-mcp-client keeps whatever session id this proxy hands it. TREK ends an
   * MCP session after an hour of inactivity (MCP_SESSION_TTL), and the MCP SDK
   * treats a 404 `Session not found` as a tool error instead of re-initializing.
   * So the proxy owns the upstream session: it maps the client's id onto a TREK
   * id, and when TREK answers `Session not found` it initializes a fresh TREK
   * session, replays the request on it and keeps the client's id unchanged.
   */
  const sessions = new Map()
  let server = null

  /** Return a usable token, minting or renewing it when needed. */
  async function getToken(force = false) {
    if (!cfg.configured) {
      throw new Error(
        'TREK is not configured yet — open Settings → TREK MCP and enter the endpoint, client id and client secret',
      )
    }
    const now = Date.now()
    if (!force && state.token && now < state.expiresAt - TOKEN_REFRESH_MARGIN_MS) return state.token
    if (state.pending) return state.pending
    state.pending = mintToken(cfg)
      .then((minted) => {
        state.token = minted.value
        state.expiresAt = minted.expiresAt
        return state.token
      })
      .finally(() => {
        state.pending = null
      })
    return state.pending
  }

  /** A minimal initialize body for sessions the proxy has to create itself. */
  function syntheticInitBody() {
    return Buffer.from(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'trek-mcp-broker', version: BROKER_VERSION },
        },
      }),
    )
  }

  /** One internal JSON-RPC POST to TREK (initialize / notifications). */
  function internalRequest(body, token, sessionId) {
    return new Promise((resolve, reject) => {
      const headers = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(body.length),
        authorization: `Bearer ${token}`,
        'x-trek-mcp-broker': BROKER_VERSION,
        host: cfg.endpoint.host,
      }
      if (sessionId) {
        headers['mcp-session-id'] = sessionId
        headers['mcp-protocol-version'] = '2025-06-18'
      }
      if (cfg.endpoint.protocol === 'http:') headers['x-forwarded-proto'] = 'https'

      const send = cfg.endpoint.protocol === 'https:' ? httpsRequest : httpRequest
      const upstream = send(cfg.endpoint, { method: 'POST', headers, timeout: 30_000 }, resolve)
      upstream.on('error', reject)
      upstream.on('timeout', () => upstream.destroy(new Error('TREK MCP upstream timed out')))
      upstream.end(body)
    })
  }

  /** Create a TREK session for one downstream session (single-flight). */
  async function establish(entry) {
    if (!entry.initBody) entry.initBody = syntheticInitBody()
    let token = await getToken()
    let initialized = await internalRequest(entry.initBody, token)
    if (initialized.statusCode === 401) {
      initialized.resume()
      token = await getToken(true)
      initialized = await internalRequest(entry.initBody, token)
    }
    const upstreamId = initialized.headers['mcp-session-id']
    initialized.resume()
    if (typeof upstreamId !== 'string' || upstreamId === '') {
      throw new Error('TREK did not return an Mcp-Session-Id on initialize')
    }
    entry.upstreamId = upstreamId
    entry.needsAck = false
    await acknowledge(entry)
    return upstreamId
  }

  /** Tell TREK the session is initialized (MCP requires it before other calls). */
  async function acknowledge(entry) {
    let token = await getToken()
    const ack = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
    let notified = await internalRequest(ack, token, entry.upstreamId)
    if (notified.statusCode === 401) {
      notified.resume()
      token = await getToken(true)
      notified = await internalRequest(ack, token, entry.upstreamId)
    }
    notified.resume()
  }

  async function ensureUpstream(entry) {
    if (!entry.upstreamId) {
      if (!entry.reinit) entry.reinit = establish(entry).finally(() => { entry.reinit = null })
      await entry.reinit
    }
    if (entry.needsAck) {
      await acknowledge(entry)
      entry.needsAck = false
    }
    return entry.upstreamId
  }

  function recoverUpstream(entry) {
    logger.warn('trek-mcp-broker: TREK ended the MCP session (idle timeout); re-initializing it')
    entry.upstreamId = undefined
    if (!entry.reinit) entry.reinit = establish(entry).finally(() => { entry.reinit = null })
    return entry.reinit
  }

  function entryFor(downstreamId) {
    let entry = sessions.get(downstreamId)
    if (!entry) {
      // Unknown id: the client is replaying a session this proxy never saw
      // (proxy restart) — give it a TREK session of its own.
      entry = { upstreamId: undefined, initBody: undefined, reinit: null, createdAt: Date.now(), needsAck: false }
      sessions.set(downstreamId, entry)
    }
    return entry
  }

  function trimSessions() {
    if (sessions.size <= 32) return
    const oldest = [...sessions.entries()]
      .sort((left, right) => left[1].createdAt - right[1].createdAt)
      .slice(0, sessions.size - 32)
    for (const [id] of oldest) sessions.delete(id)
  }

  /** Forward one downstream request to TREK with a remapped session header. */
  function forward(req, body, token, upstreamSession) {
    return new Promise((resolve, reject) => {
      const headers = {}
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase()
        if (value === undefined || DROP_REQUEST_HEADERS.has(lower) || lower === 'mcp-session-id') continue
        headers[key] = value
      }
      headers.authorization = `Bearer ${token}`
      headers['x-trek-mcp-broker'] = BROKER_VERSION
      if (upstreamSession) headers['mcp-session-id'] = upstreamSession
      if (cfg.endpoint.protocol === 'http:') headers['x-forwarded-proto'] = 'https'

      const send = cfg.endpoint.protocol === 'https:' ? httpsRequest : httpRequest
      const upstream = send(
        cfg.endpoint,
        {
          method: req.method,
          headers: {
            ...headers,
            // Node writes Host from the URL unless we provide one.
            host: cfg.endpoint.host,
            ...(body.length > 0 ? { 'content-length': String(body.length) } : {}),
          },
          timeout: 60_000,
        },
        resolve,
      )
      upstream.on('error', reject)
      upstream.on('timeout', () => {
        upstream.destroy(new Error('TREK MCP upstream timed out'))
      })
      req.on('close', () => {
        if (!req.complete) upstream.destroy()
      })
      upstream.end(body.length > 0 ? body : undefined)
    })
  }

  /** Read a small response body; `truncated` means it exceeded the cap. */
  function readSmall(response, limit) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size <= limit) chunks.push(chunk)
      })
      response.on('end', () => resolve({ buffer: Buffer.concat(chunks), truncated: size > limit }))
      response.on('error', reject)
    })
  }

  async function handle(req, res) {
    const path = requestPath(req)
    if (path !== '/mcp') {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('Not found')
      return
    }

    let body
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch (err) {
      const status = err.code === 'BODY_TOO_LARGE' ? 413 : 400
      res.writeHead(status, { 'content-type': 'text/plain' })
      res.end(err.message)
      return
    }

    const message = parseMessage(body)
    const isInitialize = message?.method === 'initialize'
    const incomingSession =
      typeof req.headers['mcp-session-id'] === 'string' && req.headers['mcp-session-id'] !== ''
        ? req.headers['mcp-session-id']
        : undefined
    const entry = !isInitialize && incomingSession ? entryFor(incomingSession) : undefined
    if (entry && message?.method === 'notifications/initialized') entry.needsAck = false

    let tokenRetried = false
    let sessionRetried = false

    for (;;) {
      let token
      try {
        token = await getToken(tokenRetried)
      } catch (err) {
        logger.error(`trek-mcp-broker: ${err.message}`)
        res.writeHead(502, { 'content-type': 'text/plain', 'x-trek-mcp-broker': BROKER_VERSION })
        res.end(`TREK authentication failed: ${err.message}`)
        return
      }

      let upstreamSession
      if (entry) {
        try {
          upstreamSession = await ensureUpstream(entry)
        } catch (err) {
          logger.error(`trek-mcp-broker: could not open a TREK MCP session: ${err.message}`)
          res.writeHead(502, { 'content-type': 'text/plain', 'x-trek-mcp-broker': BROKER_VERSION })
          res.end(`TREK MCP session failed: ${err.message}`)
          return
        }
      }

      let upstream
      try {
        upstream = await forward(req, body, token, upstreamSession)
      } catch (err) {
        logger.error(`trek-mcp-broker: upstream request failed: ${err.message}`)
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'text/plain', 'x-trek-mcp-broker': BROKER_VERSION })
          res.end(`TREK MCP upstream failed: ${err.message}`)
        } else {
          res.destroy(err)
        }
        return
      }

      if (upstream.statusCode === 401 && !tokenRetried) {
        upstream.resume() // drain before retrying
        tokenRetried = true
        continue
      }

      if (upstream.statusCode === 404 && entry && !sessionRetried) {
        const { buffer, truncated } = await readSmall(upstream, 1_000_000)
        const text = buffer.toString('utf8')
        if (!truncated && /session not found/i.test(text)) {
          sessionRetried = true
          await recoverUpstream(entry)
          continue
        }
        res.writeHead(404, { 'content-type': 'application/json', 'x-trek-mcp-broker': BROKER_VERSION })
        res.end(truncated ? JSON.stringify({ error: 'Session not found' }) : text)
        return
      }

      const headers = {}
      for (const [key, value] of Object.entries(upstream.headers)) {
        if (value === undefined || DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
        headers[key] = value
      }
      headers['x-trek-mcp-broker'] = BROKER_VERSION

      if (isInitialize) {
        // Hand the client a proxy-owned id; TREK's own id stays private so the
        // proxy can replace it without the client noticing.
        const upstreamId = upstream.headers['mcp-session-id']
        if (typeof upstreamId === 'string' && upstreamId !== '') {
          const downstreamId = randomUUID()
          sessions.set(downstreamId, {
            upstreamId,
            initBody: body,
            reinit: null,
            createdAt: Date.now(),
            needsAck: true,
          })
          trimSessions()
          headers['mcp-session-id'] = downstreamId
        }
      } else if (incomingSession) {
        headers['mcp-session-id'] = incomingSession
        if (req.method === 'DELETE') sessions.delete(incomingSession)
      }

      res.writeHead(upstream.statusCode ?? 502, headers)
      upstream.pipe(res)
      upstream.on('error', (err) => res.destroy(err))
      res.on('close', () => {
        if (!res.writableEnded) upstream.destroy()
      })
      return
    }
  }

  return {
    async start() {
      server = createServer((req, res) => {
        handle(req, res).catch((err) => {
          logger.error(`trek-mcp-broker: ${err?.stack ?? err}`)
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
          res.end('Internal broker error')
        })
      })
      server.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(cfg.listenPort, '127.0.0.1', () => {
          server.off('error', reject)
          resolve()
        })
      })
      // Warm the token so rejected credentials show up in the log right away.
      // A failure must not fail the row: the settings page that repairs the
      // client id/secret lives in this same plugin, and /mcp answers 502 until
      // a token can be minted (tools stay absent rather than unauthenticated).
      if (cfg.configured) getToken().catch((err) => logger.warn(`trek-mcp-broker: ${err.message}`))
      else logger.info('trek-mcp-broker: not configured yet; open Settings → TREK MCP to enter the endpoint and machine client')
    },
    stop() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      sessions.clear()
      if (!server) return
      const closing = server
      server = null
      closing.close()
    },
  }
}

/* ──────────────────────────── settings JSON API ─────────────────────────── */

function createApiHandler(ctx, cfg, logger) {
  return async (req, res) => {
    const url = requestPath(req)
    const route = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) || '/' : '/'
    try {
      if (req.method === 'GET' && (route === '/config' || route === '/')) {
        return json(res, 200, {
          endpoint: cfg.endpoint.href,
          tokenUrl: cfg.tokenUrl.href,
          clientId: cfg.clientId,
          scope: cfg.scope,
          listenPort: cfg.listenPort,
          mcpUrl: `http://127.0.0.1:${cfg.listenPort}/mcp`,
          configured: cfg.configured,
          hasSecret: Boolean(cfg.clientSecret),
          secretFromEnv: cfg.secretFromEnv,
        })
      }

      if (req.method === 'POST' && route === '/test') {
        const body = await readJson(req)
        const { clientId, clientSecret, scope } = testCredentials(body, cfg)
        const tokenUrl = optionalUrl(body.tokenUrl, cfg.tokenUrl)
        if (body.endpoint) optionalUrl(body.endpoint, cfg.endpoint)
        const minted = await mintToken({ tokenUrl, clientId, clientSecret, scope })
        return json(res, 200, { ok: true, expiresIn: minted.expiresIn })
      }

      if (req.method === 'PUT' && route === '/config') {
        const body = await readJson(req)
        const next = editableConfig(body, cfg)
        // Answer first: saving restarts this row (new credentials), which would
        // otherwise cut the HTTP response off mid-flight.
        json(res, 200, { saved: true, restarting: true })
        setImmediate(() => {
          persistConfig(ctx, next, logger).catch((err) => {
            logger.error(`trek-mcp-broker: saving configuration failed: ${err.message}`)
          })
        })
        return
      }

      return json(res, 404, { error: `unknown endpoint ${req.method} ${route}` })
    } catch (err) {
      const status = Number.isInteger(err.status) ? err.status : 400
      logger.warn?.(`trek-mcp-broker: ${req.method} ${route} failed: ${err.message}`)
      return json(res, status, { error: err.message })
    }
  }
}

/** Effective endpoint as a string for a public (secret-free) view. */
function testCredentials(body, cfg) {
  const clientId = optionalText(body.clientId) ?? cfg.clientId
  if (!clientId) fail('clientId is required')
  const clientSecret = optionalText(body.clientSecret) ?? cfg.clientSecret
  if (!clientSecret) fail('clientSecret is required')
  const scope = typeof body.scope === 'string' ? body.scope.trim() : cfg.scope
  return { clientId, clientSecret, scope }
}

/** Validate a settings save into a config patch object. */
function editableConfig(body, cfg) {
  if (typeof body !== 'object' || body === null) fail('invalid body')
  const endpoint = parseUrl(body.endpoint, 'endpoint').href
  const tokenUrl = body.tokenUrl
    ? parseUrl(body.tokenUrl, 'tokenUrl').href
    : new URL('/oauth/token', endpoint).href
  const clientId = optionalText(body.clientId) ?? cfg.clientId
  if (!clientId) fail('clientId is required')
  // An empty secret field means "keep the stored one"; the UI never receives it.
  const clientSecret = optionalText(body.clientSecret) ?? cfg.clientSecret
  if (!clientSecret) fail('clientSecret is required')
  const scope = typeof body.scope === 'string' ? body.scope.trim() : cfg.scope
  return { endpoint, tokenUrl, clientId, clientSecret, scope }
}

/** Write the edited fields into this row's config and let the Loader restart it. */
async function persistConfig(ctx, next, logger) {
  const entry = ctx.fiber?.entry
  const editor = ctx.get('configEditor')
  if (!entry || !editor) throw new Error('configuration cannot be saved in this profile')
  await editor.edit(entry, (current) => ({ ...current, ...next }))
  logger.info('trek-mcp-broker: configuration saved; row restarting')
}

/* ──────────────────────────────── helpers ───────────────────────────────── */

/** JSON-RPC method of a (single or batched) request body. */
function parseMessage(body) {
  if (body.length === 0) return undefined
  try {
    const value = JSON.parse(body.toString('utf8'))
    if (Array.isArray(value)) return value.find((item) => item && typeof item.method === 'string')
    return value && typeof value.method === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function requestPath(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    return '/'
  }
}

function json(res, status, value) {
  const payload = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
  return undefined
}

function fail(message) {
  const err = new Error(message)
  err.status = 400
  throw err
}

function optionalText(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function optionalUrl(value, fallback) {
  const text = optionalText(value)
  return text ? parseUrl(text, 'url') : fallback
}

/** Read a bounded JSON request body. */
function readJson(req) {
  return readBody(req, MAX_API_BODY_BYTES).then((buffer) => {
    if (buffer.length === 0) return {}
    try {
      return JSON.parse(buffer.toString('utf8'))
    } catch {
      fail('invalid JSON body')
    }
  })
}

/** Read the request body up to MAX_API_BODY_BYTES. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      resolve(Buffer.alloc(0))
      return
    }
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const err = new Error('Request body too large')
        err.code = 'BODY_TOO_LARGE'
        req.destroy()
        reject(err)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
