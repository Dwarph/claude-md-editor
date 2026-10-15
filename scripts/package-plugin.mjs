// Builds build/claude-md-editor.plugin: the plugin as one zip that Cowork (or
// Claude Code) installs as-is. The server goes in as single-file bundles
// (dist-server/), so there's no node_modules, no install step and no network
// access on first run, and a fresh install starts quickly.
//
//   npm run package:plugin
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const { name, version } = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'))
const buildDir = join(root, 'build')
const stage = join(buildDir, name)
const out = join(buildDir, `${name}.plugin`)

// What the installed plugin needs. Not the mod (Claude Code only, installed
// separately), tests, sources of the web build, or the marketplace manifest.
const INCLUDE = [
  '.claude-plugin/plugin.json',
  '.mcp.json',
  'skills',
  'server/launch.js',
  'web/dist',
  'package.json',
  'README.md',
  'LICENSE',
]

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === 'npm' })

if (!existsSync(join(root, 'web', 'dist', 'index.html'))) {
  console.error('web/dist is missing: run `npm run build` first.')
  process.exit(1)
}

rmSync(stage, { recursive: true, force: true })
rmSync(out, { force: true })
mkdirSync(stage, { recursive: true })
for (const entry of INCLUDE) cpSync(join(root, entry), join(stage, entry), { recursive: true })

console.log('Bundling the server…')
run(process.execPath, [join(root, 'scripts', 'build-server.mjs'), join(stage, 'dist-server')], root)

console.log('Zipping…')
const tmpZip = `${out}.zip`
const top = ['.claude-plugin', '.mcp.json', 'skills', 'server', 'dist-server', 'web', 'package.json', 'README.md', 'LICENSE']
if (process.platform === 'win32') {
  // Windows ships bsdtar, which writes zip with forward-slash paths. Name it in full: Git Bash's
  // GNU tar may come first on PATH and can't write zip.
  run(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['--format', 'zip', '-cf', tmpZip, '-C', stage, ...top], root)
} else {
  run('zip', ['-qr', tmpZip, ...top, '-x', '*.DS_Store'], stage)
}
renameSync(tmpZip, out)
console.log(`Built ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB), version ${version}`)
