import { supabase } from './supabase'
import { toUtcMidnight } from './sprint-dates'
import type { Sprint, SprintCreateInsert, SprintStatusUpdate } from './domain'

/**
 * The default name for a sprint created with the name left blank: `Sprint N`, where N is
 * the project's existing sprint count + 1.
 *
 * S6.1's AC asks for an **optional** name, but `sprints.name` is `not null` with no
 * default — so "optional" has to mean the app names it, not that the column is nullable.
 *
 * Count-based numbering is safe here and is NOT the ticket-key pattern. A ticket key is an
 * identifier, which is why `assign_ticket_key` is an atomic trigger and why keys are never
 * generated with `count(*)`. A sprint name is a **label**: `sprints` has no unique
 * constraint on it, so a race or a delete-then-create can yield two `Sprint 3`. That is
 * cosmetic and never corrupting.
 */
export function defaultSprintName(existing: readonly Sprint[]): string {
  return `Sprint ${existing.length + 1}`
}

/**
 * Create a sprint in a project.
 *
 * `status` is never sent: the column defaults to `'future'`, which is exactly S6.1's AC —
 * so the AC is satisfied by the database, not by the client. `sprints` has no `owner_id`;
 * the `sprints_owner` RLS policy scopes writes through the project, so a cross-tenant
 * insert is rejected by the database, not by this function. A failure is not
 * user-correctable (no unique constraint is reachable here — duplicate names are legal),
 * so the error result is a single `'unknown'`.
 */
export type CreateSprintResult = { ok: true; sprint: Sprint } | { ok: false; error: 'unknown' }

export async function createSprint(input: {
  projectId: string
  /** Blank or whitespace-only means "name it for me" — see `defaultSprintName`. */
  name?: string
  goal?: string
  /** An `<input type="date">` value, `'YYYY-MM-DD'`. Pinned to midnight UTC on write. */
  startDate?: string
  endDate?: string
  /** The project's sprints, for auto-naming. Empty when the list has not loaded. */
  existing?: readonly Sprint[]
}): Promise<CreateSprintResult> {
  const name = input.name?.trim() || defaultSprintName(input.existing ?? [])

  // `satisfies SprintCreateInsert` binds the write to the guard type (Omit status), so a
  // future edit that adds `status` here fails to compile at the call site — making the
  // "the database owns status" guarantee structural, not just a doc comment.
  const { data, error } = await supabase
    .from('sprints')
    .insert({
      project_id: input.projectId,
      name,
      goal: input.goal?.trim() || null,
      start_date: input.startDate ? toUtcMidnight(input.startDate) : null,
      end_date: input.endDate ? toUtcMidnight(input.endDate) : null,
    } satisfies SprintCreateInsert)
    .select()
    .single()

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, sprint: data as Sprint }
}

/**
 * The sprints of one project, newest first.
 *
 * The `project_id` filter is required, not optional: `sprints_owner` RLS scopes the select
 * to the owner, but the owner has many projects — without the filter this returns every
 * project's sprints. Same reasoning as `listTickets`.
 *
 * This throws rather than resolving to `[]` on error, and that is the load-bearing part: `[]`
 * is indistinguishable from "this project has no sprints", so a caller handed one could not
 * tell a failed read from an empty one and would render "No sprints yet." over a database it
 * never reached. Only a rejection carries that fact — `ProjectShell`'s `.catch()` turns it
 * into `phase: 'failed'`. Resolving to `[]` here would silently delete the failed state.
 */
export async function listSprints(projectId: string): Promise<Sprint[]> {
  const { data, error } = await supabase
    .from('sprints')
    .select()
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Could not load sprints: ${error.message}`)
  return (data ?? []) as Sprint[]
}

/**
 * Start a sprint: flip its status to `active`. The one-active-per-project rule is enforced
 * by the `sprints_one_active_per_project` partial unique index, NOT by this function — we
 * attempt the update and let the database reject a second active sprint. We never deactivate
 * another sprint to make room: that would work around the index (CLAUDE.md forbids it) and
 * silently end a running sprint.
 *
 * Unlike `createSprint`, this has a user-correctable failure. A `23505` (unique_violation)
 * is the index rejecting a second active sprint — the user can finish the current one and
 * retry — so it gets its own tag and a clear message at the UI. Everything else (an RLS
 * zero-row match on a cross-tenant or missing id, a network error) is not user-correctable
 * and collapses to `'unknown'`. RLS (`sprints_owner`) scopes the write through the owned
 * project, exactly as in the browser.
 */
export type StartSprintResult =
  | { ok: true; sprint: Sprint }
  | { ok: false; error: 'already_active' }
  | { ok: false; error: 'unknown' }

export async function startSprint(id: string): Promise<StartSprintResult> {
  const { data, error } = await supabase
    .from('sprints')
    .update({ status: 'active' } satisfies SprintStatusUpdate)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: 'already_active' }
    return { ok: false, error: 'unknown' }
  }
  return { ok: true, sprint: data as Sprint }
}
