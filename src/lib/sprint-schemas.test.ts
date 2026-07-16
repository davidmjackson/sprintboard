import { describe, expect, it } from 'vitest'

import { CreateSprintSchema } from './sprint-schemas'

const blank = { name: '', goal: '', startDate: '', endDate: '' }

describe('CreateSprintSchema', () => {
  it('accepts an entirely blank form — every field is optional', () => {
    expect(CreateSprintSchema.safeParse(blank).success).toBe(true)
  })

  it('accepts a start date with no end date', () => {
    expect(CreateSprintSchema.safeParse({ ...blank, startDate: '2026-07-20' }).success).toBe(true)
  })

  it('accepts an end date with no start date', () => {
    expect(CreateSprintSchema.safeParse({ ...blank, endDate: '2026-08-03' }).success).toBe(true)
  })

  it('accepts a well-ordered range', () => {
    const result = CreateSprintSchema.safeParse({
      ...blank,
      startDate: '2026-07-20',
      endDate: '2026-08-03',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a single-day sprint (end === start)', () => {
    const result = CreateSprintSchema.safeParse({
      ...blank,
      startDate: '2026-07-20',
      endDate: '2026-07-20',
    })
    expect(result.success).toBe(true)
  })

  it('rejects an end date before the start date, on the end field', () => {
    const result = CreateSprintSchema.safeParse({
      ...blank,
      startDate: '2026-08-03',
      endDate: '2026-07-20',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      const issue = result.error.issues[0]!
      expect(issue.path).toEqual(['endDate'])
      expect(issue.message).toBe('End date must not be before the start date')
    }
  })

  it('rejects a name longer than 80 characters', () => {
    const result = CreateSprintSchema.safeParse({ ...blank, name: 'x'.repeat(81) })
    expect(result.success).toBe(false)
  })
})
