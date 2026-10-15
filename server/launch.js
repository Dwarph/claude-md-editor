// MCP entry point. Uses only Node built-ins so it can install the plugin's
// dependencies on first run (a plugin installed from git has no node_modules),
// then hands over to the real server.
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
if (!existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk'))) {
  // stdout is the MCP channel: send npm's output to stderr.
  execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: root, stdio: ['ignore', 2, 2] })
}
await import('./mcp.js')
