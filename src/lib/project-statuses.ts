import { supabase } from './supabase'
import type { ProjectStatus } from './domain'

/**
 * The `project_statuses` read, and the two selectors the board and ticket dialog need
 * on top of it — SPRIN-76's first half. Nothing consumes these yet; the render switch
 * and the status `<select>` are later tasks in the same story.
 *
 * `listProjectStatuses` throws rather than resolving to `[]` on error, mirroring
 * `listSprints` in `sprints.ts`: `[]` is indistinguishable from "this project has no
 * statuses", so a caller handed one could not tell a failed read from an empty board —
 * this codebase removed exactly that defect once already (see `listSprints`'s doc).
 * The `project_id` filter is required for the same reason it is there: `statuses_owner_read`
 * RLS scopes the select to the owner, but the owner has many projects.
 *
 * `position` order **is** the board column order — there is no separate rule anywhere
 * else that decides where a column sits. `.order('position', { ascending: true })` is
 * therefore not a display nicety, it is the contract callers rely on to render columns
 * left to right without re-sorting.
 *
 * `statusName`'s fallback to the slug itself is AC4: a status this project's rows do not
 * (yet, or any longer) contain must still render as *something* identifying rather than
 * an empty string or `undefined` — the slug is always available and always meaningful,
 * so it is the chosen default rather than a placeholder like "Unknown".
 */
export async function listProjectStatuses(projectId: string): Promise<ProjectStatus[]> {
  const { data, error } = await supabase
    .from('project_statuses')
    .select()
    .eq('project_id', projectId)
    .order('position', { ascending: true })

  if (error) throw new Error(`Could not load statuses: ${error.message}`)
  return (data ?? []) as ProjectStatus[]
}

export function statusName(statuses: readonly ProjectStatus[], slug: string): string {
  return statuses.find((s) => s.slug === slug)?.name ?? slug
}

/**
 * The options for a ticket's status `<select>`, in the rows' own (position) order.
 *
 * The `current` append is the load-bearing part: a `<select>` whose `value` matches no
 * `<option>` renders blank, and the browser's next `change` event would then move the
 * ticket to whatever option happens to be first — somewhere the user never chose. That
 * can happen honestly (a status was deleted, or renamed out from under an open ticket),
 * so the select must stay controlled by keeping `current` selectable even when the
 * project's live status rows no longer include it.
 */
export function statusOptions(
  statuses: readonly ProjectStatus[],
  current: string,
): { slug: string; name: string }[] {
  const options = statuses.map((s) => ({ slug: s.slug, name: s.name }))
  return options.some((o) => o.slug === current)
    ? options
    : [...options, { slug: current, name: current }]
}
