// MCP entry point (see .mcp.json). Uses only Node built-ins.
// The packaged plugin runs the single-file bundle in dist-server/ and needs no
// dependencies. Run from the repo, it uses the sources, installing their
// dependencies first if they're missing.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const bundle = join(root, 'dist-server', 'mcp.mjs')
if (existsSync(bundle)) {
  await import(pathToFileURL(bundle).href)
} else {
  if (!existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
    // stdout is the MCP channel: send npm's output to stderr.
    execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: root, stdio: ['ignore', 2, 2] })
  }
  await import('./mcp.js')
}
