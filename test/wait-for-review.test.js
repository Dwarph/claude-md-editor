// wait_for_review is how Claude hears about a review where it can't run the
// background watcher (Cowork): it must return quietly when nothing arrives, and
// hand back the review as soon as one is submitted.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const PORT = '4691'
const API = `http://127.0.0.1:${PORT}/api`
const dir = mkdtempSync(join(tmpdir(), 'cmd-wait-'))
const file = join(dir, 'doc.md')
let client

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  return result.content[0].text
}

beforeAll(async () => {
  writeFileSync(file, 'Ship on Friday.\n')
  client = new Client({ name: 'wait-test', version: '0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '..', 'server', 'mcp.js')],
    env: { ...process.env, CLAUDE_MD_EDITOR_HOME: join(dir, 'state'), CLAUDE_MD_EDITOR_PORT: PORT },
  }))
}, 120_000)

afterAll(async () => {
  await fetch(`${API}/shutdown`, { method: 'POST' }).catch(() => {})
  await client?.close()
})

describe('wait_for_review', () => {
  it('returns "No review yet" when nothing is submitted in time', async () => {
    const started = Date.now()
    expect(await call('wait_for_review', { path: file, timeout_seconds: 5 })).toMatch(/^No review yet/)
    expect(Date.now() - started).toBeGreaterThan(3500)
  }, 30_000)

  it('returns the review as soon as the person submits one', async () => {
    const { id } = await fetch(`${API}/agent/open_document`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file }),
    }).then((r) => r.json())
    const waiting = call('wait_for_review', { path: file, timeout_seconds: 30 })
    await new Promise((r) => setTimeout(r, 500))
    const started = Date.now()
    await fetch(`${API}/docs/${id}/submit-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'Say which Friday' }),
    })
    const result = JSON.parse(await waiting)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result).toMatchObject({ status: 'Review submitted', notes: ['Say which Friday'] })

    // The review is marked seen, so the next wait listens for a new one.
    expect(await call('wait_for_review', { path: file, timeout_seconds: 5 })).toMatch(/^No review yet/)
  }, 60_000)
})
