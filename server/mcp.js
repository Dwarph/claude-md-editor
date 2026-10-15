// MCP server (stdio) the plugin registers: thin tools over the daemon's API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { api } from './client.js'
import { ROOT_DIR, VERSION } from './paths.js'

const CLI = join(ROOT_DIR, 'server', 'cli.js')

const server = new McpServer(
  { name: 'claude-md-editor', version: VERSION },
  {
    instructions:
      'Shared markdown editor: the person edits a rendered (WYSIWYG) view in their browser while you edit the same file live. ' +
      'Never edit an open document with Edit/Write; use these tools so your changes arrive as suggestions the person accepts or rejects. ' +
      'Load the collab-md skill for the full workflow.',
  },
)

const path = z.string().describe('Path to the markdown file (absolute, or relative to the current project).')
const abs = (p) => resolve(process.cwd(), p)
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })

/** Wrap a handler so daemon errors come back as tool errors the model can read. */
const tool = (name, config, handler) =>
  server.registerTool(name, config, async (args) => {
    try {
      return text(await handler(args))
    } catch (err) {
      return { ...text(err.message), isError: true }
    }
  })

function openInSystemBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]]
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

tool('open_document', {
  title: 'Open shared document',
  description:
    'Open (or create) a markdown file in the shared editor and return its URL. Show the URL to the person, or open it for them ' +
    '(in the Claude desktop app use the built-in browser; elsewhere pass open_browser). Then start the review watcher it returns as a background command.',
  inputSchema: { path, open_browser: z.boolean().optional().describe("Also open the URL in the system's default browser.") },
}, async ({ path: p, open_browser }) => {
  const doc = await api('agent/open_document', { path: abs(p) })
  if (open_browser) openInSystemBrowser(doc.url)
  return {
    ...doc,
    reviewWatcher: `node "${CLI}" wait-review "${abs(p)}"`,
    next: 'Run reviewWatcher with run_in_background so you are woken when the person submits review comments.',
  }
})

tool('read_document', {
  title: 'Read shared document',
  description:
    'Current markdown with [[block N]] markers, plus pending suggestions and open comments. Read before suggesting: the person may have edited since.',
  inputSchema: { path },
}, async ({ path: p }) => (await api('agent/read_document', { path: abs(p) })).text)

tool('get_selection', {
  title: "Get the person's selection",
  description: 'What the person has selected (or where their cursor is) in the editor, with the surrounding block. Use for "rewrite this", "this bit".',
  inputSchema: { path },
}, async ({ path: p }) => (await api('agent/get_selection', { path: abs(p) })).selection ?? 'Nothing selected (or the editor is not open).')

const suggestionExtras = {
  note: z.string().optional().describe('Short reason shown beside the suggestion.'),
  resolves_comment: z.string().optional().describe('Comment id this addresses; accepting the suggestion resolves the comment.'),
  direct: z.boolean().optional().describe('Apply immediately instead of suggesting. Only works if the person enabled direct edits.'),
}

tool('suggest_edit', {
  title: 'Suggest an edit',
  description:
    'Propose replacing text. Either `find` exact rendered text inside one block (no markdown syntax) and give inline markdown in `replace`, ' +
    'or replace whole blocks by `block` / `blocks` [first, last] with any markdown. An empty `replace` suggests deleting. ' +
    'Shows as a highlighted suggestion the person accepts or rejects.',
  inputSchema: {
    path,
    find: z.string().optional().describe('Exact text to replace, as it reads in the rendered document, within one paragraph/heading/list item.'),
    occurrence: z.number().int().min(1).optional().describe('Which match of `find` (1-based) if it appears more than once.'),
    block: z.number().int().min(0).optional().describe('Replace this whole block (number from read_document).'),
    blocks: z.tuple([z.number().int().min(0), z.number().int().min(0)]).optional().describe('Replace blocks first..last inclusive.'),
    replace: z.string().describe('Replacement markdown. Inline only when using `find`.'),
    ...suggestionExtras,
  },
}, async ({ path: p, find, occurrence, block, blocks, replace, note, resolves_comment, direct }) => {
  const target = find !== undefined ? { find, occurrence } : blocks ? { blocks } : block !== undefined ? { block } : null
  if (!target) throw new Error('Give `find`, `block` or `blocks`.')
  return api('agent/suggest', { path: abs(p), target, markdown: replace, note, resolves: resolves_comment, direct })
})

tool('suggest_insert', {
  title: 'Suggest new blocks',
  description: 'Propose inserting new markdown blocks (paragraphs, lists, headings, tables...) after or before a block. Use after_block: -1 for the very start.',
  inputSchema: {
    path,
    after_block: z.number().int().min(-1).optional(),
    before_block: z.number().int().min(0).optional(),
    markdown: z.string().describe('Markdown to insert.'),
    ...suggestionExtras,
  },
}, async ({ path: p, after_block, before_block, markdown, note, resolves_comment, direct }) => {
  const target = after_block !== undefined ? { after_block } : before_block !== undefined ? { before_block } : null
  if (!target) throw new Error('Give `after_block` or `before_block`.')
  return api('agent/suggest', { path: abs(p), target, markdown, note, resolves: resolves_comment, direct })
})

tool('list_suggestions', {
  title: 'List pending suggestions',
  description: 'Your suggestions the person has not accepted or rejected yet.',
  inputSchema: { path },
}, async ({ path: p }) => api('agent/list_suggestions', { path: abs(p) }))

tool('withdraw_suggestion', {
  title: 'Withdraw a suggestion',
  description: 'Remove one of your pending suggestions (e.g. to replace it with a better one).',
  inputSchema: { path, id: z.string() },
}, async ({ path: p, id }) => api('agent/withdraw_suggestion', { path: abs(p), id }))

tool('list_changes', {
  title: 'What changed',
  description:
    "The person's text edits since you last read the document (as a line diff) and the events since `since` " +
    '(accepted/rejected suggestions, reviews). Pass the returned `next` as `since` next time.',
  inputSchema: { path, since: z.number().int().min(0).optional() },
}, async ({ path: p, since }) => api('agent/list_changes', { path: abs(p), since }))

tool('get_review', {
  title: 'Get review comments',
  description:
    "The person's submitted review comments: each with its id, comment, the quoted text, block number and block markdown, and thread. " +
    'Address each by suggesting an edit with resolves_comment, and/or reply_to_comment. Then restart the review watcher.',
  inputSchema: { path },
}, async ({ path: p }) => api('agent/get_review', { path: abs(p) }))

tool('reply_to_comment', {
  title: 'Reply to a comment',
  description: 'Answer a review comment in its thread (questions, pushback, or what you changed).',
  inputSchema: { path, comment_id: z.string(), body: z.string() },
}, async ({ path: p, comment_id, body }) => api('agent/reply_to_comment', { path: abs(p), id: comment_id, body }))

tool('resolve_comment', {
  title: 'Resolve a comment',
  description: 'Mark a review comment resolved, optionally with a final reply. Prefer resolves_comment on a suggestion when the fix is an edit.',
  inputSchema: { path, comment_id: z.string(), body: z.string().optional() },
}, async ({ path: p, comment_id, body }) => api('agent/resolve_comment', { path: abs(p), id: comment_id, body }))

tool('list_documents', {
  title: 'List open documents',
  description: 'Documents open in the shared editor, with URLs and counts of suggestions and comments.',
  inputSchema: {},
}, async () => api('agent/list_documents'))

await server.connect(new StdioServerTransport())
