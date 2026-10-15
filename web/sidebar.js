// The review sidebar: Claude's pending suggestions, your comments (draft,
// sent, resolved) with their threads, and "Submit review".

/** Tiny DOM helper: el('div', { class: 'x', onclick }, ...children) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key === 'value') node.value = value
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : String(child))
  }
  return node
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return new Date(iso).toLocaleDateString()
}

/** Re-render while keeping what's typed in any field (fields carry data-key). */
function preserveFields(root, draw) {
  const values = new Map()
  for (const field of root.querySelectorAll('[data-key]')) values.set(field.dataset.key, field.value)
  const focused = document.activeElement?.closest?.('[data-key]')
  const focusKey = root.contains(focused) ? focused.dataset.key : null
  const caret = focusKey ? [focused.selectionStart, focused.selectionEnd] : null
  const scroll = root.scrollTop
  draw()
  for (const field of root.querySelectorAll('[data-key]')) {
    if (values.has(field.dataset.key) && !field.dataset.fresh) field.value = values.get(field.dataset.key)
  }
  if (focusKey) {
    const field = root.querySelector(`[data-key="${focusKey}"]`)
    field?.focus()
    if (field && caret) field.setSelectionRange(...caret)
  }
  root.scrollTop = scroll
}

function submitOnCtrlEnter(handler) {
  return (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); handler() }
    if (e.key === 'Escape') e.target.blur()
  }
}

export function renderSidebar(root, model) {
  preserveFields(root, () => root.replaceChildren(...sections(model).filter(Boolean)))
}

function sections(model) {
  const { suggestions, comments, actions } = model
  const drafts = comments.filter((c) => c.status === 'draft')
  const open = comments.filter((c) => c.status === 'submitted')
  const resolved = comments.filter((c) => c.status === 'resolved')
  return [
    reviewBox(model, drafts),
    model.draftAnchor ? composer(model) : null,
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' },
        el('h2', {}, 'Suggestions', el('span', { class: 'count' }, suggestions.length)),
        suggestions.length > 1 && el('div', { class: 'row' },
          el('button', { class: 'btn small', onclick: actions.acceptAll }, 'Accept all'),
          el('button', { class: 'btn small ghost', onclick: actions.rejectAll }, 'Reject all'))),
      suggestions.length
        ? suggestions.map((s) => suggestionCard(s, actions))
        : el('p', { class: 'empty' }, "Claude's edits show up here and in the text, for you to accept or reject.")),
    el('section', { class: 'panel' },
      el('div', { class: 'panel-head' }, el('h2', {}, 'Comments', el('span', { class: 'count' }, drafts.length + open.length))),
      drafts.length + open.length === 0 && !model.draftAnchor
        ? el('p', { class: 'empty' }, 'Select text and press 💬 Comment (Ctrl+Alt+M) to leave a note for Claude, like a code review.')
        : null,
      [...drafts, ...open].map((c) => commentCard(c, model)),
      resolved.length
        ? el('details', { class: 'resolved' },
          el('summary', {}, `Resolved (${resolved.length})`),
          resolved.map((c) => commentCard(c, model)))
        : null),
  ]
}

function reviewBox(model, drafts) {
  const { actions } = model
  const note = el('textarea', { 'data-key': 'review-note', rows: 2, placeholder: 'Overall note for Claude (optional)' })
  const submit = () => {
    actions.submitReview(note.value).then(() => { note.value = ''; note.dataset.fresh = '1' })
  }
  note.addEventListener('keydown', submitOnCtrlEnter(submit))
  return el('section', { class: 'panel review-box' },
    el('div', { class: 'panel-head' }, el('h2', {}, 'Review')),
    el('p', { class: 'hint' },
      drafts.length ? `${plural(drafts.length, 'draft comment')} ready to send.` : 'Comments stay drafts until you submit them together.',
      ' ',
      model.agentWatching ? el('span', { class: 'ok' }, 'Claude will be notified.') : el('span', { class: 'muted' }, "Claude isn't listening: after submitting, tell it \"review's in\".")),
    note,
    el('button', { class: 'btn primary', onclick: submit, disabled: drafts.length === 0 ? undefined : undefined }, drafts.length ? `Submit review (${drafts.length})` : 'Submit review'))
}

