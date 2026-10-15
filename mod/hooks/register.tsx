// The Claude Code side of claude-md-editor. Everything about documents lives
// in the per-machine daemon (server/daemon.js); this module only polls its
// HTTP API and turns what it sees into native UI:
//   - announces a submitted review to the agent, without the background watcher
//   - a pane listing open documents, with Accept all / Reject all
//   - /collab <file> to open a document, and a status line of what's pending
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { DocSummary } from '../types'
import { isOwned, noticeText, pathKey, plural, planNotices, resolvePath, statusText } from './logic'

type Engine = EngineInterface

const PANE = 'md-editor'
const PANE_TITLE = 'Shared docs'
const POLL_MS = 3000

const docs = atom({ plugin: 'md-editor-mod', key: 'docs' } as const, [])
const isDaemonUp = atom({ plugin: 'md-editor-mod', key: 'isDaemonUp' } as const, false)
const owned = atom({ plugin: 'md-editor-mod', key: 'owned' } as const, [])
const notified = atom({ plugin: 'md-editor-mod', key: 'notified' } as const, {})
const isPaneOffered = atom({ plugin: 'md-editor-mod', key: 'isPaneOffered' } as const, false)

const WATCHER_NOTE =
  'The md-editor mod is loaded in this session: it tells you as soon as the person submits a review, ' +
  'so do not start the reviewWatcher background command.'

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The editor's address as a link: surfaces other than the terminal only link https: and http://localhost. */
const linkFor = (url: string) => url.replace(/^http:\/\/127\.0\.0\.1:/, 'http://localhost:')

// --- The daemon ------------------------------------------------------------

/** The daemon's API base, from the file it writes on start; undefined when it isn't running. */
async function daemonBase($: Engine): Promise<string | undefined> {
  const home =
    (await $.env.get('CLAUDE_MD_EDITOR_HOME')) ??
    resolvePath((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '', '.claude-md-editor')
  try {
    const info = JSON.parse(await $.fs.read(resolvePath(home, 'daemon.json'))) as { port?: unknown }
    return typeof info.port === 'number' ? `http://127.0.0.1:${info.port}/api` : undefined
  } catch {
    return undefined
  }
}

/** GET (no body) or POST (a body) to the daemon; throws its error message. */
async function call<T>(base: string, $: Engine, path: string, body?: object): Promise<T> {
  const res = await $.http.fetch(
    `${base}/${path}`,
    body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  )
  const data = res.text ? (JSON.parse(res.text) as T & { error?: string }) : null
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`)
  return data as T
}

async function requireDaemon($: Engine): Promise<string> {
  const base = await daemonBase($)
  if (!base) throw new Error("the editor isn't running")
  return base
}

/** Opens `path` in the daemon, starting it through the repo's CLI when it isn't running. */
async function openDocument($: Engine, path: string): Promise<DocSummary> {
  let base = await daemonBase($)
  if (base) {
    try {
      return await call<DocSummary>(base, $, 'agent/open_document', { path })
    } catch {
      // A stale daemon.json: fall through and start it.
    }
  }
  const cli = resolvePath($.plugin.root, '../server/cli.js')
  if (!(await $.fs.exists(cli))) {
    throw new Error('the editor isn\'t running. Ask Claude to open the file (the md-editor plugin starts it).')
  }
  const ran = await $.process.run(['node', cli, 'open', path], { timeoutMs: 60_000 })
  if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `cli.js exited ${ran.exitCode}`)
  base = await requireDaemon($)
  return call<DocSummary>(base, $, 'agent/open_document', { path })
}

// --- Polling ---------------------------------------------------------------

let isTurnRunning = false
let lastStatus: string | undefined
let polling: Promise<void> | null = null
let isPollAgain = false

/** Polls now; a call while a poll runs makes it poll once more when done. */
function refresh($: Engine): Promise<void> {
  if (polling) {
    isPollAgain = true
    return polling
  }
  polling = (async () => {
    do {
      isPollAgain = false
      await poll($)
    } while (isPollAgain)
  })().finally(() => {
    polling = null
  })
  return polling
}

async function poll($: Engine) {
  const ownedPaths = await read($, owned)
  const base = await daemonBase($)
  let list: DocSummary[] = []
  let isUp = false
  if (base) {
    // `poll` keeps the daemon's idle timer running; `watch` shows "Claude is listening" in those editors.
    const watch = (await read($, docs)).filter((doc) => isOwned(doc, ownedPaths)).map((doc) => doc.id)
    try {
      const data = await call<{ documents: DocSummary[] }>(base, $, `docs?poll=1&watch=${watch.join(',')}`)
      list = data.documents
      isUp = true
    } catch {
      // Not running (or restarting): show nothing until it answers again.
    }
  }

  if (JSON.stringify(list) !== JSON.stringify(await read($, docs))) await update($, docs, () => list)
  if (isUp !== (await read($, isDaemonUp))) await update($, isDaemonUp, () => isUp)

  const status = statusText(list, ownedPaths)
  if (status !== lastStatus) {
    lastStatus = status
    $.ui.status(status)
  }

  const planned = planNotices(list, ownedPaths, await read($, notified), isTurnRunning)
  // Recorded before sending, so a failed send can never repeat a notice.
  await update($, notified, () => planned.notified)
  for (const { doc, via } of planned.notices) await announce($, base, doc, via)

  if (list.some((doc) => isOwned(doc, ownedPaths)) && !(await read($, isPaneOffered))) {
    await update($, isPaneOffered, () => true)
    void $.ui.open({ id: PANE, title: PANE_TITLE })
  }
}

/** Tells the agent a review is in: a prompt when idle, or a note it reads at its next step. */
async function announce($: Engine, base: string | undefined, doc: DocSummary, via: 'prompt' | 'append') {
  let comments = doc.openComments
  let replies = 0
  try {
    // Answers at once while a review is unseen, with its comment and reply counts.
    if (base) ({ comments, replies = 0 } = await call<{ comments: number; replies?: number }>(base, $, `docs/${doc.id}/wait-review`))
  } catch {}
  const text = noticeText(doc, comments, replies)
  if (via === 'append') {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
  } else {
    void $.prompt.submit({ text })
  }
  $.ui.toast(`Review on ${doc.name} sent to Claude`)
}

async function own($: Engine, path: string) {
  const key = pathKey(path)
  await update($, owned, (list) => (list.includes(key) ? list : [...list, key]))
}

async function bulk($: Engine, doc: DocSummary, action: 'accept-all' | 'reject-all') {
  try {
    const base = await requireDaemon($)
    if (action === 'accept-all') {
      const done = await call<{ accepted: number; failed: unknown[] }>(base, $, `docs/${doc.id}/accept-all`, {})
      const failed = done.failed.length ? `; ${done.failed.length} couldn't be applied` : ''
      $.ui.toast(`Accepted ${plural(done.accepted, 'suggestion')} on ${doc.name}${failed}`)
    } else {
      const done = await call<{ rejected: number }>(base, $, `docs/${doc.id}/reject-all`, {})
      $.ui.toast(`Rejected ${plural(done.rejected, 'suggestion')} on ${doc.name}`)
    }
  } catch (err) {
    $.ui.toast(`${doc.name}: ${errorText(err)}`)
  }
  await refresh($)
}

