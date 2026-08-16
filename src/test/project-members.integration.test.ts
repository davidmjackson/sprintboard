// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import {
  adminClient,
  anonClient,
  assertCredentialsOrExplain,
  hasRlsCredentials,
  hasServiceRoleKey,
  signIn,
  userId,
} from './supabase-clients'

assertCredentialsOrExplain()

/**
 * SPRIN-98 -- the membership boundary, live.
 *
 * This is the first table in the schema whose policies do NOT resolve to
 * `owner_id = auth.uid()`, so nothing here can lean on the shape the other suites assume.
 * Two properties are asserted throughout, and both have burned this project before:
 *
 *   * RLS FILTERS on USING and RAISES on WITH CHECK. A refused SELECT, UPDATE or DELETE
 *     comes back as `{ data: [], error: null }` -- a write that changed nothing, which is
 *     indistinguishable from one that changed everything unless the row COUNT is checked.
 *     A refused INSERT is a thrown 42501. Asserting the wrong one passes for the wrong
 *     reason.
 *   * A policy that hides everything from everyone passes every negative test. So every
 *     negative below is paired with a POSITIVE control on the same table, in the same
 *     shape.
 */
function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `M${pick()}${pick()}${pick()}`
}

/** Turns a thrown transport error into the `{ data, error }` shape. Teardown only. */
async function settled<T>(call: PromiseLike<T>): Promise<T | { data: null; error: Error }> {
  try {
    return await call
  } catch (cause) {
    return { data: null, error: cause instanceof Error ? cause : new Error(String(cause)) }
  }
}

/** Postgres "insufficient privilege" -- the GRANT layer, not RLS. */
const INSUFFICIENT_PRIVILEGE = '42501'

