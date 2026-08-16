// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import {
  adminClient,
  anonClient,
  assertServiceRoleOrExplain,
  hasServiceRoleKey,
  signInWithCredentials,
} from './supabase-clients'

assertServiceRoleOrExplain()

/**
 * SPRIN-105 -- profile visibility is CO-MEMBERSHIP, and nothing wider.
 *
 * Two properties are asserted throughout, and both have burned this project before:
 *
 *   * RLS FILTERS on USING and RAISES on WITH CHECK. A refused SELECT, UPDATE or DELETE
 *     comes back as `{ data: [], error: null }` -- a write that changed nothing, which is
 *     indistinguishable from one that changed everything unless the row COUNT is checked.
 *     A refused INSERT is a thrown 42501. Asserting the wrong one passes for the wrong
 *     reason.
 *   * A policy that hides everything from everyone passes every negative test. So every
 *     negative below is paired with a POSITIVE control in the same shape.
 *
 * WHY THIS SUITE CREATES ITS OWN USERS INSTEAD OF USING A AND B.
 * rls.integration.test.ts asserts that A and B EACH see exactly one profile row. Vitest
 * runs suites in parallel against one shared database, so making A and B co-members --
 * even inside a beforeAll that tears down -- would flip those assertions red at random.
 * Three throwaway users leave A and B untouched, which keeps those two assertions true
 * and makes them the standing guard that this widening did not over-fire.
 */
const PASSWORD = 'password123'

function freshEmail(tag: string): string {
  return `sprin105-${tag}-${crypto.randomUUID()}@example.com`
}

function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `P${pick()}${pick()}${pick()}`
}

/** Turns a thrown transport error into the `{ data, error }` shape. Teardown only. */
async function settled<T>(call: PromiseLike<T>): Promise<T | { data: null; error: Error }> {
  try {
    return await call
  } catch (cause) {
    return { data: null, error: cause instanceof Error ? cause : new Error(String(cause)) }
  }
}

const INSUFFICIENT_PRIVILEGE = '42501'

