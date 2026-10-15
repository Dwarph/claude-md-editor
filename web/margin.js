// The right margin: one lifted panel per pending suggestion, review comment
// and new-comment composer, each lined up with the text it belongs to.

/** Tiny DOM helper: el('div', { class: 'x', onclick }, ...children) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else if (key === 'value') node.value = value
    else if (key === 'html') node.innerHTML = value
    else node.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : String(child))
  }
  return node
}

export const ICONS = {
  check: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>',
  cross: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>',
  resolve: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="5.75"/><path d="M5.6 8.2l1.7 1.7 3.1-3.6"/></svg>',
  reopen: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.5-3.6"/><path d="M3 2.75V5.5h2.75"/></svg>',
  comment: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>',
}

const PANEL_GAP = 10

const glyph = (icon, label, onclick, cls = '') =>
  el('button', { type: 'button', class: `glyph ${cls}`, 'aria-label': label, title: label, onclick, html: ICONS[icon] })

export function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

const clip = (text, max = 48) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function describe(s) {
  const before = s.original?.trim()
  const after = s.markdown?.trim()
  if (!before) return 'Adds new text.'
  if (!after) return `Removes “${clip(before)}”.`
  return `Replaces “${clip(before)}”.`
}

/** Grow a textarea to fit its text. */
export function autosize(field) {
  field.style.height = 'auto'
  field.style.height = `${field.scrollHeight}px`
}

function textField(key, { value, placeholder, rows = 1, label, onsubmit, onchange, oninput }) {
  const field = el('textarea', { class: 'field', 'data-key': key, rows, placeholder, value, 'aria-label': label })
  field.addEventListener('input', () => { autosize(field); oninput?.() })
  if (onchange) field.addEventListener('change', () => onchange(field.value))
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); field.blur() }
    // Enter sends a reply; the composer and drafts send on Ctrl/Cmd+Enter so Enter can add lines.
    const send = rows === 1 ? e.key === 'Enter' && !e.shiftKey : e.key === 'Enter' && (e.ctrlKey || e.metaKey)
    if (send && onsubmit) { e.preventDefault(); onsubmit(field) }
  })
  return field
}

function suggestionPanel(s, model) {
  const { actions } = model
  return el('aside', { class: 'panel', 'data-id': s.id, 'aria-label': 'Suggestion from Claude' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'who claude' }, 'Claude'),
      el('span', { class: 'when' }, timeAgo(s.createdAt)),
      el('span', { class: 'actions' },
        s.anchorLost ? null : glyph('check', 'Accept suggestion', () => actions.accept(s.id), 'accept'),
        glyph('cross', 'Reject suggestion', () => actions.reject(s.id), 'quiet'))),
    el('p', {}, s.note || describe(s)),
    s.anchorLost ? el('p', { class: 'meta' }, 'The text it changes is gone.') : null)
}

function commentPanel(c, model) {
  const { actions } = model
  if (c.status === 'draft') {
    return el('aside', { class: 'panel', 'data-id': c.id, 'aria-label': 'Draft comment' },
      el('div', { class: 'panel-head' },
        el('span', { class: 'who' }, 'You'),
        el('span', { class: 'when' }, 'Draft'),
        el('span', { class: 'actions' }, glyph('cross', 'Delete draft', () => actions.deleteComment(c.id), 'quiet'))),
      textField(`edit-${c.id}`, { value: c.body, rows: 2, label: 'Comment', onchange: (v) => actions.editComment(c.id, v), oninput: model.relayout }),
      el('div', { class: 'panel-foot' }, el('span', { class: 'hint' }, 'Sent when you submit your review')))
  }
  const panel = el('aside', { class: 'panel', 'data-id': c.id, 'aria-label': 'Comment thread' },
    el('div', { class: 'panel-head' },
      el('span', { class: 'who' }, 'You'),
      el('span', { class: 'when' }, timeAgo(c.createdAt)),
      el('span', { class: 'actions' },
        c.status === 'resolved'
          ? glyph('reopen', 'Reopen comment', () => actions.reopen(c.id), 'quiet')
          : glyph('resolve', 'Resolve comment', () => actions.resolve(c.id)))),
    el('p', {}, c.body))
  if (c.thread?.length) {
    panel.append(el('div', { class: 'thread' }, c.thread.map((m) => el('div', {}, m.author === 'Claude' ? el('span', { class: 'who claude' }, 'Claude') : el('span', { class: 'who' }, 'You'), el('p', {}, m.body)))))
  }
  if (c.status !== 'resolved') {
    panel.append(textField(`reply-${c.id}`, {
      placeholder: 'Reply',
      label: 'Reply',
      oninput: model.relayout,
      onsubmit: (field) => {
        const body = field.value.trim()
        if (body) actions.reply(c.id, body).then(() => { field.value = '' })
      },
    }))
  }
  return panel
}

