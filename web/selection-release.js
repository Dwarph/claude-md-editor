// Clicking away from the editor clears the page's highlight but not the
// editor's own selection, so the formatting toolbar (which only looks again
// when that selection changes) stays up over text that no longer looks
// selected. Once the page's selection has left the editor, the editor's is
// collapsed to match and the toolbar closes. Focus moving to the toolbar
// itself doesn't count.
import { Plugin, Selection } from '@milkdown/kit/prose/state'

export function selectionReleasePlugin() {
  return new Plugin({
    view(view) {
      const onSelectionChange = () => {
        const { selection } = view.state
        if (selection.empty || view.hasFocus() || document.activeElement?.closest?.('.milkdown-toolbar')) return
        const page = view.root.getSelection?.()
        if (page?.rangeCount && view.dom.contains(page.anchorNode)) return
        view.dispatch(view.state.tr.setSelection(Selection.near(selection.$to, -1)))
      }
      document.addEventListener('selectionchange', onSelectionChange)
      return { destroy: () => document.removeEventListener('selectionchange', onSelectionChange) }
    },
  })
}
