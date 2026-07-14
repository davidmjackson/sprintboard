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

export const hasRlsCredentials = Boolean(
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  RLS_USERS.A.email &&
  RLS_USERS.A.password &&
  RLS_USERS.B.email &&
  RLS_USERS.B.password,
)

/**
 * A missing secret must never look like a pass. Locally we skip loudly; in CI we
 * refuse to run at all, because a silently-skipped security test reports safety
 * it has not established.
 */
export function assertCredentialsOrExplain(): void {
  if (hasRlsCredentials) return

  const message =
    'RLS integration test cannot run: missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, ' +
    'or the RLS_TEST_{A,B}_{EMAIL,PASSWORD} credentials. See .env.example.'

  if (process.env.CI) throw new Error(`${message}\nRefusing to skip in CI.`)
  console.warn(`\n  SKIPPING the RLS isolation suite.\n  ${message}\n`)
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
