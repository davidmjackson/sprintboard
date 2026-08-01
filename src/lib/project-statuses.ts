import { supabase } from './supabase'
import type { ProjectStatus, StatusCategory } from './domain'

/**
 * The category that makes a status terminal. Annotated `StatusCategory` rather than left as
 * a bare literal so that it is checked against `STATUS_CATEGORIES`' union at compile time —
 * the value is the database's, and this is the one place in the client that names it. Every
 * other site asks `doneSlugs` instead (CLAUDE.md: never inline a status literal).
 */
const TERMINAL_CATEGORY: StatusCategory = 'done'

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

/** The DB's project_statuses_slug_format check: ^[a-z][a-z0-9_]{0,29}$ — 30 chars total. */
const SLUG_MAX = 30

const SLUG_FORMAT = /^[a-z][a-z0-9_]{0,29}$/

/**
 * The machine identity derived from a display name. Users rename `name`, never `slug` — the
 * same division `projects.key` already uses, and the reason a rename never rewrites a ticket
 * row: `tickets_status_fk` references (project_id, slug).
 *
 * Returns `null` rather than a best-effort string when the name cannot produce a legal slug
 * (it starts with a digit, or is all punctuation). The caller reports a field error; sending
 * it would earn a constraint violation naming a column the user has never seen.
 *
 * The truncate happens BEFORE the edge strip, so a 30-character cut landing mid-underscore
 * cannot leave a trailing `_` and fail the check it was trying to satisfy.
 */
export function slugForName(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, SLUG_MAX)
    .replace(/^_+|_+$/g, '')

  return SLUG_FORMAT.test(slug) ? slug : null
}

/**
 * `slugForName` plus collision avoidance within one project.
 *
 * Two DIFFERENT names can derive to ONE slug — "To Do" and "To-Do" both give `to_do` — and the
 * duplicate-NAME index does not catch that, because those are not duplicate names. The
 * `project_statuses_project_slug_unique` constraint would, as a 23505 the user cannot act on.
 * So the suffix is applied client-side; the constraint remains the backstop for the race.
 *
 * The suffix is applied INSIDE the length limit, not appended past it.
 */
export function uniqueSlugForName(name: string, taken: readonly string[]): string | null {
  const base = slugForName(name)
  if (base === null) return null
  if (!taken.includes(base)) return base

  for (let n = 2; n <= 99; n++) {
    const suffix = `_${n}`
    const candidate = base.slice(0, SLUG_MAX - suffix.length) + suffix
    if (!taken.includes(candidate)) return candidate
  }
  return null
}

/**
 * The project's terminal statuses, by slug.
 *
 * ONE exported derivation, used by the sprint-completion DB filter, the shell's optimistic
 * reducer and the tests alike. The correctness argument in `completeSprint`'s docblock rests
 * on the database's rule and the client's local patch being THE SAME RULE — two independent
 * derivations could drift, one cannot.
 *
 * Before SPRIN-77 both sites hardcoded the slug `'done'`. That was only true while the
 * vocabulary was immutable; a user-added terminal status would have had its tickets dragged
 * back to the backlog on sprint completion.
 */
export function doneSlugs(statuses: readonly ProjectStatus[]): Set<string> {
  return new Set(statuses.filter((s) => s.category === TERMINAL_CATEGORY).map((s) => s.slug))
}

/**
 * Writes return a tagged result rather than throwing, matching `createProject` and
 * `startSprint`: a duplicate name is an expected, user-correctable outcome, not an exception.
 *
 * `23505` is the only code mapped, and within this table it can only mean the
 * `project_statuses_project_name_unique` index (AC4) or the slug unique constraint — both of
 * which the user fixes by choosing a different name, so one tag serves both.
 */
export type StatusWriteResult<T> = { ok: true; value: T } | { ok: false; error: StatusWriteError }

type StatusWriteError = 'duplicate' | 'unknown'

/** Postgres `unique_violation`. The only code this table can raise that a user can act on. */
const UNIQUE_VIOLATION = '23505'

function writeError(code: string | undefined): StatusWriteError {
  return code === UNIQUE_VIOLATION ? 'duplicate' : 'unknown'
}

/**
 * Add a status to a project.
 *
 * ONE object parameter, not four positional ones: T4 caps parameters at 4, and an object is
 * this repo's existing idiom for a write's inputs (`createProject`, `createSprint`).
 */
export async function createProjectStatus(input: {
  projectId: string
  name: string
  category: StatusCategory
  existing: readonly ProjectStatus[]
}): Promise<StatusWriteResult<ProjectStatus>> {
  const slug = uniqueSlugForName(
    input.name,
    input.existing.map((s) => s.slug),
  )
  // No legal slug means no request at all. Sending one would earn a check-constraint
  // violation naming `slug` — a column the user has never seen and cannot correct.
  if (slug === null) return { ok: false, error: 'unknown' }

  // Append. NOT derived from the list length — a project whose positions are 1,2,5 must not
  // produce another 5. max+1 is the only value that is free by construction, and the seed of
  // 0 keeps an empty project's first status on position 1, which the DB's positivity check
  // requires.
  const position = input.existing.reduce((max, s) => Math.max(max, s.position), 0) + 1

  const { data, error } = await supabase
    .from('project_statuses')
    .insert({
      project_id: input.projectId,
      slug,
      name: input.name,
      category: input.category,
      position,
      // Explicit, not left to the column default: that default is what SPRIN-80 changes, and
      // an added status must never silently become a project's initial one.
      is_initial: false,
    })
    .select()
    .single()

  if (error) return { ok: false, error: writeError(error.code) }
  return { ok: true, value: data as ProjectStatus }
}

/**
 * Rename. `name` is the ONLY column sent, and that is a security property rather than
 * tidiness: `authenticated` holds UPDATE on exactly (name, category, position), so a patch
 * touching `slug` is refused by Postgres before any policy is consulted. Sending only what
 * changes keeps the request inside that grant.
 */
export async function renameProjectStatus(
  id: string,
  name: string,
): Promise<StatusWriteResult<ProjectStatus>> {
  const { data, error } = await supabase
    .from('project_statuses')
    .update({ name })
    .eq('id', id)
    .select()
    .single()

  if (error) return { ok: false, error: writeError(error.code) }
  return { ok: true, value: data as ProjectStatus }
}

/**
 * Reorder, through an RPC rather than N patches.
 *
 * `project_statuses_project_position_unique` is DEFERRABLE INITIALLY DEFERRED, and that
 * deferral only helps within ONE transaction. PostgREST gives each request its own, so N
 * separate `PATCH position=` calls collide on the very first swap. One statement inside one
 * function is the only shape where the deferral does its job.
 *
 * The list must be COMPLETE and in the intended order: the function assigns `ordinality`, so
 * a partial list would leave the omitted rows on their old positions and could collide at
 * commit. Callers pass every slug the project has.
 *
 * A failure is never user-correctable here — the caller chose no text — so there is no
 * `duplicate` tag to reach, and every error collapses to `unknown`.
 */
export async function reorderProjectStatuses(
  projectId: string,
  orderedSlugs: readonly string[],
): Promise<StatusWriteResult<ProjectStatus[]>> {
  const { data, error } = await supabase.rpc('reorder_project_statuses', {
    p_project_id: projectId,
    p_slugs: [...orderedSlugs],
  })

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, value: (data ?? []) as ProjectStatus[] }
}
