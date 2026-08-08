import { supabase } from './supabase'
import type { ProjectFieldOption, ProjectFieldOptionUpdate } from './domain'
import { uniqueSlugForName } from './project-statuses'

/**
 * The columns this module reads, NAMED — not a bare `.select()`.
 *
 * `project-statuses.ts` uses a no-arg select and SPRIN-86 turned that into a user-visible
 * defect: it was the first reader of `wip_limit`, and narrowing the select left the whole
 * suite green while the board rendered `· limit undefined`. It is a CLASS, not one column.
 * `project-field-options.test.ts` asserts this exact string reaches PostgREST.
 */
export const OPTION_COLUMNS = 'project_id, field_id, slug, label, position'

/**
 * One project's select-field options, across every `select` field it has.
 *
 * THROWS rather than resolving to `[]`, mirroring `listProjectFields`: `[]` is the COMMON
 * legitimate state here — most fields are not `select`, and a select field starts with no
 * options — so a silent empty is indistinguishable from a failed read. The caller reads the
 * phase, never the emptiness.
 *
 * **Ordered `(position, slug)`, and both keys are needed.** Nothing makes `position` unique —
 * the client derives it as `max(position) + 1` from a list nothing refetches — so two options
 * can tie and PostgREST would return them in an arbitrary, unstable order. `slug` is unique
 * per field and breaks every tie. Identical to the `(created_at, slug)` guard on
 * `listProjectFields`.
 */
export async function listProjectFieldOptions(projectId: string): Promise<ProjectFieldOption[]> {
  const { data, error } = await supabase
    .from('project_field_options')
    .select(OPTION_COLUMNS)
    .eq('project_id', projectId)
    .order('position', { ascending: true })
    .order('slug', { ascending: true })

  if (error) throw new Error(`Could not load field options: ${error.message}`)
  return data ?? []
}

/** The options belonging to one field, in the order `listProjectFieldOptions` established. */
export function optionsForField(
  options: readonly ProjectFieldOption[],
  fieldId: string,
): ProjectFieldOption[] {
  return options.filter((o) => o.field_id === fieldId)
}

/**
 * Writes return a tagged result rather than throwing, matching `createProjectField` and
 * `createProjectStatus`: a refusal the user can act on is an expected outcome, not an
 * exception.
 */
export type OptionWriteResult<T> = { ok: true; value: T } | { ok: false; error: OptionWriteError }

type OptionWriteError = 'stale' | 'unknown'

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505'

/**
 * The one unique constraint reachable from here, and why its remedy is `'stale'`.
 *
 * The slug is de-duplicated against a list the caller holds and nothing refetches, so a
 * 23505 on the primary key means exactly one thing: that list was older than the database.
 * Retrying the same submit reproduces it forever — the label was never the problem — so
 * reloading is the only remedy, which is what `'stale'` means everywhere in this codebase.
 *
 * An ALLOW-LIST on purpose. A 23505 naming a constraint added by a later story collapses to
 * `'unknown'` and generic retry copy, rather than a confident sentence telling the user to
 * reload for something a reload will not fix. Matching on the message is the only channel
 * PostgREST exposes: `code` is 23505, `details` and `hint` are null, and the constraint name
 * appears inside `message` alone — untranslated, because it comes from the catalog.
 */
const STALE_CONSTRAINT = 'project_field_options_pkey'

function writeError(error: { code?: string; message?: string } | null): OptionWriteError {
  if (!error || error.code !== UNIQUE_VIOLATION) return 'unknown'
  return (error.message ?? '').includes(STALE_CONSTRAINT) ? 'stale' : 'unknown'
}

/**
 * Add an option to a `select` field (AC1).
 *
 * ONE object parameter, not four positional ones: T4 caps parameters at 4, and an object is
 * this repo's idiom for a write's inputs.
 *
 * `existing` must be the options of THIS field only — pass `optionsForField(...)`. Handing it
 * the whole project's options would de-duplicate the slug against other fields' slugs, which
 * the primary key `(field_id, slug)` does not require, and would waste `low_2` on a field
 * that has no `low`.
 *
 * No legal slug means NO REQUEST AT ALL. Sending one would earn a check-constraint violation
 * naming `slug` — a column the user has never seen and cannot correct. `AddOptionSchema`
 * refuses these at the form edge where the message can explain itself; this is the backstop
 * for every other caller.
 */
export async function createProjectFieldOption(input: {
  projectId: string
  fieldId: string
  label: string
  existing: readonly ProjectFieldOption[]
}): Promise<OptionWriteResult<ProjectFieldOption>> {
  const label = input.label.trim()
  const slug = uniqueSlugForName(
    label,
    input.existing.map((o) => o.slug),
  )
  if (slug === null) return { ok: false, error: 'unknown' }

  const position = input.existing.reduce((max, o) => Math.max(max, o.position), 0) + 1

  const { data, error } = await supabase
    .from('project_field_options')
    // EXACTLY these five keys. `authenticated` holds INSERT on these columns alone, so any
    // extra key is a 42501. The test asserts the payload EXACTLY for that reason —
    // `objectContaining` would pass with an extra key present.
    .insert({ project_id: input.projectId, field_id: input.fieldId, slug, label, position })
    .select(OPTION_COLUMNS)
    .single()

  if (error) return { ok: false, error: writeError(error) }
  // NO CAST. `as ProjectFieldOption` stood here and suppressed TS2739: narrowing the returning
  // `.select()` to fewer columns than the type needs then compiles clean and fails only at
  // runtime, against a live database a mocked unit test never reaches. `renameProjectFieldOption`
  // below has no cast and IS caught by the compiler for exactly that mutation — the two must
  // behave the same way, and the compiler is the cheaper of the two guards.
  return { ok: true, value: data }
}

