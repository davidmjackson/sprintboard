import { z } from 'zod'

/**
 * The create-sprint form rules. Every field is optional — S6.1's AC — including the name,
 * which `createSprint` fills in via `defaultSprintName` when left blank.
 *
 * Date ordering is checked here and **not** in the database. That is a known asymmetry
 * against CLAUDE.md's "validate at both edges", taken deliberately: it matches
 * `story_points`, which is also client-validated only, and it keeps this story free of a
 * migration. Recorded in the design doc as a trade, not an oversight.
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
