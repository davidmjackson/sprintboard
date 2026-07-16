import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  blockTicket,
  createTicket,
  deleteTicket,
  listTickets,
  parseBlockReason,
  unblockTicket,
} from './tickets'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// createTicket: from('tickets').insert(...).select().single()
// listTickets: from('tickets').select().eq(...).order(...)
// updateTicket / blockTicket / unblockTicket: from('tickets').update(...).eq(...).select().single()
// deleteTicket: from('tickets').delete().eq(...).select()
const single = vi.fn()
const order = vi.fn()
const eq = vi.fn(() => ({ order }))
const select = vi.fn(() => ({ eq }))
const del = vi.fn()
const update = vi.fn(() => ({ eq: () => ({ select: () => ({ single }) }) }))
beforeEach(() => {
  single.mockReset()
  order.mockReset()
  eq.mockReset()
  eq.mockReturnValue({ order })
  select.mockReset()
  select.mockReturnValue({ eq })
  del.mockReset()
  update.mockReset()
  update.mockReturnValue({ eq: () => ({ select: () => ({ single }) }) })
  vi.mocked(supabase.from).mockReset()
  vi.mocked(supabase.from).mockReturnValue({
    insert: () => ({ select: () => ({ single }) }),
    select,
    update,
    delete: () => ({ eq: () => ({ select: del }) }),
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

  it('selects every column, so the client-side row rules keep working', async () => {
    order.mockResolvedValue({ data: [], error: null })
    await listTickets('p1')
    // Narrowing this to an explicit column list looks like a harmless perf tidy-up and
    // is silently catastrophic: the returned rows are cast `as Ticket[]` unchecked, so a
    // dropped column arrives as `undefined` while TypeScript still swears it is there.
    // Drop `sprint_id` and `isBacklogTicket` (strict `=== null`) goes false for every
    // row — every project's Backlog renders empty, for ever, with no type error. Every
    // other test hand-builds its fixtures, so this assertion is the only thing standing
    // between that edit and a green suite. Same applies to `is_blocked`, `story_points`
    // and `assignee_id`, which the board and backlog rows read straight off the row.
    expect(select).toHaveBeenCalledWith()
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

describe('updateTicket', () => {
  it('returns the updated ticket on success', async () => {
    const ticket = {
      id: 't1',
      key: 'MP-1',
      number: 1,
      summary: 'Renamed',
      updated_at: '2026-07-15T00:00:01Z',
    }
    single.mockResolvedValue({ data: ticket, error: null })
    const { updateTicket } = await import('./tickets')
    expect(await updateTicket('t1', { summary: 'Renamed' })).toEqual({ ok: true, ticket })
  })

  it('maps any error to unknown', async () => {
    single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    const { updateTicket } = await import('./tickets')
    expect(await updateTicket('t1', { summary: 'x' })).toEqual({ ok: false, error: 'unknown' })
  })
})

describe('deleteTicket', () => {
  it('returns ok on a successful single-row delete', async () => {
    del.mockResolvedValue({ data: [{ id: 't1' }], error: null })
    expect(await deleteTicket('t1')).toEqual({ ok: true })
  })

  it('treats zero rows deleted (RLS filtered) as a failure, not silent success', async () => {
    del.mockResolvedValue({ data: [], error: null })
    expect(await deleteTicket('t1')).toEqual({ ok: false, error: 'unknown' })
  })

  it('maps a supabase error to unknown', async () => {
    del.mockResolvedValue({ data: null, error: { code: '42501', message: 'x' } })
    expect(await deleteTicket('t1')).toEqual({ ok: false, error: 'unknown' })
  })
})

describe('parseBlockReason', () => {
  it('rejects an empty reason — blocking requires one (S4.4 AC)', () => {
    expect(parseBlockReason('')).toEqual({ ok: false, message: expect.any(String) })
  })

  it('rejects a whitespace-only reason', () => {
    expect(parseBlockReason('   ')).toEqual({ ok: false, message: expect.any(String) })
  })

  it('accepts a reason and returns it trimmed', () => {
    expect(parseBlockReason('  waiting on API  ')).toEqual({ ok: true, value: 'waiting on API' })
  })

  it('rejects a reason longer than 500 characters', () => {
    expect(parseBlockReason('x'.repeat(501))).toEqual({ ok: false, message: expect.any(String) })
  })

  it('accepts a reason of exactly 500 characters', () => {
    const reason = 'x'.repeat(500)
    expect(parseBlockReason(reason)).toEqual({ ok: true, value: reason })
  })
})

describe('blockTicket', () => {
  it('sends is_blocked true with the trimmed reason and returns the row', async () => {
    const ticket = { id: 't1', is_blocked: true, blocked_reason: 'waiting on API' }
    single.mockResolvedValue({ data: ticket, error: null })
    expect(await blockTicket('t1', '  waiting on API  ')).toEqual({ ok: true, ticket })
    // Only these two fields are ever sent; blocked_since is trigger-owned.
    expect(update).toHaveBeenCalledWith({ is_blocked: true, blocked_reason: 'waiting on API' })
  })

  it('rejects an empty reason without touching the database', async () => {
    const result = await blockTicket('t1', '   ')
    expect(result).toEqual({ ok: false, error: 'invalid_reason', message: expect.any(String) })
    expect(update).not.toHaveBeenCalled()
  })

  it('maps a supabase error (e.g. RLS-filtered zero rows) to unknown', async () => {
    single.mockResolvedValue({ data: null, error: { code: 'PGRST116', message: 'no rows' } })
    expect(await blockTicket('t1', 'reason')).toEqual({ ok: false, error: 'unknown' })
  })
})

describe('unblockTicket', () => {
  it('sends is_blocked false (the trigger clears reason and since) and returns the row', async () => {
    const ticket = { id: 't1', is_blocked: false, blocked_reason: null, blocked_since: null }
    single.mockResolvedValue({ data: ticket, error: null })
    expect(await unblockTicket('t1')).toEqual({ ok: true, ticket })
    expect(update).toHaveBeenCalledWith({ is_blocked: false })
  })

  it('maps a supabase error to unknown', async () => {
    single.mockResolvedValue({ data: null, error: { code: '42501', message: 'x' } })
    expect(await unblockTicket('t1')).toEqual({ ok: false, error: 'unknown' })
  })
})
