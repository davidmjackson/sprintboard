import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createTicket, listTickets } from './tickets'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// createTicket: from('tickets').insert(...).select().single()
// listTickets: from('tickets').select().eq(...).order(...)
const single = vi.fn()
const order = vi.fn()
const eq = vi.fn(() => ({ order }))
beforeEach(() => {
  single.mockReset()
  order.mockReset()
  eq.mockReset()
  eq.mockReturnValue({ order })
  vi.mocked(supabase.from).mockReturnValue({
    insert: () => ({ select: () => ({ single }) }),
    select: () => ({ eq }),
  } as unknown as ReturnType<typeof supabase.from>)
})

const input = { projectId: 'p1', summary: 'Wire the board', type: 'story' as const }

describe('createTicket', () => {
  it('returns the created ticket on success', async () => {
    const ticket = { id: 't1', key: 'MP-1', number: 1, status: 'todo' }
    single.mockResolvedValue({ data: ticket, error: null })
    expect(await createTicket(input)).toEqual({ ok: true, ticket })
  })

  it('maps any error to unknown', async () => {
    single.mockResolvedValue({ data: null, error: { code: '23514', message: 'x' } })
    expect(await createTicket(input)).toEqual({ ok: false, error: 'unknown' })
  })
})

describe('listTickets', () => {
  it("returns the project's tickets, scoped by project_id and ordered by number", async () => {
    const tickets = [{ id: 't1' }, { id: 't2' }]
    order.mockResolvedValue({ data: tickets, error: null })
    expect(await listTickets('p1')).toEqual(tickets)
    // The filter is load-bearing: without it RLS still returns EVERY project the owner
    // has. Assert it, so a regression to `.eq('id', …)` or a dropped order fails here.
    expect(eq).toHaveBeenCalledWith('project_id', 'p1')
    expect(order).toHaveBeenCalledWith('number', { ascending: true })
  })

  it('returns an empty array when there are none', async () => {
    order.mockResolvedValue({ data: null, error: null })
    expect(await listTickets('p1')).toEqual([])
  })

  it('throws on a query error', async () => {
    order.mockResolvedValue({ data: null, error: { message: 'network' } })
    await expect(listTickets('p1')).rejects.toThrow(/Could not load tickets/)
  })
})
