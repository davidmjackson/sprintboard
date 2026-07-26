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
const FAKE_ACCESS_TOKEN = 'not-a-real-access-token'
const FAKE_USER_ID = '00000000-0000-0000-0000-0000000000aa'

/**
 * Import the module against a known, fake credential set. It reads `process.env`
 * once at module scope, so the stubs must be in place before `import` and the
 * registry reset to defeat the cache from a previous test.
 */
async function loadWithFakeCredentials(): Promise<typeof import('./supabase-clients')> {
  vi.stubEnv('VITE_SUPABASE_URL', FAKE_URL)
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', FAKE_ANON_KEY)
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', FAKE_SECRET_KEY)
  vi.stubEnv('RLS_TEST_A_EMAIL', 'rls-a@example.com')
  vi.stubEnv('RLS_TEST_A_PASSWORD', 'not-a-real-password')
  vi.resetModules()
  return import('./supabase-clients')
}

/** A minimal GoTrue password-grant response, enough for supabase-js to hold a session. */
function tokenGrantBody(): string {
  return JSON.stringify({
    access_token: FAKE_ACCESS_TOKEN,
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: 'not-a-real-refresh-token',
    user: { id: FAKE_USER_ID, aud: 'authenticated', role: 'authenticated' },
  })
}

/** Record the headers of every outbound request; answer plausibly, hit no network. */
function captureRequests(): Array<{ url: string; headers: Headers }> {
  const calls: Array<{ url: string; headers: Headers }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}))
    calls.push({ url, headers })
    // PostgREST returns a result set; GoTrue returns an object — except the
    // password grant, which must look like a real session or signIn() throws.
    const body = url.includes('/auth/v1/token')
      ? tokenGrantBody()
      : url.includes('/auth/v1/')
        ? '{}'
        : '[]'
    return Promise.resolve(
      new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  })
  return calls
}

