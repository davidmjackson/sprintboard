import { defineConfig, devices } from '@playwright/test'
import { loadEnv } from 'vite'

// Playwright runs outside Vite, so `.env.local` is NOT loaded for us the way it is
// for the Vitest process (vite.config.ts wires it in via `test.env`). Load the same
// prefixes here so this process has the service-role key it needs for teardown, and
// the dev server started below inherits the public VITE_ config. Existing process.env
// wins: in CI these arrive as real job env, and there is no `.env.local` to read.
const fileEnv = loadEnv('test', process.cwd(), ['VITE_', 'SUPABASE_SERVICE_ROLE'])
for (const [key, value] of Object.entries(fileEnv)) {
  if (process.env[key] === undefined) process.env[key] = value
}

const PORT = 5173
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  // The flow is long: ~eight live round-trips against a remote database, plus a
  // cold dev-server start. The default 30s is too tight; 120s is comfortable.
  timeout: 120_000,
  // The happy-path suite drives a single real signup against the shared live
  // Supabase project. One worker, no parallelism: concurrent signups trip auth
  // rate-limiting, and concurrent writers can collide on the shared database.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // One retry in CI absorbs a transient auth/network blip; each attempt signs up a
  // fresh unique user and cleans itself up, so a retry never reuses stale state.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
