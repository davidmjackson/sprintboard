import { describe, expect, it } from 'vitest'

import { parseDeliverables } from './deliverables'

describe('parseDeliverables', () => {
  it('narrows a clean string array unchanged, preserving order', () => {
    expect(parseDeliverables(['Ship the API', 'Wire the UI', 'Write docs'])).toEqual([
      'Ship the API',
      'Wire the UI',
      'Write docs',
    ])
  })

  it('trims each item and drops blank / whitespace-only items', () => {
    expect(parseDeliverables(['  Ship  ', '', '   ', 'Wire'])).toEqual(['Ship', 'Wire'])
  })

  it('drops non-string items inside the array (defends the jsonb column)', () => {
    expect(parseDeliverables(['Ship', 3, null, { text: 'x' }, ['nested'], 'Wire'])).toEqual([
      'Ship',
      'Wire',
    ])
  })

  it('returns an empty array for the empty array', () => {
    expect(parseDeliverables([])).toEqual([])
  })

  it('returns an empty array for a non-array value (the DB default, null, junk)', () => {
    expect(parseDeliverables(null)).toEqual([])
    expect(parseDeliverables(undefined)).toEqual([])
    expect(parseDeliverables('Ship, Wire')).toEqual([])
    expect(parseDeliverables(42)).toEqual([])
    expect(parseDeliverables({ 0: 'Ship' })).toEqual([])
  })
})
