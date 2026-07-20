// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { selectBacklogTickets } from '@/lib/backlog'
import {
  assertCredentialsOrExplain,
  hasRlsCredentials,
  RLS_USERS,
  signIn,
} from './supabase-clients'

assertCredentialsOrExplain()

/**
 * S4.1 — the ticket-creation contract `createTicket` relies on, proven live: the
 * BEFORE INSERT trigger assigns PROJECTKEY-N atomically, concurrent inserts get
 * consecutive unique numbers, new tickets default to To Do, and a cross-tenant insert
 * is rejected. Uses the signed-in RLS user, since inserts are owner-scoped through the
 * project.
 */
function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `P${pick()}${pick()}${pick()}`
}

describe.skipIf(!hasRlsCredentials)('S4.1 ticket-creation contract', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let projectId: string
  let projectKey: string

  beforeAll(async () => {
    a = await signIn('A')
    userAId = (await a.auth.getUser()).data.user!.id
    b = await signIn('B')
    projectKey = runKey()
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Ticket contract', key: projectKey })
      .select()
      .single()
    if (error) throw error
    projectId = data!.id
  }, 30_000)

  afterAll(async () => {
    // Deleting the project cascades to its tickets (tickets.project_id on delete cascade).
    await a.from('projects').delete().eq('id', projectId)
  }, 30_000)

  it('assigns PROJECTKEY-1, number 1, and status todo to the first ticket', async () => {
    const { data, error } = await a
      .from('tickets')
      .insert({ project_id: projectId, summary: 'First ticket' })
      .select()
      .single()

    expect(error).toBeNull()
    expect(data).toMatchObject({ key: `${projectKey}-1`, number: 1, status: 'todo' })
  }, 30_000)

  it('gives consecutive, unique numbers to tickets created in quick succession', async () => {
    const [t1, t2] = await Promise.all([
      a.from('tickets').insert({ project_id: projectId, summary: 'Race A' }).select().single(),
      a.from('tickets').insert({ project_id: projectId, summary: 'Race B' }).select().single(),
    ])

    expect(t1.error).toBeNull()
    expect(t2.error).toBeNull()
    const nums = [t1.data!.number, t2.data!.number].sort((x, y) => x - y)
    expect(nums[1]! - nums[0]!).toBe(1) // consecutive — no gaps
    expect(new Set(nums).size).toBe(2) // unique — no collision
  }, 30_000)

  it("rejects a ticket inserted into another owner's project (cross-tenant)", async () => {
    // Signed in as B, inserting into A's project: the counters_owner policy denies the
    // counter update (number -> NULL -> NOT NULL abort) and tickets_owner's with-check
    // denies the row. Either way the insert fails and nothing is created.
    const { data, error } = await b
      .from('tickets')
      .insert({ project_id: projectId, summary: 'Intruder' })
      .select()
      .single()

    expect(error).not.toBeNull()
    expect(data).toBeNull()

    // Independent no-row check, not just "nothing was returned": as the owner, confirm
    // no such row exists. `data === null` alone follows mechanically from a non-null
    // error and would not distinguish a rejected insert from an RLS-filtered RETURNING.
    const { data: rows } = await a.from('tickets').select('summary').eq('project_id', projectId)
    expect((rows ?? []).some((r) => r.summary === 'Intruder')).toBe(false)
  }, 30_000)
})