describe.skipIf(!hasServiceRoleKey)('profiles visibility is co-membership', () => {
  const admin = hasServiceRoleKey ? adminClient() : (undefined as never)
  const createdUserIds: string[] = []

  /** Co-member, project owner, seeded as admin by on_project_created_admin. */
  let cClient: SupabaseClient<Database>
  let cId: string
  let cEmail: string

  /** Co-member, added to C's project as a plain `member`. */
  let dClient: SupabaseClient<Database>
  let dId: string
  let dEmail: string

  /** Shares nothing with anyone, and never signs in. The stranger. */
  let eId: string
  let eEmail: string

  let sharedProject: string

  async function createUser(email: string, displayName: string): Promise<string> {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    })
    if (error) throw new Error(`createUser failed for ${email}: ${error.message}`)
    const id = data.user?.id
    if (!id) throw new Error(`createUser returned no user for ${email}`)
    createdUserIds.push(id)
    return id
  }

  beforeAll(async () => {
    cEmail = freshEmail('c')
    dEmail = freshEmail('d')
    eEmail = freshEmail('e')

    cId = await createUser(cEmail, 'Co-member C')
    dId = await createUser(dEmail, 'Co-member D')
    eId = await createUser(eEmail, 'Stranger E')

    cClient = await signInWithCredentials(cEmail, PASSWORD)
    dClient = await signInWithCredentials(dEmail, PASSWORD)

    const { data, error } = await cClient
      .from('projects')
      .insert({ owner_id: cId, name: 'SPRIN-105 shared project', key: runKey() })
      .select('id')
      .single()
    if (error) throw new Error(`Fixture: could not create the shared project: ${error.message}`)
    sharedProject = data.id

    // D joins as a plain member, written with the SERVICE-ROLE client on purpose: the app
    // path for this is SPRIN-102 and does not exist yet, and using C's client would build
    // the fixture out of members_admin_insert -- a policy a SIBLING suite is trying to
    // prove. A fixture must not be built out of the thing under test.
    const { error: joinError } = await admin
      .from('project_members')
      .insert({ project_id: sharedProject, user_id: dId, role: 'member' })
    if (joinError) throw new Error(`Fixture: could not add D to the project: ${joinError.message}`)
  }, 60_000)

  afterAll(async () => {
    if (!hasServiceRoleKey) return
    // Deletes FIRST, before anything that could throw. Deleting the users cascades the
    // project and the membership row, since every owned table is `on delete cascade` from
    // auth.users. A teardown assertion that fails before the delete strands fixture rows
    // in the shared database -- that has already cost this project ten orphaned projects.
    const failures: string[] = []
    for (const id of createdUserIds) {
      const { error } = await settled(admin.auth.admin.deleteUser(id))
      if (error) failures.push(`${id}: ${error.message}`)
    }
    if (failures.length > 0) {
      throw new Error(`Failed to delete ${failures.length} test user(s):\n${failures.join('\n')}`)
    }
  }, 60_000)

  describe('the email mirror', () => {
    // Asserted on a FRESHLY CREATED user, not a backfilled one: the trigger and the
    // backfill are different mechanisms and only one of them runs again.
    it('handle_new_user mirrors auth.users.email onto the new profile row', async () => {
      const { data, error } = await admin
        .from('profiles')
        .select('email, display_name')
        .eq('id', eId)
        .single()

      expect(error).toBeNull()
      expect(data!.email).toBe(eEmail)
      // display_name keeps its own source -- the metadata name, NOT the email. The two
      // columns diverging here is the point: display_name is editable, email is not.
      expect(data!.display_name).toBe('Stranger E')
    }, 30_000)

    it('leaves no profile row without an email (the backfill, from outside its own transaction)', async () => {
      const { data, error } = await admin.from('profiles').select('id').is('email', null)

      expect(error).toBeNull()
      expect(data).toEqual([])
    }, 30_000)
  })

  describe('reads', () => {
    it('lets two members of one project read each other, in BOTH directions', async () => {
      // Both directions, because the predicate is a self-join and a one-directional test
      // would pass on a broken half.
      const cReadsD = await cClient.from('profiles').select('id, display_name, email').eq('id', dId)
      const dReadsC = await dClient.from('profiles').select('id, display_name, email').eq('id', cId)

      expect(cReadsD.error).toBeNull()
      expect(cReadsD.data).toEqual([{ id: dId, display_name: 'Co-member D', email: dEmail }])
      expect(dReadsC.error).toBeNull()
      expect(dReadsC.data).toEqual([{ id: cId, display_name: 'Co-member C', email: cEmail }])
    }, 30_000)

    // AC3, by ROW COUNT. An RLS USING clause FILTERS; it does not raise. Expecting an
    // error here would pass for the wrong reason -- and would keep passing if the policy
    // were replaced with `using (true)`.
    it('hides the profile of someone sharing no project, without raising', async () => {
      const { data, error } = await cClient.from('profiles').select('id').eq('id', eId)

      expect(error).toBeNull()
      expect(data).toEqual([])
    }, 30_000)

    // The strongest assertion in the file: not "C cannot see E" but "C sees C and D and
    // NOBODY ELSE". There are other users in this database; a policy that widened too far
    // passes the test above and fails this one.
    it('shows a member exactly themselves and their co-members', async () => {
      const { data, error } = await cClient.from('profiles').select('id')

      expect(error).toBeNull()
      expect([...(data ?? [])].map((row) => row.id).sort()).toEqual([cId, dId].sort())
    }, 30_000)
  })

  describe('writes do not widen', () => {
    // The positive control for every negative below: the same verb, the same table,
    // succeeding on the caller's own row.
    it('lets a user rename themselves', async () => {
      const { data, error } = await cClient
        .from('profiles')
        .update({ display_name: 'C, renamed' })
        .eq('id', cId)
        .select('display_name')

      expect(error).toBeNull()
      expect(data).toEqual([{ display_name: 'C, renamed' }])
    }, 30_000)

    // display_name is a column `authenticated` may genuinely UPDATE (the table grant is
    // arwdDxtm), so a zero-row result here measures the POLICY and not the grant. On an
    // ungranted column this would 42501 at the privilege layer and prove nothing.
    it('refuses to let a co-member rename their co-member, by changing zero rows', async () => {
      const refused = await cClient
        .from('profiles')
        .update({ display_name: 'renamed by C' })
        .eq('id', dId)
        .select('display_name')

      expect(refused.error).toBeNull()
      expect(refused.data).toEqual([])

      // Zero rows returned is not the same claim as zero rows changed. Read D's row back
      // with a client that bypasses RLS and confirm it is untouched.
      const after = await admin.from('profiles').select('display_name').eq('id', dId).single()
      expect(after.data!.display_name).toBe('Co-member D')
    }, 30_000)

    // A refused INSERT RAISES rather than filtering -- the WITH CHECK path. `authenticated`
    // holds INSERT privilege on this table, so the 42501 here can only be the policy; the
    // message match is what discriminates the two possible authors of that code.
    it('refuses to let a user insert a profile row for someone else', async () => {
      const { error } = await cClient
        .from('profiles')
        .insert({ id: eId, display_name: 'inserted by C' })

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/row-level security/i)
    }, 30_000)
    // NOTE ON EXECUTION ORDER, since this test leans on it. E already has a profile row,
    // so this insert violates the primary key as well as the policy. Postgres evaluates
    // the RLS WITH CHECK before the tuple reaches the index, so 42501 is expected to win
    // over 23505 -- the same ordering that puts WITH CHECK ahead of foreign-key
    // validation. If the run comes back 23505, that assumption is wrong: switch the id to
    // `crypto.randomUUID()` (a user who does not exist), where the ordering IS documented,
    // and say so in the review rather than silently loosening the matcher.

    it('refuses to let a co-member delete their co-member, by deleting zero rows', async () => {
      const refused = await cClient.from('profiles').delete().eq('id', dId).select('id')

      expect(refused.error).toBeNull()
      expect(refused.data).toEqual([])

      const after = await admin.from('profiles').select('id').eq('id', dId)
      expect(after.data).toEqual([{ id: dId }])
    }, 30_000)
  })

  describe('anon holds nothing on this table', () => {
    // SPRIN-105 revoked anon's full CRUD. This is the PRIVILEGE shape -- 42501 with
    // data === null -- and NOT the filter shape (error: null, data: []) that RLS produces.
    // Asserting the wrong one would pass identically before the revoke, proving nothing.
    it('refuses an anonymous select at the privilege layer', async () => {
      const { data, error } = await anonClient().from('profiles').select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/permission denied/i)
    }, 30_000)
  })

  // LAST, AND DELIBERATELY SO. This is the positive control for profiles_self_delete, and
  // it destroys C's profile row -- so every assertion that reads C's profile must already
  // have run. Vitest runs a file's tests in source order. If you add a test that reads C,
  // add it ABOVE this one.
  describe('the self-delete positive control', () => {
    it('lets a user delete their own profile row', async () => {
      const { data, error } = await cClient.from('profiles').delete().eq('id', cId).select('id')

      expect(error).toBeNull()
      expect(data).toEqual([{ id: cId }])
    }, 30_000)
  })
})