// --- Hooks -----------------------------------------------------------------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'collab',
      description: 'Open a markdown file in the shared editor, or show the shared docs pane',
      argumentHint: '[file]',
    })
    $.clock.every(POLL_MS, () => void refresh($))
    void refresh($)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    isTurnRunning = true
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) isTurnRunning = false
    return next(e)
  })

  // The agent's own md-editor calls mark which documents are this session's,
  // so a review is announced to the session working on it and no other.
  on('tool.call', async ($, e, next) => {
    const match = /md-editor__(\w+)$/.exec(String(e.tool))
    const path = (e as unknown as { path?: unknown }).path
    if (!match || typeof path !== 'string') return next(e)
    await own($, resolvePath(await $.session.cwd(), path))
    const ran = await next(e)
    if (match[1] !== 'open_document' || ran.deny !== undefined || ran.isError) return ran
    return { ...ran, context: [...(ran.context ?? []), WATCHER_NOTE] }
  })

  on('command.run', { command: 'collab' }, async ($, e) => {
    const arg = e.args.trim().replace(/^(["'])(.*)\1$/, '$2')
    if (!arg) {
      await $.ui.open({ id: PANE, title: PANE_TITLE })
      return { text: 'Opened the shared docs pane.' }
    }
    const path = resolvePath(await $.session.cwd(), arg)
    let doc: DocSummary
    try {
      doc = await openDocument($, path)
    } catch (err) {
      return { text: `Couldn't open ${path}: ${errorText(err)}` }
    }
    await own($, doc.path)
    await refresh($)
    void $.ui.open({ id: PANE, title: PANE_TITLE })
    return {
      text: `${doc.name} is open in the shared editor: ${doc.url}`,
      context: [
        `The person opened ${doc.path} in the shared markdown editor (${doc.url}). ` +
          'Use the collab-md skill to work on it with them; read_document before suggesting edits. ' +
          WATCHER_NOTE,
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const list = await read($, docs)
    const ownedPaths = await read($, owned)

    if (!(await read($, isDaemonUp))) {
      return <Text dimColor>The shared editor isn't running. Open a file with /collab {'<file>'}.</Text>
    }
    if (list.length === 0) {
      return <Text dimColor>No documents are open. Open one with /collab {'<file>'}.</Text>
    }

    const sorted = [...list].sort((a, b) => Number(isOwned(b, ownedPaths)) - Number(isOwned(a, ownedPaths)))
    return (
      <Box flexDirection="column">
        {sorted.map((doc) => (
          <Box key={doc.id} flexDirection="column" marginBottom={1}>
            <Text bold>
              {doc.name}
              {!isOwned(doc, ownedPaths) && <Text dimColor> (another session)</Text>}
            </Text>
            <Text dimColor>
              {plural(doc.suggestions, 'suggestion')}, {plural(doc.openComments, 'comment')}
              {doc.unseenReviews > 0 ? `, ${plural(doc.unseenReviews, 'review')} waiting` : ''}
            </Text>
            <Box flexDirection="row" gap={1}>
              <Link href={linkFor(doc.url)} label="Open editor" />
              {doc.suggestions > 0 && (
                <Button key={`accept-${doc.id}`} label="Accept all" onPress={() => bulk($, doc, 'accept-all')} />
              )}
              {doc.suggestions > 0 && (
                <Button key={`reject-${doc.id}`} label="Reject all" onPress={() => bulk($, doc, 'reject-all')} />
              )}
            </Box>
            <Text dimColor>{doc.url}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
