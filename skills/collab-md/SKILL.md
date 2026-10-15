---
name: collab-md
description: The default place to write any prose with the person. A shared, live WYSIWYG markdown editor they edit in their browser while your changes arrive as suggestions they accept or reject, and they select text to send you code-review style comments. Use it by default whenever you draft, rewrite or iterate on text longer than a sentence or two with them (a project or status update, a paragraph, an email, a Slack post, an announcement, a spec, notes, a README), even if they never mention markdown, a file or the editor. Also use it when they say "let's work on this together", "open it in the editor", "I'll edit it too", "review my comments" or "review's in". Skip it only for one-line answers, code, or when they ask for the text in chat. Prefer this over Edit/Write whenever they're also editing the file.
---

# Collaborating in the shared markdown editor

The person edits a rendered (not raw markdown) view of the file in their browser. You edit the
same document live through the `md-editor` MCP tools. The file on disk always holds the accepted
text, as clean markdown.

**Never use Edit/Write on a file that is open in the editor.** Your change would land as a raw
disk edit, skip review, and fight their cursor. Use the tools below.

## When to use it

This is the default for any writing you do with the person, not something they have to ask for.
If the text is longer than a sentence or two (a project update, a paragraph, an email, a Slack
post, a check-in, a doc), put it in the editor instead of replying with it in chat, even when
they only asked you to "write" or "draft" something.

- Skip it for one-line answers, code, or when they ask for the text in chat.
- Another skill shapes the words (a voice or house-style skill, a check-in template)? Follow it
  for the writing, then put the result in the editor.
- Once the text is in the editor, keep the chat short: the link and a line on what you wrote.
  Don't paste the whole draft into chat as well.

## Start

1. Find or make the file.
   - Working on an existing file: use its full path.
   - The text is in the chat (something you drafted, or they pasted): save it as a new markdown
     file in their working folder first, with a short descriptive name, and tell them where.
     Create it with `open_document`, `create: true` and the text as `content`. It goes in as
     their starting text, not as a suggestion.
2. `open_document` with the path. It returns the editor `url` and a `reviewWatcher` command.
   - It refuses a path that doesn't exist unless you pass `create: true`. If an existing file
     isn't found, the editor may run outside your sandbox and see your files under a different
     path (this happens in Cowork). Ask the person where the file lives on their computer, or
     offer to create a copy in a folder they name. Never pass `create: true` to work around a
     missing file.
3. Show them the editor, and always give them the link as well:
   - In a Claude app UI with a built-in browser pane (the Code tab or Cowork in the Claude
     desktop app; its tools are named like `mcp__Claude_Browser__*`), always open `url` there,
     not in their default browser: `preview_start` with `url`. Then make sure the pane is in
     front, so they see the editor without looking for it. If the pane is hidden or another tab
     is in front, bring the editor's tab forward (`tabs_select`).
   - Only with no browser pane of your own (a terminal, an IDE) pass `open_browser: true` to
     `open_document`, so it opens in their default browser.
4. If you can run background shell commands on their machine (Claude Code), run
   `reviewWatcher` as a **background** Bash command (`run_in_background: true`). It exits the
   moment they click **Submit review**, which wakes you up. Skip it if you've been told the
   md-editor mod is loaded (it tells you about reviews itself), or if you can't run
   background commands or the command fails, as in Cowork. In that case, tell them once:
   "When you've submitted your review, tell me 'review's in'."

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
- The person sets your mode in the editor, and `read_document` shows it on its second line:
  - **Suggest** (default): your edits become suggestions they accept or reject.
  - **Edit live**: the same tools apply your edits straight away, so keep them as careful and
    small as suggestions. They can't reject them, only edit over them.
  - **Read only**: edit tools are refused. Reply to comments or answer in chat instead, and
    don't ask them to change the mode unless they want your edits in the document.
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
3. Restart the `reviewWatcher` in the background, if you're using one.
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
