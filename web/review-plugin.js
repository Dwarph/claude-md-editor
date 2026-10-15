// Draws Claude's pending suggestions (grey removed text, green added text),
// review comment highlights (marker fill) and the brief tint on Claude's
// Edit live changes over the live document. Accept/reject live in the margin
// panels; elements here carry data-suggestion / data-comment so panels and
// text can highlight each other.
// Anchors live in Yjs maps, so positions are resolved through the y-prosemirror
// binding's mapping on each refresh and mapped through local edits in between.
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { DOMSerializer } from '@milkdown/kit/prose/model'
import { ySyncPluginKey } from 'y-prosemirror'
import { resolveRange } from '../shared/positions.js'

export const reviewKey = new PluginKey('cmd-review')

const RECENT_MS = 4500

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
 * ctx: { ydoc, fragment, suggestions, comments, recent, schema, parse, activeComment(), onCommentClick(id), onSuggestionClick(id) }
 */
export function reviewPlugin(ctx) {
  function renderMarkdown(markdown, inline) {
    const wrap = document.createElement(inline ? 'span' : 'div')
    if (!markdown.trim()) return wrap
    try {
      const doc = ctx.parse(markdown)
      const content = inline && doc.childCount === 1 && doc.firstChild.isTextblock ? doc.firstChild.content : doc.content
      wrap.appendChild(DOMSerializer.fromSchema(ctx.schema).serializeFragment(content))
    } catch {
      wrap.textContent = markdown
    }
    return wrap
  }

  const insertion = (s, inline) => () => {
    const el = renderMarkdown(s.markdown, inline)
    el.className = inline ? 'cmd-ins' : 'cmd-ins-block'
    el.dataset.suggestion = s.id
    el.contentEditable = 'false'
    return el
  }

  let nextExpiry = null

  function build(state) {
    const decos = []
    for (const s of ctx.suggestions.values()) {
      const range = rangeOf(s, ctx, state)
      if (!range) continue
      const spec = { key: `sg-${s.id}-${s.markdown.length}`, ignoreSelection: true, stopEvent: () => false }
      if (s.kind === 'inline') {
        if (range.from < range.to) decos.push(Decoration.inline(range.from, range.to, { class: 'cmd-del', 'data-suggestion': s.id }))
        if (s.markdown) decos.push(Decoration.widget(range.to, insertion(s, true), { ...spec, side: 1 }))
      } else {
        state.doc.forEach((node, offset) => {
          if (offset >= range.from && offset + node.nodeSize <= range.to) {
            decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'cmd-del-block', 'data-suggestion': s.id }))
          }
        })
        if (s.markdown.trim()) decos.push(Decoration.widget(range.to, insertion(s, false), { ...spec, side: -1 }))
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

    // The text a comment is being written for, while the composer is open.
    const composing = ctx.composing?.()
    const target = composing ? rangeOf(composing, ctx, state) : null
    if (target && target.from < target.to) {
      decos.push(Decoration.inline(target.from, target.to, { class: 'cmd-comment cmd-comment-draft is-active' }))
    }

    nextExpiry = null
    const now = Date.now()
    for (const r of ctx.recent.values()) {
      const left = r.at + RECENT_MS - now
      if (left <= 0) continue
      const range = rangeOf(r, ctx, state)
      if (!range || range.from === range.to) continue
      decos.push(Decoration.inline(range.from, range.to, { class: 'cmd-recent' }, { key: `recent-${r.id}` }))
      nextExpiry = Math.min(nextExpiry ?? Infinity, left)
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
      handleClick(_view, _pos, event) {
        const target = event.target.closest?.('[data-comment], [data-suggestion]')
        if (target?.dataset.comment) ctx.onCommentClick(target.dataset.comment)
        else if (target?.dataset.suggestion) ctx.onSuggestionClick(target.dataset.suggestion)
        return false
      },
    },
    view(view) {
      let frame = 0
      let expiryTimer = 0
      const refresh = () => {
        cancelAnimationFrame(frame)
        // Next frame: by then the sync binding has updated its Y<->PM mapping.
        frame = requestAnimationFrame(() => {
          if (view.isDestroyed) return
          view.dispatch(view.state.tr.setMeta(reviewKey, 'refresh').setMeta('addToHistory', false))
          clearTimeout(expiryTimer)
          if (nextExpiry !== null) expiryTimer = setTimeout(refresh, nextExpiry + 50)
          ctx.afterRefresh?.()
        })
      }
      ctx.suggestions.observe(refresh)
      ctx.comments.observe(refresh)
      ctx.recent.observe(refresh)
      ctx.requestRefresh = refresh
      refresh()
      return {
        update(v, prev) {
          if (!prev.doc.eq(v.state.doc)) refresh()
        },
        destroy() {
          cancelAnimationFrame(frame)
          clearTimeout(expiryTimer)
          ctx.suggestions.unobserve(refresh)
          ctx.comments.unobserve(refresh)
          ctx.recent.unobserve(refresh)
        },
      }
    },
  })
}
