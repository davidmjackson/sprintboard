import { describe, expect, it } from 'vitest'

import { CadenceSchema } from './cadence-schemas'
import { SPRINT_CADENCE_COLUMNS, SPRINT_LENGTH_WEEKS, SPRINT_WEEKDAYS } from './domain'

const LENGTH_MESSAGE = 'Choose a sprint length from the list.'
const DAY_MESSAGE = 'Choose a start day from the list.'

/** The messages, keyed by field, so a parse failure can be checked without repeating the
 *  flatten dance in eight tests. Returns `[]` for a field that raised nothing. */
function messagesFor(input: unknown, field: keyof typeof CadenceSchema.shape): string[] {
  const result = CadenceSchema.safeParse(input)
  if (result.success) return []
  return result.error.issues.filter((i) => i.path[0] === field).map((i) => i.message)
}

const VALID = { sprint_length_weeks: 2, sprint_start_weekday: 1 }

describe('CadenceSchema (SPRIN-97)', () => {
  /**
   * The keys are the granted columns, asserted against the SHARED constant rather than
   * re-listed. The schema has to spell its keys out — an object literal's keys cannot be
   * computed from an array and stay statically typed — so this is the assertion that keeps
   * the two from drifting. Sorted on both sides: the constant's ORDER is the picker's
   * business, not this schema's.
   */
  it('validates exactly the columns migration B grants', () => {
    expect(Object.keys(CadenceSchema.shape).sort()).toEqual([...SPRINT_CADENCE_COLUMNS].sort())
  })

  /**
   * The reason `z.coerce`/`transform` is here at all: a native `<select>` submits the DOM's
   * string, and both columns are `int`. Asserting the parsed VALUES, not just success —
   * a schema that passed the strings straight through would satisfy `success: true` and
   * send `'3'` to Postgres.
   */
  it('coerces the strings a <select> submits into numbers', () => {
    expect(CadenceSchema.parse({ sprint_length_weeks: '3', sprint_start_weekday: '5' })).toEqual({
      sprint_length_weeks: 3,
      sprint_start_weekday: 5,
    })
  })

  it('accepts the numbers a defaultValues prop supplies', () => {
    expect(CadenceSchema.parse(VALID)).toEqual({
      sprint_length_weeks: 2,
      sprint_start_weekday: 1,
    })
  })

  // Every offered option must survive its own schema. Driven from the constants, so a fifth
  // length or a renumbered weekday is covered the day it is added rather than the day someone
  // remembers to extend this list.
  it.each([...SPRINT_LENGTH_WEEKS])('accepts %i as a sprint length', (weeks) => {
    expect(CadenceSchema.parse({ ...VALID, sprint_length_weeks: String(weeks) })).toEqual({
      ...VALID,
      sprint_length_weeks: weeks,
    })
  })

  it.each([...SPRINT_WEEKDAYS])('accepts $label ($iso) as a start day', ({ iso }) => {
    expect(CadenceSchema.parse({ ...VALID, sprint_start_weekday: String(iso) })).toEqual({
      ...VALID,
      sprint_start_weekday: iso,
    })
  })

  /**
   * The boundaries on both sides of each range. `0` and `5` bracket the lengths, `0` and `8`
   * the weekdays — the values a `.min()/.max()` written one off would let through, and the
   * ones a membership check refuses for free.
   */
  it.each([0, 5, -1, 2.5])('refuses %s as a sprint length', (weeks) => {
    expect(messagesFor({ ...VALID, sprint_length_weeks: weeks }, 'sprint_length_weeks')).toEqual([
      LENGTH_MESSAGE,
    ])
  })

  it.each([0, 8, -1, 1.5])('refuses %s as a start day', (iso) => {
    expect(messagesFor({ ...VALID, sprint_start_weekday: iso }, 'sprint_start_weekday')).toEqual([
      DAY_MESSAGE,
    ])
  })

  /**
   * A non-numeric string reaches the SAME message as an out-of-range number, which is the
   * gain from transforming rather than coercing: `Number('sometimes')` is `NaN`, `NaN` is not
   * in the allowed list, and the refine explains itself. `z.coerce.number()` would have
   * failed the type check first and emitted zod's "expected number, received NaN".
   */
  it('refuses a non-numeric value with the same message as an out-of-range one', () => {
    expect(
      messagesFor({ ...VALID, sprint_length_weeks: 'fortnightly' }, 'sprint_length_weeks'),
    ).toEqual([LENGTH_MESSAGE])
  })

  it('refuses an empty submission rather than reading it as zero', () => {
    expect(messagesFor({ ...VALID, sprint_start_weekday: '' }, 'sprint_start_weekday')).toEqual([
      DAY_MESSAGE,
    ])
  })

  // Both fields are required. Neither column is nullable, and neither picker can be empty, so
  // an absent key is a caller bug rather than a user one — but it must not parse to NaN.
  it.each([['sprint_length_weeks'], ['sprint_start_weekday']] as const)(
    'refuses a submission missing %s',
    (field) => {
      const input = { ...VALID }
      delete (input as Record<string, unknown>)[field]
      expect(CadenceSchema.safeParse(input).success).toBe(false)
    },
  )
})
