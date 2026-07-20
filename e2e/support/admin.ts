// Test-only teardown helper. The happy-path E2E signs up a throwaway user and
// creates a project, tickets and a sprint under it; deleting the auth user removes
// all of it, because every owned table cascades from `auth.users(id) on delete
// cascade` (see docs/sprintboard_phase1_schema.sql).
//
// This talks to the GoTrue admin API over `fetch` rather than through
// @supabase/supabase-js on purpose: supabase-js constructs a RealtimeClient in its
// createClient() constructor, which throws on Node 20 (no native WebSocket global —
// the Vitest setup polyfills one, but Playwright has no equivalent). A plain DELETE
// needs none of that.
//
// The service-role key bypasses RLS entirely, so this must never be imported by
// application code — only by the E2E teardown. It is not VITE_-prefixed, so Vite
// never inlines it into the browser bundle.

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name}. See .env.example.`)
  }
  return value
}

/** Delete a throwaway auth user by id, cascading away every row they own. */
export async function deleteAuthUser(userId: string): Promise<void> {
  const url = requireEnv('VITE_SUPABASE_URL')
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  })
  // 404 means it is already gone — an idempotent teardown, not a failure.
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete test user ${userId}: ${res.status} ${await res.text()}`)
  }
}
