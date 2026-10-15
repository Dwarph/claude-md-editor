// Draws the agent's pending suggestions (strikethrough + green insert with
// accept/reject) and review comment highlights over the live document.
// Anchors live in Yjs maps, so positions are resolved through the y-prosemirror
// binding's mapping on each refresh and mapped through local edits in between.
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { DOMSerializer } from '@milkdown/kit/prose/model'
import { ySyncPluginKey } from 'y-prosemirror'
import { resolveRange } from '../shared/positions.js'

export const reviewKey = new PluginKey('cmd-review')

export function bindingMapping(state) {
  return ySyncPluginKey.getState(state)?.binding?.mapping ?? null
}

/** Resolve an anchored item to a range inside `doc`, or null. */
export function rangeOf(item, ctx, state) {
  const mapping = bindingMapping(state)
  if (!mapping) return null
  const range = resolveRange(item, ctx.ydoc, ctx.fragment, mapping)
  if (!range) return null
  const max = state.doc.content.size
  return { from: Math.min(range.from, max), to: Math.min(range.to, max) }
}

/**
 * ctx: { ydoc, fragment, suggestions, comments, schema, parse, onAccept, onReject, onCommentClick, activeComment() }
 */
export function reviewPlugin(ctx) {
  const serializer = () => DOMSerializer.fromSchema(ctx.schema)

  function renderMarkdown(markdown, inline) {
    const wrap = document.createElement(inline ? 'span' : 'div')
    if (!markdown.trim()) return wrap
    try {
      const doc = ctx.parse(markdown)
      const content = inline && doc.childCount === 1 && doc.firstChild.isTextblock ? doc.firstChild.content : doc.content
      wrap.appendChild(serializer().serializeFragment(content))
    } catch {
      wrap.textContent = markdown
    }
    return wrap
  }

  function controls(s, block) {
    const box = document.createElement('span')
    box.className = `milkdown-diff-controls cmd-controls${block ? ' milkdown-diff-controls-block' : ''}`
    box.contentEditable = 'false'
    const accept = document.createElement('button')
    accept.className = 'milkdown-diff-accept'
    accept.type = 'button'
    accept.title = 'Accept suggestion'
    accept.textContent = '✓'
    accept.addEventListener('mousedown', (e) => { e.preventDefault(); ctx.onAccept(s.id) })
    const reject = document.createElement('button')
    reject.className = 'milkdown-diff-reject'
    reject.type = 'button'
    reject.title = 'Reject suggestion'
    reject.textContent = '✕'
    reject.addEventListener('mousedown', (e) => { e.preventDefault(); ctx.onReject(s.id) })
    box.append(accept, reject)
    if (s.note) {
      const note = document.createElement('span')
      note.className = 'cmd-note'
      note.textContent = s.note
      box.append(note)
    }
    return box
  }

  function inlineWidget(s) {
    return () => {
      const el = renderMarkdown(s.markdown, true)
      el.className = s.markdown ? 'milkdown-diff-added cmd-insert' : 'cmd-insert cmd-insert-empty'
      el.dataset.suggestion = s.id
      el.contentEditable = 'false'
      el.append(controls(s, false))
      return el
    }
  }

  function blockWidget(s) {
    return () => {
      const el = renderMarkdown(s.markdown, false)
      el.className = s.markdown.trim() ? 'milkdown-diff-added-block cmd-insert-block' : 'cmd-insert-block cmd-insert-empty'
      el.dataset.suggestion = s.id
      el.contentEditable = 'false'
      el.append(controls(s, true))
      return el
    }
  }

  function build(state) {
    const decos = []
    for (const s of ctx.suggestions.values()) {
      const range = rangeOf(s, ctx, state)
      if (!range) continue
      const key = `sg-${s.id}-${s.markdown.length}-${s.note?.length ?? 0}`
      const spec = { key, ignoreSelection: true, stopEvent: () => true }
      if (s.kind === 'inline') {
        if (range.from < range.to) decos.push(Decoration.inline(range.from, range.to, { class: 'milkdown-diff-removed', 'data-suggestion': s.id }))
        decos.push(Decoration.widget(range.to, inlineWidget(s), { ...spec, side: 1 }))
      } else {
        state.doc.forEach((node, offset) => {
          if (offset >= range.from && offset + node.nodeSize <= range.to) {
            decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'milkdown-diff-removed-block', 'data-suggestion': s.id }))
          }
        })
        decos.push(Decoration.widget(range.to, blockWidget(s), { ...spec, side: -1 }))
      }
    }
    const active = ctx.activeComment()
    for (const c of ctx.comments.values()) {
      if (c.status === 'resolved') continue
      const range = rangeOf(c, ctx, state)
      if (!range || range.from === range.to) continue
      const cls = `cmd-comment cmd-comment-${c.status}${c.id === active ? ' is-active' : ''}`
      decos.push(Decoration.inline(range.from, range.to, { class: cls, 'data-comment': c.id }))
    }
    return DecorationSet.create(state.doc, decos)
  }

  return new Plugin({
    key: reviewKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, decos, _old, state) {
        if (tr.getMeta(reviewKey) === 'refresh') return build(state)
        return decos.map(tr.mapping, tr.doc)
      },
    },
    props: {
      decorations: (state) => reviewKey.getState(state),
      handleClick(view, _pos, event) {
        const id = event.target.closest?.('[data-comment]')?.dataset.comment
        if (id) ctx.onCommentClick(id)
        return false
      },
    },
    view(view) {
      let frame = 0
      const refresh = () => {
        cancelAnimationFrame(frame)
        // Next frame: by then the sync binding has updated its Y<->PM mapping.
        frame = requestAnimationFrame(() => {
          if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(reviewKey, 'refresh').setMeta('addToHistory', false))
        })
      }
      ctx.suggestions.observe(refresh)
      ctx.comments.observe(refresh)
      ctx.requestRefresh = refresh
      refresh()
      return {
        update(view, prev) {
          if (!prev.doc.eq(view.state.doc)) refresh()
        },
        destroy() {
          cancelAnimationFrame(frame)
          ctx.suggestions.unobserve(refresh)
          ctx.comments.unobserve(refresh)
        },
      }
    },
  })
}
