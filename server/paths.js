import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readFileSync } from 'node:fs'

// Everything the daemon keeps lives here, never next to the person's files.
export const STATE_DIR = process.env.CLAUDE_MD_EDITOR_HOME ?? join(homedir(), '.claude-md-editor')
export const DOCS_DIR = join(STATE_DIR, 'docs')
export const DAEMON_FILE = join(STATE_DIR, 'daemon.json')
export const LOG_FILE = join(STATE_DIR, 'daemon.log')

export const ROOT_DIR = resolve(import.meta.dirname, '..')
export const WEB_DIST = join(ROOT_DIR, 'web', 'dist')
export const VERSION = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8')).version

// The packaged plugin runs single-file bundles from dist-server/ (no node_modules);
// the repo runs the sources. Each entry point starts its siblings the same way.
const BUNDLE_DIR = join(ROOT_DIR, 'dist-server')
const BUNDLED = resolve(import.meta.dirname) === resolve(BUNDLE_DIR)
export const ENTRY = BUNDLED
  ? { daemon: join(BUNDLE_DIR, 'daemon.mjs'), cli: join(BUNDLE_DIR, 'cli.mjs') }
  : { daemon: join(ROOT_DIR, 'server', 'daemon-main.js'), cli: join(ROOT_DIR, 'server', 'cli.js') }

export const DEFAULT_PORT = Number(process.env.CLAUDE_MD_EDITOR_PORT ?? 4545)

/** Canonical absolute path; case-folded on Windows so one file gets one id. */
export function canonicalPath(path) {
  const abs = resolve(path)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

/** Stable short id for a document, derived from its path. */
export function docIdFor(path) {
  return createHash('sha1').update(canonicalPath(path)).digest('hex').slice(0, 12)
}