function composer(model) {
  const { actions, draftAnchor } = model
  const body = el('textarea', { 'data-key': 'composer', rows: 3, placeholder: 'What should Claude change or explain?' })
  const save = () => actions.saveComment(body.value)
  body.addEventListener('keydown', submitOnCtrlEnter(save))
  return el('section', { class: 'panel composer' },
    el('blockquote', { class: 'quote' }, draftAnchor.quote),
    body,
    el('div', { class: 'row' },
      el('button', { class: 'btn primary small', onclick: save }, 'Add comment'),
      el('button', { class: 'btn ghost small', onclick: actions.cancelComment }, 'Cancel'),
      el('span', { class: 'muted small' }, 'Ctrl+Enter')))
}

function suggestionCard(s, actions) {
  const before = s.original?.trim()
  const after = s.markdown?.trim()
  const what = !before ? 'Insert' : !after ? 'Delete' : 'Replace'
  return el('article', { class: 'card suggestion', 'data-card': s.id },
    el('div', { class: 'card-head' },
      el('span', { class: `tag tag-${what.toLowerCase()}` }, what),
      el('span', { class: 'muted small' }, timeAgo(s.createdAt)),
      el('button', { class: 'link small', onclick: () => actions.showSuggestion(s.id) }, 'Show')),
    s.note ? el('p', { class: 'note' }, s.note) : null,
    before ? el('pre', { class: 'diff del' }, before) : null,
    after ? el('pre', { class: 'diff ins' }, after) : null,
    el('div', { class: 'row' },
      el('button', { class: 'btn small accept', onclick: () => actions.accept(s.id) }, '✓ Accept'),
      el('button', { class: 'btn small ghost', onclick: () => actions.reject(s.id) }, '✕ Reject')))
}

function commentCard(c, model) {
  const { actions } = model
  const isDraft = c.status === 'draft'
  const status = isDraft ? 'Draft' : c.status === 'submitted' ? 'Sent to Claude' : `Resolved${c.resolvedBy ? ` by ${c.resolvedBy}` : ''}`
  const card = el('article', {
    class: `card comment comment-${c.status}${model.activeComment === c.id ? ' is-active' : ''}`,
    'data-card': c.id,
    onclick: (e) => { if (!e.target.closest('button, textarea, summary')) actions.focusComment(c.id) },
  },
  el('div', { class: 'card-head' },
    el('span', { class: `tag tag-${c.status}` }, status),
    el('span', { class: 'muted small' }, timeAgo(c.createdAt))),
  c.quote ? el('blockquote', { class: 'quote' }, c.quote) : null)

  if (isDraft) {
    const body = el('textarea', { 'data-key': `edit-${c.id}`, rows: 2, value: c.body })
    body.addEventListener('change', () => actions.editComment(c.id, body.value))
    card.append(body, el('div', { class: 'row' }, el('button', { class: 'link small danger', onclick: () => actions.deleteComment(c.id) }, 'Delete')))
    return card
  }

  card.append(el('div', { class: 'msg' }, el('span', { class: 'who' }, 'You'), el('p', {}, c.body)))
  for (const m of c.thread ?? []) {
    card.append(el('div', { class: `msg${m.author === 'Claude' ? ' from-claude' : ''}` }, el('span', { class: 'who' }, m.author), el('p', {}, m.body)))
  }
  if (c.status === 'submitted') {
    const reply = el('textarea', { 'data-key': `reply-${c.id}`, rows: 1, placeholder: 'Reply…' })
    const send = () => reply.value.trim() && actions.reply(c.id, reply.value.trim()).then(() => { reply.value = ''; reply.dataset.fresh = '1' })
    reply.addEventListener('keydown', submitOnCtrlEnter(send))
    card.append(reply, el('div', { class: 'row' },
      el('button', { class: 'btn small', onclick: send }, 'Reply'),
      el('button', { class: 'btn small ghost', onclick: () => actions.resolve(c.id) }, 'Resolve')))
  } else {
    card.append(el('div', { class: 'row' }, el('button', { class: 'link small', onclick: () => actions.reopen(c.id) }, 'Reopen')))
  }
  return card
}
