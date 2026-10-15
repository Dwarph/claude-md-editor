#!/usr/bin/env node
// Small CLI over the daemon.
//   wait-review <file>  Block until the person submits a review, print a notice, exit 0.
//                       Run it as a background command so the agent is woken on submit.
//   open <file>         Open a file in the shared editor and print its URL.
//   status              Print open documents.
//   stop                Stop the daemon.
import { resolve } from 'node:path'
import { api, ensureDaemon } from './client.js'

const [command, file] = process.argv.slice(2)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReview(path) {
  const { id, name } = await api('agent/open_document', { path })
  let failures = 0
  for (;;) {
    try {
      const notice = await api(`docs/${id}/wait-review`, {}, { method: 'GET' })
      failures = 0
      if (notice) {
        const count = (n, one, many) => `${n} ${n === 1 ? one : many}`
        const what = [
          notice.comments ? count(notice.comments, 'comment', 'comments') : null,
          notice.replies ? count(notice.replies, 'reply', 'replies') : null,
        ].filter(Boolean).join(', ')
        const title = notice.comments || !notice.replies ? 'Review submitted' : 'New reply'
        console.log(`${title} on ${name}: ${what || '0 comments'}. Call get_review for "${path}", address each comment, then restart this watcher.`)
        return
      }
    } catch (err) {
      // The daemon restarted or went idle: reopen and keep waiting.
      if (++failures > 20) throw err
      await sleep(1000)
      await api('agent/open_document', { path }).catch(() => {})
    }
  }
}

try {
  if (command === 'wait-review' && file) {
    await waitReview(resolve(file))
  } else if (command === 'open' && file) {
    console.log((await api('agent/open_document', { path: resolve(file), create: true })).url)
  } else if (command === 'status') {
    console.log(JSON.stringify(await api('agent/list_documents'), null, 2))
  } else if (command === 'stop') {
    const port = await ensureDaemon()
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST' })
    console.log('Stopped.')
  } else {
    console.error('Usage: cli.js wait-review <file> | open <file> | status | stop')
    process.exit(2)
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
