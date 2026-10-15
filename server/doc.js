// One open markdown file: its Yjs document (shared with every browser tab),
// the suggestion/comment/review maps beside it, and its persistence.
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror'
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseMarkdown, schema, serializeDoc } from './milkdown.js'
import { FRAGMENT_NAME } from '../shared/markdown-options.js'
import { DOCS_DIR, docIdFor } from './paths.js'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1
const SAVE_DELAY_MS = 400
const AGENT_STATUS_HOLD_MS = 4000
const LISTENER_HOLD_MS = 10_000 // a poller checks every few seconds

// Transaction origins for changes the server makes itself.
export const ORIGIN = { load: 'load', file: 'file', agent: 'agent', user: 'user-api' }

export const AGENT_USER = { name: 'Claude', color: '#d97757' }

export class DocSession {
  constructor(path) {
    this.path = path
    this.id = docIdFor(path)
    this.name = basename(path)
    this.ydoc = new Y.Doc()
    this.fragment = this.ydoc.getXmlFragment(FRAGMENT_NAME)
    this.suggestions = this.ydoc.getMap('suggestions')
    this.comments = this.ydoc.getMap('comments')
    this.reviews = this.ydoc.getMap('reviews')
    this.settings = this.ydoc.getMap('settings')
    this.log = this.ydoc.getArray('log')
    this.meta = this.ydoc.getMap('meta')
    this.recent = this.ydoc.getMap('recent') // Claude's Edit live changes, tinted briefly in editors
    this.awareness = new awarenessProtocol.Awareness(this.ydoc)
    this.awareness.setLocalState({ user: AGENT_USER, agent: true, status: 'idle' })
    this.conns = new Map() // ws -> Set of awareness client ids it controls
    this.reviewWaiters = new Set()
    this.agentSnapshot = null // markdown as the agent last read it
    this.lastSerialized = ''
    this.lastWrittenRaw = ''
    this.saveTimer = null
    this.statusTimer = null
    this.watcher = null
    this.lastActivity = Date.now()
  }

  get epoch() {
    return this.meta.get('epoch')
  }

  get statePath() {
    return join(DOCS_DIR, `${this.id}.ystate`)
  }

  /** Current ProseMirror doc plus the Y-type -> node mapping position helpers need. */
  snapshot() {
    const doc = yXmlFragmentToProseMirrorRootNode(this.fragment, schema)
    const mapping = new Map()
    mapTypes(this.fragment, doc, mapping)
    return { doc, mapping }
  }

  /** Replace the document with `doc`, writing only the minimal Yjs changes. */
  applyDoc(doc, origin) {
    const meta = { mapping: new Map(), isOMark: new Map() }
    this.ydoc.transact(() => updateYFragment(this.ydoc, this.fragment, doc, meta), origin)
  }

  markdown() {
    return serializeDoc(this.snapshot().doc)
  }

  load() {
    mkdirSync(DOCS_DIR, { recursive: true })
    if (!existsSync(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true })
      writeFileSync(this.path, '')
    }
    const raw = readFileSync(this.path, 'utf8')
    if (existsSync(this.statePath)) {
      Y.applyUpdate(this.ydoc, readFileSync(this.statePath), ORIGIN.load)
    }
    const fresh = parseMarkdown(raw)
    if (this.fragment.length === 0) {
      // A brand-new Yjs history. Tabs still holding an older history must not
      // merge into it (that would duplicate the text), so they compare epochs.
      this.ydoc.transact(() => this.meta.set('epoch', crypto.randomUUID()), ORIGIN.load)
      this.applyDoc(fresh, ORIGIN.load)
    } else if (serializeDoc(this.snapshot().doc) !== serializeDoc(fresh)) {
      // Edited outside the editor since we last saw it: diff it in, keeping anchors where text survived.
      this.applyDoc(fresh, ORIGIN.file)
      this.addLog({ type: 'file-changed', by: 'disk' })
    }
    this.lastSerialized = serializeDoc(this.snapshot().doc)
    this.lastWrittenRaw = raw
    writeFileSync(join(DOCS_DIR, `${this.id}.json`), JSON.stringify({ path: this.path }))

