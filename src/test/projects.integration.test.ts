// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { assertCredentialsOrExplain, hasRlsCredentials, signIn, userId } from './supabase-clients'

assertCredentialsOrExplain()

/**
 * S3.1 — the database contract that `createProject` (src/lib/projects.ts) relies on,
 * proven live: an owner can insert and read back a project; the per-owner unique-key
 * constraint and the key-format check both bite. Uses the signed-in RLS user rather
 * than the app's unauthenticated singleton client, because the insert is only allowed
 * for `owner_id = auth.uid()`.
 */
function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `P${pick()}${pick()}${pick()}`
}

describe.skipIf(!hasRlsCredentials)('S3.1 project-creation contract', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let userBId: string
  const createdIds: string[] = []
  const bCreatedIds: string[] = []

  beforeAll(async () => {
    a = await signIn('A')
    userAId = await userId(a)
    b = await signIn('B')
    userBId = await userId(b)
  }, 30_000)

  afterAll(async () => {
    for (const id of bCreatedIds) await b.from('projects').delete().eq('id', id)
    for (const id of createdIds) await a.from('projects').delete().eq('id', id)
  }, 30_000)

  it('creates a project the owner can read back, defaulting project_type to scrum', async () => {
    const key = runKey()
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Contract test', key })
      .select()
      .single()

    expect(error).toBeNull()
    expect(data).toMatchObject({
      key,
      owner_id: userAId,
      name: 'Contract test',
      project_type: 'scrum',
    })
    if (data) createdIds.push(data.id)
  }, 30_000)

  /**
   * SPRIN-81 AC1/AC2. The two halves of the widened `projects_project_type_check`:
   * 'kanban' is now accepted, and the constraint still refuses everything else. Both
   * are live-only claims — `domain.test.ts` reads the schema DOC, which is applied by
   * hand, so only this suite can see what the database actually enforces.
   *
   * NOTE the cleanup placement, which deliberately differs from the tests either side:
   * they push after asserting, so a failed `expect()` aborts the body and strands the
   * project in the shared database forever. A teardown delete is an obligation; an
   * assertion is only a report. Push first.
   */
  it('creates a kanban project when project_type is supplied (SPRIN-81)', async () => {
    const key = runKey()
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Kanban contract test', key, project_type: 'kanban' })
      .select()
      .single()

    if (data) createdIds.push(data.id)

    expect(error).toBeNull()
    expect(data).toMatchObject({
      key,
      owner_id: userAId,
      name: 'Kanban contract test',
      project_type: 'kanban',
    })
  }, 30_000)

  it('rejects an unknown project_type (projects_project_type_check -> 23514)', async () => {
    // The row is pushed for cleanup even though the insert is expected to fail: if the
    // check constraint is ever dropped or widened by accident, this insert SUCCEEDS,
    // and the test that catches that must not also leak the project it created.
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Waterfall', key: runKey(), project_type: 'waterfall' })
      .select()
      .single()

    if (data) createdIds.push(data.id)

    // The code first — 23514 is "some check constraint refused this row".
    expect(error?.code).toBe('23514')

    // ...but `projects` has TWO check constraints, and 23514 does not say which one
    // fired. The original version of this test relied on the payload as the
    // discriminator: `runKey()` cannot produce a key `projects_key_format` rejects, so
    // project_type had to be the violation. That reasoning is true today and would go
    // silently false the day a third check lands on this table — the test would still
    // pass, while no longer testing project_type at all.
    //
    // So name the constraint. This asserts the constraint's NAME, not the message's
    // wording: the name is ours, it is written in the migration and the schema doc, and
    // renaming it is a deliberate act that SHOULD redden this. The prose around it
    // (`new row for relation ... violates check constraint ...`) stays unasserted,
    // because that IS Postgres's wording and not a contract.
    expect(error?.message).toContain('projects_project_type_check')
    expect(data).toBeNull()
  }, 30_000)

  it('rejects a duplicate key for the same owner (projects_owner_key_unique -> 23505)', async () => {
    const key = runKey()
    const first = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'First', key })
      .select()
      .single()
    expect(first.error).toBeNull()
    if (first.data) createdIds.push(first.data.id)

    const dup = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Dup', key })
      .select()
      .single()
    expect(dup.error?.code).toBe('23505')
  }, 30_000)

  it('rejects a key that violates the format check (projects_key_format -> 23514)', async () => {
    const { error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Bad key', key: 'toolong' })
      .select()
      .single()
    expect(error?.code).toBe('23514')
  }, 30_000)

  it('rejects a project whose owner_id is spoofed to another user (RLS -> 42501)', async () => {
    // The client sets owner_id, but the projects RLS policy's `with check
    // (owner_id = auth.uid())` is the boundary: signed in as A, you cannot create a
    // project owned by B, whatever you send. This is the security property S3.1 rests
    // on, pinned live at the feature. No row is created, so nothing to clean up.
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userBId, name: 'Spoofed', key: runKey() })
      .select()
      .single()

    expect(error?.code).toBe('42501')
    expect(data).toBeNull()
  }, 30_000)

  it("lists only the caller's own projects, never another owner's (RLS select)", async () => {
    // S3.2: the left-nav list is a plain select; RLS scopes it to the owner. Prove it
    // with two real owners — A's list contains A's project and excludes B's.
    const mine = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Mine', key: runKey() })
      .select()
      .single()
    expect(mine.error).toBeNull()
    createdIds.push(mine.data!.id)

    const theirs = await b
      .from('projects')
      .insert({ owner_id: userBId, name: 'Theirs', key: runKey() })
      .select()
      .single()
    expect(theirs.error).toBeNull()
    bCreatedIds.push(theirs.data!.id)

    const { data: list, error } = await a.from('projects').select('id')
    expect(error).toBeNull()
    const ids = (list ?? []).map((r) => r.id)
    expect(ids).toContain(mine.data!.id)
    expect(ids).not.toContain(theirs.data!.id)
  }, 30_000)
})
