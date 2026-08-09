import { describe, expect, it } from 'vitest'

import { latestSprintEnd, suggestSprintDates } from './sprint-cadence'
import { SPRINT_LENGTH_WEEKS, SPRINT_WEEKDAYS, type Sprint } from './domain'

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    project_id: 'p1',
    name: 'Sprint 1',
    goal: null,
    status: 'future',
    start_date: null,
    end_date: null,
    created_at: '2026-07-16T00:00:00+00:00',
    ...overrides,
  }
}

/** 2026-07-13 is a Monday, so every weekday in July 2026 is one arithmetic step away. */
const MONDAY_CADENCE = { sprint_length_weeks: 2, sprint_start_weekday: 1 }

describe('latestSprintEnd', () => {
  it('is null for no sprints at all', () => {
    expect(latestSprintEnd([])).toBeNull()
  })

  it('is null when no sprint carries an end date', () => {
    expect(latestSprintEnd([sprint(), sprint({ id: 's2' })])).toBeNull()
  })

  it('takes the maximum across every status, not just the open ones', () => {
    // The completed sprint is the LATEST one. Skipping complete sprints would chain the
    // next sprint off the older future one and suggest a date in the past.
    const sprints = [
      sprint({ id: 's1', status: 'future', end_date: '2026-07-19T00:00:00+00:00' }),
      sprint({ id: 's2', status: 'complete', end_date: '2026-08-02T00:00:00+00:00' }),
      sprint({ id: 's3', status: 'active', end_date: null }),
    ]
    expect(latestSprintEnd(sprints)).toBe('2026-08-02')
  })

  it('compares UTC calendar days, not the raw timestamps', () => {
    // Same instant, two spellings, plus one late-evening timestamp: a lexical max over the
    // raw strings gets this wrong, a max over normalised days does not.
    const sprints = [
      sprint({ id: 's1', end_date: '2026-08-02T00:00:00Z' }),
      sprint({ id: 's2', end_date: '2026-08-01T23:30:00+00:00' }),
    ]
    expect(latestSprintEnd(sprints)).toBe('2026-08-02')
  })
})

describe('suggestSprintDates', () => {
  it('starts today when today is already the cadence weekday (AC2)', () => {
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2026-07-13' }),
    ).toEqual({ startDate: '2026-07-13', endDate: '2026-07-26' })
  })

  it('advances to the next cadence weekday after today (AC2)', () => {
    // Tuesday 14th -> the following Monday, six days on.
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2026-07-14' }),
    ).toEqual({ startDate: '2026-07-20', endDate: '2026-08-02' })
  })

  it('gives the FOLLOWING week when the latest end date is itself the cadence weekday (AC3)', () => {
    // Monday 13th ends the last sprint. Strictly after means Monday the 20th, never the 13th.
    expect(
      suggestSprintDates({
        cadence: MONDAY_CADENCE,
        latestEndDate: '2026-07-13',
        today: '2026-07-01',
      }),
    ).toEqual({ startDate: '2026-07-20', endDate: '2026-08-02' })
  })

  it('starts the very next day when the latest end date is the day before (AC3)', () => {
    expect(
      suggestSprintDates({
        cadence: MONDAY_CADENCE,
        latestEndDate: '2026-07-19',
        today: '2026-07-01',
      }),
    ).toEqual({ startDate: '2026-07-20', endDate: '2026-08-02' })
  })

  it('ignores today entirely once there is a latest end date', () => {
    // Today is far in the future; the chain still governs. Same answer as the case above.
    expect(
      suggestSprintDates({
        cadence: MONDAY_CADENCE,
        latestEndDate: '2026-07-19',
        today: '2027-01-01',
      }),
    ).toEqual({ startDate: '2026-07-20', endDate: '2026-08-02' })
  })

  it('chains with no gap and no overlap: the next start is the day after the last end', () => {
    // The product claim of the whole epic, asserted as a loop rather than believed.
    let latestEndDate: string | null = null
    const starts: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const suggestion = suggestSprintDates({
        cadence: MONDAY_CADENCE,
        latestEndDate,
        today: '2026-07-13',
      })
      starts.push(suggestion.startDate)
      latestEndDate = suggestion.endDate
    }
    expect(starts).toEqual(['2026-07-13', '2026-07-27', '2026-08-10', '2026-08-24'])
  })

  it.each(SPRINT_WEEKDAYS.map((w) => w.iso))(
    'lands on ISO weekday %i whatever day it is asked on',
    (weekday) => {
      // Every day of one full week as "today", against every cadence weekday: the start is
      // always on the cadence weekday, and never in the past.
      for (const today of [
        '2026-07-13',
        '2026-07-14',
        '2026-07-15',
        '2026-07-16',
        '2026-07-17',
        '2026-07-18',
        '2026-07-19',
      ]) {
        const { startDate } = suggestSprintDates({
          cadence: { sprint_length_weeks: 2, sprint_start_weekday: weekday },
          latestEndDate: null,
          today,
        })
        const day = new Date(`${startDate}T00:00:00.000Z`).getUTCDay()
        expect(day === 0 ? 7 : day).toBe(weekday)
        expect(startDate >= today).toBe(true)
      }
    },
  )

  it.each(SPRINT_LENGTH_WEEKS)('makes a %i-week sprint end inclusively (AC4)', (weeks) => {
    const { startDate, endDate } = suggestSprintDates({
      cadence: { sprint_length_weeks: weeks, sprint_start_weekday: 1 },
      latestEndDate: null,
      today: '2026-07-13',
    })
    expect(startDate).toBe('2026-07-13')
    const spanDays =
      (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) /
      86_400_000
    expect(spanDays).toBe(weeks * 7 - 1)
  })

  it('crosses a month boundary', () => {
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2026-07-27' }),
    ).toEqual({ startDate: '2026-07-27', endDate: '2026-08-09' })
  })

  it('crosses a year boundary', () => {
    // Monday 2026-12-28 + 13 days inclusive lands in 2027.
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2026-12-28' }),
    ).toEqual({ startDate: '2026-12-28', endDate: '2027-01-10' })
  })

  it('crosses 29 February in a leap year', () => {
    // 2028 is the next leap year. Monday 2028-02-21 + 13 days inclusive = 2028-03-05,
    // which is only right if 29 Feb exists.
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2028-02-21' }),
    ).toEqual({ startDate: '2028-02-21', endDate: '2028-03-05' })
  })
})