function composerPanel(model) {
  const { actions } = model
  const field = textField('composer', {
    rows: 2,
    placeholder: 'Comment for Claude',
    label: 'New comment',
    oninput: model.relayout,
    onsubmit: (f) => actions.saveComment(f.value),
  })
  return el('aside', { class: 'panel is-active', 'data-id': 'composer', 'aria-label': 'New comment' },
    el('div', { class: 'panel-head' }, el('span', { class: 'who' }, 'You'), el('span', { class: 'when' }, 'New comment')),
    field,
    el('div', { class: 'panel-foot' },
      el('button', { type: 'button', class: 'btn primary', onclick: () => actions.saveComment(field.value) }, 'Comment'),
      el('button', { type: 'button', class: 'btn', onclick: actions.cancelComment }, 'Cancel'),
      el('span', { class: 'hint' }, 'Ctrl+Enter')))
}

/** Re-render while keeping what's typed in any field (fields carry data-key). */
function preserveFields(root, draw) {
  const values = new Map()
  for (const field of root.querySelectorAll('[data-key]')) values.set(field.dataset.key, field.value)
  const focused = document.activeElement?.closest?.('[data-key]')
  const focusKey = root.contains(focused) ? focused.dataset.key : null
  const caret = focusKey ? [focused.selectionStart, focused.selectionEnd] : null
  draw()
  for (const field of root.querySelectorAll('[data-key]')) {
    if (values.has(field.dataset.key)) field.value = values.get(field.dataset.key)
    autosize(field)
  }
  if (focusKey) {
    const field = root.querySelector(`[data-key="${focusKey}"]`)
    field?.focus()
    if (field && caret) field.setSelectionRange(...caret)
  }
}

/**
 * model: { items: [{ id, type: 'suggestion'|'comment'|'composer', data }], active, actions, relayout, onHover(id, on), onFocus(id) }
 */
export function renderMargin(root, model) {
  preserveFields(root, () => {
    const panels = model.items.map((item) => {
      const panel = item.type === 'composer' ? composerPanel(model)
        : item.type === 'suggestion' ? suggestionPanel(item.data, model)
          : commentPanel(item.data, model)
      if (item.id === model.active) panel.classList.add('is-active')
      panel.addEventListener('mouseenter', () => model.onHover(item.id, true))
      panel.addEventListener('mouseleave', () => model.onHover(item.id, false))
      panel.addEventListener('click', (e) => {
        if (!e.target.closest('button, textarea, input')) model.onFocus(item.id)
      })
      return panel
    })
    root.replaceChildren(...panels)
  })
}

/**
 * Line panels up with their text. tops: Map id -> desired top (px within root), or
 * undefined to place after the others. The active panel sits exactly at its
 * text; the rest stack around it without overlapping.
 */
export function layoutMargin(root, tops, active) {
  const panels = [...root.querySelectorAll('.panel')]
  if (getComputedStyle(panels[0] ?? root).position !== 'absolute') return // narrow layout: panels flow
  const placed = panels.map((panel) => ({ panel, want: tops.get(panel.dataset.id), height: panel.offsetHeight }))
  let last = 0
  for (const p of placed) {
    if (p.want === undefined) p.want = last
    last = Math.max(last, p.want + p.height + PANEL_GAP)
  }
  placed.sort((a, b) => a.want - b.want)
  let pivot = placed.findIndex((p) => p.panel.dataset.id === active)
  if (pivot === -1) pivot = 0
  placed[pivot].top = Math.max(0, placed[pivot].want)
  for (let i = pivot + 1; i < placed.length; i++) {
    const prev = placed[i - 1]
    placed[i].top = Math.max(placed[i].want, prev.top + prev.height + PANEL_GAP)
  }
  for (let i = pivot - 1; i >= 0; i--) {
    const next = placed[i + 1]
    placed[i].top = Math.min(placed[i].want, next.top - placed[i].height - PANEL_GAP)
  }
  // Nothing may rise above the top of the margin: push down from there.
  const shift = Math.max(0, -Math.min(...placed.map((p) => p.top)))
  let bottom = 0
  for (const p of placed) {
    p.panel.style.top = `${p.top + shift}px`
    bottom = Math.max(bottom, p.top + shift + p.height)
  }
  root.style.minHeight = `${bottom}px`
}
