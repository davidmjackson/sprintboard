// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { selectBacklogTickets } from '@/lib/backlog'
import { assertCredentialsOrExplain, hasRlsCredentials, signIn } from './supabase-clients'

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
 * S5.1 — the backlog rule proven live: **the backlog is exactly `sprint_id is null`.**
 *
 * This is the only place the rule is observable end-to-end. There is no sprint UI yet
 * (E6) and `createTicket` never sends `sprint_id`, so through the app today every row is
 * null and the filter is a behavioural no-op — a client-only test would pass whether or
 * not the rule were implemented. Here we insert a real sprint, park a Done ticket in it,
 * and prove it stays out of the backlog while an unsprinted one stays in.
 */
describe.skipIf(!hasRlsCredentials)('S5.1 backlog rule', () => {
  let a: SupabaseClient<Database>
  let userAId: string
  let projectId: string
  let sprintId: string
  let backlogTicketId: string
  let sprintedTicketId: string

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
  }, 30_000)
})
