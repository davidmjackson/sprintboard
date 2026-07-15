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
 * A service-role admin client. Test-only: it bypasses RLS entirely, so it must
 * NEVER be imported by application code — only by the integration suite, to read
 * the auto-created profile and delete the throwaway signup user afterwards.
 *
 * Sessions are not persisted: the key IS the authorization.
 */
export function adminClient(): SupabaseClient<Database> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('No service-role key. Set SUPABASE_SERVICE_ROLE_KEY. See .env.example.')
  }
  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
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

/** A fresh, signed-in client. Sessions are not persisted: each client is one user. */
export async function signIn(user: RlsUser): Promise<SupabaseClient<Database>> {
  const { email, password } = RLS_USERS[user]
  if (email === undefined || password === undefined) {
    throw new Error(`No credentials for RLS test user ${user}.`)
  }

  const client = createClient<Database>(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`Sign-in failed for user ${user}: ${error.message}`)
  if (!data.user) throw new Error(`Sign-in for user ${user} returned no user.`)

  return client
}
