// The one long-lived process per machine: serves the editor, syncs documents
// over WebSocket, and exposes the HTTP API the MCP tools, CLI and mod use.
// Binds to 127.0.0.1 only and exits after a stretch with nothing open.
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, normalize } from 'node:path'
import { WebSocketServer } from 'ws'
import { DocSession } from './doc.js'
import * as ops from './ops.js'
import { DAEMON_FILE, DEFAULT_PORT, STATE_DIR, VERSION, WEB_DIST, docIdFor } from './paths.js'

const IDLE_EXIT_MS = Number(process.env.CLAUDE_MD_EDITOR_IDLE_MS ?? 30 * 60 * 1000)
const WAIT_TIMEOUT_MS = 25_000
const STALE_TAB_CODE = 4001

const docs = new Map() // id -> DocSession
let lastApiCall = Date.now()
let port = 0

function openDoc(path) {
  const id = docIdFor(path)
  let session = docs.get(id)
  if (!session) {
    session = new DocSession(normalize(path)).load()
    docs.set(id, session)
  }
  return session
}

function docOrThrow(id) {
  const session = docs.get(id)
  if (!session) throw Object.assign(new ops.OpError(`No open document ${id}. Call open_document first.`), { status: 404 })
  return session
}

/**
 * The open document for `path`, opening it if needed. A missing file is only
 * created when the caller says so: in sandboxed hosts (e.g. Cowork) the agent's
 * paths may not be this machine's, and a silent create would hide that.
 */
function docForPath(path, { create = false, content } = {}) {
  if (!path) throw new ops.OpError('`path` is required.')
  if (!isAbsolute(path)) throw new ops.OpError(`\`path\` must be absolute, got ${path}.`)
  const open = docs.get(docIdFor(path))
  if (open) return open
  if (!existsSync(path)) {
    if (!create) {
      throw new ops.OpError(`No file at ${path} on the machine running the editor. Check it's the file's real location on the person's computer (sandboxed sessions can see files under a different path), or pass create: true to make a new document there.`)
    }
    // A new document's starting text is written as-is: it's the person's own text, not a suggestion.
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content ?? '')
  }
  return openDoc(path)
}

const editorUrl = (session) => `http://127.0.0.1:${port}/doc/${session.id}`

function docSummary(session) {
  return {
    id: session.id,
    path: session.path,
    name: session.name,
    url: editorUrl(session),
    epoch: session.epoch,
    mode: ops.getMode(session),
    suggestions: session.suggestions.size,
    openComments: [...session.comments.values()].filter((c) => c.status === 'submitted').length,
    draftComments: [...session.comments.values()].filter((c) => c.status === 'draft').length,
    unseenReviews: ops.unseenReviews(session).length,
    editors: session.conns.size,
  }
}

/** Agent calls: each marks the agent as working in open editors. */
const agentRoutes = {
  open_document: ({ path, create, content }) => {
    const session = docForPath(path, { create, content })
    return { ...docSummary(session) }
  },
  read_document: ({ path }) => {
    const session = docForPath(path)
    session.setAgentStatus('reading', 'Reading')
    return { text: ops.renderForAgent(session) }
  },
  get_selection: ({ path }) => ({ selection: ops.getSelection(docForPath(path)) }),
  suggest: ({ path, target, markdown, note, resolves }) => {
    const session = docForPath(path)
    session.setAgentStatus('editing', ops.getMode(session) === 'live' ? 'Editing' : 'Suggesting')
    return ops.suggest(session, { target, markdown, note, resolves })
  },
  list_suggestions: ({ path }) => ({ suggestions: ops.listSuggestions(docForPath(path)).map(({ from, to, ...rest }) => rest) }),
  withdraw_suggestion: ({ path, id }) => {
    ops.rejectSuggestion(docForPath(path), id, 'agent')
    return { withdrawn: id }
  },
  list_changes: ({ path, since }) => ops.listChanges(docForPath(path), since ?? 0),
  get_review: ({ path }) => ops.getReview(docForPath(path)),
  reply_to_comment: ({ path, id, body }) => {
    const session = docForPath(path)
    session.setAgentStatus('replying', 'Replying')
    ops.replyToComment(session, id, body)
    return { ok: true }
  },
  resolve_comment: ({ path, id, body }) => {
    const session = docForPath(path)
    if (body) ops.replyToComment(session, id, body)
    ops.setCommentResolved(session, id, 'Claude')
    return { ok: true }
  },
  list_documents: () => ({ documents: [...docs.values()].map(docSummary) }),
  close_document: ({ path }) => {
    const id = docIdFor(path)
    docs.get(id)?.close()
    docs.delete(id)
    return { closed: true }
  },
}

/** Editor (browser) calls, by document id. */
const editorRoutes = {
  accept: (session, { id }) => (ops.acceptSuggestion(session, id), { ok: true }),
  reject: (session, { id }) => (ops.rejectSuggestion(session, id), { ok: true }),
  'accept-all': (session) => ops.acceptAll(session),
  'reject-all': (session) => ops.rejectAll(session),
  'submit-review': (session, { note }) => ({ review: ops.submitReview(session, note) }),
  reply: (session, { id, body }) => (ops.replyToComment(session, id, body, 'You'), { ok: true }),
  resolve: (session, { id }) => (ops.setCommentResolved(session, id, 'You'), { ok: true }),
}

// --- HTTP plumbing -------------------------------------------------------

/** Reject requests a web page on another origin could forge (DNS rebinding, CSRF). */
function isLocalRequest(req) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)
  } catch {
    return false
  }
}

async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  return body ? JSON.parse(body) : {}
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json' }

