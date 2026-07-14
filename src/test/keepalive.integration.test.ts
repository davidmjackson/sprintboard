// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  assertSupabaseConfigOrExplain,
  hasSupabaseConfig,
  supabaseConfig,
} from './supabase-clients'

assertSupabaseConfigOrExplain()

/**
 * The exact contract the cron-job.org keepalive depends on. `/rest/v1/` is NOT
 * usable: it 401s for anon ("Only the `service_role` API key can be used"), and
 * the only way to make it work would be to ship the service-role key to a third
 * party. Never do that. See the S1.4 spec.
 */
const KEEPALIVE_PATH = '/rest/v1/tickets?select=id&limit=1'

describe.skipIf(!hasSupabaseConfig)('Supabase keepalive contract', () => {
  it('answers 200 with a JSON array, proving Postgres ran the query', async () => {
    const { url, anonKey } = supabaseConfig()

    const response = await fetch(`${url}${KEEPALIVE_PATH}`, {
      headers: { apikey: anonKey },
    })

    expect(response.status).toBe(200)

    // A 200 alone is not proof of life — a cached edge response would return one
    // forever while the database slept. PostgREST returns a result SET; its
    // errors return an object. An array means Postgres actually ran the query.
    // The array is empty because RLS filters an anonymous caller to zero rows,
    // which is the success signal, not a failure.
    const body: unknown = await response.json()
    expect(Array.isArray(body)).toBe(true)
  })
})
