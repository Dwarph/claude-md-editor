// A click on a block's drag handle selects the whole block as a node, which
// the formatting toolbar ignores. Once the click is over (a drag never ends in
// one), select the block's text instead, so the toolbar comes up for it.
// Code blocks and tables keep the node selection: their text doesn't read as
// one run.
import { NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state'

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
      document.addEventListener('click', onClick)
      return { destroy: () => document.removeEventListener('click', onClick) }
    },
  })
}
