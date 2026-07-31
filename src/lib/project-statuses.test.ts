import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listProjectStatuses, statusName, statusOptions } from './project-statuses'
import type { ProjectStatus } from './domain'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// listProjectStatuses: from('project_statuses').select().eq(...).order(...)
const order = vi.fn()
const eq = vi.fn(() => ({ order }))
const select = vi.fn(() => ({ eq }))

beforeEach(() => {
  order.mockReset()
  eq.mockReset()
  eq.mockReturnValue({ order })
  select.mockReset()
  select.mockReturnValue({ eq })
  vi.mocked(supabase.from).mockReset()
  vi.mocked(supabase.from).mockReturnValue({ select } as never)
})

/** Deliberately NOT in position order, and NOT the seeded four: a fixture that already
 *  looks like the answer cannot prove the code produced it. */
const ROWS = [
  { slug: 'shipped', name: 'Shipped', category: 'done', position: 3 },
  { slug: 'triage', name: 'Triage', category: 'todo', position: 1 },
] as unknown as ProjectStatus[]

describe('listProjectStatuses', () => {
  it('reads this project only, ordered by position ascending', async () => {
    order.mockResolvedValue({ data: ROWS, error: null })

    await expect(listProjectStatuses('p1')).resolves.toEqual(ROWS)

    expect(supabase.from).toHaveBeenCalledWith('project_statuses')
    expect(eq).toHaveBeenCalledWith('project_id', 'p1')
    expect(order).toHaveBeenCalledWith('position', { ascending: true })
  })

  it('THROWS on error rather than resolving to [] — [] would read as "no statuses"', async () => {
    order.mockResolvedValue({ data: null, error: { message: 'boom' } })

    await expect(listProjectStatuses('p1')).rejects.toThrow(/Could not load statuses/)
  })
})

describe('statusName', () => {
  it('returns the row name for a known slug', () => {
    expect(statusName(ROWS, 'triage')).toBe('Triage')
  })

  // AC4. The fallback is the slug itself: never empty, never undefined, always identifying.
  it('falls back to the slug itself for a status it has never seen', () => {
    expect(statusName(ROWS, 'mystery')).toBe('mystery')
  })

  it('falls back when the list is empty, rather than throwing', () => {
    expect(statusName([], 'triage')).toBe('triage')
  })
})

describe('statusOptions', () => {
  it('maps the rows in the order given, without resorting them', () => {
    expect(statusOptions(ROWS, 'triage')).toEqual([
      { slug: 'shipped', name: 'Shipped' },
      { slug: 'triage', name: 'Triage' },
    ])
  })

  // A <select> whose value matches no <option> renders BLANK, and the next change event
  // would move the ticket somewhere the user never chose.
  it('appends the current status when it is not in the list, so the select stays controlled', () => {
    expect(statusOptions(ROWS, 'mystery')).toEqual([
      { slug: 'shipped', name: 'Shipped' },
      { slug: 'triage', name: 'Triage' },
      { slug: 'mystery', name: 'mystery' },
    ])
  })

  it('does not duplicate the current status when it IS in the list', () => {
    expect(statusOptions(ROWS, 'shipped')).toHaveLength(2)
  })
})
