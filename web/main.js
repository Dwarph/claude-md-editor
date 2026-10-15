import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, parserCtx, remarkStringifyOptionsCtx, schemaCtx } from '@milkdown/kit/core'
import { $prose } from '@milkdown/kit/utils'
import { Plugin } from '@milkdown/kit/prose/state'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { ySyncPlugin } from 'y-prosemirror'
import '@milkdown/crepe/theme/common/style.css'
import './style.css'
import { FRAGMENT_NAME, REMARK_STRINGIFY_OPTIONS } from '../shared/markdown-options.js'
import { encodeAnchor } from '../shared/positions.js'
import { bindingMapping, rangeOf, reviewKey, reviewPlugin } from './review-plugin.js'
import { el, renderSidebar } from './sidebar.js'

const app = document.getElementById('app')
const docId = /^\/doc\/([0-9a-f]{12})/.exec(location.pathname)?.[1]

if (docId) openEditor(docId)
else showDocumentList()

async function showDocumentList() {
  const { documents } = await fetch('/api/docs').then((r) => r.json())
  app.replaceChildren(
    el('main', { class: 'doc-list' },
      el('h1', {}, 'Open documents'),
      documents.length
        ? el('ul', {}, ...documents.map((d) => el('li', {}, el('a', { href: `/doc/${d.id}` }, d.name), el('span', { class: 'muted' }, ` ${d.path}`))))
        : el('p', { class: 'muted' }, 'Nothing open yet. Ask Claude to open a markdown file in the shared editor.')),
  )
}

