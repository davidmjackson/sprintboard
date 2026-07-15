// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  anonClient,
  assertCredentialsOrExplain,
  hasRlsCredentials,
  RLS_USERS,
} from './supabase-clients'

assertCredentialsOrExplain()

/**
 * S2.2 — login against live GoTrue. Proves the browser's `signInWithPassword` path
 * end to end: valid credentials return a session, wrong ones return an error and no
 * session. Reuses the two pre-created, confirmed RLS users, so it does not depend on
 * the project's email-confirmation setting and creates nothing to clean up.
 */
describe.skipIf(!hasRlsCredentials)('S2.2 login', () => {
  const { email, password } = RLS_USERS.A

  it('signs in with valid credentials', async () => {
    const { data, error } = await anonClient().auth.signInWithPassword({
      email: email!,
      password: password!,
    })
    expect(error).toBeNull()
    expect(data.session).not.toBeNull()
    expect(data.user?.email).toBe(email)
  }, 30_000)

  it('rejects an invalid password with no session', async () => {
    const { data, error } = await anonClient().auth.signInWithPassword({
      email: email!,
      password: 'definitely-not-the-right-password',
    })
    expect(error).not.toBeNull()
    expect(data.session).toBeNull()
  }, 30_000)
})
