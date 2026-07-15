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
  }, 30_000)
})
