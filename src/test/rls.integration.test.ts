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
  // (user-B isolation) can attempt to reach it. Read it here so the fixture is
  // asserted, and so noUnusedLocals doesn't fail the build in the meantime.
  it("creates A's fixture sprint", () => {
    expect(sprintA).toBeTruthy()
  })

  describe('the S1.2 triggers, finally executed rather than merely catalogued', () => {
    it('assign_ticket_key numbered the first ticket KEY-1', () => {
      expect(ticketAKey).toBe(`${keyA}-1`)
    })

    it('create_project_counter made a counter row, and it tracks the last number', async () => {
      const { data, error } = await a.from('project_counters').select('last_number')
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
})
