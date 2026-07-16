import { describe, expect, it } from 'vitest'

import { formatSprintDate, toUtcMidnight } from './sprint-dates'

describe('toUtcMidnight', () => {
  it('pins an ISO date to midnight UTC', () => {
    expect(toUtcMidnight('2026-07-20')).toBe('2026-07-20T00:00:00.000Z')
  })

  it('pins a date the local zone would shift', () => {
    // 1 Jan is the classic off-by-one: in any zone west of UTC, local formatting of
    // midnight UTC lands on 31 Dec of the previous year.
    expect(toUtcMidnight('2026-01-01')).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('formatSprintDate', () => {
  it('renders the stored day, not a locale-shifted one', () => {
    expect(formatSprintDate('2026-07-20T00:00:00+00:00')).toBe('2026-07-20')
  })

  it('round-trips a typed day', () => {
    expect(formatSprintDate(toUtcMidnight('2026-01-01'))).toBe('2026-01-01')
  })

  it('renders the UTC day for a non-midnight timestamp', () => {
    expect(formatSprintDate('2026-07-20T23:30:00+00:00')).toBe('2026-07-20')
  })
})
