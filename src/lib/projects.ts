import { supabase } from './supabase'
import type { Project, ProjectType, SprintCadence } from './domain'

/**
 * Create a project for the given owner.
 *
 * `owner_id` must be the caller's own `auth.uid()` — the RLS insert policy rejects
 * anything else, so this is the security boundary, not a convenience. The result is a
 * discriminated union rather than a throw: a duplicate key is an expected,
 * user-correctable outcome (the `projects_owner_key_unique` constraint), not an
 * exception. Postgres raises `23505` on any unique violation; the only unique
 * constraint reachable here is per-owner key, so that code maps to `duplicate_key`.
 *
 * The project's four board statuses are seeded by the `on_project_created_statuses`
 * trigger, in this insert's own transaction. Deliberately not done here: the raw
 * fixture inserts across the integration suites and the Playwright E2E all create
 * projects without going through this function, and a client-side seed would leave
 * every one of them with a statusless project. Do not add one.
 *
 * `projectType` is REQUIRED and deliberately has no TypeScript default (SPRIN-81). The
 * column is `not null default 'scrum'`, and that default is the single source of the
 * decision — it is what keeps every one of those raw fixture inserts creating a Scrum
 * project. A default here would be a second source that could silently drift from it.
 * The caller supplies the user's choice; the database supplies everyone else's.
 *
 * The value is not re-validated here: `ProjectType` is a closed union, so an invalid
 * type is a compile error, and the `projects_project_type_check` constraint is the
 * backstop for anything that reaches the database by another route.
 */
export type CreateProjectResult =
  { ok: true; project: Project } | { ok: false; error: 'duplicate_key' | 'unknown' }

export async function createProject(input: {
  ownerId: string
  name: string
  key: string
  projectType: ProjectType
}): Promise<CreateProjectResult> {
  const { data, error } = await supabase
    .from('projects')
    .insert({
      owner_id: input.ownerId,
      name: input.name,
      key: input.key,
      project_type: input.projectType,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: 'duplicate_key' }
    return { ok: false, error: 'unknown' }
  }

  return { ok: true, project: data as Project }
}

/**
 * The caller's own projects, name-ordered for a stable nav.
 *
 * No owner filter is needed or wanted: the `projects_owner` RLS policy already scopes
 * `select` to `owner_id = auth.uid()`, so this returns exactly the signed-in user's
 * projects and never another tenant's — the isolation is the database's, proven live.
 */
export async function listProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select()
    .order('name', { ascending: true })

  if (error) throw new Error(`Could not load projects: ${error.message}`)
  return (data ?? []) as Project[]
}

/**
 * Change a project's sprint cadence — the FIRST write of any kind this table has accepted from
 * the app since SPRIN-82 revoked `authenticated`'s table-wide UPDATE.
 *
 * **`'forbidden'` is a tag of its own rather than part of `'unknown'`, and that is the whole
 * reason this union has two members.** `42501` here means SPRIN-97's migration B was never
 * applied: the two columns carry no grant, so Postgres refuses the patch before any policy is
 * consulted. Folding it into `'unknown'` would make a mis-applied migration — permanent, and
 * fixed only by running SQL — indistinguishable from a network blip, and the UI would offer a
 * retry that fails identically forever. It is the one database error code on this path that a
 * user-facing sentence can honestly be written about.
 *
 * **On this table `42501` has two possible authors, and only one of them is reachable here.**
 * It is also what `projects_owner`'s RLS `WITH CHECK` raises when an INSERT or UPDATE would
 * leave a row owned by someone other than `auth.uid()` — see `projects.integration.test.ts`,
 * which pins both. This path can never produce that one: the payload spells out two columns
 * and neither is `owner_id`, so there is no ownership for the check to reject. Every `42501`
 * that reaches this branch is a missing grant.
 *
 * **The payload is an object literal with both column names written out as plain keys**, and
 * that is structural, not stylistic. `src/test/project-type-immutability.test.ts` parses this
 * call and allows it only if every key it can statically read is in `SPRINT_CADENCE_COLUMNS`;
 * a spread, a computed key or an identifier standing in for the object makes the keys
 * unreadable, and unreadable is a FAILURE there rather than a pass. Spelling them out is what
 * keeps that guard able to answer.
 *
 * No `satisfies` clause, unlike `renameProjectStatus` and `renameProjectFieldOption`, which
 * use one to mirror their column grants in the type system. **The original reason for that has
 * since expired and the decision was re-taken rather than inherited.** This docblock used to
 * say a `satisfies` wrapper would hide the literal from the AST guard; as of SPRIN-97 the
 * guard routes the payload through `unwrapExpression` and reads straight through `satisfies`
 * and `as`, proved by a control in `src/test/project-type-immutability.test.ts`. So the
 * wrapper is now available.
 *
 * It is still not used, for a different reason: it would add no coverage. A `satisfies
 * ProjectCadenceUpdate` and the AST guard fail on the SAME mutation — writing an ungranted
 * column — so they are redundancy rather than the disjoint two-layer design this table's
 * immutability actually rests on. What the wrapper would buy is earlier feedback (a red
 * squiggle instead of a red suite), which is real but is not a second control. If a future
 * story wants it, the guard will not object.
 *
 * The compiler is not giving nothing up meanwhile: `.update()` is typed against the generated
 * `projects` Update type, so a misspelt column is still a compile error.
 *
 * **The affected row count is checked EXPLICITLY** rather than left to `.single()`'s incidental
 * zero-row error, following `setStatusWipLimit` and `renameProjectFieldOption` (whose docblocks
 * argue it at length) rather than the `.select().single()` the plan drafted. RLS FILTERS an
 * UPDATE instead of raising on it, so another tenant's project id — or one deleted in another
 * tab — comes back as `{ data: [], error: null }`: a write that changed nothing, and a success
 * unless the count is read. `.single()` happens to error on that today, but that is a property
 * of the terminator, not of the check we mean to make, and swapping it for `.maybeSingle()` is
 * a one-word edit no test would notice. Zero rows takes `'unknown'`: it is not a permissions
 * problem, and the generic retry copy is the honest answer to a project that is gone.
 *
 * Returning the row the database now holds, rather than echoing what the form submitted, is
 * what makes the settings section agree with a reload without a refetch.
 */
export type UpdateCadenceResult =
  { ok: true; project: Project } | { ok: false; error: 'forbidden' | 'unknown' }

export async function updateProjectCadence(
  projectId: string,
  cadence: SprintCadence,
): Promise<UpdateCadenceResult> {
  const { data, error } = await supabase
    .from('projects')
    .update({
      sprint_length_weeks: cadence.sprint_length_weeks,
      sprint_start_weekday: cadence.sprint_start_weekday,
    })
    .eq('id', projectId)
    .select()

  if (error) return { ok: false, error: error.code === '42501' ? 'forbidden' : 'unknown' }

  const rows = (data ?? []) as Project[]
  if (rows.length !== 1) return { ok: false, error: 'unknown' }
  return { ok: true, project: rows[0]! }
}
