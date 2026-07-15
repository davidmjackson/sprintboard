// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { assertCredentialsOrExplain, hasRlsCredentials, signIn } from './supabase-clients'

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
  return `P${pick()}${pick()}`
}

describe.skipIf(!hasRlsCredentials)('S3.1 project-creation contract', () => {
  let a: SupabaseClient<Database>
  let userAId: string
  const createdIds: string[] = []

  beforeAll(async () => {
    a = await signIn('A')
    userAId = (await a.auth.getUser()).data.user!.id
  }, 30_000)

  afterAll(async () => {
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
})