describe.skipIf(!hasRlsCredentials)('project_members RLS', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let userBId: string

  /** A owns it; B is NOT a member. The stranger case. */
  let strangerProject: string
  /** A owns it; B is added as a plain `member`. The non-admin case. */
  let sharedProject: string
  /** B owns it. Exists so A-sees-none assertions are not vacuous -- see below. */
  let projectB: string

  beforeAll(async () => {
    a = await signIn('A')
    b = await signIn('B')
    // The in-memory session, NOT auth.getUser(). A second auth round-trip per beforeAll is
    // the documented fuel for the GoTrue rate-limit flake.
    userAId = await userId(a)
    userBId = await userId(b)

    const mkProject = async (
      client: SupabaseClient<Database>,
      ownerId: string,
      name: string,
    ): Promise<string> => {
      const { data, error } = await client
        .from('projects')
        .insert({ owner_id: ownerId, name, key: runKey() })
        .select('id')
        .single()
      if (error) throw new Error(`Fixture: could not create "${name}": ${error.message}`)
      return data.id
    }

    strangerProject = await mkProject(a, userAId, "A's private project")
    sharedProject = await mkProject(a, userAId, "A's shared project")
    projectB = await mkProject(b, userBId, "B's project")

    // B joins the shared project as a plain member. Written with the SERVICE-ROLE client on
    // purpose: the app path for this is SPRIN-102 and does not exist yet, and using A's
    // client would make the fixture depend on the very admin-insert policy several tests
    // below are trying to prove. A fixture must not be built out of the thing under test.
    if (hasServiceRoleKey) {
      const { error } = await adminClient()
        .from('project_members')
        .insert({ project_id: sharedProject, user_id: userBId, role: 'member' })
      if (error) throw new Error(`Fixture: could not add B to the shared project: ${error.message}`)
    }
  }, 30_000)

  afterAll(async () => {
    if (!hasRlsCredentials) return
    // Deletes FIRST, before anything that could throw. A teardown assertion that fails
    // before the delete strands fixture rows in the shared database with nothing left that
    // can reach them -- that has already cost this project ten orphaned projects.
    await settled(a.from('projects').delete().in('id', [strangerProject, sharedProject]))
    await settled(b.from('projects').delete().eq('id', projectB))
  }, 30_000)

  describe('AC2 -- every project has an admin from the instant it exists', () => {
    it('seeds exactly one admin row for the creator', async () => {
      const { data, error } = await a
        .from('project_members')
        .select('user_id, role')
        .eq('project_id', strangerProject)

      expect(error).toBeNull()
      expect(data).toEqual([{ user_id: userAId, role: 'admin' }])
    })

    it('seeds the admin for B too, not just for whoever the suite happens to sign in first', async () => {
      // Without this, a trigger hardcoded to any single user would still pass the test
      // above. The assertion is that the seed follows owner_id, not that a row appeared.
      const { data, error } = await b
        .from('project_members')
        .select('user_id, role')
        .eq('project_id', projectB)

      expect(error).toBeNull()
      expect(data).toEqual([{ user_id: userBId, role: 'admin' }])
    })
  })

  describe('AC4 -- a stranger sees and touches nothing', () => {
    it('B cannot read the membership rows of a project B does not belong to', async () => {
      const { data, error } = await b
        .from('project_members')
        .select('user_id, role')
        .eq('project_id', strangerProject)

      // RLS filters rather than raising: an empty array with a null error IS the refusal.
      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('B cannot add themselves to a project they do not belong to', async () => {
      const { error } = await b
        .from('project_members')
        .insert({ project_id: strangerProject, user_id: userBId, role: 'admin' })

      // INSERT is governed by WITH CHECK, which RAISES. An empty-array assertion here
      // would be asserting the wrong mechanism entirely.
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)

      // ... and prove it did not land, read back with the client that CAN see the row.
      const { data } = await a
        .from('project_members')
        .select('user_id')
        .eq('project_id', strangerProject)
      expect(data).toEqual([{ user_id: userAId }])
    })

    it('POSITIVE CONTROL: A does see the rows B was refused', async () => {
      // Without this, a policy denying everyone would pass both tests above.
      const { data, error } = await a
        .from('project_members')
        .select('user_id')
        .eq('project_id', strangerProject)

      expect(error).toBeNull()
      expect(data).toHaveLength(1)
    })
  })

  describe.skipIf(!hasServiceRoleKey)('AC4 -- a member reads, a non-admin cannot write', () => {
    it('B, a member, reads every membership row of the shared project', async () => {
      const { data, error } = await b
        .from('project_members')
        .select('user_id, role')
        .eq('project_id', sharedProject)

      expect(error).toBeNull()
      // Both rows, not just B's own. This is what SPRIN-102's member list needs, and it is
      // the assertion that fails if members_read is narrowed to `user_id = auth.uid()`.
      expect(data).toHaveLength(2)
      expect(data).toEqual(
        expect.arrayContaining([
          { user_id: userAId, role: 'admin' },
          { user_id: userBId, role: 'member' },
        ]),
      )
    })

    it('B still cannot read a DIFFERENT project, so membership is per-project not global', async () => {
      // Deleting the correlating clause from members_read leaves "is this user a member of
      // ANY project", which still deparses plausibly and would pass every test above now
      // that B is a member of something. This is the test that kills that mutation.
      const { data, error } = await b
        .from('project_members')
        .select('user_id')
        .eq('project_id', strangerProject)

      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('B, a non-admin member, cannot add anyone', async () => {
      const { error } = await b
        .from('project_members')
        .insert({ project_id: sharedProject, user_id: userBId, role: 'admin' })

      // 23505 would mean the row already existed and the policy was never consulted;
      // 42501 is the refusal we are asserting.
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('B, a non-admin member, cannot promote themselves', async () => {
      const { data, error } = await b
        .from('project_members')
        .update({ role: 'admin' })
        .eq('project_id', sharedProject)
        .eq('user_id', userBId)
        .select('user_id')

      // UPDATE is governed by USING, which FILTERS. Zero rows changed, no error raised.
      expect(error).toBeNull()
      expect(data).toEqual([])

      // The row count is the assertion, but read the value back too: an update that
      // matched zero rows and one that matched and wrote 'member' are different bugs.
      const { data: after } = await adminClient()
        .from('project_members')
        .select('role')
        .eq('project_id', sharedProject)
        .eq('user_id', userBId)
      expect(after).toEqual([{ role: 'member' }])
    })

    it('B, a non-admin member, cannot remove anyone', async () => {
      const { data, error } = await b
        .from('project_members')
        .delete()
        .eq('project_id', sharedProject)
        .eq('user_id', userAId)
        .select('user_id')

      expect(error).toBeNull()
      expect(data).toEqual([])

      const { data: after } = await adminClient()
        .from('project_members')
        .select('user_id')
        .eq('project_id', sharedProject)
      expect(after).toHaveLength(2)
    })

    it('POSITIVE CONTROL: A, the admin, can do all three', async () => {
      // Every refusal above is only meaningful if the same statements succeed for an admin.
      const { data: promoted, error: upErr } = await a
        .from('project_members')
        .update({ role: 'admin' })
        .eq('project_id', sharedProject)
        .eq('user_id', userBId)
        .select('role')
      expect(upErr).toBeNull()
      expect(promoted).toEqual([{ role: 'admin' }])

      const { data: removed, error: delErr } = await a
        .from('project_members')
        .delete()
        .eq('project_id', sharedProject)
        .eq('user_id', userBId)
        .select('user_id')
      expect(delErr).toBeNull()
      expect(removed).toEqual([{ user_id: userBId }])

      const { error: insErr } = await a
        .from('project_members')
        .insert({ project_id: sharedProject, user_id: userBId, role: 'member' })
      expect(insErr).toBeNull()
    })
  })

  describe('the grant layer, which sits IN FRONT of the policies', () => {
    it('even an admin cannot re-point a membership row at another user', async () => {
      // `grant update (role)` and nothing else. This is refused by the PRIVILEGE layer
      // before any policy is consulted, which is what makes it a database property rather
      // than a client convention. Note it shares SQLSTATE 42501 with an RLS WITH CHECK
      // violation -- the discriminator is that A is a legitimate admin here, so no policy
      // would have objected.
      const { error } = await a
        .from('project_members')
        .update({ user_id: userBId })
        .eq('project_id', strangerProject)
        .eq('user_id', userAId)

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('anon holds no privilege on the table at all', async () => {
      // Deliberately UNLIKE the other tables in this schema, where anon receives an empty
      // array from an EXISTS that matches nothing. Membership is refused at the privilege
      // layer instead, so the shape of the refusal differs on purpose. If this ever starts
      // returning `{ data: [], error: null }`, a grant has been restored.
      const { error } = await anonClient().from('project_members').select('user_id')

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
    })
  })

  describe('the role vocabulary is constrained by the database', () => {
    it('rejects a role outside the check constraint', async () => {
      const { error } = await adminClient()
        .from('project_members')
        // A deliberately invalid role. The service-role client bypasses RLS, so the ONLY
        // thing that can refuse this is project_members_role_check -- which is the point.
        .insert({ project_id: strangerProject, user_id: userBId, role: 'owner' })

      // 23514 -- check_violation.
      expect(error?.code).toBe('23514')
    })
  })
})