describe.skipIf(!hasRlsCredentials)('S4.2 ticket-update contract', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let userBId: string
  let projectId: string
  let ticketId: string
  // A project owned by B, used only as the (forbidden) reparent target below.
  let bProjectId: string

  beforeAll(async () => {
    a = await signIn('A')
    userAId = (await a.auth.getUser()).data.user!.id
    b = await signIn('B')
    userBId = (await b.auth.getUser()).data.user!.id
    const { data: proj, error: projErr } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Update contract', key: runKey() })
      .select()
      .single()
    if (projErr) throw projErr
    projectId = proj!.id
    const { data: tkt, error: tktErr } = await a
      .from('tickets')
      .insert({ project_id: projectId, summary: 'Original' })
      .select()
      .single()
    if (tktErr) throw tktErr
    ticketId = tkt!.id
    const { data: bProj, error: bProjErr } = await b
      .from('projects')
      .insert({ owner_id: userBId, name: 'B reparent target', key: runKey() })
      .select()
      .single()
    if (bProjErr) throw bProjErr
    bProjectId = bProj!.id
  }, 30_000)

  afterAll(async () => {
    await a.from('projects').delete().eq('id', projectId)
    await b.from('projects').delete().eq('id', bProjectId)
  }, 30_000)

  it('persists an owner update and advances updated_at', async () => {
    const before = (await a.from('tickets').select('updated_at').eq('id', ticketId).single()).data!
      .updated_at
    const { data, error } = await a
      .from('tickets')
      .update({ summary: 'Edited', story_points: 5 })
      .eq('id', ticketId)
      .select()
      .single()

    expect(error).toBeNull()
    expect(data).toMatchObject({ summary: 'Edited', story_points: 5 })
    expect(Date.parse(data!.updated_at)).toBeGreaterThan(Date.parse(before))
  }, 30_000)

  it('rejects a cross-tenant update: zero rows affected, row unchanged', async () => {
    // Signed in as B, updating A's ticket. tickets_owner's USING clause filters the row
    // out, so the UPDATE matches zero rows and RETURNING is empty — RLS filters, it does
    // not raise. (No .single(): zero rows is the expected, non-error outcome.)
    const { data, error } = await b
      .from('tickets')
      .update({ summary: 'Hacked' })
      .eq('id', ticketId)
      .select()

    expect(error).toBeNull()
    expect(data).toEqual([])

    // Independent control: as the owner, confirm the summary was not changed.
    const { data: row } = await a.from('tickets').select('summary').eq('id', ticketId).single()
    expect(row!.summary).toBe('Edited')
  }, 30_000)

  it("rejects reparenting a ticket into a project the owner doesn't own (WITH CHECK)", async () => {
    // The design doc's "Verified mechanics" claims tickets_owner's WITH CHECK blocks
    // moving a ticket into someone else's project. TicketUpdate excludes project_id at
    // compile time so the app can never send this, but "verification means running it":
    // send it anyway with an `as never` bypass (mirrors rls.integration.test.ts's
    // freeze_ticket_key test) to prove the DATABASE holds, not just the type.
    //
    // Mechanism: for UPDATE, USING is checked against the OLD row (A owns it → passes),
    // then WITH CHECK is checked against the NEW row (project_id → B's project, which A
    // does not own → EXISTS is false). A failing WITH CHECK on an UPDATE RAISES 42501 —
    // unlike a USING miss, which silently filters to zero rows. Either way the row is
    // never moved; we assert the observed outcome and then that the row is unchanged.
    const { data, error } = await a
      .from('tickets')
      .update({ project_id: bProjectId } as never)
      .eq('id', ticketId)
      .select()

    // OBSERVED against the live database: WITH CHECK violation raises 42501.
    expect(error).not.toBeNull()
    expect(error!.code).toBe('42501')
    expect(data).toBeNull()

    // Independent control: as the owner, the ticket still belongs to A's project.
    const { data: row } = await a.from('tickets').select('project_id').eq('id', ticketId).single()
    expect(row!.project_id).toBe(projectId)
  }, 30_000)

  it('persists a status change and it survives a fresh re-read (S7.2 AC1/AC2)', async () => {
    const { data, error } = await a
      .from('tickets')
      .update({ status: 'in_review' })
      .eq('id', ticketId)
      .select()
      .single()

    expect(error).toBeNull()
    expect(data!.status).toBe('in_review')

    // Independent re-read — the "survives a refresh" AC. A fresh SELECT is what a page reload
    // issues; it proves the value persisted, not merely that RETURNING echoed the request.
    const { data: reread } = await a.from('tickets').select('status').eq('id', ticketId).single()
    expect(reread!.status).toBe('in_review')
  }, 30_000)
})

