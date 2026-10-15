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

Requires Node 20+ on the machine.

**Cowork (or Claude Code), from the packaged file:** build `build/md-editor.plugin` with
`npm run package:plugin` and add it to Cowork (drop it into a chat and accept it). The package
holds the server as three bundled files, so it needs no install step or network access, and
starts in about a second.

**Claude Code, from this repo:**

```
/plugin marketplace add Dwarph/claude-md-editor
/plugin install md-editor@claude-md-editor
```

Installed this way it runs from source, and installs its dependencies (`npm ci`) on first start.

**From a local clone, for development:**

```bash
npm install
claude --plugin-dir /path/to/claude-md-editor
```

**Where it works:** the editor opens in your browser and talks to a small server on your
computer, so it works wherever Claude's tools run on your own machine. In the Claude desktop
app (the Code tab or Cowork) it opens in the built-in browser pane and brings it to the front;
with no browser pane, such as in a terminal, it opens your default browser. Where Claude can't
run background commands (Cowork), it listens for your review with `wait_for_review` instead, so
its turn keeps running while you edit. Send it a message to stop it listening.

## Use

Ask Claude to open a file, for example *"let's work on docs/launch.md together in the editor"*.
You don't have to ask, though: whenever Claude writes something longer than a sentence or two
with you (a project update, a paragraph, an email), it puts the draft in the editor by default
instead of replying with it in chat. The `collab-md` skill takes it from there:

- Claude opens the doc and shows you the editor (the built-in browser in the Claude desktop app,
  or a link elsewhere).
- **Claude can:** the control in the top bar sets what Claude may do in this document.
  - *Edit live*: its changes land straight away, briefly tinted green.
  - *Suggest* (the default): its changes wait for you to accept them.
  - *Read only*: it can read the doc and reply to comments, but not change anything.
- **Claude's suggestions** appear in the text: removed words in grey with a strikethrough, new
  words tinted green. Each has a panel in the right margin, beside its text, with ✓ and ✕.
- **Your edits** go straight into the document. Claude sees them the next time it reads.
- **Comments:** select text, then press the comment button at the end of the formatting
  toolbar (or Ctrl+Alt+M). The text gets a marker
  highlight, and the comment stays a draft until you press **Submit review**. Claude replies
  in the thread, or suggests a fix that resolves the comment when you accept it.
- **Review bar:** the bar at the bottom counts what's pending and holds **Accept all** and
  **Submit review**.
- **Notify:** a green dot on Claude's avatar means Claude is listening, through its review
  watcher, `wait_for_review` or the [mod](#claude-code-mod). Submitting then wakes Claude automatically. If it
  isn't listening, tell Claude "review's in".

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
- **The server runs Milkdown headless** (`server/milkdown.js`, on linkedom's lightweight DOM), so it parses and
  serializes markdown with exactly the browser's schema. Accepting a suggestion applies a
  ProseMirror transform and writes only the minimal Yjs diff.
- **Edits made outside the editor** (in git, Claude's Edit tool or another editor) are picked up
  by a file watcher and diffed in.
- **Review notifications:** `node server/cli.js wait-review <file>` blocks until you submit a
  review, then exits. Claude runs it as a background command, so the exit wakes it. Where it
  can't (Cowork), Claude calls the `wait_for_review` tool, which holds the same long-poll for up
  to 50 seconds (Cowork cancels tool calls after about a minute) and returns the review, or
  "No review yet" so Claude calls it again.

## Claude Code mod

`mod/` is an optional Claude Code mod (function hooks) that makes the editor feel native inside a
Claude Code session. It only talks to the daemon's HTTP API, so the plugin above is still what
runs the editor.

- **Review notifications without the watcher.** Every 3 seconds it checks the daemon. When you
  submit a review on a doc this session is working on, it prompts Claude ("Review submitted on
  draft.md: 2 comments. Use the collab-md skill…"), or slips the note into the running turn if
  Claude is busy. Each review is announced once, and only to the session that opened the doc.
  It also tells Claude to skip the background `wait-review` watcher.
- **A *Shared docs* pane** listing open documents with their pending suggestions and comments,
  an *Open editor* link, and **Accept all** / **Reject all**. It opens by itself the first time
  this session opens a doc (on wide terminals). The editor itself stays in the browser.
- **`/collab <file>`** opens a file (relative to the session's folder) and shows its URL.
  `/collab` on its own opens the pane.
- **A status line** such as `draft.md: 3 suggestions, 2 comments` while anything is pending.

### Loading it

Mods need a Claude Code build with function hooks (2.1.295 is known to work). Load it from your
clone for one session:

```bash
claude --plugin-dir /path/to/claude-md-editor/mod
```

Where you can't pass a flag (the Claude desktop app, an SDK host), name the folder in
`CLAUDE_CODE_PLUGIN_DIRS`, either in your environment or in the `env` block of
`~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-md-editor/mod" } }
```

Separate several folders with your platform's path separator (`;` on Windows, `:` elsewhere).
Load it alongside the main plugin: the mod notifies and draws, the plugin's MCP tools do the
editing. `/collab <file>` can start the editor by itself when the mod sits inside this repo,
because it falls back to `server/cli.js`.

### Developing it

```bash
claude plugin validate mod   # what the module hooks and calls, and anything the engine would refuse
npm run typecheck:mod        # tsc -p mod
claude plugin test mod       # mod/tests/*.test.ts against the engine, with a fake daemon
```

Claude Code writes the API's type declarations to `mod/.claude-plugin/types/` each time it loads
the mod (they're git-ignored), so run it once with `--plugin-dir` before type-checking a fresh
clone.

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
| `wait_for_review` | Wait up to 50s for a review and return it; for clients without background commands |
| `reply_to_comment` / `resolve_comment` | Answer or close a comment |
| `list_documents` | Everything open in the editor |

## Develop

```bash
npm install
npm run build        # bundles the editor into web/dist (committed, so installs need no build)
npm test             # vitest: round-trips, suggestions, anchors, reviews, persistence
npm run dev:web      # Vite dev server for the UI, proxied to a running daemon
npm run package:plugin   # build/md-editor.plugin: editor plus bundled server, for Cowork
node server/cli.js open some.md   # start the daemon and print a doc's URL
node server/cli.js stop
```

Set `CLAUDE_MD_EDITOR_PORT` and `CLAUDE_MD_EDITOR_HOME` to run an isolated copy for testing.

## Limits (v1)

- Images and math blocks are turned off in the editor, because the server's markdown schema
  doesn't include them yet.
- A suggestion whose text you've rewritten heavily can't be applied. Accepting it fails with a
  message, and you can ask Claude to suggest again.
- Review notifications (watcher, `wait_for_review` or mod) only reach a Claude session that's open.
- In Cowork, Claude's turn stays running while it listens, and each 50-second wait is another
  tool call. It stops listening after about 30 minutes, and then you tell it "review's in".

## License

MIT