    this.ydoc.on('update', (update, origin) => {
      this.lastActivity = Date.now()
      this.broadcast(syncUpdateMessage(update), origin)
      if (origin !== ORIGIN.load) this.scheduleSave()
    })
    this.awareness.on('update', ({ added, updated, removed }, conn) => {
      const changed = added.concat(updated, removed)
      if (conn && this.conns.has(conn)) {
        const ids = this.conns.get(conn)
        added.forEach((id) => ids.add(id))
        removed.forEach((id) => ids.delete(id))
      }
      this.broadcast(awarenessMessage(this.awareness, changed))
    })
    this.watchFile()
    return this
  }

  watchFile() {
    let timer = null
    try {
      this.watcher = watch(this.path, () => {
        clearTimeout(timer)
        timer = setTimeout(() => this.reloadFromDisk(), 150)
      })
    } catch {
      // Watching is best effort (some network drives don't support it).
    }
  }

  reloadFromDisk() {
    if (!existsSync(this.path)) return
    const raw = readFileSync(this.path, 'utf8')
    if (raw === this.lastWrittenRaw) return
    this.lastWrittenRaw = raw
    const doc = parseMarkdown(raw)
    this.applyDoc(doc, ORIGIN.file)
    this.lastSerialized = serializeDoc(doc)
    this.addLog({ type: 'file-changed', by: 'disk' })
  }

  scheduleSave() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS)
  }

  save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    const md = serializeDoc(this.snapshot().doc)
    if (md !== this.lastSerialized) {
      writeFileSync(this.path, md)
      this.lastSerialized = md
      this.lastWrittenRaw = md
    }
    writeFileSync(this.statePath, Y.encodeStateAsUpdate(this.ydoc))
  }

  close() {
    if (this.saveTimer) this.save()
    this.watcher?.close()
    clearTimeout(this.watchTimer)
    for (const ws of this.conns.keys()) ws.close()
    for (const waiter of this.reviewWaiters) waiter(null)
    this.awareness.destroy()
    this.ydoc.destroy()
  }

  addLog(entry) {
    this.log.push([{ at: new Date().toISOString(), ...entry }])
  }

  /** Show the agent as working in every open editor for a few seconds. */
  setAgentStatus(status, message) {
    const state = this.awareness.getLocalState() ?? {}
    this.awareness.setLocalState({ ...state, status, message })
    clearTimeout(this.statusTimer)
    if (status !== 'idle') {
      this.statusTimer = setTimeout(() => this.setAgentStatus('idle'), AGENT_STATUS_HOLD_MS)
    }
  }

  /** A poller (the Claude Code mod) announces reviews on this doc; it counts as listening for a while. */
  noteListener() {
    this.listenerUntil = Date.now() + LISTENER_HOLD_MS
    this.updateWatching()
  }

  /**
   * Tell editors whether an agent is waiting for a review (the wait-review
   * watcher, or the mod's poll). Long-polls reconnect every ~25s, so "off"
   * waits a few seconds.
   */
  updateWatching() {
    const set = (watching) => {
      const state = this.awareness.getLocalState() ?? {}
      if (state.watching !== watching) this.awareness.setLocalState({ ...state, watching })
    }
    const isListening = () => this.reviewWaiters.size > 0 || Date.now() < (this.listenerUntil ?? 0)
    clearTimeout(this.watchTimer)
    if (isListening()) {
      set(true)
      if (this.reviewWaiters.size === 0) this.watchTimer = setTimeout(() => this.updateWatching(), this.listenerUntil - Date.now())
    } else {
      this.watchTimer = setTimeout(() => set(isListening()), 5000)
    }
  }

  /** The person's selection as their editor last reported it through awareness. */
  userSelection() {
    let best = null
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.ydoc.clientID || !state?.selection) continue
      if (!best || (state.selection.at ?? 0) > (best.at ?? 0)) best = state.selection
    }
    return best
  }

  // --- WebSocket sync (y-websocket protocol) ---

  addConnection(ws) {
    this.conns.set(ws, new Set())
    ws.binaryType = 'arraybuffer'
    ws.on('message', (data) => this.onMessage(ws, new Uint8Array(data)))
    ws.on('close', () => {
      const ids = this.conns.get(ws)
      this.conns.delete(ws)
      if (ids?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null)
    })
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.ydoc)
    ws.send(encoding.toUint8Array(encoder))
    const states = [...this.awareness.getStates().keys()]
    if (states.length) ws.send(awarenessMessage(this.awareness, states))
  }

  onMessage(ws, message) {
    this.lastActivity = Date.now()
    const decoder = decoding.createDecoder(message)
    const encoder = encoding.createEncoder()
    const type = decoding.readVarUint(decoder)
    if (type === MESSAGE_SYNC) {
      encoding.writeVarUint(encoder, MESSAGE_SYNC)
      syncProtocol.readSyncMessage(decoder, encoder, this.ydoc, ws)
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder))
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws)
    }
  }

  broadcast(message, skip) {
    for (const ws of this.conns.keys()) {
      if (ws !== skip && ws.readyState === 1) ws.send(message)
    }
  }
}

/**
 * Pair every Y element with the ProseMirror node built from it, at every depth
 * (what the editor's sync binding keeps; position conversion needs nested sizes).
 * A Y.XmlText becomes a run of zero or more PM text nodes.
 */
function mapTypes(ytype, pnode, mapping) {
  mapping.set(ytype, pnode)
  let index = 0
  for (const child of ytype.toArray()) {
    if (child instanceof Y.XmlText) {
      while (index < pnode.childCount && pnode.child(index).isText) index++
    } else if (index < pnode.childCount) {
      mapTypes(child, pnode.child(index++), mapping)
    }
  }
}

function syncUpdateMessage(update) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function awarenessMessage(awareness, clients) {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
  return encoding.toUint8Array(encoder)
}
