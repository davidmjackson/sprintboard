import path from 'node:path'
import { defineConfig } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // Claude Code puts subagent git worktrees under .claude/worktrees/ — full
    // repo copies, inside the repo. Without this, vitest collects their test
    // files too and reports double the tests, all passing, from stale code.
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
})
