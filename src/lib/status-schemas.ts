import { z } from 'zod'

import { STATUS_CATEGORIES } from './domain'
import { slugForName } from './project-statuses'

/**
 * The status add/rename form rules — the client edge of CLAUDE.md's validate-at-both-edges.
 *
 * The 40-character cap and the trim both mirror the database's
 * `project_statuses_name_nonempty` check (`btrim(name) <> '' and length(name) <= 40`), so a
 * name this schema accepts is one the database accepts. Uniqueness is deliberately NOT here:
 * it is not knowable client-side without a race, so it is the index's job
 * (`project_statuses_project_name_unique`) and surfaces as a `'duplicate'` write result.
 *
 * The derived SLUG rule is not restated here either — `AddStatusSchema` CALLS `slugForName`
 * rather than duplicating its regex, so `project-statuses.ts` stays the single source of truth
 * for the 30-character `project_statuses_slug_format` rule. What the schema adds is the place
 * to say it: a name with no derivable slug used to reach the write and come back as the
 * not-user-correctable `unknown` tag, so the form showed generic retry copy for a name the
 * user could trivially fix. Validation belongs at the edge that can explain itself.
 */
const name = z
  .string()
  .trim()
  .min(1, 'Give the status a name')
  .max(40, 'Keep the name to 40 characters or fewer')

/**
 * Add's extra rule, and ONLY Add's. `slugForName` prefixes a name whose slug would not start
 * with a letter ("2026 Review"), so the only names left to refuse are those with no
 * alphanumeric character at all — nothing to derive a slug from.
 *
 * Deliberately NOT applied to `RenameStatusSchema`: a rename never re-derives the slug (that
 * is the whole point of the name/slug division), so a name with no derivable slug is perfectly
 * storable on an existing row and refusing it would be a constraint the database does not have.
 */
const addName = name.refine(
  (value) => slugForName(value) !== null,
  'Use at least one letter or number in the name',
)

// Read from the shared constant rather than re-listing the three values: a fourth category
// must not be addable here without the database's check constraint agreeing.
const category = z.enum(STATUS_CATEGORIES)

export const AddStatusSchema = z.object({ name: addName, category })
export const RenameStatusSchema = z.object({ name })

export type AddStatusValues = z.input<typeof AddStatusSchema>
export type RenameStatusValues = z.input<typeof RenameStatusSchema>
