// Shared by the browser editor and the headless server so both write the same
// markdown. Chosen to match how most people hand-write markdown, so opening a
// file and saving it doesn't churn its formatting.
export const REMARK_STRINGIFY_OPTIONS = {
  bullet: '-',
  rule: '-',
  emphasis: '_',
  strong: '*',
  fences: true,
  listItemIndent: 'one',
}

// Name of the Yjs XmlFragment holding the ProseMirror document.
export const FRAGMENT_NAME = 'prosemirror'
