// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { assertCredentialsOrExplain, hasRlsCredentials, signIn } from './supabase-clients'

assertCredentialsOrExplain()

/**
 * S6.1 — the sprint-creation contract `createSprint` relies on, proven live: the `status`
 * column defaults to `'future'` (the AC, owned by the database rather than the client),
 * optional fields really are optional, and a cross-tenant insert is rejected. Uses the
 * signed-in RLS user, since sprint inserts are owner-scoped through the project.
 */
function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `S${pick()}${pick()}${pick()}`
}

describe.skipIf(!hasRlsCredentials)('S6.1 sprint-creation contract', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let projectId: string

  beforeAll(async () => {
    a = await signIn('A')
    userAId = (await a.auth.getUser()).data.user!.id
    b = await signIn('B')
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Sprint contract', key: runKey() })
      .select()
      .single()
    if (error) throw error
    projectId = data!.id
  }, 30_000)

  afterAll(async () => {
    // Deleting the project cascades to its sprints (sprints.project_id on delete cascade).
    await a.from('projects').delete().eq('id', projectId)
  }, 30_000)

  it('defaults status to future when the client does not send it', async () => {
    const { data, error } = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Default status' })
      .select()
      .single()

    expect(error).toBeNull()
    // The AC, proven at the database. `createSprint` never sends status, so this default
    // is the only thing making a new sprint 'future'.
    expect(data!.status).toBe('future')
  })

  it('accepts a sprint with only a name — goal and dates are optional', async () => {
    const { data, error } = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Bare sprint' })
      .select()
      .single()

    expect(error).toBeNull()
    expect(data!.goal).toBeNull()
    expect(data!.start_date).toBeNull()
    expect(data!.end_date).toBeNull()
  })

  it('round-trips a UTC-midnight date as the same calendar day', async () => {
    const { data, error } = await a
      .from('sprints')
      .insert({
        project_id: projectId,
        name: 'Dated sprint',
        start_date: '2026-07-20T00:00:00.000Z',
        end_date: '2026-08-03T00:00:00.000Z',
      })
      .select()
      .single()

    expect(error).toBeNull()
    expect(new Date(data!.start_date!).toISOString().slice(0, 10)).toBe('2026-07-20')
    expect(new Date(data!.end_date!).toISOString().slice(0, 10)).toBe('2026-08-03')
  })

  it('allows two sprints with the same name — names are labels, not identifiers', async () => {
    // This is what makes count-based auto-naming safe: a collision is cosmetic.
    await a.from('sprints').insert({ project_id: projectId, name: 'Twin' })
    const { error } = await a.from('sprints').insert({ project_id: projectId, name: 'Twin' })

    expect(error).toBeNull()
  })

  it("rejects user B inserting a sprint into user A's project", async () => {
    const { error } = await b
      .from('sprints')
      .insert({ project_id: projectId, name: 'Cross-tenant' })
      .select()
      .single()

    // RLS rejects the write outright (42501), rather than filtering it — an insert has no
    // rows to filter. Paired with the positive controls above, which prove A *can* insert.
    expect(error?.code).toBe('42501')
  })

  it("does not leak user A's sprints to user B", async () => {
    // RLS filters selects, it does not raise — so count rows, never trust a missing error.
    const { data, error } = await b.from('sprints').select().eq('project_id', projectId)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})
