import { z } from 'zod'

import { CUSTOM_FIELD_TYPES } from './domain'
import { slugForName } from './project-statuses'

/**
 * The custom-field add/rename form rules — the client edge of CLAUDE.md's
 * validate-at-both-edges (SPRIN-91, epic SPRIN-71).
 *
 * **A separate module from `status-schemas.ts`, not an addition to it**, and the reason is
 * the one rule these two surfaces do NOT share. `status-schemas.ts` is named for statuses,
 * imports `STATUS_CATEGORIES`, and exports `DUPLICATE_NAME` — a sentence about
 * `project_statuses_project_name_unique`. `project_fields` has **no name-uniqueness
 * constraint at all**: AC2 requires that adding two fields called "Customer ref" both
 * succeed, producing `customer_ref` and `customer_ref_2`. Sharing the file would put two
 * opposite decisions about duplicate names one scroll apart, and importing that sentence
 * here would show the user a constraint this table does not have, for a write that in fact
 * succeeded. There is deliberately no `DUPLICATE_NAME` equivalent below.
 *
 * The 40-character cap and the trim mirror the database's `project_fields_name_nonempty`
 * check (`btrim(name) <> '' and length(name) <= 40`), so a name this schema accepts is one
 * the database accepts. **That parity is AC4**, and it is asserted at both edges: here in
 * `field-schemas.test.ts`, and against the live constraint by name in
 * `rls.integration.test.ts`.
 */
const name = z
  .string()
  .trim()
  .min(1, 'Give the field a name')
  .max(40, 'Keep the name to 40 characters or fewer')

/**
 * Add's extra rule, and ONLY Add's.
 *
 * `slugForName` is IMPORTED from `project-statuses.ts` rather than re-derived here, and its
 * regex is deliberately not restated. `project_fields_slug_format` and
 * `project_statuses_slug_format` are `^[a-z][a-z0-9_]{0,29}$` character for character —
 * migration A says so in as many words — and two derivations of one rule drift while one
 * cannot. (If a later story gives the two tables different slug rules, splitting the helper
 * is a visible edit at that moment rather than a silent divergence now.)
 *
 * `slugForName` PREFIXES a name whose slug would not start with a letter ("2026 budget
 * code"), so the only names left to refuse are those it can derive nothing from at all.
 * Without this refine such a name reaches the write and comes back as the
 * not-user-correctable `unknown` tag, so the form shows generic retry copy for something the
 * user could trivially fix. Validation belongs at the edge that can explain itself.
 *
 * **The message names the character set rather than saying "a letter or number", because
 * ASCII is what the rule actually is.** `slugForName` keeps `[a-z0-9]` and discards
 * everything else — which refuses `参照番号`, `Ссылка` and `ß`, names that plainly consist of
 * letters. The wording that survived measurement in `status-schemas.ts` is reused verbatim
 * for that reason, not copied out of habit: "letter or number" is false exactly where this
 * fires, and leaves the user with no idea what to change. Widening the derivation to other
 * scripts is a schema question and a separate story; telling the truth about today's rule is
 * not.
 *
 * Deliberately NOT applied to `RenameFieldSchema`: a rename never re-derives the slug (that
 * is the whole point of the name/slug division, and `ProjectFieldUpdate` makes it structural),
 * so a name with no derivable slug is perfectly storable on an existing row and refusing it
 * would be a constraint the database does not have.
 */
const addName = name.refine(
  (value) => slugForName(value) !== null,
  'Include at least one character from a–z or 0–9 in the name',
)

// Read from the shared constant rather than re-listing the five values: a sixth type must not
// become addable here without the database's `project_fields_type_check` agreeing.
const type = z.enum(CUSTOM_FIELD_TYPES)

export const AddFieldSchema = z.object({ name: addName, type })
export const RenameFieldSchema = z.object({ name })

export type AddFieldValues = z.input<typeof AddFieldSchema>
export type RenameFieldValues = z.input<typeof RenameFieldSchema>
