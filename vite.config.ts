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
    // SUPABASE_DB_URL is the SPRIN-107 concurrency suite's direct Postgres connection,
    // on the same footing and for the same reason.
    //
    // WHAT THIS LIST ACTUALLY GOVERNS, corrected after the SPRIN-107 review measured it. It
    // decides what `loadEnv` lifts out of `.env.local` — and NOTHING ELSE. A variable that is
    // genuinely EXPORTED reaches the test worker whether or not it is named here, because
    // Vitest merges `test.env` into `process.env` rather than replacing it. Measured both ways
    // with the entry deleted: exported -> visible; `.env.local` only -> not visible.
    //
    // So the consequence of forgetting an entry is asymmetric, and the first draft of this
    // comment had it backwards. In CI, where verify.yml supplies these as step-level `env:`,
    // omitting a name changes NOTHING and the suite still runs. LOCALLY it silently skips, with
    // a console.warn that is easy to scroll past, and it skips indefinitely because CI stays
    // green. `requireOrExplain` does not backstop this: it fires on an ABSENT SECRET, which is
    // a different failure from an absent allow-list entry.
    env: loadEnv(mode, process.cwd(), [
      'VITE_',
      'RLS_TEST_',
      'SUPABASE_SERVICE_ROLE',
      'SUPABASE_DB_URL',
    ]),
  },
}))
