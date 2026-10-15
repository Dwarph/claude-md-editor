// Every change to a document goes through here: the agent's suggestions and
// direct edits, the person's accept/reject and review submissions.
import { randomUUID } from 'node:crypto'
import { Transform, canJoin } from '@milkdown/kit/prose/transform'
import { parseInline, parseMarkdown, schema, serializeBlocks } from './milkdown.js'
import { encodeAnchor, resolveRange } from '../shared/positions.js'
import { lineDiff } from '../shared/linediff.js'
import { ORIGIN } from './doc.js'

export class OpError extends Error {}

// Exposed for tests that create comments the way the browser does.
export const __test = { encodeAnchor, resolveRange }

const shortId = () => randomUUID().slice(0, 8)
const LEAF_CHAR = '￼'

// --- Reading -------------------------------------------------------------

/** Top-level blocks with their document positions. */
export function topBlocks(doc) {
  const blocks = []
  doc.forEach((node, offset, index) => blocks.push({ index, node, from: offset, to: offset + node.nodeSize }))
  return blocks
}

function blockIndexAt(doc, pos) {
  const blocks = topBlocks(doc)
  const hit = blocks.find((b) => pos >= b.from && pos < b.to)
  return hit ? hit.index : blocks.length - 1
}

/** Plain text of a textblock where every inline leaf counts as one character, matching positions. */
function textblockText(node) {
  let text = ''
  node.forEach((child) => { text += child.isText ? child.text : LEAF_CHAR })
  return text
}

function* textblocks(doc) {
  const found = []
  doc.descendants((node, pos) => {
    if (node.isTextblock) { found.push({ node, pos }); return false }
    return true
  })
  yield* found
}

/** Strip common markdown syntax so `**bold**` still finds the text "bold". */
function stripMarkdown(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|[^\w])[*_]([^*_]+)[*_]/g, '$1$2')
}

/** Locate `find` as plain text inside a single paragraph/heading/cell. */
export function findText(doc, find, occurrence) {
  if (!find) throw new OpError('`find` must be non-empty text.')
  for (const needle of [find, stripMarkdown(find)]) {
    const matches = []
    for (const { node, pos } of textblocks(doc)) {
      const text = textblockText(node)
      let i = text.indexOf(needle)
      while (i !== -1) {
        matches.push({ from: pos + 1 + i, to: pos + 1 + i + needle.length })
        i = text.indexOf(needle, i + 1)
      }
    }
    if (matches.length === 0) continue
    if (matches.length > 1 && occurrence === undefined) {
      throw new OpError(`"${needle}" appears ${matches.length} times. Pass a longer \`find\` or \`occurrence\` (1-based).`)
    }
    const pick = matches[(occurrence ?? 1) - 1]
    if (!pick) throw new OpError(`Only ${matches.length} occurrence(s) of "${needle}".`)
    return pick
  }
  throw new OpError(`Couldn't find "${find}". \`find\` matches the rendered text inside one block (no markdown syntax, no line breaks). Re-read the document and copy the exact words.`)
}

/** Markdown with numbered block markers, for the agent. */
export function renderForAgent(session) {
  const { doc, mapping } = session.snapshot()
  const blocks = topBlocks(doc).map((b) => `[[block ${b.index}]]\n${serializeBlocks([b.node])}`)
  const out = [`# ${session.name}  (${session.path})`, `Mode: ${MODES[getMode(session)]}`, '', blocks.join('\n\n')]

  const pending = listSuggestions(session, doc, mapping)
  if (pending.length) {
    out.push('', '---', `Pending suggestions (${pending.length}), waiting on the person to accept/reject:`)
    for (const s of pending) out.push(`- ${s.id} [${s.kind}${s.block !== undefined ? `, block ${s.block}` : ''}] "${truncate(s.original)}" -> "${truncate(s.markdown)}"${s.anchorLost ? ' (anchor lost)' : ''}`)
  }
  const open = [...session.comments.values()].filter((c) => c.status === 'submitted')
  if (open.length) {
    out.push('', `Open review comments (${open.length}); use get_review for details.`)
  }
  session.agentSnapshot = serializeDocForDiff(session)
  return out.join('\n')
}

function serializeDocForDiff(session) {
  return session.markdown()
}

