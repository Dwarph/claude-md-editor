// The line showing where a dragged block will land, standing in for the one
// Crepe ships (main.js removes that). Crepe's draws a line at the edge of the
// nearest block, so the gap between two blocks offers two lines (the bottom of
// one, the top of the next) for the same spot, and it draws none where the
// block started. Here each spot gets one line, midway between its neighbours,
// and dropping a block where it started leaves it there.
import { NodeSelection, Plugin, TextSelection } from '@milkdown/kit/prose/state'
import { dropIndicatorState } from '@milkdown/kit/plugin/cursor'

const rectOf = (view, pos) => {
  const dom = view.nodeDOM(pos)
  return dom instanceof HTMLElement ? dom.getBoundingClientRect() : null
}

// The top and bottom edge of every block, nested ones included, as [pos, left, y, right].
function blockEdges(view) {
  const edges = []
  view.state.doc.descendants((node, pos) => {
    const rect = rectOf(view, pos)
    if (rect) edges.push([pos, rect.left, rect.top, rect.right], [pos + node.nodeSize, rect.left, rect.bottom, rect.right])
    return node.isBlock && !node.isTextblock
  })
  return edges
}

// Distance to the nearer end of an edge, as Crepe's measures it.
const distance = (x, y, [, left, edgeY, right]) => Math.min(Math.abs(x - left), Math.abs(x - right)) + Math.abs(y - edgeY)

// Where the line for a drop position goes: midway between the blocks either side of it, or along the one there is.
function lineAt(view, pos) {
  const $pos = view.state.doc.resolve(pos)
  const before = $pos.nodeBefore && rectOf(view, pos - $pos.nodeBefore.nodeSize)
  const after = $pos.nodeAfter && rectOf(view, pos)
  if (!before && !after) return null
  const y = before && after ? (before.bottom + after.top) / 2 : before ? before.bottom : after.top
  const left = Math.min(before?.left ?? Infinity, after?.left ?? Infinity)
  const right = Math.max(before?.right ?? -Infinity, after?.right ?? -Infinity)
  return { p1: { x: left, y }, p2: { x: right, y } }
}

export function dropIndicatorPlugin(ctx) {
  let cached = { doc: null, rect: null, edges: [] }
  const edges = (view) => {
    const rect = view.dom.getBoundingClientRect()
    const same = cached.rect && ['x', 'y', 'width', 'height'].every((k) => cached.rect[k] === rect[k])
    if (cached.doc !== view.state.doc || !same) cached = { doc: view.state.doc, rect, edges: blockEdges(view) }
    return cached.edges
  }

  // The drop position under the pointer, and whether it's where the dragged block already is.
  const target = (view, event) => {
    if (!view.editable) return null
    let nearest = null
    for (const edge of edges(view)) {
      const d = distance(event.clientX, event.clientY, edge)
      if (!nearest || d < nearest.d || (d === nearest.d && edge[0] < nearest.pos)) nearest = { d, pos: edge[0] }
    }
    if (!nearest) return null
    // What a move takes out: the handle's block, or the blocks range-drag.js widens it to.
    const dragged = view.dragging?.move && view.dragging.node
    if (dragged && nearest.pos >= dragged.from && nearest.pos <= dragged.to) {
      // Inside the dragged blocks reads as either end of them.
      const last = view.state.doc.resolve(dragged.to).nodeBefore
      const top = rectOf(view, dragged.from)?.top
      const bottom = last && rectOf(view, dragged.to - last.nodeSize)?.bottom
      const atTop = top == null || bottom == null || event.clientY - top < bottom - event.clientY
      return { pos: atTop ? dragged.from : dragged.to, inPlace: true }
    }
    return { pos: nearest.pos, inPlace: false }
  }

  return new Plugin({
    view(view) {
      let hideTimer
      const show = (event) => {
        const spot = target(view, event)
        const line = spot && lineAt(view, spot.pos)
        if (!line) return hide()
        clearTimeout(hideTimer)
        ctx.set(dropIndicatorState.key, { view, pos: spot.pos, line })
      }
      const hide = () => ctx.set(dropIndicatorState.key, null)
      // Moving between blocks, or into the gutter (see gutter-drag.js), leaves one element just before the next dragover.
      const hideSoon = () => {
        clearTimeout(hideTimer)
        hideTimer = setTimeout(hide, 30)
      }
      view.dom.addEventListener('dragover', show)
      for (const type of ['dragleave', 'drop', 'dragend']) view.dom.addEventListener(type, hideSoon)
      return {
        destroy() {
          clearTimeout(hideTimer)
          view.dom.removeEventListener('dragover', show)
          for (const type of ['dragleave', 'drop', 'dragend']) view.dom.removeEventListener(type, hideSoon)
        },
      }
    },
    props: {
      handleDrop(view, event, slice, move) {
        const spot = target(view, event)
        if (!spot) return false
        if (spot.inPlace) return true
        const tr = view.state.tr
        if (move) {
          const { node } = view.dragging || {}
          if (node) node.replace(tr)
          else tr.deleteSelection()
        }
        const pos = tr.mapping.map(spot.pos)
        const isNode = slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
        const before = tr.doc
        if (isNode) tr.replaceRangeWith(pos, pos, slice.content.firstChild)
        else tr.replaceRange(pos, pos, slice)
        if (tr.doc.eq(before)) return true
        const $pos = tr.doc.resolve(pos)
        if (isNode && NodeSelection.isSelectable(slice.content.firstChild) && $pos.nodeAfter?.sameMarkup(slice.content.firstChild)) {
          tr.setSelection(new NodeSelection($pos))
        } else {
          let end = tr.mapping.map(spot.pos)
          tr.mapping.maps[tr.mapping.maps.length - 1].forEach((_from, _to, _newFrom, newTo) => { end = newTo })
          tr.setSelection(TextSelection.between($pos, tr.doc.resolve(end)))
        }
        view.focus()
        view.dispatch(tr.setMeta('uiEvent', 'drop'))
        return true
      },
    },
  })
}
