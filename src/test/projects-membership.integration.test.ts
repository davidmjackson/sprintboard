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
  userId,
} from './supabase-clients'

assertServiceRoleOrExplain()

/**
 * SPRIN-101 -- the `projects` table is governed by MEMBERSHIP, not ownership.
 *
 * `projects_owner` -- ONE `for all` policy, no `TO` clause, `owner_id = auth.uid()` in both
 * clauses -- is replaced by four verb-scoped policies, every one `to authenticated`:
 *
 *   projects_member_read       SELECT  app_auth.is_project_member(id)
 *   projects_bootstrap_insert  INSERT  owner_id = (select auth.uid())
 *   projects_admin_update      UPDATE  app_auth.is_project_admin(id), USING and WITH CHECK
 *   projects_admin_delete      DELETE  app_auth.is_project_admin(id)
 *
 * So this table is the first where READ IS DELIBERATELY BROADER THAN WRITE: a plain member
 * sees the project and may change nothing about it. That asymmetry is the SPRIN-64 class
 * `CLAUDE.md` warns about -- an app-layer guard that leans on a policy's breadth stops holding
 * silently -- and it is opened here ON PURPOSE, with the one reachable consequence
 * (`updateProjectCadence`'s zero-row blindness) handed to SPRIN-104 by name. Nothing below
 * papers over it; the member blocks assert exactly that a member reads and cannot write.
 *
 * Two properties are asserted throughout, and both have burned this project before:
 *
 *   * RLS FILTERS on USING and RAISES on WITH CHECK. A refused SELECT, UPDATE or DELETE comes
 *     back as `{ data: [], error: null }` -- a write that changed nothing, indistinguishable
 *     from one that changed everything unless the row COUNT is read. A refused INSERT is a
 *     thrown 42501. Asserting the wrong one passes for the wrong reason.
 *   * A policy that hides everything from everyone passes every negative test. So every
 *     negative below is paired with a POSITIVE control, plus a service-role read-back proving
 *     the row is genuinely intact rather than merely un-returned.
 *
 * EVERY ROW-COUNT WRITE ASSERTION USES `sprint_length_weeks`, and that is not a stylistic
 * choice. `projects` holds NO table-level UPDATE for `authenticated` and exactly two column
 * grants -- `sprint_length_weeks` and `sprint_start_weekday`. On any other column
 * (`name`, `key`, `project_type`, `owner_id`) the write is refused by the PRIVILEGE layer with
 * 42501 before RLS is ever consulted, so a zero-row assertion there would measure the grant
 * and say nothing whatsoever about the policy. SPRIN-82 shipped that mistake and SPRIN-97
 * fixed it; `CLAUDE.md` states the rule as a property: a cross-tenant row-count assertion is
 * only honest on a column the role may actually UPDATE.
 *
 * ...AND EVERY SUCH WRITE TARGETS A VALUE THE ROW DOES NOT ALREADY HOLD. A no-op UPDATE and a
 * refused UPDATE leave identical evidence behind, so each block reads the stored value first
 * and asserts the value it is about to write differs from it.
 *
 * WHY THIS SUITE CREATES ITS OWN USERS instead of using the long-lived A and B. Vitest runs
 * test FILES in parallel against one shared live database, so a suite built on A and B is
 * exposed to whatever a sibling does to A and B concurrently -- and vice versa.
 * `project-members.integration.test.ts` already makes A and B co-members of a shared project
 * for its whole duration. Fresh throwaway users sidestep all of it.
 *
 * WHY NO SECOND ADMIN IS EVER CREATED HERE, and it is not a stylistic choice either.
 * `project-members.integration.test.ts` asserts a whole-DATABASE invariant that every project
 * has EXACTLY ONE admin, and that it is the owner. A second `admin` row anywhere -- even
 * transiently, even in a project this file owns -- turns that sibling suite red for reasons
 * nothing in its own diff explains. The admin side of every assertion here is played by O,
 * whose row `seed_project_admin` creates for free; M joins as a plain `member`.
 *
 * GATING: gated on `SUPABASE_SERVICE_ROLE_KEY` rather than on `RLS_TEST_*`, because it creates
 * its own users and needs a client that bypasses RLS for the fixture and for every read-back.
 * `assertServiceRoleOrExplain()` above, called at module load, is what stops a missing key
 * reporting this suite green by skipping it in CI. If a future edit removes that call, it is
 * removing a control, not tidying dead code.
 */
