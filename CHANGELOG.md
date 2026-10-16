# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.4](https://github.com/Dwarph/claude-md-editor/releases/tag/v0.4.4) - 2026-10-16

### Added

- Light and dark screenshots in the README, and a rewritten intro.
- `md-editor.plugin` attached to the GitHub release, so Cowork users can download it without building.

### Fixed

- Dropping a dragged block leaves the cursor at the end of what moved instead of selecting it, so the formatting toolbar no longer pops up.
- Clicking away from a selection outside the editor now closes the formatting toolbar.

## [0.4.3](https://github.com/Dwarph/claude-md-editor/compare/726fb3d...565c60b) - 2026-10-16

### Added

- With text selected across several blocks, dragging one block's handle moves every block the selection touches.

### Changed

- One drop line, midway between two blocks, replaces Crepe's line at each block's edge. Dragging a block back to where it started leaves it in place.
- The block handle follows the pointer in the left gutter and moves between blocks faster.
- Backspace and Delete at the start of a heading edit text as they do in a paragraph, rather than dropping the heading a level.
- Typing hashes and a space at the start of a heading sets that level (`##` gives an h2) rather than adding to it.

## [0.4.2](https://github.com/Dwarph/claude-md-editor/compare/cf9aada...726fb3d) - 2026-10-15

### Added

- Replying to a comment thread wakes Claude, just like submitting a review.
- A text type picker in the selection toolbar: text, headings 1-3, bulleted and numbered lists, and quote.
- Comments, replies and Claude's notes render inline markdown.
- A suggestion that resolves a comment sits inside that comment's panel as a "Suggested fix", with its own accept and reject.
- README instructions for building, installing and updating the packaged plugin.

### Changed

- The review bar reads "with you" and "with Claude", and the submit button says how many comments it sends.
- The top bar shows "Claude" in orange with the listening dot beside it, in place of the "C" avatar.
- Comment panels stay beside their text down to 720px wide. Narrower than that, the margin becomes a rail of pins that open threads as overlays.
- Clicking a block handle selects the block's text, so the formatting toolbar appears.

### Fixed

- Dragging a block by its handle works when the pointer stays in the handle column.

## [0.4.0](https://github.com/Dwarph/claude-md-editor/compare/2211761...cf9aada) - 2026-10-15

### Added

- `wait_for_review` tool, so Claude can listen for reviews in Cowork, where it can't run the background watcher.

## [0.3.0](https://github.com/Dwarph/claude-md-editor/compare/7dbead9...2211761) - 2026-10-15

### Changed

- Renamed the plugin to `md-editor`.
- Claude puts any draft longer than a sentence or two in the editor without being asked.
- In the Claude desktop app, the editor opens in the built-in browser pane and comes to the front.

## [0.2.1](https://github.com/Dwarph/claude-md-editor/compare/8707e97...7dbead9) - 2026-10-15

### Fixed

- `suggest_edit` was dropped in Cowork, so Claude could only insert text, never change it.

## [0.2.0](https://github.com/Dwarph/claude-md-editor/compare/d136f9e...8707e97) - 2026-10-15

### Added

- `npm run package:plugin` builds a single `.plugin` file for Cowork: 3.4 MB, down from 28 MB.
- `open_document` takes starting text for new files.

### Changed

- A fresh install starts in under a second instead of timing out. The server runs Milkdown on linkedom instead of jsdom.
- `open_document` only creates missing files when asked, so a wrong path gets a clear error.
- The skill works outside the Code tab: it opens your default browser, and falls back to "review's in" where background commands can't run.

## [0.1.0](https://github.com/Dwarph/claude-md-editor/tree/d136f9e) - 2026-10-15

### Added

- Shared WYSIWYG markdown editor: you edit the rendered doc in your browser while Claude edits the same doc live through MCP tools.
- Claude's edits arrive as suggestions you accept or reject, and code-review style comments wake Claude when you submit them.
- "Claude can: Edit live / Suggest / Read only" switch for each document.
- Light and dark themes, with Claude's notes and your comments in panels in the right margin.
- Optional Claude Code mod with review notifications, a Shared docs pane, `/collab` and a status line.
