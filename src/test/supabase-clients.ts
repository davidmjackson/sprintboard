import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'

export type RlsUser = 'A' | 'B'

function credential(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

export const RLS_USERS: Record<RlsUser, { email?: string; password?: string }> = {
  A: { email: credential('RLS_TEST_A_EMAIL'), password: credential('RLS_TEST_A_PASSWORD') },
  B: { email: credential('RLS_TEST_B_EMAIL'), password: credential('RLS_TEST_B_PASSWORD') },
}

const SUPABASE_URL = credential('VITE_SUPABASE_URL')
const SUPABASE_ANON_KEY = credential('VITE_SUPABASE_ANON_KEY')
const SUPABASE_SERVICE_ROLE_KEY = credential('SUPABASE_SERVICE_ROLE_KEY')

/** The keepalive needs only the public config — no test-user credentials. */
export const hasSupabaseConfig = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY)

/** The signup integration suite needs an admin key to verify and clean up. */
export const hasServiceRoleKey = Boolean(hasSupabaseConfig && SUPABASE_SERVICE_ROLE_KEY)

export const hasRlsCredentials = Boolean(
  hasSupabaseConfig &&
  RLS_USERS.A.email &&
  RLS_USERS.A.password &&
  RLS_USERS.B.email &&
  RLS_USERS.B.password,
)

/** The public project config, or a loud failure. */
export function supabaseConfig(): { url: string; anonKey: string } {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. See .env.example.')
  }
  return { url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY }
}

/**
 * A missing secret must never look like a pass. Locally we skip loudly; in CI we
 * refuse to run at all, because a silently-skipped check reports safety — or
 * liveness — it has not established.
 */
function requireOrExplain(ok: boolean, suite: string, message: string): void {
  if (ok) return
  if (process.env.CI) throw new Error(`${message}\nRefusing to skip in CI.`)
  console.warn(`\n  SKIPPING ${suite}.\n  ${message}\n`)
}

export function assertCredentialsOrExplain(): void {
  requireOrExplain(
    hasRlsCredentials,
    'the RLS isolation suite',
    'RLS integration test cannot run: missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, ' +
      'or the RLS_TEST_{A,B}_{EMAIL,PASSWORD} credentials. See .env.example.',
  )
}

export function assertServiceRoleOrExplain(): void {
  requireOrExplain(
    hasServiceRoleKey,
    'the signup integration suite',
    'Signup integration test cannot run: missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, ' +
      'or SUPABASE_SERVICE_ROLE_KEY. See .env.example.',
  )
}

/**
 * `fetch`, minus the `Authorization` header — for the admin client only.
 *
 * supabase-js copies the API key into `Authorization: Bearer <key>` as well as
 * `apikey`. That dates from when service-role keys really were HS256 JWTs. This
 * project's keys are the new opaque format (`sb_secret_…`), and Supabase is
 * explicit that those must not be sent as a bearer token, because they are not
 * JWTs at all. GoTrue tries to verify the bearer copy anyway, finds no `kid`, and
 * — intermittently, when it does not fall back to the `apikey` header — fails the
 * request with:
 *
 *     invalid JWT: unable to parse or verify signature, token is unverifiable:
 *     error while executing keyfunc: unrecognized JWT kid <nil> for algorithm ES256
 *
 * That turned the required `verify` check red on branches whose code was fine.
 * Both observed CI failures hit the *first* `createUser` of the run while later,
 * identical calls on the same client succeeded — the tell that it is the request
 * that fails, not the credential. Deleting the duplicate header removes the
 * JWT-parsing path entirely, so the failure mode cannot occur.
 *
 * Scope matters: this is correct ONLY where the API key *is* the authorization.
 * `anonClient()` and `signIn()` clients must keep their `Authorization` header —
 * for them it carries the signed-in user's access token, and stripping it would
 * silently downgrade every request to the anon role. See [[live-suite-auth-flake]].
 */
export function apikeyOnlyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Read the headers from `init` when it supplies them, and otherwise from a
  // `Request` passed as `input`. Taking them from `init` alone looks equivalent —
  // supabase-js always calls fetch as (url, init) today — but it is not: passing an
  // `init.headers` at all makes it *replace* the Request's own headers, so a
  // Request-form call would go out carrying no `apikey` either. That fails closed
  // rather than open, but it would strip the credential instead of the redundant
  // copy of it, and nothing in the (url, init) tests would notice.
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined)
  const headers = new Headers(source)
  headers.delete('authorization')
  return fetch(input, { ...init, headers })
}

/**
 * A service-role admin client. Test-only: it bypasses RLS entirely, so it must
 * NEVER be imported by application code — only by the integration suite, to read
 * the auto-created profile and delete the throwaway signup user afterwards.
 *
 * Sessions are not persisted: the key IS the authorization, and it travels in the
 * `apikey` header alone (see `apikeyOnlyFetch`).
 */
export function adminClient(): SupabaseClient<Database> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('No service-role key. Set SUPABASE_SERVICE_ROLE_KEY. See .env.example.')
  }
  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: apikeyOnlyFetch },
  })
}

/** A fresh anon client, not signed in — the browser's client. Used by the signup
 *  suite to drive `auth.signUp` exactly as a visitor would. */
export function anonClient(): SupabaseClient<Database> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. See .env.example.')
  }
  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })
}

/**
 * A fresh, signed-in client for arbitrary credentials. Sessions are not persisted:
 * each client is one user.
 *
 * NOT wrapped in `apikeyOnlyFetch`. For a signed-in client the `Authorization`
 * header carries the USER's access token, and stripping it would silently downgrade
 * every request to the anon role — RLS would then hide the caller's own rows rather
 * than raise. `supabase-clients.test.ts` goes red if anyone shares that wrapper here.
 */
export async function signInWithCredentials(
  email: string,
  password: string,
): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`)
  if (!data.user) throw new Error(`Sign-in for ${email} returned no user.`)

  return client
}

/** A fresh, signed-in client for one of the two fixed RLS test users. */
export async function signIn(user: RlsUser): Promise<SupabaseClient<Database>> {
  const { email, password } = RLS_USERS[user]
  if (email === undefined || password === undefined) {
    throw new Error(`No credentials for RLS test user ${user}.`)
  }
  return signInWithCredentials(email, password)
}

/**
 * The signed-in user's id, read from the client's in-memory session — NOT via a
 * fresh `auth.getUser()` network call.
 *
 * Why this exists: every live suite used to follow `signIn()` with
 * `(await client.auth.getUser()).data.user!.id`. That is a second auth round-trip
 * per `beforeAll`, on top of the sign-in itself — ~14 of them across the suites in
 * one `npm test`. GoTrue's rate limiter would trip mid-run, `getUser()` would come
 * back with a null user, and the `!` turned that into a bare
 * `TypeError: Cannot read properties of null (reading 'id')` — a red required check
 * on a branch whose code was fine. `signInWithPassword` already established and
 * validated the session, so the id is available locally with no extra request and
 * nothing to rate-limit. A missing session here is a real bug, not a transient.
 */
export async function userId(client: SupabaseClient<Database>): Promise<string> {
  const { data, error } = await client.auth.getSession()
  if (error) throw new Error(`Could not read the in-memory session: ${error.message}`)
  const id = data.session?.user.id
  if (id === undefined) throw new Error('No active session — was signIn awaited before userId?')
  return id
}
