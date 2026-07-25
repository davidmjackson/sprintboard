import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import { pickFields, useTicketCommit } from './ticket-commit'
import * as tickets from './tickets'
import type { UpdateTicketResult } from './tickets'
import type { Ticket } from './domain'

vi.mock('./tickets', () => ({ updateTicket: vi.fn() }))
const updateTicket = vi.mocked(tickets.updateTicket)

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    summary: 'Original summary',
    description: 'Original description',
    story_points: 3,
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Ticket
}

/** The ticket handed to the nth `onUpdated` call (negative indexes count from the end).
 *  `noUncheckedIndexedAccess` makes a raw `mock.calls[n][0]` "possibly undefined", so the
 *  assertion lives here once — and fails with a useful message rather than a TypeError. */
function nthTicket(onUpdated: Mock, n: number): Ticket {
  const call = onUpdated.mock.calls.at(n)
  if (!call) throw new Error(`onUpdated has no call at index ${n}`)
  return call[0] as Ticket
}

beforeEach(() => {
  updateTicket.mockReset()
})

describe('pickFields', () => {
  it('copies only the named keys', () => {
    expect(pickFields({ a: 1, b: 2, c: 3 }, ['a', 'c'])).toEqual({ a: 1, c: 3 })
  })
})

describe('useTicketCommit', () => {
  it('applies the patch optimistically, then reconciles only the changed fields plus updated_at', async () => {
    const ticket = makeTicket()
    const onUpdated = vi.fn()
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: makeTicket({ summary: 'Server summary', description: 'CLOBBER', updated_at: 'T2' }),
    })

    const { result } = renderHook(() => useTicketCommit({ ticket, onUpdated }))
    await act(async () => {
      await result.current.commit({ summary: 'New summary' })
    })

    // Optimistic first.
    expect(onUpdated).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ summary: 'New summary' }),
    )
    // Reconcile takes summary + updated_at from the server row, but NOT description —
    // swapping in the whole row would clobber a concurrent edit to another field.
    const reconciled = nthTicket(onUpdated, 1)
    expect(reconciled.summary).toBe('Server summary')
    expect(reconciled.updated_at).toBe('T2')
    expect(reconciled.description).toBe('Original description')
  })

  it('reverts only the fields the failed commit changed, and surfaces an error', async () => {
    const onUpdated = vi.fn()
    let resolve: (value: UpdateTicketResult) => void = () => {}
    updateTicket.mockReturnValue(new Promise((r) => (resolve = r)))

    const { result, rerender } = renderHook(
      (props: { ticket: Ticket }) => useTicketCommit({ ticket: props.ticket, onUpdated }),
      { initialProps: { ticket: makeTicket() } },
    )

    let committed: Promise<boolean> = Promise.resolve(false)
    act(() => {
      committed = result.current.commit({ summary: 'New summary' })
    })

    // Feed the optimistic value back in, as the parent (ProjectShell) does: `onUpdated`
    // lifts it into parent state, which re-renders us with it. Without this the hook's
    // `ticketRef` still holds the PRE-change ticket at failure time, `base` already carries
    // `summary: 'Original summary'`, and `{ ...base, ...revert }` is byte-identical to
    // `{ ...base }` — so the revert would be unobservable and this test could not fail.
    // The concurrent `description` edit is here for the same reason: it is what distinguishes
    // a FIELD-SCOPED revert from a whole-ticket one, which would clobber it.
    rerender({
      ticket: makeTicket({ summary: 'New summary', description: 'Concurrent description' }),
    })

    await act(async () => {
      resolve({ ok: false, error: 'unknown' })
      await committed
    })

    const reverted = nthTicket(onUpdated, -1)
    expect(reverted.summary).toBe('Original summary') // the failed write's field, rolled back
    expect(reverted.description).toBe('Concurrent description') // untouched by this commit
    expect(result.current.error).toBe('Could not save your change. Please try again.')
    await expect(committed).resolves.toBe(false)
  })

  it('bails without reconciling once the instance has unmounted (Ultracode Critical)', async () => {
    const ticket = makeTicket()
    const onUpdated = vi.fn()
    let resolve: (value: UpdateTicketResult) => void = () => {}
    updateTicket.mockReturnValue(new Promise((r) => (resolve = r)))

    const { result, unmount } = renderHook(() => useTicketCommit({ ticket, onUpdated }))
    let committed: Promise<boolean> = Promise.resolve(false)
    act(() => {
      committed = result.current.commit({ summary: 'New summary' })
    })
    expect(onUpdated).toHaveBeenCalledTimes(1) // the optimistic call

    unmount()
    await act(async () => {
      resolve({ ok: true, ticket: makeTicket({ summary: 'Server summary' }) })
      await committed
    })

    // No second call: the reconcile would clobber the fresh instance's edits.
    expect(onUpdated).toHaveBeenCalledTimes(1)
    await expect(committed).resolves.toBe(false)
  })

  it('falls back to the commit-time ticket when the live ref has moved to another ticket', async () => {
    const onUpdated = vi.fn()
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: makeTicket({ id: 't1', summary: 'Server summary', updated_at: 'T2' }),
    })

    const { result, rerender } = renderHook(
      (props: { ticket: Ticket }) => useTicketCommit({ ticket: props.ticket, onUpdated }),
      { initialProps: { ticket: makeTicket({ id: 't1' }) } },
    )
    rerender({ ticket: makeTicket({ id: 't1' }) })

    let committed: Promise<boolean> = Promise.resolve(false)
    act(() => {
      committed = result.current.commit({ summary: 'New summary' })
    })
    // The dialog switches to a DIFFERENT ticket while the save is in flight.
    rerender({ ticket: makeTicket({ id: 't2', summary: 'Other ticket' }) })
    await act(async () => {
      await committed
    })

    // Merging onto the live ref would emit a wrong-identity object; it must use t1.
    const reconciled = nthTicket(onUpdated, -1)
    expect(reconciled.id).toBe('t1')
  })

  it('scopes the error to its ticket id, so it does not surface on a different ticket', () => {
    const onUpdated = vi.fn()
    const { result, rerender } = renderHook(
      (props: { ticket: Ticket }) => useTicketCommit({ ticket: props.ticket, onUpdated }),
      { initialProps: { ticket: makeTicket({ id: 't1' }) } },
    )
    rerender({ ticket: makeTicket({ id: 't1' }) })

    act(() => {
      result.current.setError('t1', 'Boom')
    })
    expect(result.current.error).toBe('Boom')

    rerender({ ticket: makeTicket({ id: 't2' }) })
    expect(result.current.error).toBeNull()
  })

  it('applyServerRow reconciles only the named keys onto the latest ticket', () => {
    const ticket = makeTicket({ id: 't1' })
    const onUpdated = vi.fn()
    const { result } = renderHook(() => useTicketCommit({ ticket, onUpdated }))

    const serverRow = makeTicket({
      id: 't1',
      is_blocked: true,
      blocked_reason: 'waiting',
      blocked_since: 'S',
      summary: 'CLOBBER',
      updated_at: 'T2',
    })
    act(() => {
      result.current.applyServerRow('t1', serverRow, [
        'is_blocked',
        'blocked_reason',
        'blocked_since',
      ])
    })

    const applied = nthTicket(onUpdated, 0)
    expect(applied.is_blocked).toBe(true)
    expect(applied.blocked_reason).toBe('waiting')
    expect(applied.updated_at).toBe('T2')
    expect(applied.summary).toBe('Original summary')
  })

  it('applyServerRow merges onto the server row, not the live ref, when the live ticket has moved to another ticket', () => {
    const onUpdated = vi.fn()
    const { result, rerender } = renderHook(
      (props: { ticket: Ticket }) => useTicketCommit({ ticket: props.ticket, onUpdated }),
      { initialProps: { ticket: makeTicket({ id: 't1' }) } },
    )
    // The dialog has since switched to a DIFFERENT ticket; the live ref now points at t2.
    rerender({ ticket: makeTicket({ id: 't2', summary: 'Other ticket summary' }) })

    const serverRow = makeTicket({
      id: 't1',
      is_blocked: true,
      blocked_reason: 'waiting',
      blocked_since: 'S',
      summary: 'Server summary',
      updated_at: 'T2',
    })
    act(() => {
      result.current.applyServerRow('t1', serverRow, [
        'is_blocked',
        'blocked_reason',
        'blocked_since',
      ])
    })

    // Merging onto the live ref (t2) would emit a wrong-identity object carrying t2's id
    // and its non-reconciled fields; it must fall back to the server row (t1) instead.
    const applied = nthTicket(onUpdated, 0)
    expect(applied.id).toBe('t1')
    expect(applied.summary).toBe('Server summary')
  })
})
