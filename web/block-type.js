// The text type picker at the start of the selection toolbar: turns the
// selected blocks into text, a heading, a list or a quote.
import { lift, setBlockType, wrapIn } from '@milkdown/kit/prose/commands'
import { liftListItem, wrapInList } from '@milkdown/kit/prose/schema-list'
import { el } from './margin.js'

// A "T" with a small chevron, drawn like Crepe's own toolbar icons.
export const TEXT_TYPE_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path style="fill:none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M4.5 6.25h9.5M9.25 6.25v11.5"/><path style="fill:none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M15.75 12.25l2.25 2.25 2.25-2.25"/></svg>'

export const TEXT_TYPE_KEY = 'text-type'

const TYPES = [
  { id: 'paragraph', label: 'Text' },
  { id: 'h1', label: 'Heading 1', level: 1 },
  { id: 'h2', label: 'Heading 2', level: 2 },
  { id: 'h3', label: 'Heading 3', level: 3 },
  { id: 'bullet_list', label: 'Bulleted list' },
  { id: 'ordered_list', label: 'Numbered list' },
  { id: 'blockquote', label: 'Quote' },
]
const LISTS = ['bullet_list', 'ordered_list']

function ancestor($pos, names) {
  for (let d = $pos.depth; d > 0; d--) if (names.includes($pos.node(d).type.name)) return $pos.node(d)
  return null
}

/** The type of the block the selection starts in, as a TYPES id (or null for anything else). */
export function currentType(state) {
  const { $from } = state.selection
  const list = ancestor($from, LISTS)
  if (list) return list.type.name
  if (ancestor($from, ['blockquote'])) return 'blockquote'
  const { parent } = $from
  if (parent.type.name === 'heading') return parent.attrs.level <= 3 ? `h${parent.attrs.level}` : null
  return parent.type.name === 'paragraph' ? 'paragraph' : null
}

function applyType(view, type) {
  const run = (command) => command(view.state, view.dispatch)
  const { nodes } = view.state.schema
  const within = (names) => ancestor(view.state.selection.$from, names)
  const unlist = () => { while (within(LISTS) && run(liftListItem(nodes.list_item))); }
  const unquote = () => { while (within(['blockquote']) && run(lift)); }
  const current = currentType(view.state)

  if (LISTS.includes(type.id) || type.id === 'blockquote') {
    // Choosing the type the text already has turns it back into plain text.
    if (current === type.id) return type.id === 'blockquote' ? unquote() : unlist()
    unlist()
    if (type.id !== 'blockquote') unquote()
    run(setBlockType(nodes.paragraph))
    if (type.id !== 'blockquote') run(wrapInList(nodes[type.id]))
    else if (!within(['blockquote'])) run(wrapIn(nodes.blockquote))
    return
  }
  unlist()
  unquote()
  run(type.level ? setBlockType(nodes.heading, { level: type.level }) : setBlockType(nodes.paragraph))
}

/** The menu the toolbar item opens. getView() returns the editor view. */
export function textTypeMenu(getView) {
  let menu = null

  function close() {
    if (!menu) return
    menu.remove()
    menu = null
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onKey, true)
  }
  function onOutside(e) {
    // The toolbar button toggles the menu itself.
    if (!menu.contains(e.target) && !e.target.closest?.(`[data-toolbar-item="${TEXT_TYPE_KEY}"]`)) close()
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
  }

  function toggle() {
    if (menu) return close()
    const view = getView()
    if (!view) return
    const current = currentType(view.state)
    menu = el('div', { class: 'type-menu', role: 'menu', 'aria-label': 'Text type' },
      TYPES.map((type) => el('button', {
        type: 'button',
        role: 'menuitemradio',
        'aria-checked': String(type.id === current),
        class: `type-${type.id}`,
        // Keep the editor's focus and selection while choosing.
        onpointerdown: (e) => e.preventDefault(),
        onclick: () => { applyType(view, type); close(); view.focus() },
      }, type.label)))
    document.body.append(menu)
    const button = document.querySelector(`[data-toolbar-item="${TEXT_TYPE_KEY}"]`)
    const at = button?.getBoundingClientRect() ?? view.coordsAtPos(view.state.selection.from)
    const left = Math.min(at.left, window.innerWidth - menu.offsetWidth - 16)
    menu.style.left = `${Math.max(16, left) + window.scrollX}px`
    menu.style.top = `${at.bottom + 6 + window.scrollY}px`
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('keydown', onKey, true)
  }

  return { toggle, close }
}
