import { supabase } from './supabase'
import type { Project, ProjectType, SprintCadence } from './domain'

/**
 * Create a project for the given owner.
 *
 * `owner_id` must be the caller's own `auth.uid()` — `projects_bootstrap_insert` rejects
 * anything else, so this is the security boundary, not a convenience.
 *
 * **That policy is the one place `owner_id` still carries authority, and it is a bootstrap
 * rather than an ownership model.** Since SPRIN-101 every other verb on this table resolves
 * to membership; INSERT cannot, because a brand-new project has no members yet and requiring
 * one would make every creation fail. The `seed_project_admin` trigger closes the loop in
 * this same transaction, inserting the caller's `admin` row — so by the time this function
 * returns, authority has already moved from the column to the membership table.
 *
 * The result is a
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
 * Every project the caller is a MEMBER of, name-ordered for a stable nav.
 *
 * No filter is needed or wanted: `projects_member_read` scopes `select` to
 * `app_auth.is_project_member(id)`, so this returns exactly the projects the signed-in user
 * belongs to and never another tenant's — the isolation is the database's, proven live.
 *
 * **This docblock said "the caller's OWN projects" and named `projects_owner` until
 * SPRIN-101, and both halves are now wrong.** Ownership no longer decides what appears here;
 * membership does. A user can see a project they did not create, and — once SPRIN-102 ships
 * removal — stop seeing one they did. `owner_id` is an audit column that grants nothing on
 * its own; the only place it still carries authority is the INSERT policy, purely to
 * bootstrap. Do not reintroduce an `.eq('owner_id', …)` filter here "for safety": it would
 * silently hide every project the caller was invited to, and no test asserts its absence.
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
 * It is also what an RLS `WITH CHECK` raises — on INSERT, `projects_bootstrap_insert` rejects
 * a row owned by someone other than `auth.uid()`; see `projects.integration.test.ts`, which
 * pins both. This path can never produce that one, and **SPRIN-101 changed the reason while
 * leaving the conclusion standing** — worth recording, because the old reason is the one a
 * reader will assume. It used to be that the payload names two columns and neither is
 * `owner_id`, so there was no ownership for `projects_owner`'s check to reject. That is still
 * true but no longer the operative fact: UPDATE is now governed by `projects_admin_update`,
 * whose `WITH CHECK` is `is_project_admin(id)` — the *same* predicate as its `USING`. A row
 * that fails the check would have been filtered by `USING` first, so the check can never be
 * the thing that raises. Every `42501` reaching this branch is a missing grant.
 *
 * **What DID change is the zero-row path, and it is now reachable by an ordinary user.** A
 * non-admin member's patch is filtered to zero rows and mapped to `'unknown'` below, so they
 * see the generic retry copy for a state retrying will never fix. That is a fresh instance of
 * the SPRIN-64 class — an app-layer path leaning on a policy's USING breadth — and it belongs
 * to SPRIN-104 (re-audit app-layer guards for zero-row-write blindness) rather than being
 * papered over here. A `'not_permitted'` tag was considered and rejected for SPRIN-101: zero
 * rows cannot honestly distinguish "not an admin" from "project deleted in another tab"
 * without a second read, and a tag that guesses is worse than the generic copy.
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
