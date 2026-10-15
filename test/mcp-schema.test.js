// Every tool must use JSON Schema that strict clients accept. Cowork silently
// dropped suggest_edit when its schema used a tuple (array-form `items`).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let client
let tools

beforeAll(async () => {
  client = new Client({ name: 'schema-test', version: '0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, '..', 'server', 'mcp.js')],
    // Isolated, so the background server it starts never touches a real one.
    env: { ...process.env, CLAUDE_MD_EDITOR_HOME: join(mkdtempSync(join(tmpdir(), 'cmd-schema-')), 'state'), CLAUDE_MD_EDITOR_PORT: '4690' },
  }))
  tools = (await client.listTools()).tools
})

afterAll(async () => {
  await fetch('http://127.0.0.1:4690/api/shutdown', { method: 'POST' }).catch(() => {})
  await client?.close()
})

/** Paths of every schema node that uses a construct strict validators reject. */
function unsupported(schema, path = '') {
  if (!schema || typeof schema !== 'object') return []
  const found = []
  if (Array.isArray(schema.items)) found.push(`${path}.items is an array (tuple)`)
  if ('prefixItems' in schema) found.push(`${path}.prefixItems`)
  if ('additionalItems' in schema) found.push(`${path}.additionalItems`)
  for (const [key, value] of Object.entries(schema)) {
    if (value && typeof value === 'object') found.push(...unsupported(value, `${path}.${key}`))
  }
  return found
}

describe('MCP tool schemas', () => {
  it('lists every editing tool', () => {
    const names = tools.map((t) => t.name)
    for (const name of ['open_document', 'read_document', 'suggest_edit', 'suggest_insert', 'get_review']) {
      expect(names).toContain(name)
    }
  })

  it('avoid tuple-style arrays that strict clients reject', () => {
    const problems = tools.flatMap((t) => unsupported(t.inputSchema, t.name))
    expect(problems).toEqual([])
  })
})
