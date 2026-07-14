// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { supabaseConfig } from './supabase-clients'

/**
 * The exact contract the cron-job.org keepalive depends on. `/rest/v1/` is NOT
 * usable: it 401s for anon ("Only the `service_role` API key can be used"), and
 * the only way to make it work would be to ship the service-role key to a third
 * party. Never do that. See the S1.4 spec.
 */
const KEEPALIVE_PATH = '/rest/v1/tickets?select=id&limit=1'

/**
 * No skip. Unlike the RLS test users, which a casual contributor may
 * legitimately not have locally, `VITE_SUPABASE_URL` and
 * `VITE_SUPABASE_ANON_KEY` are required for the app to boot at all — `npm run
 * dev` will not start without them. There is no developer state where they are
 * absent but a green run here would be meaningful, so `supabaseConfig()` throws
 * rather than letting this suite skip. A liveness probe has no legitimate skip.
 */
describe('Supabase keepalive contract', () => {
  it('answers 200 with a JSON array, proving the anon path still returns a result set', async () => {
    const { url, anonKey } = supabaseConfig()

    const response = await fetch(`${url}${KEEPALIVE_PATH}`, {
      headers: { apikey: anonKey },
    })

    expect(response.status).toBe(200)

    // PostgREST returns a result SET on success and an error OBJECT on failure
    // (e.g. the 401 body `/rest/v1/` gives anon). An array proves the anon
    // contract this cron depends on still holds — it is not evidence of
    // liveness by itself (a cached response would also be an array); liveness
    // is the external cron's job, not this test's. The array is empty because
    // RLS filters an anonymous caller to zero rows, which is the success
    // signal, not a failure.
    const body: unknown = await response.json()
    expect(Array.isArray(body)).toBe(true)
  })
})
