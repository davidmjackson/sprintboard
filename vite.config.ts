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
    // `e2e/**`: Playwright specs (named *.spec.ts) match Vitest's default include
    // glob too. They drive a real browser and belong to `npm run e2e`, never the
    // Vitest process — exclude them so `npm test` doesn't try to collect them.
    exclude: [...configDefaults.exclude, '**/.claude/**', 'e2e/**'],
    // Only these prefixes are loaded into the test process — not the developer's
    // entire shell environment. Test credentials must never be VITE_-prefixed:
    // Vite inlines those into the production bundle, which would ship a password
    // to visitors. check-bundle.mjs is the backstop if that rule is ever broken.
    //
    // SUPABASE_SERVICE_ROLE_KEY is a test-only admin key used by the signup
    // integration suite to read the auto-created profile and delete the throwaway
    // user. It is deliberately NOT VITE_-prefixed, so Vite never inlines it — it
    // exists in the test process (and CI's server-side runner) only, never the
    // browser bundle.
    env: loadEnv(mode, process.cwd(), ['VITE_', 'RLS_TEST_', 'SUPABASE_SERVICE_ROLE']),
  },
}))
