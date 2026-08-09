import { z } from 'zod'

import { SPRINT_LENGTH_WEEKS, SPRINT_WEEKDAYS } from './domain'

/**
 * The cadence form's rules — the client edge of CLAUDE.md's validate-at-both-edges, against
 * `projects_sprint_length_weeks_range` (1–4) and `projects_sprint_start_weekday_range` (1–7).
 *
 * **Both fields are checked by MEMBERSHIP of the shared constants, never by a re-typed
 * `.min(1).max(4)`.** A range written here would be a second source for a bound the database
 * owns, free to drift from it in either direction — and the drift is silent, because the two
 * live in different languages and no test compares them. Membership cannot drift: the pickers
 * in `CadenceSettings` are built from the same two arrays, so the set this schema accepts and
 * the set the user can choose from are the same object.
 *
 * That is also why the messages do not ENUMERATE the accepted values ("1 to 4 weeks"). Copy
 * that recites a range is the same second source in prose, and it would go quietly false the
 * day `SPRINT_LENGTH_WEEKS` gains a fifth entry. Both messages are near-unreachable anyway: a
 * native `<select>` can only submit an option it rendered, so they fire for a direct caller
 * or a tampered DOM, where "choose from the list" is the whole of the useful advice.
 */

/**
 * The ISO weekday numbers, extracted once. `SPRINT_WEEKDAYS` carries labels the picker needs
 * and this schema does not, and mapping it per-parse would rebuild the same array on every
 * keystroke of every form.
 */
const WEEKDAY_ISOS: readonly number[] = SPRINT_WEEKDAYS.map((weekday) => weekday.iso)

/**
 * A number that must be one of `allowed`, accepting the string a DOM `<select>` submits.
 *
 * **`z.union([string, number]).transform(Number)` rather than `z.coerce.number()`, and the
 * reason is measured rather than stylistic.** In zod 4.4.3 a coerced schema declares its INPUT
 * type as `unknown`, so `z.input<typeof CadenceSchema>` would be `{ sprint_length_weeks:
 * unknown; … }`. That breaks the repo's own form pattern at the type level: `useForm<…Values>`
 * with `zodResolver` fails to compile (`Resolver<{ … unknown }>` is not assignable to
 * `Resolver<{ … number }>`), and `<select {...field}>` — how `AddStatusForm` renders every
 * picker — cannot take a `value` of `unknown`. Both were reproduced with `tsc` before this
 * shape was chosen. The union declares the honest input (`string | number`: a number from
 * `defaultValues`, a string from the change event) and coerces exactly the same way.
 *
 * A second, smaller gain: `Number('abc')` is `NaN`, which is not in `allowed`, so a
 * non-numeric value fails the REFINE and gets this message. Under `z.coerce.number()` it would
 * fail the type check first and surface zod's default "expected number, received NaN" — two
 * messages for what is, from the user's side, one mistake.
 */
function oneOf(allowed: readonly number[], message: string) {
  return z
    .union([z.string(), z.number()])
    .transform((value) => Number(value))
    .refine((value) => allowed.includes(value), message)
}

export const CadenceSchema = z.object({
  sprint_length_weeks: oneOf(SPRINT_LENGTH_WEEKS, 'Choose a sprint length from the list.'),
  sprint_start_weekday: oneOf(WEEKDAY_ISOS, 'Choose a start day from the list.'),
})

/**
 * The FORM's value type — `z.input`, matching `AddStatusValues` and `CreateSprintValues`
 * rather than the plan's `z.infer`. The two differ here where they do not for those two: this
 * schema transforms, so `z.infer` (the output) is the parsed `{ number, number }` and would
 * describe what `CadenceSchema.parse(values)` RETURNS, not what `useForm` holds. The parsed
 * result is structurally a `SprintCadence`, which is what `updateProjectCadence` takes, so it
 * needs no alias of its own.
 */
export type CadenceValues = z.input<typeof CadenceSchema>
