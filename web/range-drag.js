// Dragging a block's handle while text across several blocks is selected
// drags all of those blocks. The handle alone only ever drags its own block:
// pressing it swaps the selection for that block. When the handle's block is
// one of the selected ones, the selection is put back and the drag carries
// every block it touches.
import { Plugin, Selection } from '@milkdown/kit/prose/state'

const onDragHandle = (event) => event.target.closest?.('.milkdown-block-handle .operation-item:last-child')

// The whole blocks a selection touches, or null for one block or none. A selection ending at the very
// start of a block (as triple-click leaves it) doesn't take that block along.
function selectedBlocks(doc, selection) {
  if (selection.empty) return null
  let { $from, $to } = selection
  if ($to.parentOffset === 0 && $to.depth > 0 && $to.pos > $from.pos) {
    $to = Selection.findFrom(doc.resolve($to.before()), -1, true)?.$head ?? $to
  }
  const range = $from.blockRange($to)
  if (!range || range.endIndex - range.startIndex < 2) return null
  return { from: range.start, to: range.end }
}

// A drag image of every dragged block, styled as they are in the editor.
function dragImage(view, from, to) {
  const image = document.createElement('div')
  image.className = 'ProseMirror'
  Object.assign(image.style, { position: 'fixed', top: '-10000px', left: '0', width: `${view.dom.clientWidth}px`, padding: '0' })
  view.state.doc.nodesBetween(from, to, (node, pos) => {
    const dom = view.nodeDOM(pos)
    if (dom instanceof HTMLElement) image.append(dom.cloneNode(true))
    return false
  })
  view.dom.parentElement.append(image)
  setTimeout(() => image.remove())
  return image
}

export function rangeDragPlugin() {
  return new Plugin({
    view(view) {
      let held = null // the selection as it was when the handle was pressed
      let blocks = null // the blocks the coming drag carries
      const beforeHandle = (event) => {
        held = onDragHandle(event) ? view.state.selection : null
        blocks = null
      }
      // By now the handle has selected its own block.
      const afterHandle = (event) => {
        if (!held || !onDragHandle(event)) return
        const range = selectedBlocks(view.state.doc, held)
        const { from, to } = view.state.selection
        if (range && range.from <= from && to <= range.to) {
          blocks = range
          view.dispatch(view.state.tr.setSelection(held))
        }
        held = null
      }
      // After the handle has set up its single-block drag, widen it.
      const onDragStart = (event) => {
        if (!blocks || !event.target.closest?.('.milkdown-block-handle')) return
        const { from, to } = blocks
        blocks = null
        const slice = view.state.doc.slice(from, to)
        if (event.dataTransfer) {
          const { dom, text } = view.serializeForClipboard(slice)
          event.dataTransfer.clearData()
          event.dataTransfer.setData('text/html', dom.innerHTML)
          event.dataTransfer.setData('text/plain', text)
          event.dataTransfer.setDragImage(dragImage(view, from, to), 0, 0)
        }
        // `node` is what a move deletes; ProseMirror and drop-indicator.js only call its replace().
        view.dragging = { slice, move: true, node: { from, to, replace: (tr) => tr.delete(from, to) } }
      }
      document.addEventListener('mousedown', beforeHandle, true)
      document.addEventListener('mousedown', afterHandle)
      document.addEventListener('dragstart', onDragStart)
      return {
        destroy() {
          document.removeEventListener('mousedown', beforeHandle, true)
          document.removeEventListener('mousedown', afterHandle)
          document.removeEventListener('dragstart', onDragStart)
        },
      }
    },
  })
}
