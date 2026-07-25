// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * SPRIN-46 — the service-role secret travels in `apikey`, never `Authorization`.
 *
 * This pins the fix for the ES256 live-suite flake. The project's API keys are the
 * new opaque `sb_*` format rather than HS256 JWTs, and supabase-js copies the key
 * into `Authorization: Bearer` as well as `apikey`. GoTrue tries to JWT-verify that
 * bearer copy, finds no `kid`, and intermittently rejects the request with
 * "unrecognized JWT kid <nil> for algorithm ES256" — a red required check on good
 * code. `apikeyOnlyFetch` deletes the header so the JWT path is never entered.
 *
 * Deliberately a unit test, not an integration one: it needs no credentials and
 * makes no network call, so it guards the contract on every run — including a bare
 * `test:unit` — rather than only when live secrets happen to be configured. The
 * fake credentials below are literals, not real keys.
 */

const FAKE_URL = 'https://project.supabase.co'
const FAKE_ANON_KEY = 'sb_publishable_not_a_real_key'
const FAKE_SECRET_KEY = 'sb_secret_not_a_real_key'

/**
 * Import the module against a known, fake credential set. It reads `process.env`
 * once at module scope, so the stubs must be in place before `import` and the
 * registry reset to defeat the cache from a previous test.
 */
async function loadWithFakeCredentials(): Promise<typeof import('./supabase-clients')> {
  vi.stubEnv('VITE_SUPABASE_URL', FAKE_URL)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', FAKE_ANON_KEY)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', FAKE_SECRET_KEY)
  vi.resetModules()
  return import('./supabase-clients')
}

/** Record the headers of every outbound request; answer plausibly, hit no network. */
function captureRequests(): Array<{ url: string; headers: Headers }> {
  const calls: Array<{ url: string; headers: Headers }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}))
    calls.push({ url, headers })
    // PostgREST returns a result set; GoTrue returns an object.
    const body = url.includes('/auth/v1/') ? '{}' : '[]'
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  })
  return calls
}

/** The headers of the one request expected — asserted rather than assumed. */
function onlyRequest(calls: Array<{ url: string; headers: Headers }>): Headers {
  const [call] = calls
  if (call === undefined) throw new Error('expected a request, but fetch was never called')
  return call.headers
}

/** The headers of the request whose URL contains `fragment`. */
function requestTo(calls: Array<{ url: string; headers: Headers }>, fragment: string): Headers {
  const call = calls.find((c) => c.url.includes(fragment))
  if (call === undefined) throw new Error(`expected a request to ${fragment}, saw none`)
  return call.headers
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('apikeyOnlyFetch', () => {
  it('deletes the Authorization header whatever its casing', async () => {
    const { apikeyOnlyFetch } = await loadWithFakeCredentials()
    const calls = captureRequests()

    await apikeyOnlyFetch('https://example.test/x', {
      headers: { apikey: 'k', Authorization: 'Bearer k' },
    })

    expect(onlyRequest(calls).has('authorization')).toBe(false)
  })

  it('leaves the apikey header and the rest of the request untouched', async () => {
    const { apikeyOnlyFetch } = await loadWithFakeCredentials()
    const calls = captureRequests()

    await apikeyOnlyFetch('https://example.test/x', {
      method: 'POST',
      body: '{"email":"a@example.com"}',
      headers: { apikey: 'k', Authorization: 'Bearer k', 'content-type': 'application/json' },
    })

    const headers = onlyRequest(calls)
    expect(headers.get('apikey')).toBe('k')
    expect(headers.get('content-type')).toBe('application/json')

    const [forwarded] = vi.mocked(globalThis.fetch).mock.calls
    if (forwarded === undefined) throw new Error('fetch was never called')
    expect(forwarded[1]?.method).toBe('POST')
    expect(forwarded[1]?.body).toBe('{"email":"a@example.com"}')
  })
})

describe('adminClient credential transport', () => {
  it('sends the service-role secret to GoTrue in apikey alone', async () => {
    const { adminClient } = await loadWithFakeCredentials()
    const calls = captureRequests()

    await adminClient().auth.admin.deleteUser('11111111-1111-1111-1111-111111111111')

    const headers = requestTo(calls, '/auth/v1/')
    expect(headers.get('apikey')).toBe(FAKE_SECRET_KEY)
    expect(headers.has('authorization')).toBe(false)
  })

  it('sends the service-role secret to PostgREST in apikey alone', async () => {
    const { adminClient } = await loadWithFakeCredentials()
    const calls = captureRequests()

    await adminClient().from('profiles').select('display_name')

    const headers = requestTo(calls, '/rest/v1/')
    expect(headers.get('apikey')).toBe(FAKE_SECRET_KEY)
    expect(headers.has('authorization')).toBe(false)
  })
})

describe('the strip is scoped to the admin client', () => {
  /**
   * The anon and signed-in clients must keep `Authorization`: for them it carries
   * the user's access token, and supabase-js swaps it per request as the session
   * changes. Applying `apikeyOnlyFetch` to those would silently downgrade every
   * request to the anon role — RLS would then hide the caller's own rows rather
   * than raise, which is exactly the failure mode that passes for the wrong reason.
   * This test exists so "tidying up" by sharing one fetch wrapper goes red.
   */
  it('leaves the anon client sending Authorization', async () => {
    const { anonClient } = await loadWithFakeCredentials()
    const calls = captureRequests()

    await anonClient().from('profiles').select('display_name')

    expect(requestTo(calls, '/rest/v1/').get('authorization')).toBe(`Bearer ${FAKE_ANON_KEY}`)
  })
})
