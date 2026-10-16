import { Crepe } from '@milkdown/crepe'
import { editorViewCtx, parserCtx, remarkStringifyOptionsCtx, schemaCtx } from '@milkdown/kit/core'
import { $prose } from '@milkdown/kit/utils'
import { dropIndicatorPlugin as crepeDropIndicator } from '@milkdown/kit/plugin/cursor'
import { wrapInHeadingInputRule } from '@milkdown/kit/preset/commonmark'
import { Plugin, TextSelection } from '@milkdown/kit/prose/state'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import { ySyncPlugin } from 'y-prosemirror'
import '@milkdown/crepe/theme/common/style.css'
import './style.css'
import { FRAGMENT_NAME, REMARK_STRINGIFY_OPTIONS } from '../shared/markdown-options.js'
import { encodeAnchor } from '../shared/positions.js'
import { bindingMapping, rangeOf, reviewPlugin } from './review-plugin.js'
import { autosize, el, isCompact, layoutMargin, renderMargin } from './margin.js'
import { TEXT_TYPE_ICON, TEXT_TYPE_KEY, textTypeMenu } from './block-type.js'
import { dropIndicatorPlugin } from './drop-indicator.js'
import { gutterDragPlugin } from './gutter-drag.js'
import { headingLevelInputRule, keepHeadingOnBackspace } from './heading-hashes.js'
import { gutterHoverPlugin } from './gutter-hover.js'
import { handleSelectPlugin } from './handle-select.js'
import { rangeDragPlugin } from './range-drag.js'
import { selectionReleasePlugin } from './selection-release.js'

const app = document.getElementById('app')
const docId = /^\/doc\/([0-9a-f]{12})/.exec(location.pathname)?.[1]

// Outline drawn like Crepe's own toolbar icons; the toolbar sets colour and fill, so fill is turned off here.
const COMMENT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path style="fill:none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" d="M5 5.75h14v9.5h-7.75L7.5 18.5v-3.25H5z"/><path style="fill:none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M8.5 9.25h7M8.5 12h4.25"/></svg>'

// What the person lets Claude do (mirrors server/ops.js MODES).
const MODES = [
  { id: 'live', label: 'Edit live', title: 'Claude’s changes land in the document straight away' },
  { id: 'suggest', label: 'Suggest', title: 'Claude suggests changes and comments; nothing lands until you accept' },
  { id: 'readonly', label: 'Read only', title: 'Claude can read the document and reply to comments, but not change it' },
]

if (docId) openEditor(docId)
else showDocumentList()

async function showDocumentList() {
  const { documents } = await fetch('/api/docs').then((r) => r.json())
  document.title = 'Shared documents'
  app.replaceChildren(
    el('main', { class: 'doc-list' },
      el('h1', {}, 'Shared documents'),
      documents.length
        ? el('ul', {}, ...documents.map((d) => el('li', {}, el('a', { href: `/doc/${d.id}` }, el('span', {}, d.name), el('span', { class: 'path' }, d.path)))))
        : el('p', {}, 'Nothing is open yet. Ask Claude to open a markdown file in the shared editor.')),
  )
}

let toastTimer = 0
function toast(message) {
  document.querySelector('.toast')?.remove()
  const node = el('div', { class: 'toast', role: 'status' }, message)
  document.body.append(node)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => node.remove(), 4000)
}