/** The headers of the one request expected — the "only" is asserted, not assumed. */
function onlyRequest(calls: Array<{ url: string; headers: Headers }>): Headers {
  expect(calls).toHaveLength(1)
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
  // One casing, deliberately. `new Headers({...})` lower-cases at construction and the
  // wrapper's first act is to build one, so `Authorization` / `authorization` /
  // `AuThOrIzAtIoN` are indistinguishable by the time the delete runs: three names for
  // one assertion. The capitalised spelling is the one worth keeping — it is the only
  // one that also catches an implementation which stops using `Headers` and deletes a
  // case-sensitive key off a plain object.
  it('deletes the Authorization header', async () => {
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
    const signal = AbortSignal.timeout(30_000)

    await apikeyOnlyFetch('https://example.test/x', {
      method: 'POST',
      body: '{"email":"a@example.com"}',
      signal,
      headers: { apikey: 'k', Authorization: 'Bearer k', 'content-type': 'application/json' },
    })

    const headers = onlyRequest(calls)
    expect(headers.get('apikey')).toBe('k')
    expect(headers.get('content-type')).toBe('application/json')

    const [forwarded] = vi.mocked(globalThis.fetch).mock.calls
    if (forwarded === undefined) throw new Error('fetch was never called')
    expect(forwarded[1]?.method).toBe('POST')
    expect(forwarded[1]?.body).toBe('{"email":"a@example.com"}')
    // postgrest-js passes an AbortSignal; losing it would silently disable
    // cancellation and request timeouts with nothing else going red.
    expect(forwarded[1]?.signal).toBe(signal)
  })

  it('keeps the apikey when called with a Request rather than (url, init)', async () => {
    const { apikeyOnlyFetch } = await loadWithFakeCredentials()
    const calls = captureRequests()

    // supabase-js never calls fetch this way today, but the exported signature
    // accepts it — and reading headers only from `init` would send the request
    // with no credential at all rather than merely without Authorization.
    const request = new Request('https://example.test/x', {
      method: 'POST',
      body: 'payload',
      headers: { apikey: 'k', Authorization: 'Bearer k' },
    })
    await apikeyOnlyFetch(request)

    const headers = onlyRequest(calls)
    expect(headers.get('apikey')).toBe('k')
    expect(headers.has('authorization')).toBe(false)

    // Forward the Request ITSELF, not a URL rebuilt from it. Re-sending
    // `new Request(input.url, { headers })` would keep the credential but silently
    // discard the method, body and signal, and every header assertion above would
    // still pass.
    const [forwarded] = vi.mocked(globalThis.fetch).mock.calls
    if (forwarded === undefined) throw new Error('fetch was never called')
    expect(forwarded[0]).toBe(request)
  })

  it('lets init headers win over a Request that carries its own', async () => {
    const { apikeyOnlyFetch } = await loadWithFakeCredentials()
    const calls = captureRequests()

    // Precedence matters and is easy to invert while "tidying". Real fetch lets
    // `init.headers` REPLACE a Request's own, so reading the Request first would send a
    // stale credential where the caller asked for a fresh one — wrong, and a silent
    // divergence from the platform. Nothing else in this file pins the direction.
    await apikeyOnlyFetch(
      new Request('https://example.test/x', {
        headers: { apikey: 'stale', Authorization: 'Bearer k' },
      }),
      { headers: { apikey: 'fresh' } },
    )

    const headers = onlyRequest(calls)
    expect(headers.get('apikey')).toBe('fresh')
    expect(headers.has('authorization')).toBe(false)
  })

  it('keeps the Request apikey when init carries no headers at all', async () => {
    const { apikeyOnlyFetch } = await loadWithFakeCredentials()
    const calls = captureRequests()
    const signal = AbortSignal.timeout(30_000)

    // `(Request, { signal })` — init present, no `headers` key — is postgrest-js's own
    // shape, and the single most likely way this function gets called in future. Reading
    // `init ? init.headers : …` instead of `init?.headers ?? …` looks identical and
    // reintroduces the exact bug this commit fixes: undefined headers, replaced with an
    // empty set, credential gone.
    await apikeyOnlyFetch(
      new Request('https://example.test/x', {
        headers: { apikey: 'k', Authorization: 'Bearer k' },
      }),
      { signal },
    )

    const headers = onlyRequest(calls)
    expect(headers.get('apikey')).toBe('k')
    expect(headers.has('authorization')).toBe(false)

    const [forwarded] = vi.mocked(globalThis.fetch).mock.calls
    if (forwarded === undefined) throw new Error('fetch was never called')
    expect(forwarded[1]?.signal).toBe(signal)
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

  it('leaves a signed-in client sending the user access token', async () => {
    const { signIn } = await loadWithFakeCredentials()
    const calls = captureRequests()

    const client = await signIn('A')
    await client.from('profiles').select('display_name')

    // Not the anon key: the signed-in client must carry the *user's* token. If the
    // admin wrapper were shared with signIn(), this request would go out as anon and
    // RLS would hide the caller's own rows rather than raise — the live isolation
    // suites would then pass for the wrong reason.
    expect(requestTo(calls, '/rest/v1/').get('authorization')).toBe(`Bearer ${FAKE_ACCESS_TOKEN}`)
  })
})

describe('the E2E teardown helper', () => {
  /**
   * `e2e/support/admin.ts` is Playwright-side and `vite.config.ts` excludes `e2e/**`
   * from Vitest *collection* — but nothing stops a Vitest test *importing* the module,
   * and it pulls in no Playwright types. That matters: without this test the E2E
   * teardown's header could be "tidied" back to sending a bearer token and the whole
   * required gate would stay green, with the breakage surfacing only in the
   * non-required `e2e` check as stranded signup users.
   */
  it('deletes a user with apikey alone, never a bearer token', async () => {
    vi.stubEnv('VITE_SUPABASE_URL', FAKE_URL)
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', FAKE_SECRET_KEY)
    vi.resetModules()
    const { deleteAuthUser } = await import('../../e2e/support/admin')
    const calls = captureRequests()

    await deleteAuthUser('11111111-1111-1111-1111-111111111111')

    const headers = onlyRequest(calls)
    expect(headers.get('apikey')).toBe(FAKE_SECRET_KEY)
    expect(headers.has('authorization')).toBe(false)
  })
})