function truncate(text, max = 80) {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function listSuggestions(session, doc, mapping) {
  if (!doc) ({ doc, mapping } = session.snapshot())
  return [...session.suggestions.values()].map((s) => {
    const range = resolveRange(s, session.ydoc, session.fragment, mapping)
    return { ...s, anchorLost: !range, block: range ? blockIndexAt(doc, range.from) : undefined }
  })
}

// --- Suggestions ---------------------------------------------------------

// What the person lets Claude do, set from the editor's "Claude can" control.
export const MODES = {
  live: 'Edit live: your changes land in the document straight away.',
  suggest: 'Suggest: your changes arrive as suggestions the person accepts or rejects.',
  readonly: 'Read only: you can read the document and reply to comments, but not change it.',
}

export function getMode(session) {
  const mode = session.settings.get('mode')
  if (mode in MODES) return mode
  return session.settings.get('allowDirect') ? 'live' : 'suggest' // documents from before modes existed
}

/**
 * Propose a change: a pending suggestion in Suggest mode, applied straight away
 * in Edit live mode, refused in Read only.
 * target: { find, occurrence } for inline text, { block } / { blocks: [a, b] } to
 * replace whole blocks, or { after_block } / { before_block } to insert blocks.
 */
export function suggest(session, { target, markdown, note, resolves }) {
  const mode = getMode(session)
  if (mode === 'readonly') {
    throw new OpError('The person has set you to Read only for this document: you can read it and reply to comments, but not change it. Describe the change in chat or a comment reply instead, or ask them to switch to Suggest.')
  }
  const { doc, mapping } = session.snapshot()
  markdown = markdown ?? ''
  let kind
  let from
  let to
  if (target.find !== undefined) {
    kind = 'inline'
    ;({ from, to } = findText(doc, target.find, target.occurrence))
    if (parseInline(markdown) === null) {
      throw new OpError('Replacement for `find` must be inline markdown (no blank lines, lists or headings). Replace whole blocks with `block` instead.')
    }
  } else {
    kind = 'block'
    const blocks = topBlocks(doc)
    const check = (i) => {
      if (!Number.isInteger(i) || i < -1 || i >= blocks.length) throw new OpError(`Block ${i} doesn't exist (document has blocks 0-${blocks.length - 1}).`)
      return i
    }
    if (target.after_block !== undefined) {
      const i = check(target.after_block)
      from = to = i === -1 ? 0 : blocks[i].to
    } else if (target.before_block !== undefined) {
      from = to = blocks[check(target.before_block)].from
    } else {
      const [a, b] = target.blocks ?? [target.block, target.block]
      check(a); check(b)
      if (a < 0 || b < a) throw new OpError('Block range must be [first, last] with first <= last.')
      from = blocks[a].from
      to = blocks[b].to
    }
    if (from === to && !markdown.trim()) throw new OpError('Nothing to insert.')
  }
  if (resolves && !session.comments.has(resolves)) throw new OpError(`No comment ${resolves}.`)

  const original = kind === 'inline'
    ? doc.textBetween(from, to, ' ', LEAF_CHAR)
    : serializeBlocks(topBlocks(doc).filter((b) => b.from >= from && b.to <= to).map((b) => b.node))
  const suggestion = {
    id: shortId(),
    kind,
    from: encodeAnchor(from, session.fragment, mapping),
    to: encodeAnchor(to, session.fragment, mapping),
    markdown,
    original,
    note: note ?? '',
    resolves: resolves ?? null,
    author: 'Claude',
    createdAt: new Date().toISOString(),
  }

  if (mode === 'live') {
    session.ydoc.transact(() => {
      const changed = applySuggestionToDoc(session, suggestion, doc, mapping)
      recordRecentEdit(session, changed)
      if (resolves) resolveComment(session, resolves, 'Claude')
      session.addLog({ type: 'direct-edit', by: 'agent', original, markdown })
    }, ORIGIN.agent)
    return { applied: true, kind, mode }
  }

  session.ydoc.transact(() => {
    session.suggestions.set(suggestion.id, suggestion)
    session.addLog({ type: 'suggested', by: 'agent', id: suggestion.id })
  }, ORIGIN.agent)
  return { id: suggestion.id, kind, mode }
}

function applySuggestionToDoc(session, suggestion, doc, mapping) {
  let range = resolveRange(suggestion, session.ydoc, session.fragment, mapping)
  if (!range) throw new OpError('The text this suggestion pointed at has been deleted.')
  if (suggestion.kind === 'inline' && doc.textBetween(range.from, range.to, ' ', LEAF_CHAR) !== suggestion.original) {
    // The anchored text was rewritten (e.g. a bulk edit on disk). Only apply
    // where the original words can still be found unambiguously.
    try {
      range = findText(doc, suggestion.original)
    } catch {
      throw new OpError(`The text this suggestion replaces ("${truncate(suggestion.original, 40)}") has changed. Reject it and ask Claude to suggest again.`)
    }
  }
  const tr = new Transform(doc)
  if (suggestion.kind === 'inline') {
    const $from = doc.resolve(range.from)
    const $to = doc.resolve(range.to)
    if (!$from.sameParent($to) || !$from.parent.isTextblock) throw new OpError('The suggestion no longer sits inside one paragraph.')
    // Keep formatting that wrapped the whole original range (e.g. replacing inside bold stays bold).
    const wrapping = range.from < range.to ? $from.marksAcross($to) ?? [] : $from.marks()
    const nodes = []
    parseInline(suggestion.markdown)?.forEach((node) => {
      nodes.push(node.isInline ? node.mark(wrapping.reduce((set, mark) => mark.addToSet(set), node.marks)) : node)
    })
    tr.replaceWith(range.from, range.to, nodes)
  } else {
    const content = suggestion.markdown.trim() ? parseMarkdown(suggestion.markdown).content : []
    tr.replaceWith(range.from, range.to, content)
    // A list inserted next to a list of the same kind joins it, rather than
    // starting a separate list.
    const size = Array.isArray(content) ? 0 : content.size
    for (const pos of [range.from + size, range.from]) joinListsAt(tr, pos)
  }
  let next = tr.doc
  if (next.childCount === 0) next = schema.topNodeType.createAndFill()
  session.applyDoc(next, ORIGIN.agent)
  // Where the new content now sits, so editors can flash it in Edit live mode.
  const max = next.content.size
  return { from: Math.min(tr.mapping.map(range.from, -1), max), to: Math.min(tr.mapping.map(range.to, 1), max) }
}

const RECENT_KEEP_MS = 60_000

/** Mark text Claude just changed in Edit live mode; editors tint it briefly. */
function recordRecentEdit(session, range) {
  const { mapping } = session.snapshot()
  const now = Date.now()
  for (const [id, entry] of session.recent.entries()) {
    if (now - entry.at > RECENT_KEEP_MS) session.recent.delete(id)
  }
  if (range.from >= range.to) return
  const id = shortId()
  session.recent.set(id, {
    id,
    from: encodeAnchor(range.from, session.fragment, mapping),
    to: encodeAnchor(range.to, session.fragment, mapping),
    at: now,
  })
}

function joinListsAt(tr, pos) {
  if (pos <= 0 || pos >= tr.doc.content.size) return
  const $pos = tr.doc.resolve(pos)
  const before = $pos.nodeBefore
  const after = $pos.nodeAfter
  if (before && after && before.type === after.type && /_list$/.test(before.type.name) && canJoin(tr.doc, pos)) {
    tr.join(pos)
  }
}

export function acceptSuggestion(session, id, by = 'user') {
  const suggestion = session.suggestions.get(id)
  if (!suggestion) throw new OpError(`No suggestion ${id}.`)
  const { doc, mapping } = session.snapshot()
  session.ydoc.transact(() => {
    applySuggestionToDoc(session, suggestion, doc, mapping)
    session.suggestions.delete(id)
    if (suggestion.resolves) resolveComment(session, suggestion.resolves, by)
    session.addLog({ type: 'accepted', by, id, original: suggestion.original, markdown: suggestion.markdown })
  }, ORIGIN.user)
}

export function rejectSuggestion(session, id, by = 'user') {
  const suggestion = session.suggestions.get(id)
  if (!suggestion) throw new OpError(`No suggestion ${id}.`)
  session.ydoc.transact(() => {
    session.suggestions.delete(id)
    session.addLog({ type: 'rejected', by, id, original: suggestion.original, markdown: suggestion.markdown })
  }, ORIGIN.user)
}

/** Accept every suggestion, oldest first, skipping any whose text is gone. */
export function acceptAll(session) {
  const ids = [...session.suggestions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((s) => s.id)
  const failed = []
  for (const id of ids) {
    try { acceptSuggestion(session, id) } catch (err) { failed.push({ id, error: err.message }) }
  }
  return { accepted: ids.length - failed.length, failed }
}

export function rejectAll(session) {
  const ids = [...session.suggestions.keys()]
  ids.forEach((id) => rejectSuggestion(session, id))
  return { rejected: ids.length }
}

// --- Comments and reviews ------------------------------------------------

function resolveComment(session, id, by) {
  const comment = session.comments.get(id)
  if (!comment) return
  session.comments.set(id, { ...comment, status: 'resolved', resolvedBy: by, resolvedAt: new Date().toISOString() })
}

export function replyToComment(session, id, body, author = 'Claude') {
  const comment = session.comments.get(id)
  if (!comment) throw new OpError(`No comment ${id}.`)
  const thread = [...(comment.thread ?? []), { author, body, at: new Date().toISOString() }]
  if (author === 'Claude') {
    session.ydoc.transact(() => session.comments.set(id, { ...comment, thread }), ORIGIN.agent)
    return
  }
  // The person's reply is sent straight away, so it wakes the agent like a submitted review.
  queueReview(session, { commentIds: [id], replyTo: id }, () => session.comments.set(id, { ...comment, thread }))
}

/** Record an unseen review (inside `change`'s transaction) and wake whoever is listening for one. */
function queueReview(session, fields, change) {
  const review = { id: shortId(), note: '', commentIds: [], ...fields, submittedAt: new Date().toISOString(), seen: false }
  session.ydoc.transact(() => {
    change()
    session.reviews.set(review.id, review)
    session.addLog({ type: review.replyTo ? 'comment-reply' : 'review-submitted', by: 'user', id: review.id, comments: review.commentIds.length })
  }, ORIGIN.user)
  for (const waiter of session.reviewWaiters) waiter(review)
  session.reviewWaiters.clear()
  return review
}

export function setCommentResolved(session, id, by) {
  if (!session.comments.has(id)) throw new OpError(`No comment ${id}.`)
  session.ydoc.transact(() => resolveComment(session, id, by), by === 'Claude' ? ORIGIN.agent : ORIGIN.user)
}

/** The person's "Submit review": draft comments become submitted, and waiters wake. */
export function submitReview(session, note) {
  const drafts = [...session.comments.values()].filter((c) => c.status === 'draft')
  if (!drafts.length && !note?.trim()) throw new OpError('Nothing to submit: add a comment or an overall note first.')
  const reviewId = shortId()
  return queueReview(session, { id: reviewId, note: note?.trim() ?? '', commentIds: drafts.map((c) => c.id) }, () => {
    for (const c of drafts) session.comments.set(c.id, { ...c, status: 'submitted', reviewId })
  })
}

export function unseenReviews(session) {
  return [...session.reviews.values()].filter((r) => !r.seen)
}

/** Everything the agent needs to act on submitted comments. Marks the reviews seen. */
export function getReview(session) {
  const { doc, mapping } = session.snapshot()
  const reviews = unseenReviews(session)
  const repliedTo = new Set(reviews.map((r) => r.replyTo).filter(Boolean))
  const comments = [...session.comments.values()]
    .filter((c) => c.status === 'submitted')
    .map((c) => {
      const range = resolveRange(c, session.ydoc, session.fragment, mapping)
      const block = range ? blockIndexAt(doc, range.from) : null
      return {
        id: c.id,
        comment: c.body,
        quote: range ? doc.textBetween(range.from, range.to, '\n', LEAF_CHAR) : c.quote,
        block,
        blockMarkdown: block !== null ? serializeBlocks([doc.child(block)]) : null,
        anchorLost: !range,
        thread: c.thread ?? [],
        ...(repliedTo.has(c.id) ? { newReply: true } : {}),
      }
    })
  session.ydoc.transact(() => {
    for (const r of reviews) session.reviews.set(r.id, { ...r, seen: true })
  }, ORIGIN.agent)
  return { notes: reviews.map((r) => r.note).filter(Boolean), comments }
}

/** What happened since the agent last looked: the person's text edits plus decisions. */
export function listChanges(session, since = 0) {
  const current = session.markdown()
  const diff = session.agentSnapshot === null ? null : lineDiff(session.agentSnapshot, current)
  const entries = session.log.toArray().slice(since)
  session.agentSnapshot = current
  return {
    textDiff: diff === null ? 'Not read yet: call read_document first.' : diff || 'No text changes.',
    events: entries,
    next: session.log.length,
  }
}

export function getSelection(session) {
  const selection = session.userSelection()
  if (!selection) return null
  const { doc, mapping } = session.snapshot()
  const range = resolveRange(selection, session.ydoc, session.fragment, mapping)
  if (!range) return null
  const block = blockIndexAt(doc, range.from)
  return {
    text: doc.textBetween(range.from, range.to, '\n', LEAF_CHAR),
    block,
    blockMarkdown: serializeBlocks([doc.child(block)]),
    isCursor: range.from === range.to,
  }
}
