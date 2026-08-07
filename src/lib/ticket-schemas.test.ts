import { describe, expect, it } from 'vitest'

import { CreateTicketSchema } from './ticket-schemas'

/**
 * Small and focused, per this module's docblock: `CreateTicketDialog.test.tsx` already
 * exercises this schema end to end through the rendered form, so this file covers only what
 * that suite cannot easily reach — the schema's own boundaries, and the `custom` record's three
 * distinct shapes — mirroring `status-schemas.test.ts` and `field-schemas.test.ts`.
 */
const base = { summary: 'Wire the board', type: 'story' as const }

describe('CreateTicketSchema', () => {
  it('requires a summary', () => {
    expect(CreateTicketSchema.safeParse({ ...base, summary: '' }).success).toBe(false)
  })

  // 200 is `CreateTicketDialog`'s own cap, not a database mirror. Pinned AT the boundary: 200
  // passes, 201 fails, so a one-sided test would not notice an off-by-one.
  it('accepts exactly 200 characters and rejects 201', () => {
    expect(CreateTicketSchema.safeParse({ ...base, summary: 'a'.repeat(200) }).success).toBe(true)
    expect(CreateTicketSchema.safeParse({ ...base, summary: 'a'.repeat(201) }).success).toBe(false)
  })

  it('accepts a whole-number story-points string and rejects a non-digit one', () => {
    expect(CreateTicketSchema.safeParse({ ...base, storyPoints: '13' }).success).toBe(true)
    expect(CreateTicketSchema.safeParse({ ...base, storyPoints: '1.5' }).success).toBe(false)
  })

  describe('custom', () => {
    it('accepts a form with no custom record at all', () => {
      expect(CreateTicketSchema.safeParse(base).success).toBe(true)
    })

    /**
     * The case this schema exists to get right, and `parseFieldValues`'s own "treats a
     * missing record entry as empty" test only covers the OTHER half of: an untouched
     * react-hook-form `Controller` registers its path with value `undefined`, not `''` and
     * not an absent key. If this rejected, `.parse()` would throw on submit for any project
     * with two-plus custom fields where only one was ever touched — reproduced live before
     * this schema's value type was corrected to `z.string().optional()`.
     */
    it('accepts a record entry whose value is explicitly undefined', () => {
      const result = CreateTicketSchema.safeParse({ ...base, custom: { 'f-1': undefined } })
      expect(result.success).toBe(true)
    })

    it('accepts a populated record of real string values', () => {
      const result = CreateTicketSchema.safeParse({
        ...base,
        custom: { 'f-1': 'ACME-1', 'f-2': '2026-08-07' },
      })
      expect(result.success).toBe(true)
    })
  })
})
