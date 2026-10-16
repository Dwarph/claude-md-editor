// A heading's hashes are hidden, so editing should act as if they aren't
// there. Out of the box, Backspace (and Delete) at the start of a heading
// drops it one level, as if deleting an unseen hash, and typing hashes and a
// space at its start adds that many levels (## on an h4 gives an h6). Here
// Backspace and Delete edit text as they do in a paragraph, and typed hashes
// set the level outright (## gives an h2).
import { $inputRule } from '@milkdown/kit/utils'
import { textblockTypeInputRule } from '@milkdown/kit/prose/inputrules'
import { headingKeymap, headingSchema } from '@milkdown/kit/preset/commonmark'

export const keepHeadingOnBackspace = (ctx) =>
  ctx.update(headingKeymap.key, (prev) => ({ ...prev, DowngradeHeading: { ...prev.DowngradeHeading, shortcuts: [] } }))

// Stands in for the preset's wrapInHeadingInputRule (main.js removes that).
export const headingLevelInputRule = $inputRule((ctx) =>
  textblockTypeInputRule(/^(?<hashes>#{1,6})\s$/, headingSchema.type(ctx), (match) => ({ level: match.groups.hashes.length })))
