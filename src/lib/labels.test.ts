import { describe, expect, it } from 'vitest'
import { parseLabels } from './labels'

describe('parseLabels', () => {
  it('splits on commas, trims, and drops blanks', () => {
    expect(parseLabels('ui, urgent ,')).toEqual(['ui', 'urgent'])
  })
  it('returns [] for undefined or empty', () => {
    expect(parseLabels(undefined)).toEqual([])
    expect(parseLabels('')).toEqual([])
  })
})
