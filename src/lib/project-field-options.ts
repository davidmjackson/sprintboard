import { supabase } from './supabase'
import type { ProjectFieldOption } from './domain'

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
