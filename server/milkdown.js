// Headless Milkdown: the same schema, markdown parser and serializer the
// browser editor uses, running in Node so the server can apply agent edits.
// linkedom provides just enough DOM for Milkdown to start; it is far lighter
// than jsdom, which matters for how fast a freshly installed plugin starts.
import { parseHTML } from 'linkedom'
import { REMARK_STRINGIFY_OPTIONS } from '../shared/markdown-options.js'

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>')
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'DOMParser']) {
  if (!(key in globalThis) && window[key] !== undefined) globalThis[key] = window[key]
}
globalThis.window ??= window
// linkedom has no selection API, and ProseMirror's view reads one when it syncs. Nothing ever
// selects in this DOM, so an empty selection is accurate.
const noSelection = {
  rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0, isCollapsed: true,
  getRangeAt: () => null, removeAllRanges() {}, addRange() {}, collapse() {}, extend() {},
}
document.getSelection = () => noSelection
window.getSelection = () => noSelection
// ProseMirror only checks white-space here; its own CSS sets pre-wrap.
globalThis.getComputedStyle = window.getComputedStyle = () => ({ whiteSpace: 'pre-wrap', getPropertyValue: () => '' })
// Milkdown's ctx timers listen on the global event target.
const events = new EventTarget()
for (const method of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
  globalThis[method] ??= events[method].bind(events)
}

// Imported after the DOM shims above exist.
const { Editor, rootCtx, schemaCtx, parserCtx, serializerCtx, editorViewCtx, remarkStringifyOptionsCtx } = await import('@milkdown/kit/core')
const { commonmark } = await import('@milkdown/kit/preset/commonmark')
const { gfm } = await import('@milkdown/kit/preset/gfm')

const editor = await Editor.make()
  .config((ctx) => {
    ctx.set(rootCtx, document.getElementById('root'))
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({ ...prev, ...REMARK_STRINGIFY_OPTIONS }))
  })
  .use(commonmark)
  .use(gfm)
  .create()

export const schema = editor.ctx.get(schemaCtx)
const parser = editor.ctx.get(parserCtx)
const serializer = editor.ctx.get(serializerCtx)
// Only the schema, parser and serializer are used; the view would watch a DOM nobody edits.
editor.ctx.get(editorViewCtx).destroy()

/** Markdown string -> ProseMirror doc node. */
export function parseMarkdown(markdown) {
  return parser(markdown ?? '')
}

/** ProseMirror doc node -> markdown string. */
export function serializeDoc(doc) {
  return serializer(doc)
}

/** Serialize a list of top-level block nodes as their own markdown. */
export function serializeBlocks(nodes) {
  return serializer(schema.topNodeType.create(null, nodes)).trim()
}

/**
 * Parse markdown meant to sit inline (inside one paragraph or heading).
 * Returns a Fragment of inline nodes, or null if the markdown is block-level.
 */
export function parseInline(markdown) {
  if (markdown === '') return schema.topNodeType.create(null, []).content
  const doc = parser(markdown)
  if (doc.childCount !== 1 || doc.firstChild.type.name !== 'paragraph') return null
  return doc.firstChild.content
}