describe.skipIf(!hasRlsCredentials)('S4.3 ticket-delete contract', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let projectId: string

  beforeAll(async () => {
    a = await signIn('A')
    userAId = (await a.auth.getUser()).data.user!.id
    b = await signIn('B')
    const { data: proj, error: projErr } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Delete contract', key: runKey() })
      .select()
      .single()
    if (projErr) throw projErr
    projectId = proj!.id
  }, 30_000)

  afterAll(async () => {
    await a.from('projects').delete().eq('id', projectId)
  }, 30_000)

  async function newTicket(): Promise<string> {
    const { data, error } = await a
      .from('tickets')
      .insert({ project_id: projectId, summary: 'To delete' })
      .select()
      .single()
    if (error) throw error
    return data!.id
  }

  it('lets the owner delete their ticket; the row is gone', async () => {
    const ticketId = await newTicket()
    const { data, error } = await a.from('tickets').delete().eq('id', ticketId).select()
    expect(error).toBeNull()
    expect(data).toHaveLength(1)

    // Independent re-read as the owner: the row no longer exists.
    const { data: rows } = await a.from('tickets').select('id').eq('id', ticketId)
    expect(rows).toEqual([])
  }, 30_000)

  it('rejects a cross-tenant delete: zero rows affected, row survives', async () => {
    const ticketId = await newTicket()
    // Signed in as B, deleting A's ticket. tickets_owner's USING clause filters the row
    // out, so the DELETE matches zero rows and RETURNING is empty — RLS filters, it does
    // not raise. (No .single(): zero rows is the expected, non-error outcome.)
    const { data, error } = await b.from('tickets').delete().eq('id', ticketId).select()
    expect(error).toBeNull()
    expect(data).toEqual([])

    // Independent control: as the owner, confirm the ticket still exists.
    const { data: rows } = await a.from('tickets').select('id').eq('id', ticketId)
    expect(rows).toHaveLength(1)
  }, 30_000)
})

/**
 * S4.4 — the block/unblock contract `blockTicket`/`unblockTicket` rely on, proven live.
 * The `sync_blocked_fields` trigger stamps `blocked_since` on block and clears both it
 * and `blocked_reason` on unblock; `tickets_blocked_coherent` backstops the app-layer
 * "a reason is required" rule (a block with a null reason raises `23514`, not silently
 * persists). Blocking is a flag, never a column: `status` is untouched by it.
 */
describe.skipIf(!hasRlsCredentials)('S4.4 ticket-block contract', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let projectId: string

  beforeAll(async () => {
    a = await signIn('A')
    userAId = (await a.auth.getUser()).data.user!.id
    b = await signIn('B')
    const { data: proj, error: projErr } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Block contract', key: runKey() })
      .select()
      .single()
    if (projErr) throw projErr
    projectId = proj!.id
  }, 30_000)

  afterAll(async () => {
    await a.from('projects').delete().eq('id', projectId)
  }, 30_000)

  async function newTicket(): Promise<string> {
    const { data, error } = await a
      .from('tickets')
      .insert({ project_id: projectId, summary: 'To block' })
      .select()
      .single()
    if (error) throw error
    return data!.id
  }

  it('blocks with a reason: the trigger stamps blocked_since and status is untouched', async () => {
    const ticketId = await newTicket()
    // Move it off the default column first, so we can prove blocking does NOT move it.
    await a.from('tickets').update({ status: 'in_progress' }).eq('id', ticketId)

    const { data, error } = await a
      .from('tickets')
      .update({ is_blocked: true, blocked_reason: 'waiting on API' })
      .eq('id', ticketId)
      .select()
      .single()

    expect(error).toBeNull()
    expect(data).toMatchObject({
      is_blocked: true,
      blocked_reason: 'waiting on API',
      status: 'in_progress', // a blocked ticket stays in its real column (S4.4 AC)
    })
    // The trigger stamped it — the client never sent blocked_since.
    expect(data!.blocked_since).not.toBeNull()
  }, 30_000)

  it('unblocks: the trigger clears both blocked_reason and blocked_since', async () => {
    const ticketId = await newTicket()
    await a
      .from('tickets')
      .update({ is_blocked: true, blocked_reason: 'transient' })
      .eq('id', ticketId)

    const { data, error } = await a
      .from('tickets')
      .update({ is_blocked: false })
      .eq('id', ticketId)
      .select()
      .single()

    expect(error).toBeNull()
    // We only sent is_blocked:false — the trigger nulled the other two, keeping the
    // three fields coherent (S4.4 AC).
    expect(data).toMatchObject({
      is_blocked: false,
      blocked_reason: null,
      blocked_since: null,
    })
  }, 30_000)

  it('rejects a block with no reason: the check constraint holds even though the app never sends it', async () => {
    const ticketId = await newTicket()
    // Send is_blocked:true with no reason — the app's blockTicket forbids this at the
    // type/validation layer, but "verification means running it": prove the DATABASE
    // backstops the app-layer rule. The trigger stamps blocked_since, leaving
    // (is_blocked=true, blocked_reason=null), which violates tickets_blocked_coherent.
    const { error } = await a.from('tickets').update({ is_blocked: true }).eq('id', ticketId)
    expect(error).not.toBeNull()
    expect(error!.code).toBe('23514') // check_violation

    // Independent control: the ticket was not left half-blocked.
    const { data: row } = await a
      .from('tickets')
      .select('is_blocked, blocked_reason')
      .eq('id', ticketId)
      .single()
    expect(row).toMatchObject({ is_blocked: false, blocked_reason: null })
  }, 30_000)

  it('rejects a cross-tenant block: zero rows affected, row stays unblocked', async () => {
    const ticketId = await newTicket()
    // Signed in as B, blocking A's ticket. tickets_owner's USING clause filters the row
    // out, so the UPDATE matches zero rows and RETURNING is empty — RLS filters, it does
    // not raise.
    const { data, error } = await b
      .from('tickets')
      .update({ is_blocked: true, blocked_reason: 'hacked' })
      .eq('id', ticketId)
      .select()
    expect(error).toBeNull()
    expect(data).toEqual([])

    // Independent control: as the owner, the ticket is still unblocked.
    const { data: row } = await a.from('tickets').select('is_blocked').eq('id', ticketId).single()
    expect(row!.is_blocked).toBe(false)
  }, 30_000)
})

