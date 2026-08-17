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
 * SPRIN-100 -- the board tables are governed by MEMBERSHIP, not ownership.
 *
 * `counters_owner`, `sprints_owner` and `tickets_owner` each become a single `for all`
 * policy resolving through `app_auth.is_project_member(project_id)`, with no role
 * predicate: an `admin` and a plain `member` do the same board work. The policy NAMES
 * still say "_owner" and no longer mean it -- see the migration's section 4.
 *
 * Two properties are asserted throughout, and both have burned this project before:
 *
 *   * RLS FILTERS on USING and RAISES on WITH CHECK. A refused SELECT, UPDATE or DELETE
 *     comes back as `{ data: [], error: null }` -- a write that changed nothing, which is
 *     indistinguishable from one that changed everything unless the row COUNT is checked.
 *     A refused INSERT is a thrown 42501. Asserting the wrong one passes for the wrong
 *     reason.
 *   * A policy that hides everything from everyone passes every negative test. So every
 *     negative below is paired with a POSITIVE control: the same statement, succeeding for
 *     a member, plus a service-role read-back proving the row is genuinely intact rather
 *     than merely un-returned.
 *
 * WHY THIS SUITE CREATES ITS OWN USERS instead of using the long-lived A and B. Vitest
 * runs test FILES in parallel against one shared live database, so a suite built on A and
 * B is exposed to whatever a sibling suite does to A and B concurrently -- and vice versa.
 * `project-members.integration.test.ts` already makes A and B co-members of a shared
 * project in its `beforeAll`, which is live for that suite's whole duration. Fresh
 * throwaway users sidestep all of it.
 *
 * WHY NO SECOND ADMIN IS EVER CREATED HERE, and it is not a stylistic choice.
 * `project-members.integration.test.ts` asserts a whole-DATABASE invariant that every
 * project has EXACTLY ONE admin. A second `admin` row anywhere -- even transiently, even
 * in a project this file owns -- turns that sibling suite red for reasons nothing in its
 * own diff explains. M joins as a plain `member`, and the only other membership rows in
 * play are the ones `on_project_created_admin` seeds for a project's own creator.
 *
 * EVERY ASSERTION IS SCOPED to a fixture this file created. Under a membership model an
 * unscoped `select` is a whole-table invariant whose answer depends on every concurrently
 * running suite; that exact mistake broke two assertions in SPRIN-105. The single
 * deliberate exception is the anonymous read below, and its docblock says why it is safe.
 *
 * GATING: this suite is gated on `SUPABASE_SERVICE_ROLE_KEY` rather than on `RLS_TEST_*`,
 * because it creates its own users and needs a client that bypasses RLS for the fixture
 * and for the read-backs. `assertServiceRoleOrExplain()` above, called at module load, is
 * what stops a missing key reporting this suite green by skipping it in CI. If a future
 * edit removes that call, it is removing a control, not tidying dead code.
 */
const PASSWORD = 'password123'

function freshEmail(tag: string): string {
  return `sprin100-${tag}-${crypto.randomUUID()}@example.com`
}

function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `B${pick()}${pick()}${pick()}`
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
 * Postgres "insufficient privilege". On these three tables `authenticated` holds the full
 * table grant (relacl `authenticated=arwdDxtm`, unchanged by SPRIN-100), so a 42501 here
 * can only be an RLS WITH CHECK violation -- but the code alone does not say so, and a
 * future revoke would silently change the author while leaving the code identical. Every
 * assertion of it below therefore pairs the code with a message match naming the mechanism.
 */
const INSUFFICIENT_PRIVILEGE = '42501'

const OWNER_TICKET_SUMMARY = 'Written by the owner'
const OWNER_SPRINT_NAME = 'Owned sprint'

