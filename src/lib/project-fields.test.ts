import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listProjectFields } from './project-fields'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// The one chain this module issues:
//
//   listProjectFields: from().select().eq().order().order()
//
// TWO `.order()` links, not one, and each gets its own mock so a test can say WHICH sort key
// it saw and in what order they were applied. Sharing one `order` mock would make
// `(created_at, slug)` and `(slug, created_at)` indistinguishable — and the second key is the
// tie-breaker that makes the sequence total, so losing it is precisely the defect worth
// catching.
const orderSlug = vi.fn()
const orderCreated = vi.fn(() => ({ order: orderSlug }))
const eq = vi.fn(() => ({ order: orderCreated }))
const select = vi.fn(() => ({ eq }))

function mockRows(data: unknown[] | null, error: { message: string } | null = null) {
  orderSlug.mockResolvedValue({ data, error })
}

const ROWS = [
  {
    id: 'f1',
    project_id: 'p1',
    slug: 'customer_ref',
    name: 'Customer ref',
    type: 'text',
    created_at: '2026-08-05T10:00:00Z',
  },
  {
    id: 'f2',
    project_id: 'p1',
    slug: 'due',
    name: 'Due',
    type: 'date',
    created_at: '2026-08-05T11:00:00Z',
  },
]

describe('listProjectFields', () => {
  beforeEach(() => {
    vi.mocked(supabase.from)
      .mockReset()
      .mockReturnValue({ select } as never)
    select.mockClear()
    eq.mockClear()
    orderCreated.mockClear()
    orderSlug.mockClear()
  })

  it("reads the project's own field rows", async () => {
    mockRows(ROWS)

    await expect(listProjectFields('p1')).resolves.toEqual(ROWS)

    expect(supabase.from).toHaveBeenCalledWith('project_fields')
    expect(eq).toHaveBeenCalledWith('project_id', 'p1')
  })

  /**
   * The class-closing assertion, and the reason this module names its columns at all.
   *
   * `listProjectStatuses` uses a bare `.select()` and SPRIN-86 measured the consequence: as
   * the first reader of `wip_limit`, narrowing that select left the whole suite green while
   * the board rendered `· limit undefined`. `project-statuses.test.ts`'s mock is
   * argument-agnostic (`vi.fn(() => ({ eq }))`), so it cannot see a narrowing at all.
   *
   * Asserting the EXACT string, not a substring: a substring match (`expect.stringContaining
   * ('type')`) would survive dropping `created_at`, which is one of the two sort keys.
   */
  it('names every column it reads, so a silent narrowing goes red', async () => {
    mockRows(ROWS)

    await listProjectFields('p1')

    expect(select).toHaveBeenCalledWith('id, project_id, slug, name, type, created_at')
  })

  it('orders by created_at and breaks ties on slug, in that order', async () => {
    mockRows(ROWS)

    await listProjectFields('p1')

    expect(orderCreated).toHaveBeenCalledWith('created_at', { ascending: true })
    expect(orderSlug).toHaveBeenCalledWith('slug', { ascending: true })
  })

  it('throws rather than resolving to an empty list when the read fails', async () => {
    mockRows(null, { message: 'permission denied for table project_fields' })

    // `[]` is what a project with no custom fields legitimately returns, and that is the
    // COMMON case here — so a read that swallowed its error into `[]` would render "No custom
    // fields yet." over a failure, which is S4.6's defect on the surface most prone to it.
    await expect(listProjectFields('p1')).rejects.toThrow(/Could not load custom fields/)
  })

  it('resolves to an empty list when the project genuinely has none', async () => {
    mockRows([])

    await expect(listProjectFields('p1')).resolves.toEqual([])
  })

  /**
   * The narrowing in `ProjectField` is a CLAIM about what the database returns, and a bare
   * `as ProjectField` would make it a lie the moment the column holds a value the union does
   * not. That is reachable rather than hypothetical: widening the CHECK constraint is a
   * one-line migration, and a client compiled before it would meet the new value.
   */
  it('rejects a row whose type is not one this client understands', async () => {
    mockRows([{ ...ROWS[0], type: 'checkbox' }])

    await expect(listProjectFields('p1')).rejects.toThrow(/Unrecognised custom field type/)
  })

  it('accepts every type the domain declares', async () => {
    mockRows([
      { ...ROWS[0], slug: 'a', type: 'text' },
      { ...ROWS[0], slug: 'b', type: 'paragraph' },
      { ...ROWS[0], slug: 'c', type: 'number' },
      { ...ROWS[0], slug: 'd', type: 'date' },
      { ...ROWS[0], slug: 'e', type: 'select' },
    ])

    await expect(listProjectFields('p1')).resolves.toHaveLength(5)
  })
})
