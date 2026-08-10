import { z } from 'zod'

/**
 * The create-sprint form rules. Every field is optional — S6.1's AC — including the name,
 * which `createSprint` fills in via `defaultSprintName` when left blank.
 *
 * Date ordering is checked at **both** edges, as CLAUDE.md requires. SPRIN-95 added the
 * database half: `sprints_end_not_before_start`, a check constraint on `sprints` proven live
 * in `src/test/sprints.integration.test.ts`. This `refine` is not a duplicate of it — it is
 * what stops a user ever *seeing* the database's error, because `CreateSprintDialog` never
 * submits a form this rejects, which is why `createSprint` has no branch for `23514`.
 *
 * The two comparisons agree because both operands are written at UTC midnight by
 * `toUtcMidnight`, so instant order (what the constraint compares) and calendar-day order
 * (what this compares) coincide for every value the app can produce. A same-day sprint is
 * legal at both edges: both use `>=`.
 *
 * The comparison is a plain string compare because both values are ISO `YYYY-MM-DD` from
 * `<input type="date">`, which sorts lexically in date order. No Date parsing, so no
 * timezone enters the validation path at all.
 */
export const CreateSprintSchema = z
  .object({
    name: z.string().trim().max(80, 'Keep the name to 80 characters or fewer').optional(),
    goal: z.string().trim().max(500, 'Keep the goal to 500 characters or fewer').optional(),
    startDate: z.string().optional(),
    endDate: z.string().optional(),
  })
  .refine((v) => !v.startDate || !v.endDate || v.endDate >= v.startDate, {
    message: 'End date must not be before the start date',
    // Reported on the end field: it is the one the user most likely mistyped, and an
    // error with no path renders as a form-level message with nothing to point at.
    path: ['endDate'],
  })

export type CreateSprintValues = z.input<typeof CreateSprintSchema>
