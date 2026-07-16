// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
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
    const { data: row } = await a
      .from('tickets')
      .select('project_id')
      .eq('id', ticketId)
      .single()
    expect(row!.project_id).toBe(projectId)
  }, 30_000)
})
