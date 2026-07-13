// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { assertCredentialsOrExplain, hasRlsCredentials, signIn } from './supabase-clients'

assertCredentialsOrExplain()

/** A unique, schema-legal project key per run, so a failed cleanup cannot collide. */
function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `T${pick()}${pick()}`
}

describe.skipIf(!hasRlsCredentials)('RLS isolation between two users', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let userBId: string
  let projectA: string
  let sprintA: string
  let ticketA: string
  let keyA: string
  let ticketAKey: string

  beforeAll(async () => {
    a = await signIn('A')
    b = await signIn('B')
    userAId = (await a.auth.getUser()).data.user!.id
    userBId = (await b.auth.getUser()).data.user!.id

    keyA = runKey()

    const { data: project, error: pErr } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: "A's project", key: keyA })
      .select()
      .single()
    if (pErr) throw new Error(`Fixture: could not create A's project: ${pErr.message}`)
    projectA = project.id

    const { data: sprint, error: sErr } = await a
      .from('sprints')
      .insert({ project_id: projectA, name: 'Sprint 1' })
      .select()
      .single()
    if (sErr) throw new Error(`Fixture: could not create A's sprint: ${sErr.message}`)
    sprintA = sprint.id

    const { data: ticket, error: tErr } = await a
      .from('tickets')
      .insert({ project_id: projectA, summary: "A's ticket" })
      .select()
      .single()
    if (tErr) throw new Error(`Fixture: could not create A's ticket: ${tErr.message}`)
    ticketA = ticket.id
    ticketAKey = ticket.key
  }, 30_000)

  it('signs in as two distinct users', () => {
    expect(userAId).toBeTruthy()
    expect(userBId).toBeTruthy()
    expect(userAId).not.toBe(userBId)
  })

  // The signup trigger from S1.2, exercised for the first time.
  it('each user has exactly one profile row, created by handle_new_user', async () => {
    const { data, error } = await a.from('profiles').select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]!.id).toBe(userAId)
  })

  // sprintA is otherwise write-only in this file: it exists so a later task
  // (user-B isolation) can attempt to reach it. This asserts a real property
  // of the fixture (ownership + the schema's status default) rather than
  // just reading sprintA to satisfy noUnusedLocals.
  it("creates A's fixture sprint, belonging to A's project and defaulting to status 'future'", async () => {
    const { data, error } = await a
      .from('sprints')
      .select('project_id, status')
      .eq('id', sprintA)
      .single()
    expect(error).toBeNull()
    expect(data!.project_id).toBe(projectA)
    expect(data!.status).toBe('future')
  })

  describe('the S1.2 triggers, finally executed rather than merely catalogued', () => {
    it('assign_ticket_key numbered the first ticket KEY-1', () => {
      expect(ticketAKey).toBe(`${keyA}-1`)
    })

    it('create_project_counter made a counter row, and it tracks the last number', async () => {
      // Scoped to the fixture project: counters_owner's RLS returns every
      // project user A owns, not just this run's, so an unfiltered select
      // would flake (or worse, vacuously pass) against leftover projects.
      const { data, error } = await a
        .from('project_counters')
        .select('last_number')
        .eq('project_id', projectA)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0]!.last_number).toBe(1)
    })

    it('assign_ticket_key increments — the second ticket is KEY-2, not KEY-1', async () => {
      const { data, error } = await a
        .from('tickets')
        .insert({ project_id: projectA, summary: 'Second' })
        .select()
        .single()
      expect(error).toBeNull()
      expect(data!.key).toBe(`${keyA}-2`)
    })

    it('freeze_ticket_key refuses to let the key be rewritten', async () => {
      // Deliberately sending what TicketUpdate makes untypeable: the point is to
      // prove the DATABASE holds, not just the type. A bug in the app would send
      // exactly this.
      const forbidden = { key: 'LOL-9', number: 999 } as never

      const { data, error } = await a
        .from('tickets')
        .update(forbidden)
        .eq('id', ticketA)
        .select()
        .single()

      expect(error).toBeNull()
      expect(data!.key).toBe(ticketAKey) // unchanged
      expect(data!.number).toBe(1)
    })
  })

  describe("user B cannot reach user A's data", () => {
    // RLS FILTERS — it does not raise. An unauthorised update returns success
    // with zero rows. Asserting `error === null` would pass on a wide-open
    // database. Every assertion below counts rows.

    it('B cannot SELECT any of it', async () => {
      const project = await b.from('projects').select('id').eq('id', projectA)
      const sprint = await b.from('sprints').select('id').eq('id', sprintA)
      const ticket = await b.from('tickets').select('id').eq('id', ticketA)

      expect(project.data).toEqual([])
      expect(sprint.data).toEqual([])
      expect(ticket.data).toEqual([])

      // Positive control: A can. Without this, the three assertions above also
      // pass when the fixture was never created.
      const asA = await a.from('projects').select('id').eq('id', projectA)
      expect(asA.data).toHaveLength(1)
    })

    it('B cannot UPDATE any of it', async () => {
      const project = await b.from('projects').update({ name: 'pwned' }).eq('id', projectA).select()
      const sprint = await b.from('sprints').update({ name: 'pwned' }).eq('id', sprintA).select()
      const ticket = await b.from('tickets').update({ summary: 'pwned' }).eq('id', ticketA).select()

      expect(project.data).toEqual([])
      expect(sprint.data).toEqual([])
      expect(ticket.data).toEqual([])

      // Positive control: the same update, as A, changes exactly one row.
      const asA = await a
        .from('tickets')
        .update({ summary: 'renamed by its owner' })
        .eq('id', ticketA)
        .select()
      expect(asA.data).toHaveLength(1)
      expect(asA.data![0]!.summary).toBe('renamed by its owner')
    })

    it('B cannot DELETE any of it', async () => {
      const ticket = await b.from('tickets').delete().eq('id', ticketA).select()
      const sprint = await b.from('sprints').delete().eq('id', sprintA).select()
      const project = await b.from('projects').delete().eq('id', projectA).select()

      expect(ticket.data).toEqual([])
      expect(sprint.data).toEqual([])
      expect(project.data).toEqual([])

      // Positive control: it is all still there, seen by its owner.
      const stillThere = await a.from('tickets').select('id').eq('id', ticketA)
      expect(stillThere.data).toHaveLength(1)
    })

    // WITH CHECK, not USING. The asymmetry between them is the classic RLS hole,
    // and only an INSERT can find it: a policy that filters reads but not writes
    // would let B plant rows inside A's project.
    it("B cannot INSERT a ticket into A's project", async () => {
      const { data, error } = await b
        .from('tickets')
        .insert({ project_id: projectA, summary: 'planted by B' })
        .select()

      expect(error).not.toBeNull()
      expect(data).toBeNull()

      // And nothing landed.
      const asA = await a.from('tickets').select('id').eq('project_id', projectA)
      expect(asA.data!.length).toBe(2) // the fixture ticket and the KEY-2 one
    })

    it("B cannot INSERT a sprint into A's project", async () => {
      const { error } = await b
        .from('sprints')
        .insert({ project_id: projectA, name: 'planted by B' })
        .select()

      expect(error).not.toBeNull()
    })
  })
})
