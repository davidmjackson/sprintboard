import { supabase } from './supabase'
import { isCustomFieldType, type CustomFieldType, type ProjectField } from './domain'
import type { ProjectFieldUpdate } from './domain'
import { uniqueSlugForName } from './project-statuses'
import type { Tables } from './database.types'

/**
 * The columns `listProjectFields` reads, NAMED — not a bare `.select()`.
 *
 * `project-statuses.ts` uses a no-arg select and casts the rows unchecked, and SPRIN-86
 * turned that into a user-visible defect: it was the first reader of `wip_limit`, and
 * narrowing the select (or deleting the column from a test fixture) left the whole suite
 * green while the board rendered the literal `· limit undefined`. Measured twice in review.
 *
 * It is a CLASS, not one column — every future first-reader of a column inherits it — so
 * this module does not join it. `project-fields.test.ts` asserts this exact string reaches
 * PostgREST, which is what makes a silent narrowing go red rather than ship.
 */
const FIELD_COLUMNS = 'id, project_id, slug, name, type, created_at'

/**
 * Reject a row whose `type` is not one this client understands.
 *
 * `ProjectField` narrows the column's `string` to `CustomFieldType`, and a bare
 * `as ProjectField` would make that narrowing a lie the moment the database holds a value
 * the union does not — which is exactly what a widened CHECK constraint would produce, and
 * exactly the drift an unchecked cast hides. Throwing here means the failure surfaces as a
 * failed read (which the shell already renders honestly) rather than as an unrenderable
 * field appearing halfway down a settings list.
 *
 * This is a real possibility rather than a hypothetical: the database check already accepts
 * all five types, so a client compiled before a sixth is added would meet one.
 */
function toProjectField(row: Tables<'project_fields'>): ProjectField {
  if (!isCustomFieldType(row.type)) {
    throw new Error(`Unrecognised custom field type: ${row.type}`)
  }
  return { ...row, type: row.type }
}

/**
 * One project's custom field definitions, in creation order.
 *
 * THROWS rather than resolving to `[]` on error, mirroring `listProjectStatuses` and
 * `listSprints`: `[]` is indistinguishable from "this project has no custom fields", so a
 * caller handed one could not tell a failed read from a project that simply has none. That
 * matters more here than anywhere else in this epic, because having none is the COMMON
 * case — every project starts with zero, and nothing seeds them.
 *
 * The `project_id` filter is required even though `fields_owner_read` scopes the select to
 * the owner: the owner has many projects, and RLS narrows to the tenant, not to the project.
 *
 * **Ordered by `(created_at, slug)`, and both keys are needed.** `created_at` is the
 * intended order — fields appear in the order they were added — but it is a `timestamptz`
 * with no uniqueness, so two fields created in the same transaction (or the same clock tick)
 * would tie and PostgREST would return them in an arbitrary, unstable order. `slug` is
 * unique per project, so it breaks every tie and makes the sequence total. Dropping it looks
 * harmless and produces a list that reorders itself between reads.
 *
 * There is deliberately no `position` column: with no reorder UI it would be `created_at`
 * with extra machinery, and reordering is its own story if it is ever wanted.
 */
