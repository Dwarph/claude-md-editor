import { defineConfig } from 'vite'

const daemon = `http://127.0.0.1:${process.env.CLAUDE_MD_EDITOR_PORT ?? 4545}`

export default defineConfig({
  root: 'web',
  base: '/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  server: {
    // `npm run dev:web` against a running daemon, for working on the UI.
    proxy: {
      '/api': daemon,
      '/ws': { target: daemon.replace('http', 'ws'), ws: true },
    },
  },
})
