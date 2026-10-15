import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const dir = mkdtempSync(join(tmpdir(), 'cmd-test-'))
process.env.CLAUDE_MD_EDITOR_HOME = join(dir, 'state')

let DocSession
let ops
let milkdown
beforeAll(async () => {
  ;({ DocSession } = await import('../server/doc.js'))
  ops = await import('../server/ops.js')
  milkdown = await import('../server/milkdown.js')
})

const sessions = []
let counter = 0
function open(markdown) {
  const file = join(dir, `doc-${counter++}.md`)
  writeFileSync(file, markdown)
  const session = new DocSession(file).load()
  sessions.push(session)
  return { session, file, read: () => (session.save(), readFileSync(file, 'utf8')) }
}

afterEach(() => {
  while (sessions.length) sessions.pop().close()
})

const SAMPLE = `# Title

The **quick** brown fox.

- one
- two
- three

> A quote with words.

| a | b |
| - | - |
| 1 | 2 |

\`\`\`js
const x = 1
\`\`\`

Last paragraph.
`

describe('markdown round trip', () => {
  it('keeps common markdown stable', () => {
    const once = milkdown.serializeDoc(milkdown.parseMarkdown(SAMPLE))
    expect(once).toBe(SAMPLE)
  })

  it('does not rewrite the file when only opened', () => {
    const raw = '* star bullets\n* stay as written\n'
    const { session, file } = open(raw)
    session.save()
    expect(readFileSync(file, 'utf8')).toBe(raw)
  })
})

