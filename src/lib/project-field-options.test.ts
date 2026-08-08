import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createProjectFieldOption, listProjectFieldOptions, optionsForField } from './project-field-options'
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

// The insert chain gets its OWN link functions rather than sharing the read's `select`. The
// chains diverge after the same method name — `.select()` returns `{ eq }` when it starts a
// read and `{ single }` when it terminates a write — so a shared mock could only return one
// of them, and a test asserting on it could not say which call it saw. Mirrors
// `project-fields.test.ts`.
const single = vi.fn()
const selectInsert = vi.fn(() => ({ single }))
const insert = vi.fn(() => ({ select: selectInsert }))

function mockWrite(data: unknown, error: { code?: string; message?: string } | null = null) {
  single.mockResolvedValue({ data, error })
}

describe('createProjectFieldOption', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReturnValue({ select, insert } as never)
  })

  it('sends exactly the five granted columns and no others', async () => {
    mockWrite({ ...LOW, slug: 'medium', label: 'Medium', position: 3 })
    await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Medium',
      existing: ROWS,
    })
    expect(insert).toHaveBeenCalledWith({
      project_id: 'p1',
      field_id: 'f1',
      slug: 'medium',
      label: 'Medium',
      position: 3,
    })
  })

  it('derives position as max(position) + 1', async () => {
    mockWrite(LOW)
    await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Medium',
      existing: [{ ...LOW, position: 7 }],
    })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ position: 8 }))
  })

  it('starts at position 1 when the field has no options', async () => {
    mockWrite(LOW)
    await createProjectFieldOption({ projectId: 'p1', fieldId: 'f1', label: 'Low', existing: [] })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ position: 1 }))
  })

  it('de-duplicates the slug against the options already held', async () => {
    mockWrite(LOW)
    await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Low',
      existing: ROWS,
    })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ slug: 'low_2' }))
  })

  it('sends NO request at all when no legal slug can be derived', async () => {
    const result = await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: '参照',
      existing: [],
    })
    expect(insert).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: 'unknown' })
  })

  it('reports a primary-key collision as stale', async () => {
    mockWrite(null, { code: '23505', message: 'duplicate key ... "project_field_options_pkey"' })
    const result = await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Low',
      existing: [],
    })
    expect(result).toEqual({ ok: false, error: 'stale' })
  })

  it('reports a DIFFERENT 23505 as unknown, not stale', async () => {
    mockWrite(null, { code: '23505', message: 'duplicate key ... "some_later_constraint"' })
    const result = await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Low',
      existing: [],
    })
    expect(result).toEqual({ ok: false, error: 'unknown' })
  })
})