function serveStatic(res, pathname) {
  const rel = pathname === '/' || pathname.startsWith('/doc/') ? 'index.html' : pathname.slice(1)
  const file = normalize(join(WEB_DIST, rel))
  if (!file.startsWith(WEB_DIST) || !existsSync(file) || !statSync(file).isFile()) {
    if (!existsSync(join(WEB_DIST, 'index.html'))) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      return res.end('Editor not built. Run `npm run build` in the claude-md-editor folder.')
    }
    res.writeHead(404)
    return res.end()
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
}

async function handle(req, res) {
  if (!isLocalRequest(req)) return send(res, 403, { error: 'Forbidden' })
  const url = new URL(req.url, 'http://127.0.0.1')
  const parts = url.pathname.split('/').filter(Boolean)
  try {
    if (parts[0] !== 'api') return serveStatic(res, url.pathname)
    // The mod's background poll (`GET /api/docs?poll=1`) must not keep an unused daemon alive.
    if (!url.searchParams.has('poll')) lastApiCall = Date.now()

    if (parts[1] === 'health') return send(res, 200, { ok: true, version: VERSION, pid: process.pid, port })
    if (parts[1] === 'shutdown' && req.method === 'POST') {
      send(res, 200, { ok: true })
      return shutdown()
    }
    if (parts[1] === 'agent' && req.method === 'POST') {
      const route = agentRoutes[parts[2]]
      if (!route) return send(res, 404, { error: `Unknown call ${parts[2]}` })
      return send(res, 200, await route(await readJson(req)))
    }
    if (parts[1] === 'docs' && parts.length === 2) {
      // `watch=<id>,<id>`: a poller that will announce reviews on these docs is listening.
      for (const id of (url.searchParams.get('watch') ?? '').split(',')) docs.get(id)?.noteListener()
      return send(res, 200, { documents: [...docs.values()].map(docSummary) })
    }
    if (parts[1] === 'docs' && parts[2]) {
      const session = docOrThrow(parts[2])
      if (parts.length === 3) return send(res, 200, docSummary(session))
      if (parts[3] === 'wait-review') return waitForReview(session, res, Number(url.searchParams.get('timeout')) || WAIT_TIMEOUT_MS)
      const route = editorRoutes[parts[3]]
      if (route && req.method === 'POST') return send(res, 200, route(session, await readJson(req)))
    }
    send(res, 404, { error: 'Not found' })
  } catch (err) {
    send(res, err.status ?? (err instanceof ops.OpError ? 400 : 500), { error: err.message })
    if (!(err instanceof ops.OpError)) console.error(err)
  }
}

/** Long-poll: answers as soon as an unseen review exists, else 204 after `timeoutMs` (at most WAIT_TIMEOUT_MS). */
function waitForReview(session, res, timeoutMs) {
  const existing = ops.unseenReviews(session)
  if (existing.length) return send(res, 200, reviewNotice(session, existing))
  const done = () => {
    clearTimeout(timer)
    session.reviewWaiters.delete(waiter)
    session.updateWatching()
  }
  const timer = setTimeout(() => {
    done()
    // The waiter usually asks again within seconds: keep the editor showing "Claude is listening" meanwhile.
    session.noteListener()
    res.writeHead(204).end()
  }, Math.min(Math.max(timeoutMs, 1000), WAIT_TIMEOUT_MS))
  const waiter = (review) => {
    done()
    if (review) send(res, 200, reviewNotice(session, [review]))
    else res.writeHead(204).end()
  }
  session.reviewWaiters.add(waiter)
  session.updateWatching()
  res.on('close', done)
}

function reviewNotice(session, reviews) {
  const replies = reviews.filter((r) => r.replyTo).length
  const comments = reviews.reduce((n, r) => n + (r.replyTo ? 0 : r.commentIds.length), 0)
  return { path: session.path, name: session.name, reviews: reviews.length, comments, replies }
}

// --- Lifecycle -----------------------------------------------------------

function shutdown() {
  for (const session of docs.values()) session.close()
  try {
    const info = JSON.parse(readFileSync(DAEMON_FILE, 'utf8'))
    if (info.pid === process.pid) rmSync(DAEMON_FILE)
  } catch {}
  setTimeout(() => process.exit(0), 50)
}

function listen(server, candidate) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(candidate, '127.0.0.1', () => resolve(server.address().port))
  })
}

export async function startDaemon() {
  mkdirSync(STATE_DIR, { recursive: true })
  const server = createServer(handle)
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const match = /^\/ws\/([0-9a-f]{12})$/.exec(url.pathname)
    const session = match && docs.get(match[1])
    if (!isLocalRequest(req) || !session) return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      // The tab holds a different history of this document: make it reload rather than merge.
      if (url.searchParams.get('epoch') !== session.epoch) return ws.close(STALE_TAB_CODE, 'stale')
      session.addConnection(ws)
    })
  })
  for (let candidate = DEFAULT_PORT; ; candidate++) {
    try {
      port = await listen(server, candidate)
      break
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || candidate > DEFAULT_PORT + 20) throw err
    }
  }
  writeFileSync(DAEMON_FILE, JSON.stringify({ pid: process.pid, port, version: VERSION }))
  console.error(`claude-md-editor ${VERSION} listening on http://127.0.0.1:${port}`)

  setInterval(() => {
    const busy = [...docs.values()].some((s) => s.conns.size > 0 || s.reviewWaiters.size > 0 || Date.now() - s.lastActivity < IDLE_EXIT_MS)
    if (!busy && Date.now() - lastApiCall > IDLE_EXIT_MS) shutdown()
  }, 60_000).unref()
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return port
}

