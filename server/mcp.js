// MCP server (stdio) the plugin registers: thin tools over the daemon's API.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { join, resolve } from 'node:path'
import { api, ensureDaemon } from './client.js'
import { ENTRY, VERSION } from './paths.js'

const CLI = ENTRY.cli

const server = new McpServer(
  { name: 'md-editor', version: VERSION },
  {
    instructions:
      'Shared markdown editor: the person edits a rendered (WYSIWYG) view in their browser while you edit the same file live. ' +
      'Use it by default whenever you draft or rework text longer than a sentence or two with the person (a project update, a paragraph, an email, a post, a doc), ' +
      'even if they never mention the editor: put the draft in a markdown file and open it here instead of replying with it in chat. ' +
      'Skip it for one-line answers, code, or when they ask for the text in chat. ' +
      'Never edit an open document with Edit/Write; use these tools so your changes arrive as suggestions the person accepts or rejects. ' +
      'Load the collab-md skill for the full workflow.',
  },
)

const path = z.string().describe('Path to the markdown file (absolute, or relative to the current project).')
const abs = (p) => resolve(process.cwd(), p)
const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] })

/** Wrap a handler so daemon errors come back as tool errors the model can read. */
const tool = (name, config, handler) =>
  server.registerTool(name, config, async (args, extra) => {
    try {
      return text(await handler(args, extra))
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
    'Open a markdown file in the shared editor and return its URL. Use it for any draft longer than a sentence or two that you write ' +
    'with the person, not only when they ask for the editor. Then show it to the person: in a Claude app UI with a built-in browser pane, ' +
    'open the URL there and bring that pane to the front; only without a pane of your own, pass open_browser to open their default browser. ' +
    'Always give them the link as well. Then start the review watcher it returns ' +
    'as a background command if you can run one; otherwise listen with wait_for_review.',
  inputSchema: {
    path,
    open_browser: z.boolean().optional().describe("Also open the URL in the person's default browser (use when you have no browser pane of your own)."),
    create: z.boolean().optional().describe('Create the file if it does not exist yet. Leave unset when opening an existing file, so a wrong path is reported.'),
    content: z.string().optional().describe('Starting markdown for a file being created (e.g. text from the chat). Written as-is, not as a suggestion. Ignored if the file exists.'),
  },
}, async ({ path: p, open_browser, create, content }) => {
  const doc = await api('agent/open_document', { path: abs(p), create, content })
  if (open_browser) openInSystemBrowser(doc.url)
  return {
    ...doc,
    reviewWatcher: `node "${CLI}" wait-review "${abs(p)}"`,
    next: 'If you can run background shell commands on this machine, run reviewWatcher in the background so you are woken when the person submits review comments. ' +
      'Otherwise (e.g. in Cowork) tell them you are listening, then call wait_for_review.',
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
}

tool('suggest_edit', {
  title: 'Suggest an edit',
  description:
    'Propose replacing text. Either `find` exact rendered text inside one block (no markdown syntax) and give inline markdown in `replace`, ' +
    'or replace whole blocks by `block` / `blocks` [first, last] with any markdown. An empty `replace` suggests deleting. ' +
    'What happens depends on the mode the person set (read_document shows it): Suggest makes a highlighted suggestion they accept or reject, ' +
    'Edit live applies it straight away, Read only refuses.',
  inputSchema: {
    path,
    find: z.string().optional().describe('Exact text to replace, as it reads in the rendered document, within one paragraph/heading/list item.'),
    occurrence: z.number().int().min(1).optional().describe('Which match of `find` (1-based) if it appears more than once.'),
    block: z.number().int().min(0).optional().describe('Replace this whole block (number from read_document).'),
    // A plain two-item array, not z.tuple: tuples become array-form `items`, which some
    // clients (Cowork) reject, dropping the whole tool.
    blocks: z.array(z.number().int().min(0)).length(2).optional().describe('Replace blocks first..last inclusive, as [first, last].'),
    replace: z.string().describe('Replacement markdown. Inline only when using `find`.'),
    ...suggestionExtras,
  },
}, async ({ path: p, find, occurrence, block, blocks, replace, note, resolves_comment }) => {
  const target = find !== undefined ? { find, occurrence } : blocks ? { blocks } : block !== undefined ? { block } : null
  if (!target) throw new Error('Give `find`, `block` or `blocks`.')
  return api('agent/suggest', { path: abs(p), target, markdown: replace, note, resolves: resolves_comment })
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
}, async ({ path: p, after_block, before_block, markdown, note, resolves_comment }) => {
  const target = after_block !== undefined ? { after_block } : before_block !== undefined ? { before_block } : null
  if (!target) throw new Error('Give `after_block` or `before_block`.')
  return api('agent/suggest', { path: abs(p), target, markdown, note, resolves: resolves_comment })
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
    'A comment with newReply: true has a new reply from the person at the end of its thread: answer that reply. ' +
    'Address each by suggesting an edit with resolves_comment, and/or reply_to_comment. Then restart the review watcher, or wait_for_review again.',
  inputSchema: { path },
}, async ({ path: p }) => api('agent/get_review', { path: abs(p) }))

// Cowork cancels a tool call after about a minute, so the default stays under that;
// a call that runs out returns quietly and the agent calls again.
const WAIT_DEFAULT_S = 50

tool('wait_for_review', {
  title: 'Wait for review',
  description:
    'Listen for the person to submit a review or reply to a comment thread, for when you cannot run the background reviewWatcher (e.g. in Cowork). ' +
    'Blocks until they do, then returns the review (the same as get_review). If nothing arrives within timeout_seconds ' +
    'it returns "No review yet": call it again to keep listening. Your turn keeps running while you listen, so first tell ' +
    'the person you are listening and that sending you a message stops it.',
  inputSchema: {
    path,
    timeout_seconds: z.number().int().min(5).max(1800).optional()
      .describe(`How long this call waits (default ${WAIT_DEFAULT_S}). Keep the default unless you know your client allows longer tool calls.`),
  },
}, async ({ path: p, timeout_seconds }, extra) => {
  const file = abs(p)
  const { id } = await api('agent/open_document', { path: file })
  const deadline = Date.now() + (timeout_seconds ?? WAIT_DEFAULT_S) * 1000
  // The daemon answers each long-poll within 25s: ask again until the deadline.
  while (deadline - Date.now() > 1000) {
    const notice = await api(`docs/${id}/wait-review?timeout=${deadline - Date.now()}`, {}, { method: 'GET', signal: extra?.signal })
    if (notice) {
      return {
        status: 'Review submitted',
        ...(await api('agent/get_review', { path: file })),
        next: 'Address each comment (suggest_edit with resolves_comment, and/or reply_to_comment), then call wait_for_review again.',
      }
    }
  }
  return 'No review yet. Call wait_for_review again to keep listening.'
})

tool('reply_to_comment', {
  title: 'Reply to a comment',
  description: 'Answer a review comment in its thread (questions, pushback, or what you changed). ' +
    'The body may use inline markdown: **bold**, *italic*, `code`, ~~strikethrough~~ and [links](https://example.com).',
  inputSchema: { path, comment_id: z.string(), body: z.string() },
}, async ({ path: p, comment_id, body }) => api('agent/reply_to_comment', { path: abs(p), id: comment_id, body }))

tool('resolve_comment', {
  title: 'Resolve a comment',
  description: 'Mark a review comment resolved, optionally with a final reply (inline markdown allowed). Prefer resolves_comment on a suggestion when the fix is an edit.',
  inputSchema: { path, comment_id: z.string(), body: z.string().optional() },
}, async ({ path: p, comment_id, body }) => api('agent/resolve_comment', { path: abs(p), id: comment_id, body }))

tool('list_documents', {
  title: 'List open documents',
  description: 'Documents open in the shared editor, with URLs and counts of suggestions and comments.',
  inputSchema: {},
}, async () => api('agent/list_documents'))

await server.connect(new StdioServerTransport())

// Start the editor server now, in the background: a fresh install's first start is slow, and this
// way it's usually ready before the first tool call. Failures surface on that call instead.
ensureDaemon().catch(() => {})
