import { defineConfig } from 'vitest/config'

// Separate from vite.config.js, whose root is the web/ folder.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    testTimeout: 20000,
  },
})
