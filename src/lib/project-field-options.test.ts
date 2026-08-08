import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  countTicketsHoldingOption,
  createProjectFieldOption,
  deleteProjectFieldOption,
  listProjectFieldOptions,
  optionsForField,
  renameProjectFieldOption,
} from './project-field-options'
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

  // The schema trims at the form edge, but this function is the backstop for every OTHER
  // caller — same reasoning as createProjectField's trim. `pfo_label_nonempty` checks
  // `length(label) <= 40` on the STORED value, not a trimmed one, so an untrimmed label can
  // be wrongly rejected (or silently persisted with stray whitespace) if this trim ever goes
  // missing. Asserted EXACTLY, not with objectContaining, for the same reason as the
  // five-column test above.
  it('trims the label it sends', async () => {
    mockWrite({ ...LOW, slug: 'medium', label: 'Medium', position: 3 })
    await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: '  Medium  ',
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

// The update chain gets its OWN link functions past `.eq()`, for the same reason the insert
// chain does not reuse the read chain: `.update()` starts a different shape than `.select()`
// does. It no longer shares the insert chain's terminal `single` mock either — the rename now
// counts its own affected rows, so this chain ends in a bare `.select(...)` resolving an ARRAY,
// the same shape the delete chain below uses.
const updateSelect = vi.fn()
const eqUpdateSlug = vi.fn(() => ({ select: updateSelect }))
const eqUpdateField = vi.fn(() => ({ eq: eqUpdateSlug }))
const update = vi.fn(() => ({ eq: eqUpdateField }))

describe('renameProjectFieldOption', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReturnValue({ update } as never)
  })

  // This one assertion pins TWO properties at once: the payload carries `label` and NOTHING
  // else (the grant is column-scoped, so any other key is a 42501 a mocked test cannot see),
  // and the label is TRIMMED before it is sent — asserted EXACTLY, not with
  // `objectContaining`, the same discipline as `createProjectFieldOption`'s trim test.
  it('sends label ALONE, trimmed, filtered on both key columns', async () => {
    updateSelect.mockResolvedValue({ data: [{ ...LOW, label: 'Lowest' }], error: null })
    await renameProjectFieldOption('f1', 'low', '  Lowest  ')
    expect(update).toHaveBeenCalledWith({ label: 'Lowest' })
    expect(eqUpdateField).toHaveBeenCalledWith('field_id', 'f1')
    expect(eqUpdateSlug).toHaveBeenCalledWith('slug', 'low')
  })

  it('returns the renamed row when exactly one was updated', async () => {
    const renamed = { ...LOW, label: 'Lowest' }
    updateSelect.mockResolvedValue({ data: [renamed], error: null })
    await expect(renameProjectFieldOption('f1', 'low', 'Lowest')).resolves.toEqual({
      ok: true,
      value: renamed,
    })
  })

  // The explicit count, mirroring the delete's own `reports stale when no row was deleted`.
  // RLS FILTERS an update rather than raising on it, so a cross-tenant or already-deleted row
  // arrives here as `{ data: [], error: null }` — a SUCCESS. Without this check the function
  // depended on `.single()` happening to error on zero rows, which is a property of the
  // terminator rather than of any guard we wrote.
  it('reports stale when the update matched NO row, even with no error', async () => {
    updateSelect.mockResolvedValue({ data: [], error: null })
    await expect(renameProjectFieldOption('f1', 'low', 'Lowest')).resolves.toEqual({
      ok: false,
      error: 'stale',
    })
  })
})

// The delete chain gets its OWN link functions for the same reason: `.eq()` here terminates
// in `.select('slug')` rather than `.order()` or `.select().single()`, so sharing a mock with
// either other chain could only return one shape.
const deleteSelect = vi.fn()
const eqDeleteSlug = vi.fn(() => ({ select: deleteSelect }))
const eqDeleteField = vi.fn(() => ({ eq: eqDeleteSlug }))
const del = vi.fn(() => ({ eq: eqDeleteField }))

describe('deleteProjectFieldOption', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReturnValue({ delete: del } as never)
  })

  it('filters the delete on BOTH key columns, not field_id alone', async () => {
    deleteSelect.mockResolvedValue({ data: [{ slug: 'low' }], error: null })
    await deleteProjectFieldOption('f1', 'low')
    expect(eqDeleteField).toHaveBeenCalledWith('field_id', 'f1')
    expect(eqDeleteSlug).toHaveBeenCalledWith('slug', 'low')
  })

  it('reports stale when no row was deleted', async () => {
    deleteSelect.mockResolvedValue({ data: [], error: null })
    await expect(deleteProjectFieldOption('f1', 'low')).resolves.toEqual({
      ok: false,
      error: 'stale',
    })
  })

  it('succeeds when exactly one row was deleted', async () => {
    deleteSelect.mockResolvedValue({ data: [{ slug: 'low' }], error: null })
    await expect(deleteProjectFieldOption('f1', 'low')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
  })
})

// The count chain gets its OWN link functions: it reads `ticket_field_values`, not
// `project_field_options`, and terminates in a head-count response rather than rows.
const countEqSlug = vi.fn()
const countEqField = vi.fn(() => ({ eq: countEqSlug }))
const countSelect = vi.fn(() => ({ eq: countEqField }))

describe('countTicketsHoldingOption', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReturnValue({ select: countSelect } as never)
  })

  it('asks for an exact head count on both key columns', async () => {
    countEqSlug.mockResolvedValue({ count: 3, error: null })
    await expect(countTicketsHoldingOption('f1', 'low')).resolves.toBe(3)
    expect(countSelect).toHaveBeenCalledWith('*', { head: true, count: 'exact' })
    expect(countEqField).toHaveBeenCalledWith('field_id', 'f1')
    expect(countEqSlug).toHaveBeenCalledWith('value_option', 'low')
  })

  it('THROWS on error rather than reporting zero', async () => {
    countEqSlug.mockResolvedValue({ count: null, error: { message: 'boom' } })
    await expect(countTicketsHoldingOption('f1', 'low')).rejects.toThrow(
      'Could not count tickets holding that option: boom',
    )
  })

  it('THROWS on a MISSING count, which is not the same as zero', async () => {
    countEqSlug.mockResolvedValue({ count: null, error: null })
    await expect(countTicketsHoldingOption('f1', 'low')).rejects.toThrow()
  })
})
