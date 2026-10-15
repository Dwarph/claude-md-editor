---
name: collab-md
description: Work on a markdown document together with the person in a shared, live WYSIWYG editor. They edit the rendered doc in their browser; your edits arrive as highlighted suggestions they accept or reject, and they can select text and send you code-review style comments. Use whenever the person wants to write, draft, edit, review or iterate on a markdown file (docs, specs, posts, notes, READMEs) with you, says "let's work on this doc together", "open it in the editor", "I'll edit it too", "review my comments", or "review's in", or mentions the shared/markdown editor. Prefer this over editing the file with Edit/Write whenever the person is also editing it.
---

# Collaborating in the shared markdown editor

The person edits a rendered (not raw markdown) view of the file in their browser. You edit the
same document live through the `md-editor` MCP tools. The file on disk always holds the accepted
text, as clean markdown.

**Never use Edit/Write on a file that is open in the editor.** Your change would land as a raw
disk edit, skip review, and fight their cursor. Use the tools below.

## Start

1. `open_document` with the file path (it is created if missing). It returns the editor `url`
   and a `reviewWatcher` command.
2. Show them the editor:
   - In the Claude desktop app, open `url` in the built-in browser (`preview_start` with `url`).
   - Elsewhere, give them the link, or pass `open_browser: true` to open their default browser.
3. Run `reviewWatcher` as a **background** Bash command (`run_in_background: true`). It exits the
   moment they click **Submit review**, which wakes you up. Without it they have to tell you
   "review's in" themselves; the editor shows whether you are listening.

## Making changes

- `read_document` first, every time you start a round of edits: they may have changed things.
  Blocks are numbered `[[block N]]`.
- `suggest_edit` with `find` for wording changes inside one paragraph, heading or list item.
  `find` is the exact rendered text (no `**`, no line breaks), and `replace` is inline markdown.
  If the text appears more than once, lengthen `find` or pass `occurrence`.
- `suggest_edit` with `block` / `blocks: [first, last]` to rewrite whole blocks (any markdown).
  An empty `replace` suggests a deletion.
- `suggest_insert` with `after_block` (`-1` = top) or `before_block` for new paragraphs, lists,
  sections or tables.
- Add a short `note` explaining *why* when the reason isn't obvious.
- Prefer several small, independent suggestions over one big rewrite: they accept or reject
  each one. Don't pile a second suggestion onto text that already has one pending. Use
  `withdraw_suggestion` and re-suggest instead.
- `direct: true` applies a change immediately, but only works if they switched on "Let Claude
  edit directly". Use it only when they've asked you to just make the changes.
- They said "this", "here" or "the bit I've selected"? Call `get_selection`.

## Handling a review

When the watcher exits (or they say "review's in"):

1. `get_review`. Each comment has an `id`, their `comment`, the `quote` it's attached to, and
   the block it sits in. Overall notes come back in `notes`.
2. For each comment:
   - The fix is an edit: suggest it with `resolves_comment: <id>`. Accepting the suggestion
     resolves the comment.
   - The comment asks a question, or you disagree: `reply_to_comment` and leave it open.
   - Nothing to change: `resolve_comment` with a short reply saying why.
3. Restart the `reviewWatcher` in the background.
4. Tell them briefly in chat what you did ("4 suggestions, 1 question back to you on the intro").

## Keeping up

- `list_changes` shows their edits since you last read the doc (as a diff), and which of your
  suggestions they accepted or rejected. Pass the returned `next` as `since` the next time.
- `list_suggestions` shows what's still pending.
- If a suggestion's text has since been rewritten, accepting it fails safely and they'll see
  why. Re-read the doc and suggest again.

## Wrapping up

Nothing needs saving: the file updates as they accept changes. When you're done, say what is
still pending (suggestions, unresolved comments) so nothing is left hanging in the editor.
