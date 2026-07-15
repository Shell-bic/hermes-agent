import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // Tests exercise ui-tui source directly; resolve the workspace package to
    // its source as well so a clean checkout (or git worktree with a stale
    // node_modules junction) does not require a prebuilt hermes-ink/dist.
    alias: [
      {
        find: /^@hermes\/ink$/,
        replacement: fileURLToPath(new URL('./packages/hermes-ink/src/entry-exports.ts', import.meta.url))
      }
    ]
  },
  test: {
    exclude: ['dist/**', 'node_modules/**']
  }
})
