import { supabase } from './supabase'
import { isCustomFieldType, type ProjectField } from './domain'
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