const PASSWORD = 'password123'

/** The cadence the ADMIN writes. Never equal to the column default, and asserted so. */
const ADMIN_LENGTH = 4
/** The cadence a plain MEMBER attempts. */
const MEMBER_ATTEMPT = 1
/** The cadence the CROSS-PROJECT admin attempts. All three differ, all are in 1..4. */
const STRANGER_ATTEMPT = 3

const PROJECT_NAME = 'SPRIN-101 membership project'

function freshEmail(tag: string): string {
  return `sprin101-${tag}-${crypto.randomUUID()}@example.com`
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

/**
 * Postgres "insufficient privilege". On `projects` this code has TWO possible authors -- a
 * revoked GRANT and an RLS WITH CHECK violation -- and they differ only in the message prose.
 * Every assertion of it below therefore pairs the code with a match naming which control
 * refused, so a future grant change cannot leave the assertion green while the mechanism it
 * describes has been replaced.
 */
const INSUFFICIENT_PRIVILEGE = '42501'

describe.skipIf(!hasServiceRoleKey)('SPRIN-101 projects resolves to membership', () => {
  const admin = hasServiceRoleKey ? adminClient() : (undefined as never)
  const createdUserIds: string[] = []

  /** Creates the fixture project, so `seed_project_admin` makes them its sole admin. */
  let oClient: SupabaseClient<Database>
  let oId: string

  /** Added to O's project as a plain `member`. Reads it, and may write nothing about it. */
  let mClient: SupabaseClient<Database>
  let mId: string

  /**
   * A stranger to the fixture project who is nonetheless the ADMIN of a project of their own.
   * This user, and only this user, can catch a predicate that ignores its `project_id`
   * argument -- see the cross-project block, which is the most important in the file.
   */
  let sClient: SupabaseClient<Database>
  let sId: string

  /**
   * The bootstrapper: belongs to NO project at all, and is a fourth user rather than a reuse
   * of S precisely because S owns one. AC3 asks whether INSERT works for someone with zero
   * membership rows anywhere, which is the only case that can prove the INSERT policy is not
   * quietly leaning on membership. Reusing S would answer a weaker question.
   */
  let nClient: SupabaseClient<Database>
  let nId: string

  /** O's project. M is a member of it; S and N are not. Subject of nearly every assertion. */
  let projectId: string
  /** O's second project, created to be deleted by O in AC2. Nothing else may touch it. */
  let doomedProjectId: string
  /** S's own project. Exists so S is a member of SOMETHING. Never touched by anyone else. */
  let strangerProjectId: string

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

  /**
   * Signs in and proves the session belongs to the user we think it does.
   *
   * The id itself comes from the admin API's own `createUser` response, so there is no
   * `auth.getUser()` anywhere in this file -- that second auth round-trip per `beforeAll` is
   * the documented fuel for the GoTrue rate-limit flake, whose signature is a bare
   * `TypeError: Cannot read properties of null (reading 'id')` in setup.
   *
   * `userId()` is called anyway, as a CONTROL rather than for the value: it reads the
   * IN-MEMORY session, costs no network call and cannot be rate-limited, and it is the only
   * thing in this file that would notice a fixture wiring the wrong client to the wrong user
   * -- a mix-up that would otherwise make every negative assertion pass for the wrong reason.
   */
  async function signInAs(email: string, expectedId: string): Promise<SupabaseClient<Database>> {
    const client = await signInWithCredentials(email, PASSWORD)
    const actual = await userId(client)
    if (actual !== expectedId) {
      throw new Error(`Fixture: signed in as ${actual}, expected ${expectedId} (${email}).`)
    }
    return client
  }

  async function createProject(
    client: SupabaseClient<Database>,
    ownerId: string,
    name: string,
  ): Promise<string> {
    const { data, error } = await client
      .from('projects')
      .insert({ owner_id: ownerId, name, key: runKey() })
      .select('id')
      .single()
    if (error) throw new Error(`Fixture: could not create "${name}": ${error.message}`)
    return data.id
  }

  /** The stored cadence, read with the client that bypasses RLS. */
  async function storedLength(id: string): Promise<number> {
    const { data, error } = await admin
      .from('projects')
      .select('sprint_length_weeks')
      .eq('id', id)
      .single()
    if (error) throw new Error(`Could not read the stored cadence of ${id}: ${error.message}`)
    return data.sprint_length_weeks
  }

  beforeAll(async () => {
    const oEmail = freshEmail('o')
    const mEmail = freshEmail('m')
    const sEmail = freshEmail('s')
    const nEmail = freshEmail('n')

    oId = await createUser(oEmail, 'Admin O')
    mId = await createUser(mEmail, 'Member M')
    sId = await createUser(sEmail, 'Stranger S')
    nId = await createUser(nEmail, 'Newcomer N')

    oClient = await signInAs(oEmail, oId)
    mClient = await signInAs(mEmail, mId)
    sClient = await signInAs(sEmail, sId)
    nClient = await signInAs(nEmail, nId)

    projectId = await createProject(oClient, oId, PROJECT_NAME)
    doomedProjectId = await createProject(oClient, oId, 'SPRIN-101 project the admin deletes')
    // S creates their own, so S is its sole admin and the sibling suite's one-admin-per-project
    // invariant is untouched. N creates nothing here -- that is AC3's whole subject.
    strangerProjectId = await createProject(sClient, sId, "SPRIN-101 stranger's own project")

    // M joins as a plain member, written with the SERVICE-ROLE client on purpose: the app path
    // for this is SPRIN-102 and does not exist yet, and using O's client would build the
    // fixture out of `members_admin_insert` -- a policy a SIBLING suite is trying to prove. A
    // fixture must not be built out of the thing under test.
    const join = await admin
      .from('project_members')
      .insert({ project_id: projectId, user_id: mId, role: 'member' })
    if (join.error)
      throw new Error(`Fixture: could not add M to the project: ${join.error.message}`)
  }, 60_000)

  afterAll(async () => {
    if (!hasServiceRoleKey) return
    // Deletes FIRST, before anything that could throw. Deleting the users cascades their
    // projects, and each project cascades its counter row, statuses, sprints and tickets --
    // every owned table is `on delete cascade` from auth.users. A teardown assertion that fails
    // before the delete strands fixture rows in the shared database, which has already cost
    // this project ten orphaned projects.
    const failures: string[] = []
    for (const id of createdUserIds) {
      const { error } = await settled(admin.auth.admin.deleteUser(id))
      if (error) failures.push(`${id}: ${error.message}`)
    }
    if (failures.length > 0) {
      throw new Error(`Failed to delete ${failures.length} test user(s):\n${failures.join('\n')}`)
    }
  }, 60_000)

  describe('AC1 -- SELECT resolves to membership', () => {
    it('shows the project to a member who does not own it, and nothing to a stranger', async () => {
      const asMember = await mClient.from('projects').select('id, name').eq('id', projectId)
      expect(asMember.error).toBeNull()
      expect(asMember.data).toEqual([{ id: projectId, name: PROJECT_NAME }])

      // The stranger is filtered, not refused: `projects_member_read`'s USING is false for S,
      // so this is `{ data: [], error: null }` and NOT a raised error.
      const asStranger = await sClient.from('projects').select('id').eq('id', projectId)
      expect(asStranger.error).toBeNull()
      expect(asStranger.data).toEqual([])

      // POSITIVE CONTROL. Without it, a fixture that was never created -- or a sign-in that
      // silently produced an anon client -- passes the stranger assertion above.
      const asAdmin = await oClient.from('projects').select('id').eq('id', projectId)
      expect(asAdmin.error).toBeNull()
      expect(asAdmin.data).toEqual([{ id: projectId }])
    }, 30_000)

    /**
     * The member's PROJECT LIST, which is the gap SPRIN-100 left open and this story closes:
     * a member had board access to a project that did not appear in their own list at all.
     * The scoped read above cannot see that -- it filters by the very id under test.
     *
     * UNSCOPED, and safe to be. Elsewhere in this repo an unscoped select is a whole-table
     * invariant racing every concurrent suite; here it is bounded by M, a user this file
     * created moments ago with a random address. No other suite can add M to a project, so
     * the set of projects M can read is exactly the set this file put them in.
     */
    it("puts the project in the member's own project list", async () => {
      const { data, error } = await mClient.from('projects').select('id')
      expect(error).toBeNull()
      expect(data).toEqual([{ id: projectId }])
    }, 30_000)
  })

  describe('AC2 -- UPDATE and DELETE are admin work', () => {
    it('lets the admin change the sprint cadence, and changes exactly one row', async () => {
      const before = await storedLength(projectId)
      // A no-op UPDATE and a refused UPDATE are indistinguishable afterwards, so the value
      // written must differ from the value stored. SPRIN-97 recorded exactly this.
      expect(before).not.toBe(ADMIN_LENGTH)

      const { data, error } = await oClient
        .from('projects')
        .update({ sprint_length_weeks: ADMIN_LENGTH })
        .eq('id', projectId)
        .select('id, sprint_length_weeks')

      expect(error).toBeNull()
      expect(data).toEqual([{ id: projectId, sprint_length_weeks: ADMIN_LENGTH }])

      // Rows RETURNED is not the same claim as rows WRITTEN. Read back through the client that
      // bypasses RLS. This read-back is also the positive control every zero-row assertion in
      // this file depends on: it proves `authenticated` really does hold the column grant, so
      // a zero-row result elsewhere is the POLICY refusing and not a missing privilege.
      expect(await storedLength(projectId)).toBe(ADMIN_LENGTH)
    }, 30_000)

    it('lets the admin delete a project, and deletes exactly one row', async () => {
      const { data, error } = await oClient
        .from('projects')
        .delete()
        .eq('id', doomedProjectId)
        .select('id')

      expect(error).toBeNull()
      expect(data).toEqual([{ id: doomedProjectId }])

      // Gone for real, not merely un-returned.
      const after = await admin.from('projects').select('id').eq('id', doomedProjectId)
      expect(after.data).toEqual([])
    }, 30_000)

    /**
     * THE SOLE SURVIVING CONTROL ON `owner_id`, and this test exists because this migration
     * is what reduced them from two to one.
     *
     * The old `projects_owner` was `for all` with `owner_id = auth.uid()` in its WITH CHECK,
     * so that clause applied to UPDATE as well as INSERT. `projects_admin_update` checks
     * `is_project_admin(id)` and says NOTHING about `owner_id` -- deliberately, because an
     * admin who is not the owner must be able to change the cadence. On paper an admin may
     * therefore now reassign ownership; in practice the write is refused a layer EARLIER,
     * because `authenticated` holds no table-level UPDATE on `projects` and no column grant on
     * `owner_id`. The design records that narrowing rather than glossing it. One control left
     * means the control needs a test.
     *
     * ASSERT THE CODE *AND* THE MESSAGE. 42501 is a class, not a control: an RLS WITH CHECK
     * violation raises the identical code elsewhere in this very file. Only the message tells
     * them apart, and both wordings were measured live by SPRIN-82 --
     * `permission denied for table projects` for the revoked grant against
     * `new row violates row-level security policy for table "projects"` for RLS. Without the
     * message, a future migration that ran `grant update (owner_id)` while some policy
     * happened to refuse would leave this green and the narrowing undetected -- which is
     * precisely the four-part obligation `CLAUDE.md` places on widening this table.
     *
     * THE CALLER IS THE ADMIN, NOT A STRANGER, and that is the whole point. A stranger's
     * UPDATE is filtered to zero rows by `projects_admin_update` regardless, so a
     * stranger-side test would pass identically with the grant fully restored and prove
     * nothing at all. The only caller who could ever rewrite the column is one RLS admits.
     */
    it("refuses even the admin's own owner_id UPDATE (revoked grant -> 42501)", async () => {
      const { data, error } = await oClient
        .from('projects')
        .update({ owner_id: mId })
        .eq('id', projectId)
        .select('id')

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toContain('permission denied')
      expect(data).toBeNull()

      // The privilege layer refuses before any row is touched, so the column still holds O.
      // Read past RLS: a policy-filtered read would say nothing about the stored value.
      const stored = await admin.from('projects').select('owner_id').eq('id', projectId).single()
      expect(stored.data!.owner_id).toBe(oId)
    }, 30_000)
  })

  describe('AC3 -- INSERT still bootstraps', () => {
    /**
     * THE BOOTSTRAP, which pins the half of the migration the membership tests cannot reach.
     *
     * If authority came only from membership rows, creating a project would require a
     * membership that does not yet exist and EVERY project creation would fail.
     * `projects_bootstrap_insert` keeps `owner_id = (select auth.uid())` for exactly that
     * reason, and N -- who belongs to no project anywhere -- is the only caller who can show
     * it works without a membership row masking the result.
     *
     * BOTH HALVES ARE ASSERTED, because the insert succeeding proves nothing about the
     * seeding. `seed_project_admin` reads NEW.OWNER_ID rather than `auth.uid()`; if it were
     * ever rewritten to read `auth.uid()`, every service-role fixture insert across the live
     * suites and the Playwright E2E would create a project with NO admin -- permanently
     * undeletable under `projects_admin_delete`, and invisible to nobody, so nothing else
     * would notice. The membership read-back below is what notices.
     */
    it('lets a user who belongs to no project create one and be seeded as its admin', async () => {
      const key = runKey()
      const created = await nClient
        .from('projects')
        .insert({ owner_id: nId, name: 'Bootstrapped by a newcomer', key })
        .select('id')
        .single()

      expect(created.error).toBeNull()
      expect(created.data).not.toBeNull()
      const newProjectId = created.data!.id

      // The seeded row, read with the client that bypasses RLS -- reading it as N would
      // conflate "the row exists" with "N may see it".
      const seeded = await admin
        .from('project_members')
        .select('user_id, role')
        .eq('project_id', newProjectId)
      expect(seeded.error).toBeNull()
      expect(seeded.data).toEqual([{ user_id: nId, role: 'admin' }])

      // ...and the creator can read the project back through `projects_member_read`, i.e.
      // through the seeded membership row. `owner_id` grants nothing on its own after this
      // migration; it is an audit column.
      const readBack = await nClient.from('projects').select('id').eq('id', newProjectId)
      expect(readBack.error).toBeNull()
      expect(readBack.data).toEqual([{ id: newProjectId }])
    }, 30_000)
  })

  describe('AC4 -- a member reads the project but cannot update it', () => {
    it('changes zero rows when a member edits the cadence, and the stored value stands', async () => {
      const before = await storedLength(projectId)
      expect(before).not.toBe(MEMBER_ATTEMPT)

      const { data, error } = await mClient
        .from('projects')
        .update({ sprint_length_weeks: MEMBER_ATTEMPT })
        .eq('id', projectId)
        .select('id')

      // `expect(error).toBeNull()` on its own proves NOTHING here -- it is precisely what a
      // successful write returns too. `projects_admin_update`'s USING FILTERS the row out, so
      // the ROW COUNT is the assertion. And the column is one `authenticated` genuinely holds
      // UPDATE on, so zero rows measures the policy rather than the grant.
      expect(error).toBeNull()
      expect(data).toEqual([])

      expect(await storedLength(projectId)).toBe(before)

      // POSITIVE CONTROL, and it is the one that makes this test about ROLE rather than about
      // access. Without it, a membership row that was never created -- or one deleted by a
      // stray cascade -- passes the assertion above for entirely the wrong reason. M can still
      // SEE the project; M simply may not write it. That asymmetry is the point of the story.
      const visible = await mClient.from('projects').select('id').eq('id', projectId)
      expect(visible.data).toEqual([{ id: projectId }])
    }, 30_000)
  })

  describe('AC5 -- the remaining verbs, and the anonymous caller', () => {
    it('changes zero rows when a member deletes the project, and it survives', async () => {
      const { data, error } = await mClient
        .from('projects')
        .delete()
        .eq('id', projectId)
        .select('id')

      // DELETE is governed by USING and therefore FILTERS. A member deleting a project would
      // not be a small leak: the delete cascades through counters, sprints, tickets, statuses,
      // fields, options, values and memberships, and RLS IS NOT ENFORCED ON CASCADED CHILD
      // ROWS. `projects_admin_delete` is what keeps the blast radius matched to the authority.
      expect(error).toBeNull()
      expect(data).toEqual([])

      const survives = await admin.from('projects').select('id').eq('id', projectId)
      expect(survives.data).toEqual([{ id: projectId }])

      // POSITIVE CONTROL: still a member, still reading. A DELETE that returned no rows while
      // having deleted them would be the worst of both worlds, and the service-role read above
      // is the only thing that could tell.
      const visible = await mClient.from('projects').select('id').eq('id', projectId)
      expect(visible.data).toEqual([{ id: projectId }])
    }, 30_000)

    /**
     * THE ANON SHAPE, WHICH IS PROTECTING THE KEEPALIVE AND NOT JUST A POLICY.
     *
     * Measured from `pg_class.relacl` on 2026-08-20, `anon` holds INSERT, SELECT and DELETE on
     * `projects` (`anon=ardDxtm`). Policy expressions are evaluated as the CALLING role, and
     * `anon` holds neither USAGE on schema `app_auth` nor EXECUTE on its functions. So WITHOUT
     * `to authenticated` on `projects_member_read`, an anonymous read of this table stops
     * returning an empty array and starts raising `permission denied for schema app_auth`
     * (42501) -- the rule SPRIN-100 added to `CLAUDE.md`, of which `projects` is the second
     * table to need it.
     *
     * The assertion is therefore on the SHAPE -- `error: null` with `data: []`, the RLS filter
     * -- and NOT merely on "anon sees no rows". A 42501 also returns no rows, and an assertion
     * written that way would stay green through exactly the regression it exists to detect.
     *
     * UNSCOPED ON PURPOSE, and the only unscoped read in this file other than M's project
     * list. Elsewhere an unscoped select is a whole-table invariant racing every concurrent
     * suite; here it cannot be, because `anon` matches no policy on any row of this table
     * regardless of what else is running.
     *
     * `anonClient()` performs no sign-in, so all of this costs the GoTrue rate limiter nothing.
     */
    it('gives an anonymous caller the RLS-filtered empty array, not a schema error', async () => {
      const anon = anonClient()

      const { data, error } = await anon.from('projects').select('id').limit(1)
      expect(error).toBeNull()
      expect(data).toEqual([])

      // POSITIVE CONTROL: the rows anon cannot see do exist. Without this, a database holding
      // no projects at all passes the assertion above.
      const exists = await admin.from('projects').select('id').eq('id', projectId)
      expect(exists.data).toEqual([{ id: projectId }])
    }, 30_000)

    /**
     * The two anon WRITE verbs, which fail in DIFFERENT SHAPES -- and picking the wrong shape
     * is how a test passes for the wrong reason. INSERT is governed by WITH CHECK, which
     * RAISES; DELETE is governed by USING, which FILTERS.
     *
     * WHEN SPRIN-103 LANDS, BOTH ASSERTIONS BELOW CHANGE, and that is the sweep arriving
     * rather than a regression. That story revokes `anon`'s now-pointless `a`/`d` grants on
     * this table schema-wide; afterwards the INSERT is refused one layer earlier with
     * `permission denied for table projects`, and the DELETE stops being a silent zero-row
     * filter and becomes a raised 42501 too. Update them deliberately at that point -- do not
     * loosen the message matches now to make them survive both worlds, because the message is
     * the only thing that says WHICH control refused.
     */
    it('refuses an anonymous insert and deletes nothing anonymously', async () => {
      const anon = anonClient()

      const insert = await anon
        .from('projects')
        .insert({ owner_id: oId, name: 'Planted by nobody', key: runKey() })
      expect(insert.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(insert.error?.message).toMatch(/violates row-level security policy/)

      const planted = await admin.from('projects').select('id').eq('name', 'Planted by nobody')
      expect(planted.data).toEqual([])

      const del = await anon.from('projects').delete().eq('id', projectId).select('id')
      expect(del.error).toBeNull()
      expect(del.data).toEqual([])

      const survives = await admin.from('projects').select('id').eq('id', projectId)
      expect(survives.data).toEqual([{ id: projectId }])
    }, 30_000)
  })

  /**
   * MEMBERSHIP IS SCOPED TO ONE PROJECT, AND THIS IS THE ONLY BLOCK THAT CAN PROVE IT.
   *
   * Every other negative in this file is written from a caller who belongs to NOTHING relevant
   * -- S has no row in the fixture project, N has no row anywhere -- so all of them are
   * satisfied by a predicate that merely asks "is this caller a member of anything?". Drop the
   * `project_id` comparison from `app_auth.is_project_member` and M is still granted, N is
   * still refused, and every assertion above stays green while any member of any project reads
   * EVERY PROJECT IN THE DATABASE. That is the whole tenant boundary.
   *
   * S is the caller who can see it, because S is an admin of their own project and a stranger
   * to this one. Note that only an ADMIN elsewhere can catch the UPDATE and DELETE mutations:
   * M is a member of this project but an admin of nothing, so an `is_project_admin` that
   * ignored its argument would still refuse M and every AC4/AC5 assertion would hold.
   *
   * The mutations this kills, stated exactly so they can be re-run:
   *
   *   select exists (select 1 from public.project_members m
   *                  where m.user_id = (select auth.uid()))   -- p_project_id ignored
   *
   *   ...and the same in is_project_admin, with `and m.role = 'admin'` retained.
   *
   * Both directions are asserted. The mirror -- O, an admin HERE, reaching into S's project --
   * is not redundant: a predicate could be broken for one argument position and not the other,
   * and the cheapest way to find out is to ask twice.
   */
  describe('membership is scoped to one project, not granted globally', () => {
    it('gives an admin of another project no read, update or delete here', async () => {
      const read = await sClient.from('projects').select('id').eq('id', projectId)
      expect(read.error).toBeNull()
      expect(read.data).toEqual([])

      const before = await storedLength(projectId)
      expect(before).not.toBe(STRANGER_ATTEMPT)

      const update = await sClient
        .from('projects')
        .update({ sprint_length_weeks: STRANGER_ATTEMPT })
        .eq('id', projectId)
        .select('id')
      expect(update.error).toBeNull()
      expect(update.data).toEqual([])

      const del = await sClient.from('projects').delete().eq('id', projectId).select('id')
      expect(del.error).toBeNull()
      expect(del.data).toEqual([])

      // Intact, read past RLS.
      expect(await storedLength(projectId)).toBe(before)
      const survives = await admin.from('projects').select('id').eq('id', projectId)
      expect(survives.data).toEqual([{ id: projectId }])

      // POSITIVE CONTROL, and it is what makes S a CROSS-PROJECT caller rather than a broken
      // session. S is an admin of their own project and can do all three things there. Without
      // this, a user whose membership row never existed passes every assertion above.
      const own = await sClient.from('projects').select('id').eq('id', strangerProjectId)
      expect(own.data).toEqual([{ id: strangerProjectId }])
    }, 30_000)

    it("gives an admin here no reach into another project's row", async () => {
      const ownBefore = await storedLength(strangerProjectId)
      expect(ownBefore).not.toBe(STRANGER_ATTEMPT)

      const read = await oClient.from('projects').select('id').eq('id', strangerProjectId)
      expect(read.error).toBeNull()
      expect(read.data).toEqual([])

      const update = await oClient
        .from('projects')
        .update({ sprint_length_weeks: STRANGER_ATTEMPT })
        .eq('id', strangerProjectId)
        .select('id')
      expect(update.error).toBeNull()
      expect(update.data).toEqual([])

      const del = await oClient.from('projects').delete().eq('id', strangerProjectId).select('id')
      expect(del.error).toBeNull()
      expect(del.data).toEqual([])

      expect(await storedLength(strangerProjectId)).toBe(ownBefore)

      // POSITIVE CONTROL: O is not simply locked out of everything -- O administers the
      // fixture project and AC2 proved it there.
      const own = await oClient.from('projects').select('id').eq('id', projectId)
      expect(own.data).toEqual([{ id: projectId }])
    }, 30_000)
  })
})
