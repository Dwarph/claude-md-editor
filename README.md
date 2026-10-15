# claude-md-editor

A shared markdown editor for writing with Claude. You edit the **rendered** document (not raw
markdown) in your browser. Claude edits the same document live, and its changes show up as
highlighted suggestions you accept or reject. Select any text to leave Claude a comment, then
submit them together like a code review. Claude is woken up automatically when you do.

The file on disk is always plain markdown holding the accepted text, so it works with git and
every other tool.

Built entirely on free, open-source parts: [Milkdown](https://milkdown.dev) (Crepe editor),
[Yjs](https://yjs.dev), y-prosemirror and the MCP SDK. No accounts, API keys or hosted services:
everything runs on `127.0.0.1`.

## Install

As a Claude Code plugin, from this repo:

```
/plugin marketplace add Dwarph/claude-md-editor
/plugin install claude-md-editor@claude-md-editor
```

Or from a local clone, for development:

```bash
npm install
claude --plugin-dir /path/to/claude-md-editor
```

Requires Node 20+. On first start, the plugin installs its own dependencies (`npm ci`) if
they're missing, which can take a minute.

## Use

Ask Claude to open a file, for example *"let's work on docs/launch.md together in the editor"*.
The `collab-md` skill takes it from there:

- Claude opens the doc and shows you the editor (the built-in browser in the Claude desktop app,
  or a link elsewhere).
- **Claude's edits** appear inline: red strikethrough for removed text and green for new text,
  with ✓ / ✕ beside each one. They're also listed in the sidebar, with **Accept all** and
  **Reject all**.
- **Your edits** go straight into the document. Claude sees them the next time it reads.
- **Comments:** select text, then press **💬 Comment** (or Ctrl+Alt+M). Comments stay drafts
  until you press **Submit review**. Claude replies in the thread, or suggests a fix that
  resolves the comment when you accept it.
- **Notify:** the top bar shows *Claude is listening* when Claude's review watcher is running.
  Submitting then wakes Claude automatically. If it isn't listening, tell Claude "review's in".
- **Let Claude edit directly** skips suggestions for when you just want the changes made.

## How it works

```
Claude ──MCP (stdio)──> server/mcp.js ──HTTP──┐
                                              ├──> daemon (127.0.0.1:4545) <──WebSocket/Yjs──> editor in browser
cli.js wait-review ─────long-poll HTTP────────┘           │
                                                    file.md + ~/.claude-md-editor/docs/<id>.ystate
```

- **One daemon per machine** (`server/daemon.js`) holds a Yjs document per open file. Every MCP
  server, CLI and browser tab talks to it, so two Claude sessions never fight over a file. It
  starts on demand and exits after 30 idle minutes.
- **Suggestions and comments** are stored beside the document in Yjs maps, anchored with Yjs
  relative positions, so they follow the text while either side edits. They're never written
  into the markdown. Sidecar state lives in `~/.claude-md-editor/`, never next to your files.
- **The server runs Milkdown headless** (`server/milkdown.js`, via jsdom), so it parses and
  serializes markdown with exactly the browser's schema. Accepting a suggestion applies a
  ProseMirror transform and writes only the minimal Yjs diff.
- **Edits made outside the editor** (in git, Claude's Edit tool or another editor) are picked up
  by a file watcher and diffed in.
- **Review notifications:** `node server/cli.js wait-review <file>` blocks until you submit a
  review, then exits. Claude runs it as a background command, so the exit wakes it.

## MCP tools

| Tool | What it does |
| --- | --- |
| `open_document` | Open or create a file and return the editor URL and the watcher command |
| `read_document` | Markdown with `[[block N]]` markers, plus pending suggestions and comments |
| `get_selection` | What you've selected in the editor |
| `suggest_edit` | Replace found text (inline) or whole blocks |
| `suggest_insert` | Insert new blocks before or after a block |
| `list_suggestions` / `withdraw_suggestion` | Manage pending suggestions |
| `list_changes` | Your edits since Claude last read the doc (diff), plus accept/reject events |
| `get_review` | Submitted comments, with quotes and context |
| `reply_to_comment` / `resolve_comment` | Answer or close a comment |
| `list_documents` | Everything open in the editor |

## Develop

```bash
npm install
npm run build        # bundles the editor into web/dist (committed, so installs need no build)
npm test             # vitest: round-trips, suggestions, anchors, reviews, persistence
npm run dev:web      # Vite dev server for the UI, proxied to a running daemon
node server/cli.js open some.md   # start the daemon and print a doc's URL
node server/cli.js stop
```

Set `CLAUDE_MD_EDITOR_PORT` and `CLAUDE_MD_EDITOR_HOME` to run an isolated copy for testing.

## Limits (v1)

- Images and math blocks are turned off in the editor, because the server's markdown schema
  doesn't include them yet.
- A suggestion whose text you've rewritten heavily can't be applied. Accepting it fails with a
  message, and you can ask Claude to suggest again.
- The review watcher only notifies a Claude session that's open. A native Claude Code mod
  (planned) could notify without it, and add a sidebar pane and status line.

## License

MIT