async function openEditor(id) {
  const info = await fetch(`/api/docs/${id}`).then((r) => (r.ok ? r.json() : null))
  if (!info) {
    app.replaceChildren(el('main', { class: 'doc-list' },
      el('h1', {}, 'This document isn’t open'),
      el('p', {}, 'The editor server restarted or the document was closed. Ask Claude to open it again.'),
      el('p', {}, el('a', { href: '/' }, 'All shared documents'))))
    return
  }
  document.title = info.name

  async function api(path, body) {
    const res = await fetch(`/api/docs/${id}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast(data.error ?? `Something went wrong (${res.status}).`)
      throw new Error(data.error)
    }
    return data
  }

  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment(FRAGMENT_NAME)
  const suggestions = ydoc.getMap('suggestions')
  const comments = ydoc.getMap('comments')
  const recent = ydoc.getMap('recent')
  const settings = ydoc.getMap('settings')
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
  awareness.setLocalStateField('user', { name: 'You' })

  // --- Layout -------------------------------------------------------------
  const status = el('span', { class: 'doc-status' }, 'Connecting…')
  // Claude's name in its orange; it pulses while Claude works and gets a green dot while it listens.
  const claudeName = el('span', { class: 'claude-name' }, 'Claude')
  // The white pill behind the chosen mode; it slides between options.
  const modeThumb = el('span', { class: 'segmented-thumb', 'aria-hidden': 'true' })
  const modeButtons = MODES.map((m) =>
    el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', title: m.title, 'data-mode': m.id, onclick: () => setMode(m.id) }, m.label))
  const editorHost = el('div', { class: 'editor-host' })
  const margin = el('div', { class: 'margin', 'aria-label': 'Suggestions and comments' })
  const bar = el('div', { class: 'reviewbar', role: 'region', 'aria-label': 'Review', hidden: true })

  app.replaceChildren(
    el('header', { class: 'topbar' },
      el('div', { class: 'doc-title' }, el('strong', { title: info.path }, info.name), status),
      el('div', { class: 'claude-can' },
        el('span', { id: 'claude-can-label' }, claudeName, ' can'),
        el('div', { class: 'segmented', role: 'radiogroup', 'aria-labelledby': 'claude-can-label' }, modeThumb, modeButtons))),
    el('div', { class: 'workspace' }, el('div', { class: 'page' }, editorHost), margin),
    bar,
  )

  let connected = false
  provider.on('status', ({ status: s }) => { connected = s === 'connected'; renderHeader() })

  await new Promise((resolve) => (provider.synced ? resolve() : provider.once('sync', resolve)))

  let view = null
  let active = null // id of the focused panel
  let draftAnchor = null // { from, to, quote } while composing a comment
  const hooks = { selection: () => {} }
  const typeMenu = textTypeMenu(() => view)

  const reviewCtx = {
    ydoc,
    fragment,
    suggestions,
    comments,
    recent,
    schema: null,
    parse: null,
    activeComment: () => active,
    composing: () => draftAnchor,
    onCommentClick: (cid) => focusItem(cid, false),
    onSuggestionClick: (sid) => focusItem(sid, false),
    afterRefresh: () => relayout(),
  }

  const crepe = new Crepe({
    root: editorHost,
    defaultValue: '',
    features: {
      // These add node types the server's markdown round-trip doesn't know.
      [Crepe.Feature.ImageBlock]: false,
      [Crepe.Feature.Latex]: false,
      [Crepe.Feature.AI]: false,
      [Crepe.Feature.TopBar]: false,
    },
    featureConfigs: {
      [Crepe.Feature.Placeholder]: { text: 'Start writing…', mode: 'doc' },
      // Close to the text, so the gutter style.css keeps for it stays narrow.
      [Crepe.Feature.BlockEdit]: { blockHandle: { getOffset: () => 6 } },
      // The text type picker leads the selection toolbar (its own group, so a divider follows it).
      // Comment sits straight after code and link (same group, no divider).
      [Crepe.Feature.Toolbar]: {
        buildToolbar: (builder) => {
          const groups = builder.build().map((g) => ({ ...g, items: [...g.items] }))
          builder.clear()
          builder.addGroup('block', 'Text type').addItem(TEXT_TYPE_KEY, {
            icon: TEXT_TYPE_ICON,
            label: 'Text type',
            active: () => false,
            onRun: () => typeMenu.toggle(),
          })
          for (const { key, label, items } of groups) {
            const group = builder.addGroup(key, label)
            for (const { key: itemKey, ...item } of items) group.addItem(itemKey, item)
          }
          builder.getGroup('function').addItem('comment', {
            icon: COMMENT_ICON,
            label: 'Comment',
            shortcut: 'Ctrl+Alt+M',
            active: () => false,
            onRun: () => startComment(),
          })
        },
      },
    },
  })
  crepe.editor
    .config((ctx) => ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...REMARK_STRINGIFY_OPTIONS })))
    .config(keepHeadingOnBackspace)
    .use(headingLevelInputRule)
    .use($prose(() => ySyncPlugin(fragment)))
    .use($prose(() => reviewPlugin(reviewCtx)))
    .use($prose(() => gutterDragPlugin()))
    .use($prose((ctx) => gutterHoverPlugin(ctx)))
    .use($prose((ctx) => dropIndicatorPlugin(ctx)))
    .use($prose(() => handleSelectPlugin()))
    .use($prose(() => rangeDragPlugin()))
    .use($prose(() => selectionReleasePlugin()))
    // Selection changes (and focus) drive the Comment button and what Claude sees as "your selection".
    .use($prose(() => new Plugin({
      view: () => ({ update: (v, prev) => { if (!prev.selection.eq(v.state.selection)) { typeMenu.close(); hooks.selection() } } }),
      props: { handleDOMEvents: { focus: () => { hooks.selection(); return false }, blur: () => { setTimeout(hooks.selection, 150); return false } } },
    })))
  // drop-indicator.js draws the drop line instead (Crepe's keeps its line's state and drawing).
  await crepe.editor.remove(crepeDropIndicator)
  await crepe.editor.remove(wrapInHeadingInputRule) // heading-hashes.js sets the level instead
  await crepe.create()
  crepe.editor.action((ctx) => {
    view = ctx.get(editorViewCtx)
    reviewCtx.schema = ctx.get(schemaCtx)
    reviewCtx.parse = ctx.get(parserCtx)
  })
  reviewCtx.requestRefresh?.()

  // --- Mode ---------------------------------------------------------------
  function currentMode() {
    const mode = settings.get('mode')
    if (MODES.some((m) => m.id === mode)) return mode
    return settings.get('allowDirect') ? 'live' : 'suggest'
  }
  function setMode(mode) {
    ydoc.transact(() => {
      settings.set('mode', mode)
      settings.delete('allowDirect')
    })
  }

  // --- Selection: share it with Claude, offer "Comment" -------------------
  let selectionTimer = 0
  hooks.selection = () => {
    if (!view) return
    const { from, to } = view.state.selection
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
  }
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'm') { e.preventDefault(); startComment() }
    if (e.key === 'Escape' && active && isCompact(margin)) closeOverlay()
  })
  // In a tight window the open panel is an overlay: tapping anywhere else closes it.
  document.addEventListener('pointerdown', (e) => {
    if (!active || !isCompact(margin)) return
    if (e.target.closest?.('.margin, .reviewbar, [data-comment], [data-suggestion]')) return
    closeOverlay()
  })

  /** Shrink the open panel back to its pin; a half-written comment stays in it, an empty one goes. */
  function closeOverlay() {
    if (active === 'composer' && !margin.querySelector('[data-key="composer"]')?.value.trim()) return actions.cancelComment()
    active = null
    render()
    reviewCtx.requestRefresh?.()
  }

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
    active = 'composer'
    // Collapse the selection so the formatting toolbar closes; the marker shows the target instead.
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, to)))
    render()
    reviewCtx.requestRefresh?.()
    margin.querySelector('[data-key="composer"]')?.focus({ preventScroll: isCompact(margin) })
    revealOverlay()
  }

  function saveComment(body) {
    if (!draftAnchor || !body.trim()) return
    const cid = crypto.randomUUID().slice(0, 8)
    comments.set(cid, { id: cid, ...draftAnchor, body: body.trim(), author: 'You', status: 'draft', thread: [], createdAt: new Date().toISOString() })
    draftAnchor = null
    active = cid
    const field = margin.querySelector('[data-key="composer"]')
    if (field) field.value = ''
  }

  function updateComment(cid, patch) {
    const c = comments.get(cid)
    if (c) comments.set(cid, { ...c, ...patch })
  }

  /** The open comment a suggestion resolves, if any: the suggestion is shown in that comment's panel. */
  function linkedComment(sid) {
    const target = suggestions.get(sid)?.resolves
    return target && comments.has(target) && comments.get(target).status !== 'resolved' ? target : null
  }
  const fixesFor = (cid) => [...suggestions.values()].filter((s) => linkedComment(s.id) === cid)

  function focusItem(itemId, scrollText) {
    active = linkedComment(itemId) ?? itemId
    render()
    reviewCtx.requestRefresh?.()
    if (isCompact(margin)) return revealOverlay()
    if (scrollText) {
      const item = suggestions.get(itemId) ?? comments.get(itemId)
      const range = item && view ? rangeOf(item, reviewCtx, view.state) : null
      if (range) {
        const top = view.coordsAtPos(range.from).top + window.scrollY - window.innerHeight / 3
        window.scrollTo({ top, behavior: 'smooth' })
      }
    }
  }

  /**
   * In a tight window, scroll the least that shows the open overlay and the text
   * it belongs to (the text wins if both don't fit), once it has slid into place.
   */
  function revealOverlay() {
    if (!isCompact(margin)) return
    setTimeout(() => {
      const panel = margin.querySelector('.panel.is-active')
      if (!panel) return
      const box = panel.getBoundingClientRect()
      const top = Math.min(box.top, ...[...marksOf(active)].map((node) => node.getBoundingClientRect().top))
      const floor = window.innerHeight - 96 // clear of the review bar
      const ceiling = document.querySelector('.topbar').offsetHeight + 8
      let dy = Math.max(0, box.bottom - floor)
      if (top - dy < ceiling) dy = top - ceiling
      if (dy) window.scrollBy({ top: dy, behavior: 'smooth' })
    }, 200)
  }

  /** An item's marked text in the page: a comment's own and that of the fixes inside it. */
  function marksOf(itemId) {
    if (itemId === 'composer') return editorHost.querySelectorAll('.cmd-comment-draft')
    const ids = [itemId, ...fixesFor(itemId).map((s) => s.id)]
    return editorHost.querySelectorAll(ids.map((i) => `[data-suggestion="${i}"], [data-comment="${i}"]`).join(', '))
  }

  // A comment's panel lights up its text and the text of the fixes inside it.
  function setHot(itemId, on) {
    for (const node of marksOf(itemId)) node.classList.toggle('is-hot', on)
  }

  // --- Rendering ----------------------------------------------------------
  function agentState() {
    for (const [clientId, state] of awareness.getStates()) {
      if (clientId !== ydoc.clientID && state?.agent) return state
    }
    return null
  }

  function renderHeader() {
    const agent = agentState()
    const working = agent?.status && agent.status !== 'idle'
    if (!connected) {
      status.textContent = 'Offline, reconnecting…'
      status.dataset.state = 'offline'
    } else if (working) {
      status.textContent = `Claude is ${(agent.message ?? 'working').toLowerCase()}…`
      status.dataset.state = 'working'
    } else {
      status.textContent = 'Saved'
      status.dataset.state = ''
    }
    claudeName.dataset.working = String(!!working)
    claudeName.dataset.listening = String(!!agent?.watching)
    claudeName.title = agent?.watching ? 'Claude is listening for your review' : ''
    const mode = currentMode()
    for (const button of modeButtons) button.setAttribute('aria-checked', String(button.dataset.mode === mode))
    placeModeThumb()
  }

  function placeModeThumb() {
    const chosen = modeButtons.find((b) => b.getAttribute('aria-checked') === 'true')
    if (!chosen) return
    modeThumb.style.transform = `translateX(${chosen.offsetLeft}px)`
    modeThumb.style.width = `${chosen.offsetWidth}px`
    // Appear in place on first paint; slide only on later changes.
    if (!modeThumb.dataset.ready) requestAnimationFrame(() => { modeThumb.dataset.ready = 'true' })
  }

  /** Items in document order, so panels stack the way the text reads. */
  function marginItems() {
    const pos = (data) => (view ? rangeOf(data, reviewCtx, view.state)?.from ?? Infinity : 0)
    const withAnchor = (s) => ({ ...s, anchorLost: pos(s) === Infinity })
    const items = []
    for (const s of suggestions.values()) if (!linkedComment(s.id)) items.push({ id: s.id, type: 'suggestion', data: withAnchor(s) })
    for (const c of comments.values()) {
      if (c.status !== 'resolved') items.push({ id: c.id, type: 'comment', data: { ...c, fixes: fixesFor(c.id).map(withAnchor) } })
    }
    if (draftAnchor) items.push({ id: 'composer', type: 'composer', data: draftAnchor })
    for (const item of items) item.pos = pos(item.data)
    return items.sort((a, b) => a.pos - b.pos)
  }

  function relayout() {
    if (!view) return
    const base = margin.getBoundingClientRect().top
    const tops = new Map()
    for (const panel of margin.querySelectorAll('.panel')) {
      const pid = panel.dataset.id
      const item = pid === 'composer' ? draftAnchor : suggestions.get(pid) ?? comments.get(pid)
      const range = item ? rangeOf(item, reviewCtx, view.state) : null
      if (range) tops.set(pid, view.coordsAtPos(range.from).top - base - 8)
    }
    layoutMargin(margin, tops, active)
    // In a tight window the open panel overlays the page: drop it below all of its text.
    const open = active && isCompact(margin) ? margin.querySelector('.panel.is-active') : null
    if (open) {
      let bottom = -Infinity
      for (const node of marksOf(active)) for (const rect of node.getClientRects()) bottom = Math.max(bottom, rect.bottom)
      if (bottom > -Infinity) open.style.setProperty('--drop', `${bottom - base - parseFloat(open.style.top) + 6}px`)
    }
  }

  /**
   * Open items by whose turn it is, each in document order: "you" for Claude's
   * suggestions and for comments it has replied to or proposed a fix for,
   * "claude" while the last word on a comment is yours.
   */
  function reviewGroups() {
    const groups = { you: [], claude: [], draft: [] }
    for (const item of marginItems()) {
      if (item.type === 'suggestion') groups.you.push(item.id)
      if (item.type !== 'comment') continue
      const c = item.data
      if (c.status === 'draft') groups.draft.push(c.id)
      else if (c.fixes.length || c.thread?.at(-1)?.author === 'Claude') groups.you.push(c.id)
      else groups.claude.push(c.id)
    }
    return groups
  }

  /** Step to the next item in a group, wrapping after the last. */
  function jumpTo(ids) {
    const next = ids[(ids.indexOf(active) + 1) % ids.length]
    focusItem(next, true)
  }

  function renderBar() {
    const pending = suggestions.size
    const { you, claude, draft } = reviewGroups()
    const listening = !!agentState()?.watching
    bar.hidden = pending + you.length + claude.length + draft.length === 0
    const dot = (kind) => el('span', { class: `dot ${kind}`, 'aria-hidden': 'true' })
    // "3 with you" reads "1 of 3 with you" while you step through them.
    const at = you.indexOf(active)
    const counts = [
      you.length
        ? el('button', { type: 'button', class: `count${at >= 0 ? ' is-current' : ''}`, title: 'Claude’s suggestions, replies and fixes', onclick: () => jumpTo(you) },
          dot('you'), `${at >= 0 && you.length > 1 ? `${at + 1} of ${you.length}` : you.length} with you`)
        : null,
      // Whether Claude is listening shows in the dot; the top bar says it in words.
      claude.length
        ? el('span', { class: 'count', title: listening ? 'Claude is listening and will pick these up' : 'Claude isn’t listening: tell it “review’s in”' },
          dot(listening ? 'claude' : 'idle'), `${claude.length} with Claude`)
        : null,
    ].filter(Boolean)
    bar.replaceChildren(...[
      ...counts.flatMap((c, i) => (i ? [el('span', { class: 'sep', 'aria-hidden': 'true' }), c] : [c])),
      pending > 1 ? el('button', { type: 'button', onclick: acceptAll }, 'Accept all') : null,
      draft.length
        ? el('button', {
          type: 'button',
          class: 'submit',
          title: listening ? 'Claude is listening and will pick these up straight away' : 'Claude isn’t listening: tell it “review’s in” after submitting',
          onclick: submitReview,
        }, `Submit ${draft.length} comment${draft.length === 1 ? '' : 's'}`)
        : null,
    ].filter(Boolean))
  }

  async function acceptAll() {
    const result = await api('accept-all')
    if (result.failed?.length) toast(`${result.failed.length} couldn’t be applied because their text has changed.`)
  }

  async function submitReview() {
    await api('submit-review', {})
    toast(agentState()?.watching ? 'Review sent. Claude is on it.' : 'Review submitted. Tell Claude “review’s in” to pick it up.')
  }

  const actions = {
    accept: (sid) => api('accept', { id: sid }),
    reject: (sid) => api('reject', { id: sid }),
    saveComment,
    cancelComment: () => { draftAnchor = null; active = null; render(); reviewCtx.requestRefresh?.() },
    editComment: (cid, body) => updateComment(cid, { body }),
    deleteComment: (cid) => comments.delete(cid),
    reply: async (cid, body) => {
      await api('reply', { id: cid, body })
      if (!agentState()?.watching) toast('Reply sent. Claude isn’t listening: tell it “review’s in” to pick it up.')
    },
    resolve: (cid) => api('resolve', { id: cid }),
    reopen: (cid) => updateComment(cid, { status: 'submitted' }),
  }

  function render() {
    renderHeader()
    renderMargin(margin, {
      items: marginItems(),
      active,
      actions,
      relayout,
      onHover: setHot,
      onFocus: (itemId) => focusItem(itemId, true),
    })
    renderBar()
    relayout()
  }

  // Redraw on the next frame: Yjs observers fire before the editor has applied
  // the same update, and positions resolve against the editor's state.
  let renderFrame = 0
  const scheduleRender = () => {
    cancelAnimationFrame(renderFrame)
    renderFrame = requestAnimationFrame(render)
  }
  for (const map of [suggestions, comments, settings]) map.observe(scheduleRender)
  // Awareness also carries your own selection; only redraw when Claude's state changes.
  let lastAgent = ''
  awareness.on('change', () => {
    const key = JSON.stringify(agentState())
    if (key !== lastAgent) { lastAgent = key; renderHeader(); renderBar() }
  })
  window.addEventListener('resize', () => {
    // Panels change width with the window, so their fields rewrap.
    for (const field of margin.querySelectorAll('.field')) autosize(field)
    relayout()
    placeModeThumb()
  })
  document.fonts?.ready.then(() => { relayout(); placeModeThumb() })
  // Relative times ("2m") age.
  setInterval(scheduleRender, 60_000)
  render()
}
