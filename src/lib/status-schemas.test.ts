import { describe, expect, it } from 'vitest'

import { STATUS_CATEGORIES } from './domain'
import { AddStatusSchema, RenameStatusSchema } from './status-schemas'

describe('AddStatusSchema', () => {
  it('accepts a name and a category', () => {
    expect(
      AddStatusSchema.safeParse({ name: 'Ready for QA', category: 'in_progress' }).success,
    ).toBe(true)
  })

  it('trims, so surrounding space cannot smuggle a name past the length rule', () => {
    const parsed = AddStatusSchema.parse({ name: '  Ready  ', category: 'todo' })
    expect(parsed.name).toBe('Ready')
  })

  it('rejects a name that is empty after trimming', () => {
    expect(AddStatusSchema.safeParse({ name: '   ', category: 'todo' }).success).toBe(false)
  })

  // 40 is project_statuses_name_nonempty's `length(name) <= 40`. Pinned AT the boundary:
  // 40 passes, 41 fails. A one-sided test would not notice an off-by-one.
  it('accepts exactly 40 characters and rejects 41', () => {
    expect(AddStatusSchema.safeParse({ name: 'a'.repeat(40), category: 'todo' }).success).toBe(true)
    expect(AddStatusSchema.safeParse({ name: 'a'.repeat(41), category: 'todo' }).success).toBe(
      false,
    )
  })

  it('rejects a category outside the three the check constraint allows', () => {
    expect(AddStatusSchema.safeParse({ name: 'QA', category: 'blocked' }).success).toBe(false)
  })

  // The three the check constraint DOES allow, read off the shared constant rather than
  // re-listed: a fourth category added to `STATUS_CATEGORIES` without the database's check
  // agreeing would sail through a hand-written list here.
  it('accepts every category in STATUS_CATEGORIES', () => {
    for (const category of STATUS_CATEGORIES) {
      expect(AddStatusSchema.safeParse({ name: 'QA', category }).success).toBe(true)
    }
  })
})

describe('RenameStatusSchema', () => {
  it('applies the same name rule', () => {
    expect(RenameStatusSchema.safeParse({ name: '' }).success).toBe(false)
    expect(RenameStatusSchema.safeParse({ name: 'In QA' }).success).toBe(true)
  })

  // The rename form has no category field. Sending one must not be able to smuggle a
  // category change through a call site that only means to rename.
  it('does not carry a category through', () => {
    const parsed = RenameStatusSchema.parse({ name: 'In QA', category: 'done' })
    expect(parsed).toEqual({ name: 'In QA' })
  })
})
