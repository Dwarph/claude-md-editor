// Bundles the server into single files (mcp, daemon, cli) in the folder given
// as the first argument (default: dist-server/), so
// the packaged plugin ships no node_modules. A fresh install then loads three
// files instead of thousands, which is most of a cold start's cost.
import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outdir = resolve(process.argv[2] ?? join(root, 'dist-server'))
rmSync(outdir, { recursive: true, force: true })

await build({
  entryPoints: {
    mcp: join(root, 'server', 'mcp.js'),
    daemon: join(root, 'server', 'daemon-main.js'),
    cli: join(root, 'server', 'cli.js'),
  },
  outdir,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'linked',
  logLevel: 'warning',
  // Bundled CommonJS dependencies still call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  // ws's optional native speed-ups; it runs fine without them.
  external: ['bufferutil', 'utf-8-validate'],
})
console.log(`Built ${outdir} (mcp.mjs, daemon.mjs, cli.mjs)`)