/**
 * S4.5 — the epic contract the detail dialog relies on, proven live: an epic's `context`
 * (text) and `deliverables` (jsonb) round-trip as sent; a child can reference a parent
 * epic in the SAME project; the composite fk `tickets_epic_fk (parent_epic_id, project_id)`
 * rejects a parent in a DIFFERENT project (keeping the reference in-project rather than
 * merely discouraged); and deleting a parent epic nulls its children's `parent_epic_id`
 * via the fk's `on delete set null`, so ticket numbers and children survive.
 */
describe.skipIf(!hasRlsCredentials)(
  'S4.5 epic context / deliverables / parent-epic contract',
  () => {
    let a: SupabaseClient<Database>
    let userAId: string
    let p1: string
    let p2: string
    let epic1: string
    let story1: string
    let epic2: string

    async function newProject(name: string): Promise<string> {
      const { data, error } = await a
        .from('projects')
        .insert({ owner_id: userAId, name, key: runKey() })
        .select()
        .single()
      if (error) throw error
      return data!.id
    }

    async function newTicket(
      project: string,
      type: 'epic' | 'story',
      summary: string,
    ): Promise<string> {
      const { data, error } = await a
        .from('tickets')
        .insert({ project_id: project, type, summary })
        .select()
        .single()
      if (error) throw error
      return data!.id
    }

    beforeAll(async () => {
      a = await signIn('A')
      userAId = (await a.auth.getUser()).data.user!.id
      p1 = await newProject('Epic contract P1')
      p2 = await newProject('Epic contract P2')
      epic1 = await newTicket(p1, 'epic', 'Epic one')
      story1 = await newTicket(p1, 'story', 'Story one')
      epic2 = await newTicket(p2, 'epic', 'Epic two')
    }, 30_000)

    afterAll(async () => {
      await a.from('projects').delete().eq('id', p1)
      await a.from('projects').delete().eq('id', p2)
    }, 30_000)

    it("round-trips an epic's context and deliverables (jsonb) exactly as sent", async () => {
      const deliverables = ['Ship the API', 'Wire the UI']
      const { data, error } = await a
        .from('tickets')
        .update({ context: 'Why this epic exists', deliverables })
        .eq('id', epic1)
        .select()
        .single()

      expect(error).toBeNull()
      expect(data!.context).toBe('Why this epic exists')
      expect(data!.deliverables).toEqual(deliverables)
    }, 30_000)

    it('references a parent epic in the same project', async () => {
      const { data, error } = await a
        .from('tickets')
        .update({ parent_epic_id: epic1 })
        .eq('id', story1)
        .select()
        .single()

      expect(error).toBeNull()
      expect(data!.parent_epic_id).toBe(epic1)
    }, 30_000)

    it('rejects a parent epic in another project (the composite fk keeps it in-project)', async () => {
      // story1 lives in p1; epic2 lives in p2. The fk checks (epic2, p1) against
      // tickets(id, project_id) — no such pair exists, so it raises 23503. A owns BOTH
      // projects, so this is the fk holding the line, not RLS.
      const { data, error } = await a
        .from('tickets')
        .update({ parent_epic_id: epic2 })
        .eq('id', story1)
        .select()

      expect(error).not.toBeNull()
      expect(error!.code).toBe('23503') // foreign_key_violation
      expect(data).toBeNull()

      // Independent control: the parent is still the in-project epic1, not moved.
      const { data: row } = await a
        .from('tickets')
        .select('parent_epic_id')
        .eq('id', story1)
        .single()
      expect(row!.parent_epic_id).toBe(epic1)
    }, 30_000)

    it("nulls a child's parent_epic_id when the parent epic is deleted (on delete set null)", async () => {
      const parent = await newTicket(p1, 'epic', 'Doomed epic')
      const { data: child, error: childErr } = await a
        .from('tickets')
        .insert({ project_id: p1, type: 'story', summary: 'Orphan-to-be', parent_epic_id: parent })
        .select()
        .single()
      if (childErr) throw childErr
      expect(child!.parent_epic_id).toBe(parent)

      // Delete the parent epic — the child must survive with a nulled parent, not cascade.
      const { error: delErr } = await a.from('tickets').delete().eq('id', parent)
      expect(delErr).toBeNull()

      const { data: row } = await a
        .from('tickets')
        .select('id, parent_epic_id')
        .eq('id', child!.id)
        .single()
      expect(row!.id).toBe(child!.id) // child still exists
      expect(row!.parent_epic_id).toBeNull() // parent reference cleared
    }, 30_000)
  },
)

