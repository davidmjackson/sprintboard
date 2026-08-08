import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listProjectFieldOptions, optionsForField } from './project-field-options'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// TWO `.order()` links, not one, and each gets its OWN mock so a test can say WHICH sort key
// it saw and in what order they were applied. Sharing one `order` mock would make
// `(position, slug)` and `(slug, position)` indistinguishable — and `slug` is the tie-breaker
// that makes the sequence total, so losing it is precisely the defect worth catching. Mirrors
// the `(created_at, slug)` guard in `project-fields.test.ts`.
const orderSlug = vi.fn()
const orderPosition = vi.fn(() => ({ order: orderSlug }))
const eq = vi.fn(() => ({ order: orderPosition }))
const select = vi.fn(() => ({ eq }))

function mockRows(data: unknown[] | null, error: { message: string } | null = null) {
  orderSlug.mockResolvedValue({ data, error })
}

// Named individually, not just indexed off `ROWS`: `noUncheckedIndexedAccess` types
// `ROWS[0]` as possibly `undefined`, which `optionsForField`'s expected-array literal below
// cannot accept.
const LOW = { project_id: 'p1', field_id: 'f1', slug: 'low', label: 'Low', position: 1 }
const HIGH = { project_id: 'p1', field_id: 'f1', slug: 'high', label: 'High', position: 2 }
const ROWS = [LOW, HIGH]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(supabase.from).mockReturnValue({ select } as never)
})

describe('listProjectFieldOptions', () => {
  it('names its columns explicitly rather than issuing a bare select', async () => {
    mockRows(ROWS)
    await listProjectFieldOptions('p1')
    expect(select).toHaveBeenCalledWith('project_id, field_id, slug, label, position')
  })

  it('filters by project and orders by position then slug', async () => {
    mockRows(ROWS)
    await listProjectFieldOptions('p1')
    expect(eq).toHaveBeenCalledWith('project_id', 'p1')
    expect(orderPosition).toHaveBeenCalledWith('position', { ascending: true })
    expect(orderSlug).toHaveBeenCalledWith('slug', { ascending: true })
  })

  it('returns the rows', async () => {
    mockRows(ROWS)
    await expect(listProjectFieldOptions('p1')).resolves.toEqual(ROWS)
  })

  it('THROWS on error rather than resolving to an empty list', async () => {
    mockRows(null, { message: 'boom' })
    await expect(listProjectFieldOptions('p1')).rejects.toThrow(
      'Could not load field options: boom',
    )
  })
})

describe('optionsForField', () => {
  it('keeps only the named field and preserves the query order', () => {
    const other = { project_id: 'p1', field_id: 'f2', slug: 'a', label: 'A', position: 1 }
    expect(optionsForField([LOW, other, HIGH], 'f1')).toEqual([LOW, HIGH])
  })
})
