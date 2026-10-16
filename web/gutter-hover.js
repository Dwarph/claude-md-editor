// The block handle follows the pointer over the text, but the pointer often
// sits in the gutter left of it, where the editor gets no pointer events, so
// the handle stays on whichever block the pointer last crossed. Pointer moves
// there are passed to the handle at the same height.
import { Plugin } from '@milkdown/kit/prose/state'
import { blockServiceInstance } from '@milkdown/kit/plugin/block'

export function gutterHoverPlugin(ctx) {
  return new Plugin({
    view(view) {
      const follow = (event) => {
        // Over the handle itself, leave it put: moving onto its edge shouldn't send it to the next block.
        if (view.dragging || event.target.closest?.('.milkdown-block-handle')) return
        const rect = view.dom.getBoundingClientRect()
        if (event.clientX >= rect.left || event.clientY < rect.top || event.clientY > rect.bottom) return
        // In the gap between two blocks the handle would hide; keep it on the last block until the pointer reaches the next.
        if (view.root.elementFromPoint(rect.left + rect.width / 2, event.clientY) === view.dom) return
        ctx.get(blockServiceInstance.key).mousemoveCallback(view, event)
      }
      document.addEventListener('pointermove', follow)
      return { destroy: () => document.removeEventListener('pointermove', follow) }
    },
  })
}
