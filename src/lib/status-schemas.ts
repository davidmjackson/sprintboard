import { z } from 'zod'

import { STATUS_CATEGORIES } from './domain'

/**
 * The status add/rename form rules — the client edge of CLAUDE.md's validate-at-both-edges.
 *
 * The 40-character cap and the trim both mirror the database's
 * `project_statuses_name_nonempty` check (`btrim(name) <> '' and length(name) <= 40`), so a
 * name this schema accepts is one the database accepts. Uniqueness is deliberately NOT here:
 * it is not knowable client-side without a race, so it is the index's job
 * (`project_statuses_project_name_unique`) and surfaces as a `'duplicate'` write result.
 *
 * Nothing here validates the derived SLUG either. A legal name can still fail to produce a
 * legal slug ("42", "!!!"), and that verdict belongs to `slugForName` in `project-statuses.ts`
 * where the 30-character `project_statuses_slug_format` rule lives — duplicating it here
 * would be a second source of truth for the same constraint.
 */
const name = z
  .string()
  .trim()
  .min(1, 'Give the status a name')
  .max(40, 'Keep the name to 40 characters or fewer')

// Read from the shared constant rather than re-listing the three values: a fourth category
// must not be addable here without the database's check constraint agreeing.
const category = z.enum(STATUS_CATEGORIES)

export const AddStatusSchema = z.object({ name, category })
export const RenameStatusSchema = z.object({ name })

export type AddStatusValues = z.input<typeof AddStatusSchema>
export type RenameStatusValues = z.input<typeof RenameStatusSchema>
