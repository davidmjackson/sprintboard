// @vitest-environment node
import { afterAll, describe, expect, it } from 'vitest'
import { adminClient, assertServiceRoleOrExplain, hasServiceRoleKey } from './supabase-clients'

assertServiceRoleOrExplain()

/**
 * S2.1 — signup creates a matching profile, and display_name defaults to the email.
 *
 * What this proves is the `handle_new_user` trigger: on any insert into
 * `auth.users` it writes a `profiles` row, defaulting `display_name` to the email
 * when no metadata name is given. That is the AC that lives in the database.
 *
 * The user is created through the admin API rather than the browser's `auth.signUp`
 * on purpose. The trigger fires identically either way (it is `AFTER INSERT ON
 * auth.users`), but `signUp` also asks GoTrue to send a confirmation email if the
 * project has confirmations on — and that email rate limit would make this required
 * CI check flaky. The browser's actual call to `supabase.auth.signUp` (its arguments,
 * the default vs provided display name, duplicate handling) is covered by
 * `src/routes/SignupPage.test.tsx`. Here we isolate the trigger, deterministically.
 *
 * The service-role admin client reads the profile RLS would otherwise hide, and
 * deletes each throwaway user afterwards so no fixtures leak.
 */
describe.skipIf(!hasServiceRoleKey)('S2.1 signup creates a profile', () => {
  const admin = hasServiceRoleKey ? adminClient() : (undefined as never)
  const createdUserIds: string[] = []

  /** A unique email per run so a failed cleanup cannot collide on the next run. */
  function freshEmail(): string {
    return `s21-${crypto.randomUUID()}@example.com`
  }

  async function createUser(email: string, displayName?: string): Promise<string> {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: 'password123',
      email_confirm: true,
      user_metadata: displayName ? { display_name: displayName } : undefined,
    })
    if (error) throw new Error(`createUser failed for ${email}: ${error.message}`)
    const id = data.user?.id
    if (!id) throw new Error(`createUser returned no user for ${email}`)
    createdUserIds.push(id)
    return id
  }

  async function profileDisplayName(id: string): Promise<string | null> {
    const { data, error } = await admin
      .from('profiles')
      .select('display_name')
      .eq('id', id)
      .single()
    if (error) throw new Error(`Could not read profile ${id}: ${error.message}`)
    return data.display_name
  }

  afterAll(async () => {
    for (const id of createdUserIds) {
      await admin.auth.admin.deleteUser(id)
    }
  }, 30_000)

  it('creates a profile whose display_name defaults to the email', async () => {
    const email = freshEmail()
    const id = await createUser(email)
    expect(await profileDisplayName(id)).toBe(email)
  }, 30_000)

  it('honours a provided display name', async () => {
    const email = freshEmail()
    const id = await createUser(email, 'Ada Lovelace')
    expect(await profileDisplayName(id)).toBe('Ada Lovelace')
  }, 30_000)
})
