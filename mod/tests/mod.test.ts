import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import type { DocSummary } from '../types'

const PLUGIN = 'md-editor-mod'
const OPEN_TOOL = 'mcp__plugin_claude-md-editor_md-editor__open_document'

const draft = (over: Partial<DocSummary> = {}): DocSummary => ({
  id: 'abc123def456',
  path: 'D:\\work\\draft.md',
  name: 'draft.md',
  url: 'http://127.0.0.1:4545/doc/abc123def456',
  suggestions: 3,
  openComments: 2,
  draftComments: 0,
  unseenReviews: 0,
  editors: 1,
  ...over,
})

type Request = { method: string; path: string; body?: unknown }

/** A fake daemon beneath the plugin, and a record of what the plugin did to the session. */
function world(on: On, docs: DocSummary[]) {
  const requests: Request[] = []
  const prompts: string[] = []
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const panes: string[] = []

  mock.env(on, { CLAUDE_MD_EDITOR_HOME: 'D:\\state' })
  const clock = mock.clock(on)
  const session = mock.session(on)
  on('fs.read', ($, e) => {
    if (e.path !== 'D:\\state\\daemon.json') throw new Error(`ENOENT ${e.path}`)
    return { value: JSON.stringify({ port: 4545, pid: 1 }) }
  })
  on('http.fetch', ($, e) => {
    const path = e.url.replace('http://127.0.0.1:4545/api/', '')
    const method = e.init?.method ?? 'GET'
    requests.push({ method, path, body: e.init?.body && JSON.parse(e.init.body) })
    const reply = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })
    if (path.startsWith('docs?')) return reply({ documents: docs })
    if (path.endsWith('/wait-review')) return reply({ reviews: 1, comments: 2 })
    if (path.endsWith('/accept-all')) return reply({ accepted: 3, failed: [] })
    if (path === 'agent/open_document') return reply(draft({ path: (JSON.parse(e.init?.body ?? '{}') as { path: string }).path }))
    return { value: { status: 404, ok: false, headers: {}, text: '{"error":"Not found"}' } }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'D:\\work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => {
    prompts.push(e.text)
    return { text: e.text }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    panes.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('tool.call', () => ({ result: { content: [{ type: 'text', text: '{}' }] } }))

  return { clock, session, requests, prompts, statuses, toasts, panes }
}

async function start($: Engine) {
  await $.session.start({ cwd: 'D:\\work', surface: 'terminal', isInteractive: true })
}

async function openDraft($: Engine) {
  return $.tool.call({ tool: OPEN_TOOL, path: 'draft.md' })
}

test('a submitted review is announced to the session working on the doc, once', async ($, on) => {
  const docs = [draft()]
  const w = world(on, docs)
  await start($)
  const opened = await openDraft($)
  expect(opened.context?.join('\n')).toContain('do not start the reviewWatcher')

  docs[0] = draft({ unseenReviews: 1 })
  await w.clock.advance(3000)
  expect(w.prompts).toEqual([
    'Review submitted on draft.md: 2 comments. Use the collab-md skill: call get_review for D:\\work\\draft.md.',
  ])

  await w.clock.advance(9000)
  expect(w.prompts).toHaveLength(1)

  // get_review marks it seen; the next submission is a new review.
  docs[0] = draft({ unseenReviews: 0 })
  await w.clock.advance(3000)
  docs[0] = draft({ unseenReviews: 1 })
  await w.clock.advance(3000)
  expect(w.prompts).toHaveLength(2)
})

test('a review on a doc this session never touched is left alone', async ($, on) => {
  const w = world(on, [draft({ unseenReviews: 1 })])
  await start($)
  await w.clock.advance(6000)
  expect(w.prompts).toEqual([])
  expect(w.panes).toEqual([])
})

test('during a turn the notice is appended, and prompted once if the turn ends unread', async ($, on) => {
  const docs = [draft()]
  const w = world(on, docs)
  await start($)
  await openDraft($)
  await $.turn.start({ text: 'working', turnId: 't1' })

  docs[0] = draft({ unseenReviews: 1 })
  await w.clock.advance(3000)
  expect(w.prompts).toEqual([])
  const notes = w.session.appended().filter((row) => row.door === 'note')
  expect(notes).toHaveLength(1)
  expect(JSON.stringify(notes[0]?.message.content)).toContain('Review submitted on draft.md')

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await w.clock.advance(3000)
  expect(w.prompts).toHaveLength(1)
  await w.clock.advance(6000)
  expect(w.prompts).toHaveLength(1)
})

test('the status line shows what is pending, and the poll watches owned docs', async ($, on) => {
  const w = world(on, [draft()])
  await start($)
  await openDraft($)
  await w.clock.advance(6000)
  expect(w.statuses.at(-1)).toBe('draft.md: 3 suggestions, 2 comments')
  expect(w.requests.some((r) => r.path === 'docs?poll=1&watch=abc123def456')).toBe(true)
  expect(w.panes).toEqual(['md-editor'])
})

test('/collab opens a file relative to the session and reports its URL', async ($, on) => {
  const w = world(on, [])
  await start($)
  const ran = await $.command.run({
    command: 'collab',
    args: 'notes.md',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(w.requests).toContainEqual({ method: 'POST', path: 'agent/open_document', body: { path: 'D:\\work\\notes.md' } })
  expect(ran.text).toBe('draft.md is open in the shared editor: http://127.0.0.1:4545/doc/abc123def456')
  expect(ran.context?.[0]).toContain('collab-md skill')
})

test('the pane lists docs and Accept all posts to the daemon', async ($, on) => {
  const w = world(on, [draft()])
  await start($)
  await openDraft($)
  await w.clock.advance(3000)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: PLUGIN,
      surface,
      component: 'Pane',
      requestId: 'md-editor',
      props: {
        title: 'Shared docs',
        isFocused: false,
        bodyColumns: 60,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: 'draft.md' })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toMatchObject({ props: { href: 'http://localhost:4545/doc/abc123def456', label: 'Open editor' } })
    await ui.press({ key: 'accept-abc123def456' })
    await ui.unmount()
  }
  expect(w.requests.filter((r) => r.path === 'docs/abc123def456/accept-all')).toHaveLength(2)
  expect(w.toasts).toContain('Accepted 3 suggestions on draft.md')
})
