/**
 * Sprint dates are **calendar days** stored in `timestamptz` columns. Both directions are
 * pinned to UTC so the day a user types is the day every user reads.
 *
 * The trap this avoids: a `timestamptz` of midnight UTC, formatted in a local zone west of
 * UTC, renders as the PREVIOUS day. Because the display format is ISO (S6.1's chosen
 * format), there is no reformatting step at all — we slice the UTC ISO string. No `Intl`,
 * no locale, no local-timezone code path to get wrong. The hazard is designed out rather
 * than guarded against, and these tests do not depend on the machine's timezone.
 */

/** `'2026-07-20'` (an `<input type="date">` value) → `'2026-07-20T00:00:00.000Z'`. */
export function toUtcMidnight(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00.000Z`).toISOString()
}

/** A `timestamptz` from the database → the ISO calendar day it falls on **in UTC**. */
export function formatSprintDate(timestamptz: string): string {
  return new Date(timestamptz).toISOString().slice(0, 10)
}