describe('suggestions', () => {
  it('replaces inline text and keeps surrounding marks', () => {
    const { session, read } = open(SAMPLE)
    const { id } = ops.suggest(session, { target: { find: 'quick' }, markdown: 'slow' })
    expect(read()).toBe(SAMPLE) // nothing changes until accepted
    ops.acceptSuggestion(session, id)
    expect(read()).toContain('The **slow** brown fox.')
  })

  it('anchors inside nested blocks (lists, quotes, tables)', () => {
    const { session, read } = open(SAMPLE)
    const a = ops.suggest(session, { target: { find: 'two' }, markdown: 'TWO' })
    const b = ops.suggest(session, { target: { find: 'quote with' }, markdown: 'quote, with' })
    const listed = ops.listSuggestions(session)
    expect(listed.find((s) => s.id === a.id).block).toBe(2)
    expect(listed.find((s) => s.id === b.id).block).toBe(3)
    ops.acceptSuggestion(session, a.id)
    ops.acceptSuggestion(session, b.id)
    const md = read()
    expect(md).toContain('- TWO')
    expect(md).toContain('> A quote, with words.')
  })

  it('survives other edits landing first', () => {
    const { session, read } = open(SAMPLE)
    const first = ops.suggest(session, { target: { after_block: 0 }, markdown: 'Intro paragraph.' })
    const second = ops.suggest(session, { target: { find: 'Last paragraph' }, markdown: 'Final paragraph' })
    const third = ops.suggest(session, { target: { block: 2 }, markdown: '' })
    ops.acceptSuggestion(session, first.id)
    ops.rejectSuggestion(session, third.id)
    ops.acceptSuggestion(session, second.id)
    const md = read()
    expect(md).toMatch(/^# Title\n\nIntro paragraph\.\n\nThe \*\*quick\*\*/)
    expect(md).toContain('- one')
    expect(md).toContain('Final paragraph.')
  })

  it('follows the person typing inside the suggested range', () => {
    const { session, read } = open('Alpha beta gamma.\n')
    const { id } = ops.suggest(session, { target: { find: 'beta' }, markdown: 'BETA' })
    // The person types at both ends of the paragraph (one edit at a time, as the editor sends them).
    session.applyDoc(milkdown.parseMarkdown('Hello. Alpha beta gamma.\n'), 'test')
    session.applyDoc(milkdown.parseMarkdown('Hello. Alpha beta gamma delta.\n'), 'test')
    ops.acceptSuggestion(session, id)
    expect(read()).toBe('Hello. Alpha BETA gamma delta.\n')
  })

  it('re-finds its text after a bulk rewrite, and refuses when it cannot', () => {
    const { session, read } = open('Alpha beta gamma.\n')
    const a = ops.suggest(session, { target: { find: 'beta' }, markdown: 'BETA' })
    const b = ops.suggest(session, { target: { find: 'gamma' }, markdown: 'GAMMA' })
    // One big replacement of the paragraph (like an edit on disk) collapses the anchors.
    session.applyDoc(milkdown.parseMarkdown('Zeta. Alpha beta delta.\n'), 'test')
    ops.acceptSuggestion(session, a.id)
    expect(read()).toBe('Zeta. Alpha BETA delta.\n')
    expect(() => ops.acceptSuggestion(session, b.id)).toThrow(/has changed/)
    expect(read()).toBe('Zeta. Alpha BETA delta.\n')
  })

  it('joins an inserted list into the list before it', () => {
    const { session, read } = open('- a\n- b\n\nAfter.\n')
    const { id } = ops.suggest(session, { target: { after_block: 0 }, markdown: '- c' })
    ops.acceptSuggestion(session, id)
    expect(read()).toBe('- a\n- b\n- c\n\nAfter.\n')
  })

  it('deletes whole blocks and never leaves the doc empty', () => {
    const { session, read } = open('Only paragraph.\n')
    const { id } = ops.suggest(session, { target: { block: 0 }, markdown: '' })
    ops.acceptSuggestion(session, id)
    expect(read().trim()).toBe('')
    expect(session.snapshot().doc.childCount).toBe(1)
  })

  it('rejects ambiguous or missing find text with a helpful error', () => {
    const { session } = open('word word\n')
    expect(() => ops.suggest(session, { target: { find: 'word' }, markdown: 'x' })).toThrow(/appears 2 times/)
    expect(() => ops.suggest(session, { target: { find: 'nope' }, markdown: 'x' })).toThrow(/Couldn't find/)
    expect(() => ops.suggest(session, { target: { find: 'word', occurrence: 2 }, markdown: 'x\n\ny' })).toThrow(/inline markdown/)
  })

  it('finds text even when the agent includes markdown syntax', () => {
    const { session } = open('The **quick** fox.\n')
    expect(ops.suggest(session, { target: { find: 'The **quick** fox' }, markdown: 'A fox' }).kind).toBe('inline')
  })

  it('only applies direct edits when the person allowed them', () => {
    const { session, read } = open('Draft text.\n')
    expect(() => ops.suggest(session, { target: { find: 'Draft' }, markdown: 'Final', direct: true })).toThrow(/switched off/)
    session.settings.set('allowDirect', true)
    ops.suggest(session, { target: { find: 'Draft' }, markdown: 'Final', direct: true })
    expect(read()).toBe('Final text.\n')
    expect(session.suggestions.size).toBe(0)
  })
})

describe('review comments', () => {
  function addComment(session, find, body) {
    const { doc, mapping } = session.snapshot()
    const { from, to } = ops.findText(doc, find)
    const { encodeAnchor } = ops.__test
    const id = `c${Math.random().toString(16).slice(2, 8)}`
    session.comments.set(id, { id, from: encodeAnchor(from, session.fragment, mapping), to: encodeAnchor(to, session.fragment, mapping), quote: find, body, author: 'You', status: 'draft', thread: [], createdAt: new Date().toISOString() })
    return id
  }

  it('submits drafts, wakes waiters, and resolves via a linked suggestion', async () => {
    const { session, read } = open('Ship on Friday.\n\n- tasks\n- more tasks\n')
    const cid = addComment(session, 'more tasks', 'Be specific')
    const woken = new Promise((resolve) => session.reviewWaiters.add(resolve))
    const review = ops.submitReview(session, 'Looks close')
    expect((await woken).id).toBe(review.id)

    const got = ops.getReview(session)
    expect(got.notes).toEqual(['Looks close'])
    expect(got.comments).toHaveLength(1)
    expect(got.comments[0]).toMatchObject({ id: cid, quote: 'more tasks', block: 1, comment: 'Be specific' })
    expect(ops.unseenReviews(session)).toHaveLength(0)

    ops.replyToComment(session, cid, 'Listed them.')
    const { id } = ops.suggest(session, { target: { find: 'more tasks' }, markdown: 'write docs', resolves: cid })
    ops.acceptSuggestion(session, id)
    expect(session.comments.get(cid).status).toBe('resolved')
    expect(session.comments.get(cid).thread.at(-1).body).toBe('Listed them.')
    expect(read()).toContain('- write docs')
  })

  it('will not submit an empty review', () => {
    const { session } = open('Text.\n')
    expect(() => ops.submitReview(session, '')).toThrow(/Nothing to submit/)
  })

  it("shows a polling mod as listening, and stops once it's gone quiet", () => {
    vi.useFakeTimers()
    try {
      const { session } = open('Text.\n')
      const watching = () => session.awareness.getLocalState()?.watching
      session.noteListener()
      expect(watching()).toBe(true)
      vi.advanceTimersByTime(9_000)
      session.noteListener()
      vi.advanceTimersByTime(12_000)
      expect(watching()).toBe(true)
      vi.advanceTimersByTime(5_000)
      expect(watching()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('persistence', () => {
  it('keeps pending suggestions across a restart, and merges edits made on disk', () => {
    const { session, file } = open('Keep this. Change that.\n')
    const { id } = ops.suggest(session, { target: { find: 'that' }, markdown: 'this too' })
    session.close()
    sessions.pop()

    writeFileSync(file, 'New first line.\n\nKeep this. Change that.\n')
    const reopened = new DocSession(file).load()
    sessions.push(reopened)
    expect(reopened.suggestions.has(id)).toBe(true)
    ops.acceptSuggestion(reopened, id)
    reopened.save()
    expect(readFileSync(file, 'utf8')).toBe('New first line.\n\nKeep this. Change this too.\n')
  })
})

describe('changes since last read', () => {
  it("reports the person's edits as a diff", () => {
    const { session } = open('One.\n\nTwo.\n')
    ops.renderForAgent(session)
    session.applyDoc(milkdown.parseMarkdown('One.\n\nTwo, edited.\n'), 'test')
    const { textDiff } = ops.listChanges(session)
    expect(textDiff).toContain('- Two.')
    expect(textDiff).toContain('+ Two, edited.')
  })
})