async function api(path, body) {
  const res = await fetch(`/api/docs/${docId}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    toast(data.error ?? `Request failed (${res.status})`)
    throw new Error(data.error)
  }
  return data
}

function toast(message) {
  const node = el('div', { class: 'toast', role: 'status' }, message)
  document.body.append(node)
  setTimeout(() => node.remove(), 4000)
}

async function openEditor(id) {
  const info = await fetch(`/api/docs/${id}`).then((r) => (r.ok ? r.json() : null))
  if (!info) {
    app.replaceChildren(el('main', { class: 'doc-list' }, el('h1', {}, 'Document not open'), el('p', { class: 'muted' }, 'The editor server restarted or the document was closed. Ask Claude to open it again.'), el('a', { href: '/' }, 'All open documents')))
    return
  }
  document.title = `${info.name} · Markdown editor`

  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment(FRAGMENT_NAME)
  const provider = new WebsocketProvider(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, id, ydoc, {
    params: { epoch: info.epoch },
  })
  // The server's copy was recreated (e.g. its saved state was cleared): start over from it.
  provider.on('connection-close', (event) => {
    if (event?.code === 4001) {
      provider.shouldConnect = false
      location.reload()
    }
  })
  const awareness = provider.awareness
  awareness.setLocalStateField('user', { name: 'You', color: '#3b82f6' })

  // Layout: header, editor, sidebar.
  const status = el('span', { class: 'conn', title: 'Connection to the editor server' })
  const agentPill = el('span', { class: 'agent-pill' })
  const directToggle = el('input', { type: 'checkbox', id: 'direct' })
  const editorHost = el('div', { class: 'editor-host' })
  const sidebar = el('aside', { class: 'sidebar' })
  app.replaceChildren(
    el('header', { class: 'topbar' },
      el('div', { class: 'title' }, el('strong', {}, info.name), el('span', { class: 'path muted', title: info.path }, info.path)),
      el('div', { class: 'topbar-right' },
        agentPill,
        el('label', { class: 'toggle', title: 'When on, Claude can apply edits straight away instead of suggesting them' }, directToggle, ' Let Claude edit directly'),
        status)),
    el('div', { class: 'layout' }, el('div', { class: 'page' }, editorHost), sidebar),
  )

  const setConn = (state) => { status.dataset.state = state; status.textContent = state === 'connected' ? 'Live' : state === 'connecting' ? 'Connecting…' : 'Offline' }
  setConn('connecting')
  provider.on('status', ({ status: s }) => setConn(s))

  await new Promise((resolve) => (provider.synced ? resolve() : provider.once('sync', resolve)))

  const suggestions = ydoc.getMap('suggestions')
  const comments = ydoc.getMap('comments')
  const reviews = ydoc.getMap('reviews')
  const settings = ydoc.getMap('settings')

  let activeComment = null
  let draftAnchor = null // { from, to, quote } while the comment composer is open
  let view = null
  const hooks = { selection: () => {} }

  const reviewCtx = {
    ydoc,
    fragment,
    suggestions,
    comments,
    schema: null,
    parse: null,
    activeComment: () => activeComment,
    onAccept: (sid) => api('accept', { id: sid }),
    onReject: (sid) => api('reject', { id: sid }),
    onCommentClick: (cid) => focusComment(cid, false),
  }

  const crepe = new Crepe({
    root: editorHost,
    defaultValue: '',
    features: {
      // These add node types the markdown round-trip on the server doesn't know.
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.TopBar]: false,
    },
    featureConfigs: {
      [Crepe.Feature.Placeholder]: { text: 'Start writing…', mode: 'doc' },
    },
  })
  crepe.editor
    .config((ctx) => ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...REMARK_STRINGIFY_OPTIONS })))
    .use($prose(() => ySyncPlugin(fragment)))
    .use($prose(() => reviewPlugin(reviewCtx)))
    // Selection changes (and focus) drive the comment button and what Claude sees as "your selection".
    .use($prose(() => new Plugin({
      view: () => ({
        update: (v, prev) => { if (!prev.selection.eq(v.state.selection)) hooks.selection() },
      }),
      props: { handleDOMEvents: { focus: () => { hooks.selection(); return false }, blur: () => { setTimeout(hooks.selection, 150); return false } } },
    })))
  await crepe.create()

  crepe.editor.action((ctx) => {
    view = ctx.get(editorViewCtx)
    reviewCtx.schema = ctx.get(schemaCtx)
    reviewCtx.parse = ctx.get(parserCtx)
  })
  reviewCtx.requestRefresh?.()

  // --- Selection: share it with the agent, offer "Comment" ---
  const commentButton = el('button', { class: 'comment-fab', type: 'button', title: 'Comment on selection (Ctrl+Alt+M)' }, '💬 Comment')
  document.body.append(commentButton)
  commentButton.addEventListener('mousedown', (e) => { e.preventDefault(); startComment() })

  let selectionTimer = 0
  const onSelectionChange = () => {
    if (!view) return
    const { from, to, empty } = view.state.selection
    const mapping = bindingMapping(view.state)
    if (mapping && view.hasFocus()) {
      clearTimeout(selectionTimer)
      selectionTimer = setTimeout(() => {
        awareness.setLocalStateField('selection', {
          from: encodeAnchor(from, fragment, mapping),
          to: encodeAnchor(to, fragment, mapping),
          at: Date.now(),
        })
      }, 150)
    }
    if (!empty && view.hasFocus()) {
      const coords = view.coordsAtPos(to)
      commentButton.style.top = `${coords.bottom + window.scrollY + 6}px`
      commentButton.style.left = `${Math.min(coords.left + window.scrollX, window.innerWidth - 140)}px`
      commentButton.classList.add('visible')
    } else {
      commentButton.classList.remove('visible')
    }
  }
  hooks.selection = onSelectionChange
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); startComment() }
  })

  function startComment() {
    if (!view) return
    const { from, to, empty } = view.state.selection
    if (empty) return toast('Select some text to comment on.')
    const mapping = bindingMapping(view.state)
    draftAnchor = {
      from: encodeAnchor(from, fragment, mapping),
      to: encodeAnchor(to, fragment, mapping),
      quote: view.state.doc.textBetween(from, to, '\n', '￼'),
    }
    commentButton.classList.remove('visible')
    render()
    sidebar.querySelector('.composer textarea')?.focus()
  }

  function saveComment(body) {
    if (!draftAnchor || !body.trim()) return
    const cid = crypto.randomUUID().slice(0, 8)
    comments.set(cid, {
      id: cid,
      ...draftAnchor,
      body: body.trim(),
      author: 'You',
      status: 'draft',
      thread: [],
      createdAt: new Date().toISOString(),
    })
    draftAnchor = null
    activeComment = cid
    render()
  }

  function updateComment(cid, patch) {
    const c = comments.get(cid)
    if (c) comments.set(cid, { ...c, ...patch })
  }

  function focusComment(cid, scrollEditor) {
    activeComment = cid
    render()
    reviewCtx.requestRefresh?.()
    sidebar.querySelector(`[data-card="${cid}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    if (scrollEditor) scrollToItem(comments.get(cid))
  }

  function scrollToItem(item) {
    if (!item || !view) return
    const range = rangeOf(item, reviewCtx, view.state)
    if (!range) return
    const node = view.domAtPos(range.from).node
    ;(node.nodeType === 1 ? node : node.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }

  /** Comments and suggestions ordered as they appear in the document. */
  function inDocOrder(items) {
    return items
      .map((item) => ({ item, pos: view ? rangeOf(item, reviewCtx, view.state)?.from ?? Infinity : 0 }))
      .sort((a, b) => a.pos - b.pos)
      .map(({ item }) => item)
  }

  function agentState() {
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId !== ydoc.clientID && state?.agent) return state
    }
    return null
  }

  function render() {
    const agent = agentState()
    agentPill.textContent = agent?.status && agent.status !== 'idle' ? `Claude: ${agent.message ?? agent.status}…` : agent?.watching ? 'Claude is listening' : 'Claude'
    agentPill.dataset.state = agent?.status && agent.status !== 'idle' ? 'working' : agent?.watching ? 'watching' : 'idle'
    agentPill.title = agent?.watching
      ? 'Claude is waiting for your review and is notified when you submit.'
      : 'Claude is not waiting for a review. After you submit, tell it "review\'s in".'
    directToggle.checked = !!settings.get('allowDirect')

    renderSidebar(sidebar, {
      suggestions: inDocOrder([...suggestions.values()]),
      comments: inDocOrder([...comments.values()]),
      reviews: [...reviews.values()],
      draftAnchor,
      activeComment,
      agentWatching: !!agent?.watching,
      actions: {
        accept: (sid) => api('accept', { id: sid }),
        reject: (sid) => api('reject', { id: sid }),
        acceptAll: () => api('accept-all').then((r) => r.failed?.length && toast(`${r.failed.length} suggestion(s) couldn't be applied: their text is gone.`)),
        rejectAll: () => api('reject-all'),
        showSuggestion: (sid) => scrollToItem(suggestions.get(sid)),
        saveComment,
        cancelComment: () => { draftAnchor = null; render() },
        editComment: (cid, body) => updateComment(cid, { body }),
        deleteComment: (cid) => comments.delete(cid),
        focusComment: (cid) => focusComment(cid, true),
        reply: (cid, body) => api('reply', { id: cid, body }),
        resolve: (cid) => api('resolve', { id: cid }),
        reopen: (cid) => updateComment(cid, { status: 'submitted' }),
        submitReview: (note) => api('submit-review', { note }).then(() => toast(agent?.watching ? 'Review sent. Claude has been notified.' : 'Review submitted. Tell Claude "review\'s in" to have it pick it up.')),
      },
    })
  }

  // Redraw on the next frame: Yjs observers fire before the editor has applied
  // the same update, and positions resolve against the editor's state.
  let renderFrame = 0
  const scheduleRender = () => {
    cancelAnimationFrame(renderFrame)
    renderFrame = requestAnimationFrame(render)
  }

  directToggle.addEventListener('change', () => settings.set('allowDirect', directToggle.checked))
  for (const map of [suggestions, comments, reviews, settings]) map.observe(scheduleRender)
  // Awareness also carries your own selection; only redraw when Claude's state changes.
  let lastAgent = ''
  awareness.on('change', () => {
    const key = JSON.stringify(agentState())
    if (key !== lastAgent) { lastAgent = key; render() }
  })
  render()
}
