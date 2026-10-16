// A click on a block's drag handle selects the whole block as a node, which
// the formatting toolbar ignores. Once the click is over (a drag never ends in
// one), select the block's text instead, so the toolbar comes up for it.
// Code blocks and tables keep the node selection: their text doesn't read as
// one run. A drag leaves nothing selected however it ends: dropped elsewhere
// (drop-indicator.js puts the cursor after the moved block), dropped where it
// started, or called off.
import { NodeSelection, Plugin, Selection, TextSelection } from '@milkdown/kit/prose/state'

const awkward = (node) => node.type.spec.code || node.type.spec.tableRole

export function handleSelectPlugin() {
  return new Plugin({
    view(view) {
      const onClick = (event) => {
        if (!event.target.closest?.('.milkdown-block-handle .operation-item:last-child')) return
        const { selection, doc } = view.state
        if (!(selection instanceof NodeSelection) || !selection.node.textContent) return
        let skip = awkward(selection.node)
        selection.node.descendants((node) => { skip ||= awkward(node) })
        if (skip) return
        view.focus()
        view.dispatch(view.state.tr.setSelection(TextSelection.between(doc.resolve(selection.from), doc.resolve(selection.to))))
      }
      let dragging = false
      const onDragStart = (event) => { dragging = !!event.target.closest?.('.milkdown-block-handle') }
      const onDragEnd = () => {
        if (!dragging) return
        dragging = false
        const { selection } = view.state
        if (!selection.empty) view.dispatch(view.state.tr.setSelection(Selection.near(selection.$to, -1)))
      }
      document.addEventListener('click', onClick)
      document.addEventListener('dragstart', onDragStart)
      document.addEventListener('dragend', onDragEnd)
      return {
        destroy() {
          document.removeEventListener('click', onClick)
          document.removeEventListener('dragstart', onDragStart)
          document.removeEventListener('dragend', onDragEnd)
        },
      }
    },
  })
}
