// Dragging a block by its handle: the pointer naturally stays in the handle's
// column, left of the text, where the editor gets no drag events, so no drop
// line shows and nothing moves on release. While one of the editor's own
// drags is under way, drag events left of the text are passed on to the text
// at the same height.
import { Plugin } from '@milkdown/kit/prose/state'

export function gutterDragPlugin() {
  return new Plugin({
    view(view) {
      const forward = (event) => {
        if (!view.dragging || view.dom.contains(event.target)) return
        const rect = view.dom.getBoundingClientRect()
        // A little above the first block or below the last still counts, so blocks can move to either end.
        const reach = 48
        if (event.clientX >= rect.left || event.clientY < rect.top - reach || event.clientY > rect.bottom + reach) return
        event.preventDefault()
        view.dom.dispatchEvent(new DragEvent(event.type, {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + 1,
          clientY: Math.min(Math.max(event.clientY, rect.top + 1), rect.bottom - 1),
          dataTransfer: event.dataTransfer,
          altKey: event.altKey,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
        }))
      }
      document.addEventListener('dragover', forward)
      document.addEventListener('drop', forward)
      return {
        destroy() {
          document.removeEventListener('dragover', forward)
          document.removeEventListener('drop', forward)
        },
      }
    },
  })
}