export async function listProjectFields(projectId: string): Promise<ProjectField[]> {
  const { data, error } = await supabase
    .from('project_fields')
    .select(FIELD_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .order('slug', { ascending: true })

  if (error) throw new Error(`Could not load custom fields: ${error.message}`)
  return (data ?? []).map(toProjectField)
}

/**
 * Writes return a tagged result rather than throwing, matching `createProjectStatus` and
 * `startSprint`: a refusal the user can act on is an expected outcome, not an exception.
 *
 * **TWO tags, where statuses have five** — and the missing one is the point. There is no
 * `'duplicate'`, because `project_fields` carries **no name-uniqueness constraint**: AC2
 * requires that two fields called "Customer ref" both succeed. A tag whose message described
 * a constraint this table does not have would be a lie on screen about a write that worked.
 */
export type FieldWriteResult<T> = { ok: true; value: T } | { ok: false; error: FieldWriteError }

type FieldWriteError = 'stale' | 'unknown'

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505'

/**
 * The ONE unique constraint on `project_fields`, and why its remedy is `'stale'`.
 *
 * `createProjectField` derives a collision-free slug from a `existing` list the caller holds
 * and nothing refetches. So a 23505 on `project_fields_project_slug_unique` means exactly one
 * thing: that list was older than the database, and the slug it de-duplicated against was
 * missing a row. Retrying the same submit reproduces it forever — nothing about the *name*
 * was ever the problem — so reloading is the only remedy, which is what `'stale'` means
 * everywhere else in this codebase (`startSprint`, `setStatusWipLimit`, `createProjectStatus`).
 *
 * It is an ALLOW-LIST on purpose, the same shape `project-statuses.ts` uses. A 23505 naming a
 * constraint added by a later story collapses to `'unknown'` and its generic retry copy,
 * rather than to a confident sentence telling the user to reload for something a reload will
 * not fix.
 *
 * **Matching on the message is the only channel available**, measured on `project_statuses`
 * on 2026-08-01 and true of every PostgREST unique violation: `code` is `23505`, `details`
 * and `hint` are both null, and the constraint name appears inside `message` alone.
 * Localisation does not threaten it — Postgres translates the surrounding prose, but the
 * name inside the double quotes comes from the catalog and is never translated.
 */
const STALE_CONSTRAINT = 'project_fields_project_slug_unique'

function writeError(error: { code?: string; message?: string } | null): FieldWriteError {
  if (!error || error.code !== UNIQUE_VIOLATION) return 'unknown'
  return (error.message ?? '').includes(STALE_CONSTRAINT) ? 'stale' : 'unknown'
}

/**
 * Add a custom field definition to a project (SPRIN-91 AC2).
 *
 * ONE object parameter, not four positional ones: T4 caps parameters at 4, and an object is
 * this repo's existing idiom for a write's inputs (`createProject`, `createProjectStatus`).
 *
 * The name is trimmed HERE and not only in `AddFieldSchema`, because the schema is the FORM's
 * edge and this function's contract has to hold for every caller. A direct caller sending
 * `'  Customer ref  '` would otherwise store surrounding space the database's
 * `btrim(name) <> ''` check tolerates — and the trim also changes the derived slug, so doing
 * it after `uniqueSlugForName` would produce a slug for a name that was never stored.
 *
 * **Two fields may share a NAME, and that is the AC.** `project_fields` has no
 * name-uniqueness constraint, so nothing here refuses the second "Customer ref" — it simply
 * gets `customer_ref_2` from `uniqueSlugForName`, which de-duplicates against the slugs the
 * project already holds. This is the one place copying `createProjectStatus` wholesale would
 * be wrong.
 */
export async function createProjectField(input: {
  projectId: string
  name: string
  type: CustomFieldType
  existing: readonly ProjectField[]
}): Promise<FieldWriteResult<ProjectField>> {
  const name = input.name.trim()
  const slug = uniqueSlugForName(
    name,
    input.existing.map((f) => f.slug),
  )
  // No legal slug means NO REQUEST AT ALL. Sending one would earn a check-constraint
  // violation naming `slug` — a column the user has never seen and cannot correct.
  // `AddFieldSchema` refuses these at the form edge, where the message can explain itself;
  // this is the backstop for every other caller.
  if (slug === null) return { ok: false, error: 'unknown' }

  const { data, error } = await supabase
    .from('project_fields')
    // EXACTLY these four keys, and no convenience spread of `input`. `authenticated` holds
    // INSERT on (project_id, slug, name, type) alone — `created_at` is withheld because it is
    // the SORT KEY and a writable sort key makes `(created_at, slug)` a client convention
    // rather than a database property, and `id` is withheld because a client that cannot
    // supply a primary key cannot collide with one. Either extra key is a 42501, so this is
    // load-bearing rather than tidiness, and the tests assert the payload EXACTLY for that
    // reason: `objectContaining` would pass with either present.
    .insert({ project_id: input.projectId, slug, name, type: input.type })
    .select(FIELD_COLUMNS)
    .single()

  if (error) return { ok: false, error: writeError(error) }
  return { ok: true, value: toProjectField(data) }
}

/**
 * Rename a custom field (AC3). `name` is the ONLY column sent, and that is a **security
 * property rather than tidiness**: `authenticated` holds UPDATE on `name` alone, so a patch
 * touching `slug` or `type` is refused by Postgres with a 42501 before any policy is
 * consulted.
 *
 * `satisfies ProjectFieldUpdate` is what makes that structural instead of a comment. The
 * generated row type offers every column, so `.update({ slug })` would COMPILE and fail only
 * at runtime, against the live database — somewhere a mocked-client unit test never goes.
 *
 * The slug is untouched by construction, which is the whole point of the name/slug division:
 * story 5's value rows key on the slug, so a rename must rewrite nothing but this one cell.
 *
 * The trim is here rather than only in `RenameFieldSchema` for the same reason it is in
 * `createProjectField`: the schema binds the form, this contract binds every caller.
 *
 * A write that matched NO row — another tenant's field, or one another tab deleted — is
 * reported as a failure rather than a silent success, but only INCIDENTALLY: `.single()`
 * errors on zero rows. That is the same protection `renameProjectStatus` gets and the same
 * caveat applies — RLS FILTERS an UPDATE rather than raising on it, so dropping `.single()`
 * for a bare `.select()` here would turn a zero-row write into `{ ok: true }`. A test pins
 * the current behaviour so that edit goes red.
 */
export async function renameProjectField(
  id: string,
  name: string,
): Promise<FieldWriteResult<ProjectField>> {
  const { data, error } = await supabase
    .from('project_fields')
    .update({ name: name.trim() } satisfies ProjectFieldUpdate)
    .eq('id', id)
    .select(FIELD_COLUMNS)
    .single()

  if (error) return { ok: false, error: writeError(error) }
  return { ok: true, value: toProjectField(data) }
}
