import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDecomposition } from './ticket-decomposition'
import * as ai from './ai'
import type { DecomposeProposal } from './ai'
import * as tickets from './tickets'
import type { CreateTicketResult } from './tickets'
import type { Ticket } from './domain'

vi.mock('./ai', () => ({ decomposeEpic: vi.fn() }))
vi.mock('./tickets', () => ({ createTicket: vi.fn() }))
const decomposeEpic = vi.mocked(ai.decomposeEpic)
const createTicket = vi.mocked(tickets.createTicket)

const epic = {
  id: 'e1',
  project_id: 'p1',
  type: 'epic',
  summary: 'The epic',
  context: 'Some context',
  deliverables: ['A', 'B'],
} as unknown as Ticket

const proposal: DecomposeProposal = {
  title: 'Story one',
  type: 'story',
  description: 'Do the thing',
  rationale: 'Because',
  covers: [0],
  estimate: 3,
  estimate_reason: 'Small',
}

beforeEach(() => {
  decomposeEpic.mockReset()
  createTicket.mockReset()
})

describe('useDecomposition', () => {
  it('stores the proposals and selects them all by default', async () => {
    decomposeEpic.mockResolvedValue({
      ok: true,
      proposals: [proposal, { ...proposal, title: 'Story two' }],
      coverage_gaps: [{ index: 1, deliverable: 'B' }],
      scope_creep: [],
      estimate_total: 5,
    })

    const { result } = renderHook(() => useDecomposition({ ticket: epic }))
    await act(async () => {
      await result.current.runDecompose()
    })

    expect(result.current.proposals).toHaveLength(2)
    expect([...result.current.selected]).toEqual([0, 1])
    expect(result.current.estimateTotal).toBe(5)
    expect(result.current.coverageGaps).toHaveLength(1)
  })

  it('reset clears the trace but deliberately keeps aiError', async () => {
    decomposeEpic.mockResolvedValue({
      ok: true,
      proposals: [proposal],
      coverage_gaps: [{ index: 1, deliverable: 'B' }],
      scope_creep: [{ proposal_index: 0, title: 'Story one' }],
      estimate_total: 5,
    })
    const { result } = renderHook(() => useDecomposition({ ticket: epic }))
    await act(async () => {
      await result.current.runDecompose()
    })

    // Force an error to sit alongside a live trace. A failed run sets aiError and returns
    // WITHOUT touching the trace, so the successful run's proposals are still on screen.
    decomposeEpic.mockResolvedValue({ ok: false, error: 'unauthenticated' })
    await act(async () => {
      await result.current.runDecompose()
    })
    expect(result.current.aiError).toBe('Your session expired — sign in again.')
    expect(result.current.proposals).toHaveLength(1)

    act(() => {
      result.current.reset()
    })

    expect(result.current.proposals).toBeNull()
    expect(result.current.selected.size).toBe(0)
    expect(result.current.coverageGaps).toEqual([])
    expect(result.current.scopeCreep).toEqual([])
    expect(result.current.estimateTotal).toBe(0)
    // The point of this test: reset drops the trace and NOTHING else. An AI error survives
    // a deliverables write today, and this refactor changes no behaviour.
    expect(result.current.aiError).toBe('Your session expired — sign in again.')
  })

  it('distinguishes an expired session from an unreachable service', async () => {
    const { result } = renderHook(() => useDecomposition({ ticket: epic }))

    decomposeEpic.mockResolvedValue({ ok: false, error: 'unauthenticated' })
    await act(async () => {
      await result.current.runDecompose()
    })
    expect(result.current.aiError).toBe('Your session expired — sign in again.')

    decomposeEpic.mockResolvedValue({ ok: false, error: 'request_failed' })
    await act(async () => {
      await result.current.runDecompose()
    })
    expect(result.current.aiError).toBe('Could not reach the AI service. Is it running?')
  })

  it('toggles a proposal off and creates only the still-selected one', async () => {
    decomposeEpic.mockResolvedValue({
      ok: true,
      proposals: [proposal, { ...proposal, title: 'Story two' }],
      coverage_gaps: [],
      scope_creep: [],
      estimate_total: 6,
    })
    createTicket.mockResolvedValue({ ok: true, ticket: { id: 'c1' } as Ticket })
    const onTicketsCreated = vi.fn()

    const { result } = renderHook(() => useDecomposition({ ticket: epic, onTicketsCreated }))
    await act(async () => {
      await result.current.runDecompose()
    })
    expect([...result.current.selected]).toEqual([0, 1])

    act(() => {
      result.current.toggle(1, false)
    })
    expect([...result.current.selected]).toEqual([0])

    await act(async () => {
      await result.current.acceptSelected()
    })

    // Only the still-selected proposal (index 0) was created; the toggled-off one (index 1)
    // never reached createTicket.
    expect(createTicket).toHaveBeenCalledTimes(1)
    expect(onTicketsCreated).toHaveBeenCalledWith([{ id: 'c1' }])
    expect(result.current.proposals).toBeNull()
  })

  it('clears the panel and reports an error when a selected proposal fails to create', async () => {
    decomposeEpic.mockResolvedValue({
      ok: true,
      proposals: [proposal, { ...proposal, title: 'Story two' }],
      coverage_gaps: [],
      scope_creep: [],
      estimate_total: 6,
    })
    createTicket
      .mockResolvedValueOnce({ ok: true, ticket: { id: 'c1' } as Ticket })
      .mockResolvedValueOnce({ ok: false, error: 'unknown' })
    const onTicketsCreated = vi.fn()

    const { result } = renderHook(() => useDecomposition({ ticket: epic, onTicketsCreated }))
    await act(async () => {
      await result.current.runDecompose()
    })
    await act(async () => {
      await result.current.acceptSelected()
    })

    expect(onTicketsCreated).toHaveBeenCalledWith([{ id: 'c1' }])
    // Panel cleared regardless, so a re-click cannot duplicate the ticket that succeeded.
    expect(result.current.proposals).toBeNull()
    expect(result.current.aiError).toBe(
      'Some tickets could not be created. The ones that succeeded were added to the backlog.',
    )
  })

  // `accepting` is the ONLY thing standing between a double-click on Accept and duplicate
  // child tickets, so it needs its own assertion: deleting `setAccepting(true)` from
  // `acceptProposals` leaves every other test in this file green. Same defect shape the
  // block flow's `setPending(true)` had. A deferred `createTicket` holds the loop open so
  // the mid-flight value is observable.
  it('sets accepting for the duration of the accept, then clears it', async () => {
    decomposeEpic.mockResolvedValue({
      ok: true,
      proposals: [proposal],
      coverage_gaps: [],
      scope_creep: [],
      estimate_total: 3,
    })
    const { result } = renderHook(() => useDecomposition({ ticket: epic }))
    await act(async () => {
      await result.current.runDecompose()
    })
    expect(result.current.accepting).toBe(false)

    let resolveCreate: (value: CreateTicketResult) => void = () => {}
    createTicket.mockReturnValue(new Promise<CreateTicketResult>((r) => (resolveCreate = r)))

    let accepted: Promise<void> = Promise.resolve()
    act(() => {
      accepted = result.current.acceptSelected()
    })
    expect(result.current.accepting).toBe(true) // in flight

    await act(async () => {
      resolveCreate({ ok: true, ticket: { id: 'c1' } as Ticket })
      await accepted
    })
    expect(result.current.accepting).toBe(false) // settled
  })

  it('does nothing for a null ticket: neither decomposeEpic nor createTicket are called', async () => {
    const { result } = renderHook(() => useDecomposition({ ticket: null }))

    await act(async () => {
      await result.current.runDecompose()
    })
    await act(async () => {
      await result.current.acceptSelected()
    })

    expect(decomposeEpic).not.toHaveBeenCalled()
    expect(createTicket).not.toHaveBeenCalled()
  })

  it('passes the epic summary, context and parsed deliverables to the model', async () => {
    decomposeEpic.mockResolvedValue({
      ok: true,
      proposals: [],
      coverage_gaps: [],
      scope_creep: [],
      estimate_total: 0,
    })
    const { result } = renderHook(() => useDecomposition({ ticket: epic }))
    await act(async () => {
      await result.current.runDecompose()
    })

    expect(decomposeEpic).toHaveBeenCalledWith({
      summary: 'The epic',
      context: 'Some context',
      deliverables: ['A', 'B'],
    })
  })
})
