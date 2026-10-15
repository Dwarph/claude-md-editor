// Headless Milkdown: the same schema, markdown parser and serializer the
// browser editor uses, running in Node so the server can apply agent edits.
import { JSDOM } from 'jsdom'
import { REMARK_STRINGIFY_OPTIONS } from '../shared/markdown-options.js'

const dom = new JSDOM('<!doctype html><div id="root"></div>')
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'MutationObserver', 'getComputedStyle', 'DOMParser']) {
  if (!(key in globalThis)) globalThis[key] = dom.window[key] ?? dom.window
}
// Milkdown's ctx timers listen on the global event target.
const events = new EventTarget()
for (const method of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
  globalThis[method] ??= events[method].bind(events)
}

const { Editor, rootCtx, schemaCtx, parserCtx, serializerCtx, remarkStringifyOptionsCtx } = await import('@milkdown/kit/core')
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