/**
 * Rename an option's LABEL (AC3). `label` is the ONLY column sent, and that is a security
 * property rather than tidiness: `authenticated` holds UPDATE on `label` alone, so a patch
 * touching `slug` is refused by Postgres with 42501 before any policy is consulted.
 *
 * `satisfies ProjectFieldOptionUpdate` is what makes that structural instead of a comment.
 * The generated row type offers every column, so `.update({ slug })` would COMPILE and fail
 * only at runtime against the live database — somewhere a mocked unit test never goes.
 *
 * The slug is untouched by construction, which is the whole point: `tfv_option_fk` keys value
 * rows on the slug, so a rename must rewrite nothing but this one cell. AC3 is therefore true
 * by construction rather than by care.
 *
 * The affected row count is checked EXPLICITLY, like `deleteProjectFieldOption` below and
 * `deleteProjectStatus` before it, rather than leaning on `.single()`'s incidental zero-row
 * error. RLS FILTERS an update rather than raising on it, so a cross-tenant or already-deleted
 * row is a successful ZERO-row update; `.single()` happens to turn that into an error today,
 * but that is a property of the terminator we chose, not of the check we meant to make. Stating
 * it makes the guard survive anyone swapping `.single()` for `.maybeSingle()` — which would be
 * a one-word change with no test to notice.
 *
 * Zero rows is `'stale'` for the same reason it is on the delete: the list this rename was
 * driven from is older than the database, and only a reload fixes that. The caller
 * (`CustomFieldOptionRow`) shows generic retry copy for either tag, so this changes no
 * sentence on screen — it changes what the function KNOWS.
 */
export async function renameProjectFieldOption(
  fieldId: string,
  slug: string,
  label: string,
): Promise<OptionWriteResult<ProjectFieldOption>> {
  const { data, error } = await supabase
    .from('project_field_options')
    .update({ label: label.trim() } satisfies ProjectFieldOptionUpdate)
    .eq('field_id', fieldId)
    .eq('slug', slug)
    .select(OPTION_COLUMNS)

  if (error) return { ok: false, error: writeError(error) }
  // The FIRST row rather than a `length !== 1` count (the delete's shape below): both `.eq()`
  // filters name a primary-key column, so the update matches at most one row and "no first row"
  // and "no rows" are the same fact. `noUncheckedIndexedAccess` types this `| undefined`, so
  // deleting this line does not compile.
  const renamed = (data ?? [])[0]
  if (!renamed) return { ok: false, error: 'stale' }
  return { ok: true, value: renamed }
}

/**
 * Delete an option (AC4). Its value rows go with it via `tfv_option_fk`'s cascade — that is
 * the AC, not a side effect: refusing the delete instead would make any option that was ever
 * used permanently undeletable.
 *
 * The affected row count is checked EXPLICITLY, like `deleteProjectStatus`, rather than
 * leaning on `.single()`'s incidental zero-row error. RLS FILTERS a delete rather than raising
 * on it, so a cross-tenant or already-deleted row comes back as a successful zero-row delete
 * unless something counts.
 *
 * BOTH key columns are filtered. `field_id` alone would delete every option on the field.
 */
export async function deleteProjectFieldOption(
  fieldId: string,
  slug: string,
): Promise<OptionWriteResult<void>> {
  const { data, error } = await supabase
    .from('project_field_options')
    .delete()
    .eq('field_id', fieldId)
    .eq('slug', slug)
    .select('slug')

  if (error) return { ok: false, error: writeError(error) }
  if ((data ?? []).length !== 1) return { ok: false, error: 'stale' }
  return { ok: true, value: undefined }
}

/**
 * How many tickets hold this option (AC4 — the count is shown BEFORE the user commits).
 *
 * THROWS rather than resolving to zero on error — and on a MISSING count, treated the same
 * way — for the same reason `ticketCountsByStatus` does: **zero is what UNLOCKS the
 * destructive action**, so a failed count reported as zero would offer a delete whose blast
 * radius the user was told was nil.
 */
export async function countTicketsHoldingOption(fieldId: string, slug: string): Promise<number> {
  const { count, error } = await supabase
    .from('ticket_field_values')
    .select('*', { head: true, count: 'exact' })
    .eq('field_id', fieldId)
    .eq('value_option', slug)

  if (error) throw new Error(`Could not count tickets holding that option: ${error.message}`)
  if (count === null) throw new Error('Could not count tickets holding that option: no count')
  return count
}