/**
 * S5.1 — the backlog rule against the real database: **the backlog is exactly
 * `sprint_id is null`.**
 *
 * The rule itself is covered by the client tests (`backlog.test.ts` and the BacklogTab
 * cases in `BoardTab.test.tsx` — revert `selectBacklogTickets` and they go red). What
 * those cannot cover is that a *real* row behaves the way their hand-built fixtures
 * assume, and today nothing in the app can produce one: there is no sprint UI yet (E6)
 * and `createTicket` never sends `sprint_id`, so every row the app writes is already
 * null. So this suite does what the app cannot — inserts a real completed sprint, parks
 * a Done ticket in it — and pins the three things only Postgres can answer: the column
 * defaults to null, the DB's own `is('sprint_id', null)` agrees with our client-side
 * rule, and deleting a sprint returns its tickets to the backlog.
 *
 * It also owns this file's coverage of `tickets_sprint_fk` — both halves of it: the
 * `on delete set null` behaviour above, and (last test) that the composite fk rejects a
 * sprint belonging to a DIFFERENT project, which is the guarantee `TicketDetailDialog`'s
 * unfiltered sprint picker leans on.
 */
describe.skipIf(!hasRlsCredentials)('S5.1 backlog rule', () => {
  let a: SupabaseClient<Database>
  let userAId: string
  let projectId: string
  let sprintId: string
  let backlogTicketId: string
  let sprintedTicketId: string
  // A SECOND project owned by the SAME user, and a sprint inside it — the fixture for the
  // cross-project rejection test at the bottom of this block. Owned by A, like everything
  // else here, so RLS is not what stops the write.
  let otherProjectId: string
  let otherSprintId: string

  beforeAll(async () => {
    a = await signIn('A')
    userAId = (await a.auth.getUser()).data.user!.id

    const { data: project, error: projectErr } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Backlog rule', key: runKey() })
      .select()
      .single()
    if (projectErr) throw projectErr
    projectId = project!.id

    const { data: otherProject, error: otherProjectErr } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Backlog rule other', key: runKey() })
      .select()
      .single()
    if (otherProjectErr) throw otherProjectErr
    otherProjectId = otherProject!.id

    const { data: otherSprint, error: otherSprintErr } = await a
      .from('sprints')
      .insert({ project_id: otherProjectId, name: 'Other project sprint', status: 'future' })
      .select()
      .single()
    if (otherSprintErr) throw otherSprintErr
    otherSprintId = otherSprint!.id

    // A COMPLETED sprint, not an active one: the AC that bites is "a Done ticket in a
    // completed sprint does not appear in the backlog".
    const { data: sprint, error: sprintErr } = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Sprint 1', status: 'complete' })
      .select()
      .single()
    if (sprintErr) throw sprintErr
    sprintId = sprint!.id

    const { data: sprinted, error: sprintedErr } = await a
      .from('tickets')
      .insert({
        project_id: projectId,
        summary: 'Finished last sprint',
        type: 'story',
        status: 'done',
        sprint_id: sprintId,
      })
      .select()
      .single()
    if (sprintedErr) throw sprintedErr
    sprintedTicketId = sprinted!.id

    const { data: backlog, error: backlogErr } = await a
      .from('tickets')
      .insert({ project_id: projectId, summary: 'Not yet sprinted', type: 'story' })
      .select()
      .single()
    if (backlogErr) throw backlogErr
    backlogTicketId = backlog!.id
  }, 30_000)

  afterAll(async () => {
    // The project cascade removes its tickets and sprints.
    await a.from('projects').delete().eq('id', projectId)
    await a.from('projects').delete().eq('id', otherProjectId)
  }, 30_000)

  it('defaults sprint_id to null — a ticket created without one is backlog', async () => {
    const { data } = await a.from('tickets').select('sprint_id').eq('id', backlogTicketId).single()
    expect(data!.sprint_id).toBeNull()
  })

  it('accepts a ticket parked in a sprint (positive control for the filter below)', async () => {
    // Without this, the exclusion test below could pass simply because the insert failed
    // and the row never existed. RLS filters, it does not raise — never trust a negative
    // on its own.
    const { data } = await a
      .from('tickets')
      .select('sprint_id, status')
      .eq('id', sprintedTicketId)
      .single()
    expect(data!.sprint_id).toBe(sprintId)
    expect(data!.status).toBe('done')
  })

  it('excludes a Done ticket in a completed sprint from `sprint_id is null` (S5.1 AC)', async () => {
    const { data, error } = await a
      .from('tickets')
      .select('id')
      .eq('project_id', projectId)
      .is('sprint_id', null)
    expect(error).toBeNull()
    const ids = (data ?? []).map((t) => t.id)
    expect(ids).toContain(backlogTicketId)
    expect(ids).not.toContain(sprintedTicketId)
  })

  it('agrees with the client-side rule: selectBacklogTickets(listTickets()) === the DB filter', async () => {
    // The app filters client-side over the shell's shared list; the column comment and
    // `tickets_sprint_idx` describe the same rule server-side. This pins the two together,
    // so a future move to a server-side `.is('sprint_id', null)` cannot silently disagree.
    const { data: all } = await a.from('tickets').select().eq('project_id', projectId)
    const clientSide = selectBacklogTickets(all as never).map((t) => t.id)

    const { data: serverSide } = await a
      .from('tickets')
      .select('id')
      .eq('project_id', projectId)
      .is('sprint_id', null)

    expect(clientSide.sort()).toEqual((serverSide ?? []).map((t) => t.id).sort())
    expect(clientSide).toEqual([backlogTicketId])
  })

  it('returns a ticket to the backlog when its sprint is deleted (on delete set null)', async () => {
    // `tickets_sprint_fk ... on delete set null (sprint_id)` — column-qualified, so
    // deleting a sprint nulls only sprint_id and never aborts on not-null project_id.
    const { data: sprint, error: sprintErr } = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Doomed', status: 'future' })
      .select()
      .single()
    if (sprintErr) throw sprintErr

    const { data: ticket, error: ticketErr } = await a
      .from('tickets')
      .insert({
        project_id: projectId,
        summary: 'Sprint about to vanish',
        type: 'task',
        sprint_id: sprint!.id,
      })
      .select()
      .single()
    if (ticketErr) throw ticketErr
    expect(ticket!.sprint_id).toBe(sprint!.id)

    const { error: delErr } = await a.from('sprints').delete().eq('id', sprint!.id)
    expect(delErr).toBeNull()

    const { data: row } = await a
      .from('tickets')
      .select('id, sprint_id, project_id')
      .eq('id', ticket!.id)
      .single()
    expect(row!.id).toBe(ticket!.id) // ticket survives
    expect(row!.sprint_id).toBeNull() // and is back in the backlog
    expect(row!.project_id).toBe(projectId) // project_id untouched

    // This test's ticket is now permanently unsprinted, i.e. a second row in this
    // shared project's backlog. Remove it rather than leave it for whatever assertion
    // lands below: the exact-list check above ("=== [backlogTicketId]") is the kind that
    // would then fail pointing at the backlog rule, which would be fine.
    await a.from('tickets').delete().eq('id', ticket!.id)
  }, 30_000)

  it('rejects a sprint in another project (the composite fk keeps it in-project)', async () => {
    // WHY THIS EXISTS. `TicketDetailDialog`'s sprint picker is deliberately NOT
    // status-filtered and NOT type-gated, and its comment justifies that by asserting the
    // database cannot store a cross-project reference:
    //   tickets_sprint_fk foreign key (sprint_id, project_id)
    //     references sprints (id, project_id) on delete set null (sprint_id)
    // The pair — not the id alone — is what gets checked, so a sprint from another project
    // has no matching (id, project_id) row. That claim was load-bearing and unproven.
    //
    // THE SAME-OWNER CASE IS THE INTERESTING ONE. A owns BOTH projects, so RLS is happy to
    // let this write through: it is the composite fk alone holding the line. Relax it to a
    // plain `references sprints (id)` — which reads as redundant next to sprints' PK, and
    // the schema comment even says so — and an owner of two projects could park a ticket
    // in the wrong project's sprint with this entire suite still green. This is that net.
    const { data: ticket, error: ticketErr } = await a
      .from('tickets')
      .insert({ project_id: projectId, type: 'task', summary: 'Sprint fk probe' })
      .select()
      .single()
    if (ticketErr) throw ticketErr

    // Positive control FIRST. Without it, a test that rejects every sprint write — a bad
    // uuid, a null, an RLS filter, a typo'd column — looks identical to a working guard.
    // This proves the exact same write shape SUCCEEDS when the sprint is in-project, so
    // the rejection below can only be about the project pairing.
    const { data: sameProject, error: sameProjectErr } = await a
      .from('tickets')
      .update({ sprint_id: sprintId })
      .eq('id', ticket!.id)
      .select()
      .single()
    expect(sameProjectErr).toBeNull()
    expect(sameProject!.sprint_id).toBe(sprintId)

    // The negative: same ticket, same statement, only the sprint's project differs.
    const { data, error } = await a
      .from('tickets')
      .update({ sprint_id: otherSprintId })
      .eq('id', ticket!.id)
      .select()

    expect(error).not.toBeNull()
    expect(error!.code).toBe('23503') // foreign_key_violation — specifically the fk, not a check/null/RLS
    expect(error!.message).toContain('tickets_sprint_fk') // and specifically THIS fk
    expect(data).toBeNull()

    // Independent re-read: the ticket still points at its own project's sprint, so the
    // rejected write did not partially land.
    const { data: row } = await a
      .from('tickets')
      .select('sprint_id, project_id')
      .eq('id', ticket!.id)
      .single()
    expect(row!.sprint_id).toBe(sprintId)
    expect(row!.project_id).toBe(projectId)

    await a.from('tickets').delete().eq('id', ticket!.id)
  }, 30_000)
})

