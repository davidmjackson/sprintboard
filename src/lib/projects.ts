import { supabase } from './supabase'
import type { Project } from './domain'

/**
 * Create a project for the given owner.
 *
 * `owner_id` must be the caller's own `auth.uid()` — the RLS insert policy rejects
 * anything else, so this is the security boundary, not a convenience. The result is a
 * discriminated union rather than a throw: a duplicate key is an expected,
 * user-correctable outcome (the `projects_owner_key_unique` constraint), not an
 * exception. Postgres raises `23505` on any unique violation; the only unique
 * constraint reachable here is per-owner key, so that code maps to `duplicate_key`.
 */
export type CreateProjectResult =
  { ok: true; project: Project } | { ok: false; error: 'duplicate_key' | 'unknown' }

export async function createProject(input: {
  ownerId: string
  name: string
  key: string
}): Promise<CreateProjectResult> {
  const { data, error } = await supabase
    .from('projects')
    .insert({ owner_id: input.ownerId, name: input.name, key: input.key })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: 'duplicate_key' }
    return { ok: false, error: 'unknown' }
  }

  return { ok: true, project: data as Project }
}
