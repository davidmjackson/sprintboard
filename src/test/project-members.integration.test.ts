// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import {
  adminClient,
  anonClient,
  assertCredentialsOrExplain,
  assertServiceRoleOrExplain,
  hasRlsCredentials,
  hasServiceRoleKey,
  signIn,
  supabaseConfig,
  userId,
} from './supabase-clients'

assertCredentialsOrExplain()
// NINE of this file's tests are `skipIf(!hasServiceRoleKey)` -- the member-vs-admin block,
// the seed-follows-owner_id test and the backfill invariant all need a client that bypasses
// RLS. Without this call a missing key silently drops more than half the suite while the
// file still reports green. It IS caught today, but only by a throw in
// signup.integration.test.ts, i.e. by a guard in someone else's file; this story leaned much
// harder on the service role and should carry its own.
assertServiceRoleOrExplain()

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

/**
 * Postgres "insufficient privilege". On THIS table it has two possible authors -- a revoked
 * GRANT and an RLS WITH CHECK violation -- so every assertion of it below is paired with a
 * message match naming which one refused.
 *
 * A DECLARED DEPARTURE, so it is not mistaken for carelessness. `projects.integration.test.ts`
 * deliberately matches only `/permission denied/`, reasoning that the message prose belongs to
 * Postgres rather than to us and a substring naming the control is enough. That is right where
 * only one mechanism can raise the code. Here both can, and they differ only in the prose, so
 * a substring that stops before the table name cannot discriminate. The cost is accepted: if
 * Postgres ever rewords these, this file goes red and the sibling does not.
 */
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
      // above. But note what it still cannot see -- see the next test.
      const { data, error } = await b
        .from('project_members')
        .select('user_id, role')
        .eq('project_id', projectB)

      expect(error).toBeNull()
      expect(data).toEqual([{ user_id: userBId, role: 'admin' }])
    })

    it.skipIf(!hasServiceRoleKey)('seeds from owner_id, NOT from the caller', async () => {
      // The two tests above CANNOT distinguish `new.owner_id` from `auth.uid()`, because
      // projects_owner's WITH CHECK forces them equal for any RLS-bound insert and every
      // fixture passes its own id as owner_id. That is the "fixture equals what the code
      // computes" shape: replace the trigger body's new.owner_id with auth.uid() and both
      // stay green.
      //
      // The service-role client is where the two come apart: it bypasses RLS and carries
      // no `sub` claim, so auth.uid() is NULL. A trigger reading auth.uid() would attempt
      // a null user_id and die on the not-null constraint; one reading owner_id seeds B.
      const admin = adminClient()
      const { data: project, error: pErr } = await admin
        .from('projects')
        .insert({ owner_id: userBId, name: 'Seeded for B by service role', key: runKey() })
        .select('id')
        .single()
      if (pErr) throw new Error(`Fixture: service-role project insert failed: ${pErr.message}`)

      try {
        const { data, error } = await admin
          .from('project_members')
          .select('user_id, role')
          .eq('project_id', project.id)

        expect(error).toBeNull()
        expect(data).toEqual([{ user_id: userBId, role: 'admin' }])
      } finally {
        // Delete unconditionally, before any assertion can throw past it.
        await settled(admin.from('projects').delete().eq('id', project.id))
      }
    })

    it.skipIf(!hasServiceRoleKey)(
      'every project has at least one admin, and on backfilled rows it is the owner',
      async () => {
        // AC3 -- the BACKFILL. Nothing else in this suite covers it: every fixture project
        // is created inside beforeAll and gets its admin row from the TRIGGER, not the
        // backfill. The migration's own DO block reads back its own INSERT inside the same
        // transaction, which proves the statement ran and nothing more.
        //
        // A whole-table invariant rather than a fixture assertion, so it also catches a
        // future story that adds a project-creation path bypassing the trigger.
        //
        // ONE REQUEST, NOT TWO -- and this is load-bearing, not tidiness. The first
        // version read `projects` and then `project_members` separately and went RED on
        // its first run against a project that, when re-queried a moment later, did not
        // exist. Vitest runs test FILES in parallel: a sibling suite created a project
        // (correctly seeded by the trigger) and its teardown deleted it BETWEEN the two
        // reads, so the project appeared in snapshot one and its membership row was gone
        // by snapshot two. The invariant was fine; the measurement was racy by
        // construction, and against a shared database that is a flake generator. A single
        // statement gets a single Postgres snapshot, so there is no window.
        const admin = adminClient()

        const { data: projects, error: pErr } = await admin
          .from('projects')
          .select('id, owner_id, created_at, project_members(user_id, role)')
        expect(pErr).toBeNull()

        const rows = projects ?? []
        const admins = (p: (typeof rows)[number]) =>
          p.project_members.filter((m) => m.role === 'admin')

        // CARDINALITY: AT LEAST one admin, never EXACTLY one. This half stays
        // WHOLE-DATABASE -- no story makes a ZERO-admin project a legitimate state, and
        // SPRIN-102's last-admin guard is the thing that now enforces it.
        //
        // THIS ASSERTION USED TO READ `!== 1` AND THE COMMENT ABOVE IT USED TO NAME
        // SPRIN-102 AS "PRECISELY THE LEAK" IT WOULD CATCH. Both were written before that
        // story had a design, and SPRIN-102 INVERTED them: `set_project_member_role`
        // promotes a member to admin ON PURPOSE, and the last-admin guard it exists to
        // enforce is only REACHABLE with two admins present -- demoting or removing one of
        // a pair is the only path that can be refused. Two admins is the FEATURE, so
        // `!== 1` would have gone red on `member-management.integration.test.ts`'s
        // legitimate fixtures, in parallel, on the required `verify` check.
        //
        // Narrowing this does not weaken it. The property worth protecting was never
        // "exactly one" -- it is that a project can never be left with NOBODY able to
        // administer it, which is what strands the row permanently: SPRIN-101 made
        // `projects_admin_update` and `projects_admin_delete` both resolve to
        // `app_auth.is_project_admin`, so a zero-admin project can no longer be
        // reconfigured OR deleted by any authenticated user. `=== 0` is that property
        // stated exactly; `!== 1` was that property plus an accident of the fixtures.
        const adminlessProjects = rows.filter((p) => admins(p).length === 0)

        // POSITIVE CONTROL, and it has to be sharper than `rows.length > 0`. This suite's
        // own three fixture projects satisfy that, so a plain count would keep the test
        // green while it silently stopped covering the BACKFILL at all -- the backfill is
        // the only reason the test exists, and only rows predating the migration exercise
        // it. Every fixture project is created inside beforeAll and seeded by the TRIGGER.
        const MIGRATION_APPLIED = '2026-08-16'
        const preMigration = rows.filter((p) => p.created_at < MIGRATION_APPLIED)

        // ADMIN-IS-OWNER IS SCOPED TO PRE-MIGRATION ROWS, and the scope is the assertion's
        // real subject rather than a concession to a flaky sibling. It exists to test the
        // BACKFILL, and only rows predating the migration exercise that.
        //
        // As a whole-database invariant it was FALSIFIED BY SPRIN-101. `projects_admin_update`
        // and `projects_admin_delete` resolve to `app_auth.is_project_admin`, deliberately not
        // to ownership, so "the admin is the owner" stopped being a property of this schema and
        // became a property of how a project HAPPENS to have been created.
        // `projects-membership.integration.test.ts` creates the counter-example on purpose --
        // a project whose owner has been swapped out of the membership -- and SPRIN-102's
        // add/remove path will make it routine. Left unscoped, this line goes red on a sibling
        // suite's legitimate fixture, on the required `verify` check, for a reason nothing in
        // that PR's diff explains.
        //
        // The property this used to protect for NEW projects -- the creator becomes the sole
        // admin, via `seed_project_admin` -- is NOT left unpinned by the narrowing:
        // `projects-membership.integration.test.ts` asserts it directly against the trigger.
        // An earlier version of this test asserted `no admin at all` as a separate property
        // and it was DEAD, being a strict subset of `no admin equal to the owner`; the
        // cardinality check above is what covers it now, and it covers it everywhere.
        const adminIsNotOwner = preMigration.filter(
          (p) => !admins(p).some((m) => m.user_id === p.owner_id),
        )

        expect(adminIsNotOwner).toEqual([])
        expect(adminlessProjects).toEqual([])
        expect(preMigration.length).toBeGreaterThan(0)
      },
    )
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

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)

      // THE AUTHOR OF THIS 42501 CHANGED IN SPRIN-102, AND THIS ASSERTION IS WHY WE KNOW.
      // It used to read `/violates row-level security policy/` and the comment beside it
      // said, in as many words, that deleting the column INSERT grant would leave the test
      // "green while measuring the privilege layer instead of the policy" -- so the
      // message assertion was put here to separate the two. SPRIN-102 revoked exactly that
      // grant, and this test went RED rather than silently changing meaning. The
      // discrimination did its job; the expectation is now updated to the control that
      // actually refuses.
      //
      // Which is the PRIVILEGE layer, table-wide: `permission denied for table
      // project_members`. members_admin_insert's WITH CHECK is still there and still
      // correct, but it is no longer REACHABLE over PostgREST -- the grant is checked
      // first and there is nothing left to grant.
      //
      // SO THE THREE WRITE POLICIES ARE NOW A GUARD NO TEST IN THIS REPO CAN OBSERVE, and
      // that is a real gap rather than an oversight to fix here. Their only witness is
      // pg_policies, which lives in pg_catalog; PostgREST publishes only the exposed
      // schemas, so adminClient() cannot read it and no live suite can assert the policies
      // still exist. SPRIN-102 kept them deliberately as defence in depth -- so that
      // re-granting a verb later cannot silently reopen a ROW-level hole at the same
      // moment -- but nothing red-flags their removal. Verify them from the catalog by
      // hand when touching this table's grants. Tracked with the other unobservable guards
      // in docs/standards-audit-2026-07-25.md.
      expect(error?.message).toMatch(/permission denied for table project_members/)

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

      // 23505 would mean the row already existed and nothing was consulted; 42501 is the
      // refusal we are asserting. Pin the AUTHOR too — see the note on the stranger-insert
      // test above; the grant and the policy share this SQLSTATE, and since SPRIN-102 it
      // is the GRANT that answers.
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/permission denied for table project_members/)
    })

    it('B, a non-admin member, cannot promote themselves', async () => {
      const { data, error } = await b
        .from('project_members')
        .update({ role: 'admin' })
        .eq('project_id', sharedProject)
        .eq('user_id', userBId)
        .select('user_id')

      // THE MECHANISM CHANGED IN SPRIN-102. This used to assert `error` null and `data`
      // empty, because UPDATE was governed by members_admin_update's USING, which FILTERS
      // rather than raising. The UPDATE grant is gone, so the privilege layer now refuses
      // the statement outright and there is no filtering left to observe.
      //
      // A FILTERED refusal and a REFUSED statement are genuinely different outcomes and
      // this test must not paper over which one it got: an empty `data` alone would be
      // satisfied by both, so the error is asserted first and by MESSAGE, not just by code.
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/permission denied for table project_members/)
      expect(data).toBeNull()

      // Read the value back regardless: a refused statement and one that wrote the wrong
      // value are different bugs, and only this catches the second.
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

      // Same inversion as the promote test above: members_admin_delete's USING used to
      // FILTER this to zero rows with no error; since SPRIN-102 revoked the DELETE grant
      // the privilege layer refuses the statement. Discriminate on the message.
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/permission denied for table project_members/)
      expect(data).toBeNull()

      const { data: after } = await adminClient()
        .from('project_members')
        .select('user_id')
        .eq('project_id', sharedProject)
      expect(after).toHaveLength(2)
    })

    it('the table refuses A, the ADMIN, too -- and the RPC is the path that works', async () => {
      // THIS TEST WAS INVERTED BY SPRIN-102, and the inversion is the story's whole point.
      // It used to be `POSITIVE CONTROL: A, the admin, can do all three` and asserted that
      // A could UPDATE, DELETE and INSERT the table directly. All three are now refused:
      // the write grants are gone and the three RPCs are the only write path.
      //
      // WITHOUT THE SECOND HALF THIS TEST WOULD BE WORTHLESS, and worse, it would quietly
      // rot the four negatives above it. Every one of those asserts the same privilege
      // refusal this one does, so if the table simply became unreachable -- a bad project
      // id, an expired session, a client signed in as nobody -- all five would pass
      // together while proving nothing about admin vs non-admin at all. The RPC call below
      // is what makes them meaningful: it proves this exact client, this session and this
      // project are live and that A really is an admin of it, so the refusals above are
      // the privilege layer talking and not a broken fixture.
      const { error: upErr } = await a
        .from('project_members')
        .update({ role: 'admin' })
        .eq('project_id', sharedProject)
        .eq('user_id', userBId)
      expect(upErr?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(upErr?.message).toMatch(/permission denied for table project_members/)

      const { error: delErr } = await a
        .from('project_members')
        .delete()
        .eq('project_id', sharedProject)
        .eq('user_id', userBId)
      expect(delErr?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(delErr?.message).toMatch(/permission denied for table project_members/)

      const { error: insErr } = await a
        .from('project_members')
        .insert({ project_id: strangerProject, user_id: userBId, role: 'member' })
      expect(insErr?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(insErr?.message).toMatch(/permission denied for table project_members/)

      // POSITIVE CONTROL, through the door that is actually open. Promote B and put them
      // straight back, so the fixture ends exactly as it started -- the tests after this
      // one in the file rely on B being a plain member of sharedProject.
      const { data: promoted, error: promoteErr } = await a.rpc('set_project_member_role', {
        p_project_id: sharedProject,
        p_user_id: userBId,
        p_role: 'admin',
      })
      expect(promoteErr).toBeNull()
      expect(promoted).toBe('updated')

      const { data: demoted, error: demoteErr } = await a.rpc('set_project_member_role', {
        p_project_id: sharedProject,
        p_user_id: userBId,
        p_role: 'member',
      })
      expect(demoteErr).toBeNull()
      expect(demoted).toBe('updated')

      // And prove the round trip really landed rather than both calls no-opping.
      const { data: after } = await adminClient()
        .from('project_members')
        .select('role')
        .eq('project_id', sharedProject)
        .eq('user_id', userBId)
      expect(after).toEqual([{ role: 'member' }])
    })
  })

  describe('the grant layer, which sits IN FRONT of the policies', () => {
    it('a single UPDATE cannot touch user_id or project_id, even for an admin', async () => {
      // THIS TEST STAYED GREEN THROUGH SPRIN-102 AND NOW PROVES SOMETHING WIDER THAN ITS
      // NAME. Read that as a warning, not a reassurance. It was written when `authenticated`
      // held `update (role)` and nothing else, so it pinned a real and narrow property: the
      // SET-list route to user_id and project_id was closed while role remained updatable.
      // SPRIN-102 revoked UPDATE entirely, so both arms below now pass for the blunt reason
      // that NO column is updatable -- the same assertions, a much weaker claim. Re-granting
      // `update (role, project_id)` tomorrow would leave this test green and the hole open,
      // which is exactly the failure it was built to prevent. If UPDATE is ever granted back
      // on this table, this test must be re-derived, not re-run.
      //
      // The history it records is still worth keeping: the first version was called "even an
      // admin cannot re-point a membership row at another user" and that was NOT what held.
      // An admin reached the same end state with DELETE + INSERT, because members_admin_delete
      // and members_admin_insert each constrain only the PROJECT and say nothing about
      // user_id. SPRIN-102 closed that route too, by revoking both verbs -- which is why the
      // admin control above no longer performs that sequence.
      //
      // Refused by the PRIVILEGE layer before any policy is consulted. It shares SQLSTATE
      // 42501 with an RLS WITH CHECK violation, so assert the wording: A is a legitimate
      // admin here, so no policy would have objected and the message must name the table.
      const { error: userErr } = await a
        .from('project_members')
        .update({ user_id: userBId })
        .eq('project_id', strangerProject)
        .eq('user_id', userAId)

      expect(userErr?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(userErr?.message).toMatch(/permission denied for table project_members/)

      // THE SECOND ARM, which the first version omitted. The claim names two columns and
      // only one was tested, so widening the grant to `update (role, project_id)` left the
      // whole suite green -- while letting an admin of two projects MOVE a row between
      // them (USING sees the old row, WITH CHECK the new, both pass) and strand the source
      // project with zero admins and no way back.
      const { error: projectErr } = await a
        .from('project_members')
        .update({ project_id: sharedProject })
        .eq('project_id', strangerProject)
        .eq('user_id', userAId)

      expect(projectErr?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(projectErr?.message).toMatch(/permission denied for table project_members/)
    })

    it('anon holds no privilege on the table at all', async () => {
      // Deliberately UNLIKE the other tables in this schema, where anon receives an empty
      // array from an EXISTS that matches nothing. Membership is refused at the privilege
      // layer instead, so the shape of the refusal differs on purpose.
      const { error } = await anonClient().from('project_members').select('user_id')

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)

      // ASSERT THE AUTHOR, NOT JUST THE CODE. The code alone is vacuous here. Derived from
      // the CATALOGUE, not measured -- proving it by experiment would mean running
      // `grant select on project_members to anon` against the shared live database, which
      // nothing in this project is allowed to do. What is measured is the input:
      // `app_auth`'s nspacl is {postgres=UC, authenticated=U}, so anon has no USAGE. Grant
      // anon SELECT and the call still fails 42501 -- because the
      // moment members_read is finally evaluated Postgres raises `permission denied for
      // schema app_auth`, the SAME SQLSTATE. The test would stay green through exactly
      // the grant it exists to detect. The message is what discriminates.
      expect(error?.message).toMatch(/permission denied for table project_members/)
    })

    it('does not expose app_auth over PostgREST', async () => {
      // The property the whole recursion fix rests on: app_auth holds two SECURITY
      // DEFINER functions, and it is safe to hold them there ONLY while PostgREST cannot
      // reach the schema.
      //
      // This replaces a tripwire that could never fire. An earlier version of
      // database.types.ts claimed app_auth's absence from the generated `Functions` block
      // proved non-exposure. It proves nothing — the generator emits `public` regardless,
      // so a non-public schema is absent either way. `graphql_public` IS exposed in this
      // project and is likewise absent from that file. This probe is the real check: it
      // asks PostgREST directly, and flips the instant app_auth joins the exposed list.
      //
      // WHY 406 DISCRIMINATES, measured against all four cases rather than assumed:
      //   Accept-Profile: app_auth        -> 406 PGRST106  (unexposed -- what we assert)
      //   Accept-Profile: public          -> 200           (so 406 is not universal)
      //   Accept-Profile: graphql_public  -> 404 PGRST205  (EXPOSED non-public schema)
      //   Accept-Profile: no_such_schema  -> 406 PGRST106
      // The third line is the one that matters: an exposed schema answers 404, not 406, so
      // adding app_auth to the exposed list turns this test red. A 404-based detector would
      // NOT have worked -- it passes both before and after -- and one was proposed.
      //
      // The table name in the URL is decorative: the schema is rejected before the relation
      // is resolved. It is left as project_members for readability.
      const { url, anonKey } = supabaseConfig()
      const res = await fetch(`${url}/rest/v1/project_members?select=user_id&limit=1`, {
        headers: { apikey: anonKey, 'Accept-Profile': 'app_auth' },
      })

      expect(res.status).toBe(406)
      const body = (await res.json()) as { code?: string; hint?: string }
      expect(body.code).toBe('PGRST106')
      // Stronger than the code alone: the hint ENUMERATES the exposed schemas, so this
      // pins the whole list rather than just app_auth's absence from it.
      expect(body.hint).toBe('Only the following schemas are exposed: public, graphql_public')
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