/**
 * S6.2 AC 2 — **`sprint_id` updates correctly in both directions, through the APP's
 * write path.**
 *
 * The S5.1 block above writes `sprint_id` too, so this looks covered. It is not: every
 * one of those writes goes through the raw test client, as a fixture. They pin the
 * column, the composite fk and `on delete set null` — real database facts, but facts
 * about Postgres, not about our code. Nothing anywhere drives the function the sprint
 * picker actually calls: `TicketDetailDialog`'s `commit({ sprint_id })` is `updateTicket`,
 * and `updateTicket` writes through the app's own module-scope `supabase` client with its
 * own `TicketUpdate` shape, `.single()` and result mapping. Any of those could break with
 * this file green. So this block drives `updateTicket` itself.
 *
 * Two deliberate choices make the evidence real rather than circular:
 * - the write goes through the **app** client (signed in below), the same object the
 *   browser uses — not the suite's `a`;
 * - every assertion is on a **re-read through `a`**, a different client and connection.
 *   Asserting on the row `updateTicket` returned would also pass for a function that
 *   echoed its own input straight back.
 */
describe.skipIf(!hasRlsCredentials)('S6.2 sprint membership via updateTicket', () => {
  let a: SupabaseClient<Database>
  let userAId: string
  let projectId: string
  let sprintId: string
  // The app's real data layer, imported lazily — see beforeAll.
  let appClient: typeof import('@/lib/supabase').supabase
  let updateTicket: typeof import('@/lib/tickets').updateTicket

  beforeAll(async () => {
    a = await signIn('A')
    userAId = (await a.auth.getUser()).data.user!.id

    const { data: proj, error: projErr } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Sprint membership', key: runKey() })
      .select()
      .single()
    if (projErr) throw projErr
    projectId = proj!.id

    const { data: sprint, error: sprintErr } = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Sprint 1', status: 'future' })
      .select()
      .single()
    if (sprintErr) throw sprintErr
    sprintId = sprint!.id

    // Imported dynamically, not at the top of the file: `@/lib/supabase` calls `getEnv()`
    // at MODULE scope, so a static import would throw at load time when the environment
    // is missing — turning this file's loud, deliberate skip into a hard error for all
    // six describes. Inside a skipIf'd beforeAll, the import only happens when the
    // credentials that make it valid are present.
    ;({ supabase: appClient } = await import('@/lib/supabase'))
    ;({ updateTicket } = await import('@/lib/tickets'))

    // `updateTicket` takes no client — it closes over the app singleton. Signing that
    // singleton in as A is what makes the app's write path owner-scoped here exactly as
    // it is in the browser; without it every update below would be an anonymous write
    // that RLS filters to zero rows.
    //
    // ORDER DEPENDENCY, for whoever appends the next describe to this file: this signs in
    // a MODULE-SCOPE singleton, so its auth state outlives this block. Vitest runs a
    // file's describes in order and `afterAll` below signs it back out — but a later
    // describe that drives any app data-layer function (rather than the raw `a`/`b`
    // clients every other block here uses) inherits whatever this left behind, and would
    // be the only block in the file whose result depends on one running before it. Sign
    // the app client in from your own `beforeAll`; do not lean on this one.
    const { email, password } = RLS_USERS.A
    const { error: authErr } = await appClient.auth.signInWithPassword({
      email: email!,
      password: password!,
    })
    if (authErr) throw authErr
  }, 30_000)

  afterAll(async () => {
    // Delete FIRST, sign out second. This suite runs against the real shared Supabase
    // project, so the delete is the load-bearing statement: if `signOut` went first and
    // threw, the throw would abort this hook and leak the project, its sprint and its
    // tickets into the hosted database permanently. Signing out only tidies a client
    // that the process is about to discard anyway.
    // The project cascade removes its tickets and sprints.
    await a.from('projects').delete().eq('id', projectId)
    await appClient?.auth.signOut()
  }, 30_000)

  /** A fresh backlog ticket (`sprint_id` defaults to null), created through the raw
   *  client — the fixture is not what is under test here. */
  async function newTicket(summary: string): Promise<string> {
    const { data, error } = await a
      .from('tickets')
      .insert({ project_id: projectId, type: 'story', summary })
      .select()
      .single()
    if (error) throw error
    expect(data!.sprint_id).toBeNull() // starts in the backlog, or the adds below prove nothing
    return data!.id
  }

  it('adds a ticket to a sprint: updateTicket persists sprint_id', async () => {
    const ticketId = await newTicket('To be sprinted')

    const result = await updateTicket(ticketId, { sprint_id: sprintId })
    expect(result.ok).toBe(true)

    // Independent re-read through `a`, not the app client that wrote it.
    const { data, error } = await a.from('tickets').select('sprint_id').eq('id', ticketId).single()
    expect(error).toBeNull()
    expect(data!.sprint_id).toBe(sprintId)
  }, 30_000)

  it('removes a ticket from a sprint: updateTicket nulls sprint_id and the DB calls it backlog', async () => {
    const ticketId = await newTicket('To be unsprinted')

    // The other direction first — and a positive control. Without proving the ticket is
    // genuinely IN the sprint, the null below would be indistinguishable from an update
    // that never happened: a ticket starts unsprinted, so "sprint_id is null" is also
    // what a no-op looks like.
    const added = await updateTicket(ticketId, { sprint_id: sprintId })
    expect(added.ok).toBe(true)
    const { data: before } = await a.from('tickets').select('sprint_id').eq('id', ticketId).single()
    expect(before!.sprint_id).toBe(sprintId)

    const removed = await updateTicket(ticketId, { sprint_id: null })
    expect(removed.ok).toBe(true)

    const { data: after, error } = await a
      .from('tickets')
      .select('sprint_id')
      .eq('id', ticketId)
      .single()
    expect(error).toBeNull()
    expect(after!.sprint_id).toBeNull()

    // Not merely "no longer that sprint": the database's own `is('sprint_id', null)` —
    // the server-side spelling of `isBacklogTicket` — returns the ticket. The removed
    // ticket is back in the backlog by the rule the backlog tab actually applies.
    const { data: backlog } = await a
      .from('tickets')
      .select('id')
      .eq('project_id', projectId)
      .is('sprint_id', null)
    expect((backlog ?? []).map((t) => t.id)).toContain(ticketId)
  }, 30_000)
})
