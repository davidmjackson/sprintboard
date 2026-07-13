import path from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import { configDefaults } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => ({
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
    // Empty prefix = load EVERY variable, not just VITE_*. This reaches the test
    // process only. Test credentials must never be VITE_-prefixed: Vite inlines
    // those into the production bundle, which would ship a password to visitors.
    env: loadEnv(mode, process.cwd(), ''),
  },
}))
