import { formatSprintDate } from './sprint-dates'
import type { Sprint, SprintCadence } from './domain'

/**
 * The suggested dates for a project's next sprint: ISO calendar days, in the shape an
 * `<input type="date">` holds.
 *
 * Pure and clock-free by construction — `today` is a parameter — so every rule below is a
 * table test rather than something that depends on the day the suite runs.
 */
export type SprintDateSuggestion = { startDate: string; endDate: string }

/** A calendar day plus `days`, via UTC so month, year and leap-day rollover are the
 *  platform's problem. Never a local-timezone accessor: that is the bug `sprint-dates.ts`
 *  exists to design out. */
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** 1 = Monday … 7 = Sunday, matching Postgres `isodow` and `SPRINT_WEEKDAYS`. `getUTCDay`
 *  returns 0 for Sunday, and this is the single place that difference is reconciled. */
function isoWeekday(isoDate: string): number {
  const day = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay()
  return day === 0 ? 7 : day
}

/**
 * The latest `end_date` across ALL of a project's sprints — future, active and complete
 * alike — as a UTC calendar day, or null if none has one.
 *
 * Every status counts. Skipping complete sprints would chain the next sprint off an older
 * one and suggest a date in the past, which is the manual arithmetic this story removes.
 *
 * Each value goes through `formatSprintDate` BEFORE comparison. A raw `timestamptz` is not
 * lexically comparable — `'…T00:00:00+00:00'` and `'…Z'` are the same instant and different
 * strings — but a UTC calendar day is, exactly.
 */
export function latestSprintEnd(sprints: readonly Sprint[]): string | null {
  return sprints.reduce<string | null>((latest, sprint) => {
    if (!sprint.end_date) return latest
    const day = formatSprintDate(sprint.end_date)
    return latest === null || day > latest ? day : latest
  }, null)
}

/**
 * Where the project's next sprint should start and end, given its cadence.
 *
 * ONE rule, with no branch between "no sprints yet" and "chained onto the last one":
 *
 *   candidate = latestEndDate + 1 day, or today when there is none
 *   start     = the first day, candidate included, on the cadence weekday
 *   end       = start + length × 7 − 1 days
 *
 * The `+ 1 day` is what makes AC3's *strictly after* fall out of the arithmetic rather than
 * out of a comparison someone can get backwards: a latest end date that is itself the cadence
 * weekday yields the FOLLOWING week, never the same day.
 *
 * The end date is INCLUSIVE, hence `− 1`. That is load-bearing rather than cosmetic: it is
 * what makes the next sprint's candidate land exactly on the cadence weekday, so consecutive
 * sprints chain with no gap and no overlap. An exclusive end would push every sprint after
 * the first a week late, and only the SECOND sprint a project creates would show it.
 *
 * The double modulo is not superstition: `%` in JavaScript keeps the sign of the dividend, so
 * a cadence weekday below the candidate's would otherwise give a negative offset and a start
 * date in the past.
 *
 * No range guard on the cadence: the database constrains 1–4 and 1–7, the settings form offers
 * nothing else, and `Project` makes both fields non-optional — so every value that can actually
 * reach here is total: it cannot throw or loop. (It is not total for an arbitrary integer — a
 * `sprint_length_weeks` above roughly 1.43e7 pushes the end date past what `Date` can represent
 * and throws, as do `NaN`/`undefined` in either field — but no path a real user can take
 * supplies one.) A bad in-range value shows as a visibly wrong date rather than a dialog that
 * will not open. Unlike `cadenceSummary`, there is no honest fallback to render here; inventing
 * one would only disguise the input.
 */
export function suggestSprintDates(input: {
  cadence: SprintCadence
  latestEndDate: string | null
  today: string
}): SprintDateSuggestion {
  const candidate = input.latestEndDate ? addDays(input.latestEndDate, 1) : input.today
  const offset = (((input.cadence.sprint_start_weekday - isoWeekday(candidate)) % 7) + 7) % 7
  const startDate = addDays(candidate, offset)
  return { startDate, endDate: addDays(startDate, input.cadence.sprint_length_weeks * 7 - 1) }
}