describe.skipIf(!hasServiceRoleKey)('SPRIN-100 board tables resolve to membership', () => {
  const admin = hasServiceRoleKey ? adminClient() : (undefined as never)
  const createdUserIds: string[] = []

  /** Creates the project, so `on_project_created_admin` makes them its sole admin. */
  let oClient: SupabaseClient<Database>
  let oId: string

  /** Added to O's project as a plain `member`. Owns nothing, and does all the board work. */
  let mClient: SupabaseClient<Database>
  let mId: string

  /** Belongs to no project at all. The stranger -- and, at the very end, the bootstrapper. */
  let sClient: SupabaseClient<Database>
  let sId: string

  let projectId: string
  let projectKey: string
  /**
   * A SECOND project, owned by O, that M is deliberately NOT a member of. Without it this
   * file cannot distinguish "membership grants access to THIS project" from "membership
   * anywhere grants access to EVERYTHING" -- see the describe block that uses it.
   */
  let otherProjectId: string
  let otherTicketId: string
  let otherSprintId: string
  /** O's ticket. Read and updated by M; never deleted, so later tests can still see it. */
  let ownerTicketId: string
  /** O's second ticket, created to be deleted by M. Nothing else may touch it. */
  let doomedTicketId: string
  /** O's sprint. */
  let ownerSprintId: string

  // `@/lib/tickets` imports `./supabase`, which calls `getEnv()` at MODULE scope -- a static
  // import here would throw at file-load time whenever the environment is missing, turning
  // this file's loud, deliberate skip into a hard error. Imported lazily in beforeAll, the
  // same reasoning as tickets.integration.test.ts. Every `tickets` insert in the repo routes
  // through `ticketInsertPayload`, which is the one place that bridges the optional-`status`
  // guard type to the generated Insert type; a local cast here would be a second one.
  let ticketInsertPayload: typeof import('@/lib/tickets').ticketInsertPayload

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

  async function ownerTicket(summary: string): Promise<string> {
    const { data, error } = await oClient
      .from('tickets')
      .insert(ticketInsertPayload({ project_id: projectId, summary }))
      .select('id')
      .single()
    if (error)
      throw new Error(`Fixture: could not create the ticket "${summary}": ${error.message}`)
    return data.id
  }

  beforeAll(async () => {
    ;({ ticketInsertPayload } = await import('@/lib/tickets'))

    const oEmail = freshEmail('o')
    const mEmail = freshEmail('m')
    const sEmail = freshEmail('s')

    oId = await createUser(oEmail, 'Owner O')
    mId = await createUser(mEmail, 'Member M')
    sId = await createUser(sEmail, 'Stranger S')

    oClient = await signInWithCredentials(oEmail, PASSWORD)
    mClient = await signInWithCredentials(mEmail, PASSWORD)
    sClient = await signInWithCredentials(sEmail, PASSWORD)
    // The ids come from the admin API's own response, so there is no `auth.getUser()` here
    // and no second auth round-trip per user. ~14 of those once tripped GoTrue's rate
    // limiter and produced a bare null-`id` TypeError in a beforeAll.

    projectKey = runKey()
    const project = await oClient
      .from('projects')
      .insert({ owner_id: oId, name: 'SPRIN-100 board project', key: projectKey })
      .select('id')
      .single()
    if (project.error)
      throw new Error(`Fixture: could not create the project: ${project.error.message}`)
    projectId = project.data.id

    // M joins as a plain member, written with the SERVICE-ROLE client on purpose: the app
    // path for this is SPRIN-102 and does not exist yet, and using O's client would build
    // the fixture out of members_admin_insert -- a policy a SIBLING suite is trying to
    // prove. A fixture must not be built out of the thing under test.
    const join = await admin
      .from('project_members')
      .insert({ project_id: projectId, user_id: mId, role: 'member' })
    if (join.error)
      throw new Error(`Fixture: could not add M to the project: ${join.error.message}`)

    ownerTicketId = await ownerTicket(OWNER_TICKET_SUMMARY)
    doomedTicketId = await ownerTicket('Deleted by the member')

    const sprint = await oClient
      .from('sprints')
      .insert({ project_id: projectId, name: OWNER_SPRINT_NAME })
      .select('id')
      .single()
    if (sprint.error)
      throw new Error(`Fixture: could not create the sprint: ${sprint.error.message}`)
    ownerSprintId = sprint.data.id

    // The second project. O creates it too, so O is its sole admin and the sibling suite's
    // one-admin-per-project invariant is untouched. M is NEVER added to it.
    const other = await oClient
      .from('projects')
      .insert({ owner_id: oId, name: 'SPRIN-100 project M cannot reach', key: runKey() })
      .select('id')
      .single()
    if (other.error)
      throw new Error(`Fixture: could not create the second project: ${other.error.message}`)
    otherProjectId = other.data.id

    const otherTicket = await oClient
      .from('tickets')
      .insert(ticketInsertPayload({ project_id: otherProjectId, summary: 'Out of reach' }))
      .select('id')
      .single()
    if (otherTicket.error)
      throw new Error(`Fixture: could not create the second ticket: ${otherTicket.error.message}`)
    otherTicketId = otherTicket.data.id

    const otherSprint = await oClient
      .from('sprints')
      .insert({ project_id: otherProjectId, name: 'Out of reach' })
      .select('id')
      .single()
    if (otherSprint.error)
      throw new Error(`Fixture: could not create the second sprint: ${otherSprint.error.message}`)
    otherSprintId = otherSprint.data.id
  }, 60_000)

  afterAll(async () => {
    if (!hasServiceRoleKey) return
    // Deletes FIRST, before anything that could throw. Deleting the users cascades the
    // projects, and each project cascades its counter row, sprints and tickets -- every
    // owned table is `on delete cascade` from auth.users. A teardown assertion that fails
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

  describe('a member who owns nothing does the board work', () => {
    it('reads the tickets and the sprints of a project they do not own', async () => {
      const tickets = await mClient.from('tickets').select('id').eq('project_id', projectId)
      expect(tickets.error).toBeNull()
      expect([...(tickets.data ?? [])].map((row) => row.id).sort()).toEqual(
        [ownerTicketId, doomedTicketId].sort(),
      )

      const sprints = await mClient.from('sprints').select('id').eq('project_id', projectId)
      expect(sprints.error).toBeNull()
      expect(sprints.data).toEqual([{ id: ownerSprintId }])
    }, 30_000)

    it('reads the project counter row', async () => {
      // Scoped to the fixture project on purpose: counters_owner returns a row for every
      // project the caller belongs to, so an unfiltered select is a whole-table assertion
      // whose answer moves with whatever else is running.
      const { data, error } = await mClient
        .from('project_counters')
        .select('project_id')
        .eq('project_id', projectId)

      expect(error).toBeNull()
      expect(data).toEqual([{ project_id: projectId }])
    }, 30_000)

    /**
     * THE ASSERTION THAT MATTERS MOST IN THIS FILE, and it does not look like it.
     *
     * `assign_ticket_key` is deliberately NOT security definer (schema, lines 686-705), so
     * its `update project_counters ... returning last_number` runs as the caller and is
     * permitted only by `counters_owner`. If that policy ever stops granting a member the
     * WRITE -- narrowed to read-only, or split so that read is broader than write -- the
     * update matches zero rows, `last_number` comes back NULL, and the trigger assigns a
     * NULL key that the NOT NULL constraint then aborts. The key is the only observable
     * proof the counter update ran at all.
     *
     * The expected number is READ FROM THE COUNTER first rather than hardcoded. Hardcoding
     * `-3` would couple this test to how many tickets the fixture happens to create, and
     * asserting only "the key is well formed" would survive the trigger reading the wrong
     * counter row entirely.
     */
    it('assigns a member-created ticket a correctly numbered key from the counter', async () => {
      const before = await admin
        .from('project_counters')
        .select('last_number')
        .eq('project_id', projectId)
        .single()
      if (before.error) throw new Error(`Could not read the counter: ${before.error.message}`)
      const expected = before.data.last_number + 1

      const { data, error } = await mClient
        .from('tickets')
        .insert(ticketInsertPayload({ project_id: projectId, summary: 'Created by the member' }))
        .select('key, number')
        .single()

      expect(error).toBeNull()
      expect(data).toEqual({ key: `${projectKey}-${expected}`, number: expected })

      // ... and the counter really advanced, rather than the key being computed from
      // something else that happened to agree with it.
      const after = await admin
        .from('project_counters')
        .select('last_number')
        .eq('project_id', projectId)
        .single()
      expect(after.data!.last_number).toBe(expected)
    }, 30_000)

    it('updates a ticket they did not create', async () => {
      const { data, error } = await mClient
        .from('tickets')
        .update({ summary: 'Edited by the member' })
        .eq('id', ownerTicketId)
        .select('summary')

      expect(error).toBeNull()
      expect(data).toEqual([{ summary: 'Edited by the member' }])
    }, 30_000)

    it('deletes a ticket they did not create', async () => {
      const { data, error } = await mClient
        .from('tickets')
        .delete()
        .eq('id', doomedTicketId)
        .select('id')

      expect(error).toBeNull()
      expect(data).toEqual([{ id: doomedTicketId }])

      // Rows returned is not the same claim as rows deleted. Read back with the client that
      // bypasses RLS, so a delete that returned a row while leaving it in place is caught.
      const after = await admin.from('tickets').select('id').eq('id', doomedTicketId)
      expect(after.data).toEqual([])
    }, 30_000)

    it('creates a sprint and reads it back', async () => {
      const created = await mClient
        .from('sprints')
        .insert({ project_id: projectId, name: 'Created by the member' })
        .select('id, status')
        .single()

      expect(created.error).toBeNull()
      expect(created.data!.status).toBe('future')

      const read = await mClient.from('sprints').select('name').eq('id', created.data!.id)
      expect(read.error).toBeNull()
      expect(read.data).toEqual([{ name: 'Created by the member' }])
    }, 30_000)
  })

  describe('a stranger sees nothing and touches nothing', () => {
    it('sees zero tickets, zero sprints and zero counter rows for the project', async () => {
      const tickets = await sClient.from('tickets').select('id').eq('project_id', projectId)
      expect(tickets.error).toBeNull()
      expect(tickets.data).toEqual([])

      const sprints = await sClient.from('sprints').select('id').eq('project_id', projectId)
      expect(sprints.error).toBeNull()
      expect(sprints.data).toEqual([])

      const counter = await sClient
        .from('project_counters')
        .select('project_id')
        .eq('project_id', projectId)
      expect(counter.error).toBeNull()
      expect(counter.data).toEqual([])

      // POSITIVE CONTROL. Without it, a fixture that was never created -- or a sign-in that
      // silently produced an anon client -- passes all three assertions above.
      const asMember = await mClient.from('tickets').select('id').eq('project_id', projectId)
      expect(asMember.data?.length).toBeGreaterThan(0)
    }, 30_000)

    it('is refused a ticket insert, and the refusal RAISES', async () => {
      const { error } = await sClient
        .from('tickets')
        .insert(ticketInsertPayload({ project_id: projectId, summary: 'Written by a stranger' }))

      // INSERT is governed by WITH CHECK, which raises rather than filtering. Postgres runs
      // the RLS WITH CHECK before the tuple's NOT NULL constraints, so tickets_owner refuses
      // first and 42501 wins over the 23502 that `assign_ticket_key` would otherwise produce
      // (its counter update matches no row for a stranger, so `number` would arrive NULL).
      // Both are genuine refusals; only one of them is the POLICY, and this pins that one.
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/violates row-level security policy/)

      // Nothing landed, read with a client that bypasses RLS.
      const after = await admin
        .from('tickets')
        .select('id')
        .eq('project_id', projectId)
        .eq('summary', 'Written by a stranger')
      expect(after.data).toEqual([])
    }, 30_000)

    it('is refused a sprint insert, and the refusal RAISES', async () => {
      const { error } = await sClient
        .from('sprints')
        .insert({ project_id: projectId, name: 'Sprint by a stranger' })

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/violates row-level security policy/)

      const after = await admin
        .from('sprints')
        .select('id')
        .eq('project_id', projectId)
        .eq('name', 'Sprint by a stranger')
      expect(after.data).toEqual([])
    }, 30_000)

    it('changes zero rows updating a ticket, a sprint or the counter', async () => {
      // UPDATE is governed by USING, which FILTERS. `expect(error).toBeNull()` on its own
      // proves NOTHING here -- it is exactly what a successful cross-tenant write returns
      // too. The row COUNT is the assertion. All three columns touched below are ones
      // `authenticated` may genuinely UPDATE (the table grants are unchanged by SPRIN-100),
      // so a zero-row result measures the POLICY and not the grant; on an ungranted column
      // this would 42501 at the privilege layer and prove nothing about RLS at all.
      const ticket = await sClient
        .from('tickets')
        .update({ summary: 'Hijacked' })
        .eq('id', ownerTicketId)
        .select('id')
      expect(ticket.error).toBeNull()
      expect(ticket.data).toEqual([])

      const sprint = await sClient
        .from('sprints')
        .update({ name: 'Hijacked' })
        .eq('id', ownerSprintId)
        .select('id')
      expect(sprint.error).toBeNull()
      expect(sprint.data).toEqual([])

      // The counter is the ticket-key hijack vector: rewinding `last_number` would make the
      // next member-created ticket collide on `(project_id, number)`.
      const counter = await sClient
        .from('project_counters')
        .update({ last_number: 0 })
        .eq('project_id', projectId)
        .select('project_id')
      expect(counter.error).toBeNull()
      expect(counter.data).toEqual([])

      // POSITIVE CONTROL, in two halves. The service-role read proves the rows are intact;
      // the member read proves they are still VISIBLE through the policy, which is the half
      // a service-role read can never establish.
      const intact = await admin.from('tickets').select('summary').eq('id', ownerTicketId).single()
      expect(intact.data!.summary).not.toBe('Hijacked')

      const visible = await mClient.from('sprints').select('name').eq('id', ownerSprintId)
      expect(visible.data).toEqual([{ name: OWNER_SPRINT_NAME }])
    }, 30_000)

    it('changes zero rows deleting a ticket or a sprint', async () => {
      const ticket = await sClient.from('tickets').delete().eq('id', ownerTicketId).select('id')
      expect(ticket.error).toBeNull()
      expect(ticket.data).toEqual([])

      const sprint = await sClient.from('sprints').delete().eq('id', ownerSprintId).select('id')
      expect(sprint.error).toBeNull()
      expect(sprint.data).toEqual([])

      // Both halves of the positive control again: the rows exist, and the member can still
      // reach them. A DELETE that returned no rows while having deleted them would be the
      // worst of both worlds and nothing above would notice.
      const intact = await admin.from('tickets').select('id').in('id', [ownerTicketId])
      expect(intact.data).toEqual([{ id: ownerTicketId }])

      const visible = await mClient.from('sprints').select('id').eq('id', ownerSprintId)
      expect(visible.data).toEqual([{ id: ownerSprintId }])
    }, 30_000)
  })

  /**
   * MEMBERSHIP IS SCOPED TO ONE PROJECT, and this is the only block that can prove it.
   *
   * Every other negative in this file is written from S, who belongs to NO project at all --
   * so all of them are satisfied by a predicate that merely asks "is this caller a member of
   * anything?". Delete the `project_id` comparison from `app_auth.is_project_member` and S is
   * still refused, M is still granted, and every assertion above stays green while M can read
   * and write EVERY PROJECT IN THE DATABASE. That is the whole tenant boundary, and it needs a
   * caller who is a member of one project and a stranger to another. M, here, is both.
   *
   * The mutation this kills, stated exactly so it can be re-run:
   *
   *   select exists (select 1 from public.project_members m
   *                  where m.user_id = (select auth.uid()))   -- p_project_id ignored
   *
   * Note this also covers the weaker mutation of comparing against the wrong column, and it
   * is the case a viewer/role rewrite is most likely to break by accident later.
   */
  describe('membership is scoped to one project, not granted globally', () => {
    it("gives a member of one project no reach into another project's board", async () => {
      const tickets = await mClient.from('tickets').select('id').eq('project_id', otherProjectId)
      expect(tickets.error).toBeNull()
      expect(tickets.data).toEqual([])

      const sprints = await mClient.from('sprints').select('id').eq('project_id', otherProjectId)
      expect(sprints.error).toBeNull()
      expect(sprints.data).toEqual([])

      const counter = await mClient
        .from('project_counters')
        .select('project_id')
        .eq('project_id', otherProjectId)
      expect(counter.error).toBeNull()
      expect(counter.data).toEqual([])

      // Writes, too: read and write are one predicate here, so a leak on either is a leak.
      const update = await mClient
        .from('tickets')
        .update({ summary: 'Reached across' })
        .eq('id', otherTicketId)
        .select('id')
      expect(update.error).toBeNull()
      expect(update.data).toEqual([])

      const insert = await mClient
        .from('tickets')
        .insert(ticketInsertPayload({ project_id: otherProjectId, summary: 'Planted across' }))
      expect(insert.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(insert.error?.message).toMatch(/violates row-level security policy/)

      // POSITIVE CONTROLS. The rows exist and are intact; the second project is reachable by
      // somebody (O); and M's own project is still readable, so this is not a member whose
      // access simply broke. Without the last one, revoking M's membership entirely would
      // pass this test.
      const intact = await admin.from('tickets').select('summary').eq('id', otherTicketId).single()
      expect(intact.data!.summary).toBe('Out of reach')

      const asOwner = await oClient.from('sprints').select('id').eq('id', otherSprintId)
      expect(asOwner.data).toEqual([{ id: otherSprintId }])

      const ownProject = await mClient.from('tickets').select('id').eq('project_id', projectId)
      expect(ownProject.data?.length).toBeGreaterThan(0)
    }, 30_000)
  })

  /**
   * THE ANON SHAPE, WHICH IS PROTECTING PRODUCTION AND NOT JUST A POLICY.
   *
   * SPRIN-100 is the first story to put an `app_auth` call in front of tables `anon` holds a
   * grant on (relacl `anon=arwdDxtm` on all three, measured 2026-08-17). Policy expressions
   * are evaluated as the CALLING role, and `anon` holds neither USAGE on schema `app_auth`
   * nor EXECUTE on `is_project_member`. So WITHOUT the `to authenticated` clause on these
   * three policies, an anonymous read stops returning an empty array and starts raising
   * `permission denied for schema app_auth` (42501).
   *
   * What that breaks, in order of severity:
   *
   *   a. The cron-job.org keepalive performs an anonymous
   *      `GET /rest/v1/tickets?select=id&limit=1` and expects 200 with a JSON array. It
   *      would start receiving an error object, its failure email is the only monitoring,
   *      and the Supabase free tier pauses the project after ~7 days of inactivity -- at
   *      which point a paused database blocks EVERY merge, including the one that fixes it.
   *   b. This test, and `keepalive.integration.test.ts`, go red first. That is the good case,
   *      and it is the whole reason this test exists.
   *
   * So the assertion is deliberately on the SHAPE -- `error: null` with `data: []`, the RLS
   * filter -- and NOT merely on "anon sees no rows". A 42501 also returns no rows, and an
   * assertion written that way would stay green through exactly the regression it exists to
   * detect. If anyone drops `to authenticated`, this goes red here.
   *
   * UNSCOPED ON PURPOSE, and the only unscoped read in this file. Elsewhere an unscoped
   * select is a whole-table invariant that races every concurrent suite; here it cannot be,
   * because `anon` matches no policy on any row of these tables regardless of what else is
   * running. It is also the shape the cron itself uses, so scoping it to a fixture project
   * would test something narrower than the contract being protected.
   */
  describe('an anonymous caller gets the empty-array contract the keepalive depends on', () => {
    it('returns error null and an empty array on tickets, sprints and project_counters', async () => {
      const anon = anonClient()

      const tickets = await anon.from('tickets').select('id').limit(1)
      expect(tickets.error).toBeNull()
      expect(tickets.data).toEqual([])

      const sprints = await anon.from('sprints').select('id').limit(1)
      expect(sprints.error).toBeNull()
      expect(sprints.data).toEqual([])

      const counters = await anon.from('project_counters').select('project_id').limit(1)
      expect(counters.error).toBeNull()
      expect(counters.data).toEqual([])

      // POSITIVE CONTROL: the rows anon cannot see do exist. Without this, a database with
      // no tickets in it at all passes every assertion above.
      const asMember = await mClient.from('tickets').select('id').eq('project_id', projectId)
      expect(asMember.data?.length).toBeGreaterThan(0)
    }, 30_000)
  })

  /**
   * READ IS CO-EXTENSIVE WITH WRITE, and this is the test `src/lib/sprints.ts` names.
   *
   * `completeSprint`'s guard (`requireSprintStatus`, docblock at src/lib/sprints.ts around
   * lines 219-255) is correct ONLY because `sprints_owner` is a single `for all` policy: one
   * predicate governs the guard's precondition SELECT and both of the writes that follow it,
   * so "can read this sprint's status" and "can write it" are the same question. Split that
   * policy by verb so that read is broader than write -- a read-only `viewer` role is the
   * obvious way in, and David rejected one for the whole epic for exactly this reason -- and
   * a caller passes the guard and reaches the ticket move having never been allowed to
   * complete the sprint. The isolation suite would NOT flag it: nothing leaks across tenants,
   * so every cross-tenant assertion stays green.
   *
   * The assertion is therefore SET EQUALITY, not a round trip on one row: the set of sprints
   * a member may UPDATE must equal the set it may SELECT. A single-row round trip would stay
   * green under a verb split that widened read on OTHER rows. Both sets are scoped to this
   * file's own project, and both are asserted non-empty, so a policy denying everything
   * cannot pass by making two empty sets agree.
   */
  describe('read is co-extensive with write for a member', () => {
    it('gives a member exactly the same sprints to write as to read', async () => {
      const readable = await mClient.from('sprints').select('id').eq('project_id', projectId)
      expect(readable.error).toBeNull()

      const writable = await mClient
        .from('sprints')
        .update({ goal: 'Round-tripped through the same predicate' })
        .eq('project_id', projectId)
        .select('id')
      expect(writable.error).toBeNull()

      const readableIds = [...(readable.data ?? [])].map((row) => row.id).sort()
      const writableIds = [...(writable.data ?? [])].map((row) => row.id).sort()
      expect(writableIds).toEqual(readableIds)
      expect(readableIds.length).toBeGreaterThan(0)
    }, 30_000)

    it('gives a member exactly the same tickets to write as to read', async () => {
      // `completeSprint` writes `tickets` as well as `sprints` -- it returns the incomplete
      // tickets to the backlog -- so the same equivalence has to hold on this table.
      const readable = await mClient.from('tickets').select('id').eq('project_id', projectId)
      expect(readable.error).toBeNull()

      const writable = await mClient
        .from('tickets')
        .update({ description: 'Round-tripped through the same predicate' })
        .eq('project_id', projectId)
        .select('id')
      expect(writable.error).toBeNull()

      const readableIds = [...(readable.data ?? [])].map((row) => row.id).sort()
      const writableIds = [...(writable.data ?? [])].map((row) => row.id).sort()
      expect(writableIds).toEqual(readableIds)
      expect(readableIds.length).toBeGreaterThan(0)
    }, 30_000)
  })

  /**
   * THE BOOTSTRAP, which pins the OTHER half of the migration.
   *
   * Three AFTER INSERT triggers fire on `projects` in NAME order, and `on_project_created`
   * (the counter) sorts before `on_project_created_admin` (the membership row). Under a
   * membership-only `counters_owner`, a SECURITY INVOKER `create_project_counter` therefore
   * runs BEFORE the row that would authorise it exists, fails WITH CHECK, and EVERY PROJECT
   * CREATION FAILS. SPRIN-100 makes that function SECURITY DEFINER; revert only that half
   * and this block goes red while every membership assertion above stays green.
   *
   * S is used because at this point S belongs to no project anywhere, so nothing
   * pre-existing can mask the bootstrap. This block runs LAST for that reason: creating a
   * project makes S an admin of it, and the stranger assertions above must run first.
   * Note that S becomes the admin of their OWN project only -- exactly one admin per
   * project, which is the whole-database invariant a sibling suite asserts.
   */
  describe('a user who belongs to no project can still create one', () => {
    it('creates a project and immediately a ticket in it', async () => {
      const key = runKey()
      const project = await sClient
        .from('projects')
        .insert({ owner_id: sId, name: 'Bootstrapped by a newcomer', key })
        .select('id')
        .single()

      expect(project.error).toBeNull()
      expect(project.data).not.toBeNull()

      // The counter row exists, which is create_project_counter having survived RLS.
      const counter = await sClient
        .from('project_counters')
        .select('last_number')
        .eq('project_id', project.data!.id)
      expect(counter.error).toBeNull()
      expect(counter.data).toEqual([{ last_number: 0 }])

      // And the creator can immediately do board work in it, through the membership row
      // `on_project_created_admin` seeded -- not through `owner_id`, which grants nothing.
      const ticket = await sClient
        .from('tickets')
        .insert(ticketInsertPayload({ project_id: project.data!.id, summary: 'First ticket' }))
        .select('key, number')
        .single()

      expect(ticket.error).toBeNull()
      expect(ticket.data).toEqual({ key: `${key}-1`, number: 1 })
    }, 30_000)
  })
})
