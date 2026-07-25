import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useBlockFlow, useDeleteFlow } from './ticket-actions'
import * as tickets from './tickets'
import type { BlockTicketResult, DeleteTicketResult, UnblockTicketResult } from './tickets'
import type { Ticket } from './domain'

vi.mock('./tickets', async () => {
  const actual = await vi.importActual<typeof tickets>('./tickets')
  return {
    ...actual,
    blockTicket: vi.fn(),
    unblockTicket: vi.fn(),
    deleteTicket: vi.fn(),
  }
})
const blockTicket = vi.mocked(tickets.blockTicket)
const unblockTicket = vi.mocked(tickets.unblockTicket)
const deleteTicket = vi.mocked(tickets.deleteTicket)

const ticket = { id: 't1', key: 'SB-1' } as unknown as Ticket
const serverRow = {
  id: 't1',
  is_blocked: true,
  blocked_reason: 'waiting',
  blocked_since: 'S',
  updated_at: 'T2',
} as unknown as Ticket

beforeEach(() => {
  blockTicket.mockReset()
  unblockTicket.mockReset()
  deleteTicket.mockReset()
})

/** Rendered through a props object so a test can `rerender({ ticket: null })` — the dialog's
 *  ticket really can empty while a write is in flight. */
function setupBlock(initialTicket: Ticket | null = ticket) {
  const applyServerRow = vi.fn()
  const setError = vi.fn()
  const clearError = vi.fn()
  const rendered = renderHook(
    (props: { ticket: Ticket | null }) =>
      useBlockFlow({ ticket: props.ticket, applyServerRow, setError, clearError }),
    { initialProps: { ticket: initialTicket } },
  )
  return { ...rendered, applyServerRow, setError, clearError }
}

function setupDelete(initialTicket: Ticket | null = ticket) {
  const onDeleted = vi.fn()
  const setError = vi.fn()
  const rendered = renderHook(
    (props: { ticket: Ticket | null }) =>
      useDeleteFlow({ ticket: props.ticket, onDeleted, setError }),
    { initialProps: { ticket: initialTicket } },
  )
  return { ...rendered, onDeleted, setError }
}

describe('useBlockFlow', () => {
  it('blocks with the trimmed reason and applies the server row field-scoped', async () => {
    blockTicket.mockResolvedValue({ ok: true, ticket: serverRow })
    const { result, applyServerRow } = setupBlock()

    act(() => {
      result.current.open()
      result.current.setReason('  waiting on design  ')
    })
    await act(async () => {
      await result.current.submit()
    })

    expect(blockTicket).toHaveBeenCalledWith('t1', 'waiting on design')
    expect(applyServerRow).toHaveBeenCalledWith('t1', serverRow, [
      'is_blocked',
      'blocked_reason',
      'blocked_since',
    ])
    expect(result.current.blocking).toBe(false)
    expect(result.current.reason).toBe('')
    expect(result.current.error).toBeNull()
    expect(result.current.pending).toBe(false)
  })

  it('refuses an empty reason without calling the database', async () => {
    const { result } = setupBlock()
    act(() => {
      result.current.open()
    })
    await act(async () => {
      await result.current.submit()
    })

    expect(blockTicket).not.toHaveBeenCalled()
    expect(result.current.error).toBe('A reason is required to block a ticket')
  })

  it('surfaces a failed block without closing the dialog', async () => {
    blockTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const { result } = setupBlock()

    act(() => {
      result.current.open()
      result.current.setReason('waiting')
    })
    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.error).toBe('Could not block this ticket. Please try again.')
    expect(result.current.blocking).toBe(true)
    // Pending must clear on failure or the retry button stays disabled forever.
    expect(result.current.pending).toBe(false)
  })

  // The `invalid_reason` branch shows the DATABASE's own message; every other failure shows
  // the generic copy. Without this, collapsing the ternary to the generic string passes.
  it('shows the database rejection message when the reason is refused server-side', async () => {
    blockTicket.mockResolvedValue({
      ok: false,
      error: 'invalid_reason',
      message: 'Keep the reason to 500 characters or fewer',
    })
    const { result } = setupBlock()

    act(() => {
      result.current.open()
      result.current.setReason('waiting')
    })
    await act(async () => {
      await result.current.submit()
    })

    expect(result.current.error).toBe('Keep the reason to 500 characters or fewer')
    expect(result.current.blocking).toBe(true)
  })

  it('close resets the reason and the error', async () => {
    blockTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const { result } = setupBlock()
    act(() => {
      result.current.open()
      result.current.setReason('waiting')
    })
    await act(async () => {
      await result.current.submit()
    })
    act(() => {
      result.current.close()
    })

    expect(result.current.blocking).toBe(false)
    expect(result.current.reason).toBe('')
    expect(result.current.error).toBeNull()
  })

  // `open()` resets before opening, so a reason/error left over from a previous attempt is
  // never shown to the next one. A regression to a bare `setBlocking(true)` fails here.
  it('open clears a stale reason and error before showing the dialog', async () => {
    blockTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const { result } = setupBlock()
    act(() => {
      result.current.open()
      result.current.setReason('waiting')
    })
    await act(async () => {
      await result.current.submit()
    })
    expect(result.current.error).not.toBeNull()

    act(() => {
      result.current.open()
    })

    expect(result.current.blocking).toBe(true)
    expect(result.current.reason).toBe('')
    expect(result.current.error).toBeNull()
  })

  // The dialog's Textarea used to clear the error inline on change; that rule now lives in
  // `setReason` so the flow keeps a single owner of its validation error.
  it('clears a stale validation error as soon as the reason is edited', async () => {
    const { result } = setupBlock()
    act(() => {
      result.current.open()
    })
    await act(async () => {
      await result.current.submit()
    })
    expect(result.current.error).toBe('A reason is required to block a ticket')

    act(() => {
      result.current.setReason('w')
    })

    expect(result.current.error).toBeNull()
    expect(result.current.reason).toBe('w')
  })

  it('does not block when there is no ticket', async () => {
    const { result } = setupBlock(null)
    act(() => {
      result.current.open()
      result.current.setReason('waiting')
    })
    await act(async () => {
      await result.current.submit()
    })

    expect(blockTicket).not.toHaveBeenCalled()
  })

  // `isMounted` must be CALLED after the await, never snapshotted before it: a block that
  // resolves after this dialog instance unmounted must touch no state and must not reconcile
  // the row. Passing a boolean instead of the function leaves every other test here green.
  it('applies nothing when the block lands after the dialog unmounts', async () => {
    let resolveBlock: (value: BlockTicketResult) => void = () => {}
    blockTicket.mockReturnValue(new Promise<BlockTicketResult>((r) => (resolveBlock = r)))
    const { result, unmount, applyServerRow } = setupBlock()

    act(() => {
      result.current.open()
      result.current.setReason('waiting')
    })
    act(() => {
      void result.current.submit()
    })
    expect(result.current.pending).toBe(true)
    unmount()
    await act(async () => {
      resolveBlock({ ok: true, ticket: serverRow })
    })

    expect(blockTicket).toHaveBeenCalledWith('t1', 'waiting')
    expect(applyServerRow).not.toHaveBeenCalled()
  })

  it('guards a duplicate unblock while the first is in flight', async () => {
    let resolveUnblock: (value: UnblockTicketResult) => void = () => {}
    unblockTicket.mockReturnValue(new Promise<UnblockTicketResult>((r) => (resolveUnblock = r)))
    const { result, applyServerRow, clearError } = setupBlock()

    act(() => {
      void result.current.unblock()
    })
    expect(result.current.unblockPending).toBe(true)
    act(() => {
      void result.current.unblock()
    })
    expect(unblockTicket).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveUnblock({ ok: true, ticket: serverRow })
    })
    expect(result.current.unblockPending).toBe(false)
    expect(applyServerRow).toHaveBeenCalledWith('t1', serverRow, [
      'is_blocked',
      'blocked_reason',
      'blocked_since',
    ])
    expect(clearError).toHaveBeenCalled()

    // Positive control: the guard re-opens rather than closing the flow permanently.
    unblockTicket.mockResolvedValue({ ok: true, ticket: serverRow })
    await act(async () => {
      await result.current.unblock()
    })
    expect(unblockTicket).toHaveBeenCalledTimes(2)
  })

  it('reports a failed unblock through the shared ticket error', async () => {
    unblockTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const { result, setError } = setupBlock()
    await act(async () => {
      await result.current.unblock()
    })

    expect(setError).toHaveBeenCalledWith('t1', 'Could not unblock this ticket. Please try again.')
  })

  it('does not unblock when there is no ticket', async () => {
    const { result } = setupBlock(null)
    await act(async () => {
      await result.current.unblock()
    })

    expect(unblockTicket).not.toHaveBeenCalled()
  })

  it('touches nothing when the unblock lands after the dialog unmounts', async () => {
    let resolveUnblock: (value: UnblockTicketResult) => void = () => {}
    unblockTicket.mockReturnValue(new Promise<UnblockTicketResult>((r) => (resolveUnblock = r)))
    const { result, unmount, applyServerRow, clearError } = setupBlock()

    act(() => {
      void result.current.unblock()
    })
    unmount()
    await act(async () => {
      resolveUnblock({ ok: true, ticket: serverRow })
    })

    expect(applyServerRow).not.toHaveBeenCalled()
    expect(clearError).not.toHaveBeenCalled()
  })

  // The id is captured BEFORE the await, so the error lands on the ticket the unblock
  // belongs to. Reading it from the live ticket at continuation time would report against
  // the wrong ticket — or crash on the null the dialog can legitimately hold by then.
  it('survives the ticket going null mid-flight', async () => {
    let resolveUnblock: (value: UnblockTicketResult) => void = () => {}
    unblockTicket.mockReturnValue(new Promise<UnblockTicketResult>((r) => (resolveUnblock = r)))
    const { result, rerender, setError } = setupBlock()

    act(() => {
      void result.current.unblock()
    })
    rerender({ ticket: null })
    await act(async () => {
      resolveUnblock({ ok: false, error: 'unknown' })
    })

    expect(setError).toHaveBeenCalledWith('t1', 'Could not unblock this ticket. Please try again.')
  })
})

describe('useDeleteFlow', () => {
  it('reports the deleted id upward on success', async () => {
    deleteTicket.mockResolvedValue({ ok: true })
    const { result, onDeleted } = setupDelete()

    await act(async () => {
      await result.current.submit()
    })

    expect(deleteTicket).toHaveBeenCalledWith('t1')
    expect(onDeleted).toHaveBeenCalledWith('t1')
    // The parent removes the row → `ticket` goes null → the dialog unmounts. The flow does
    // not close itself, so `deleting` deliberately stays true on the way out.
    expect(result.current.deleting).toBe(true)
  })

  it('clears the confirm state and surfaces an error on failure', async () => {
    deleteTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const { result, onDeleted, setError } = setupDelete()

    act(() => {
      result.current.setConfirming(true)
    })
    await act(async () => {
      await result.current.submit()
    })

    expect(onDeleted).not.toHaveBeenCalled()
    expect(result.current.deleting).toBe(false)
    expect(result.current.confirming).toBe(false)
    expect(setError).toHaveBeenCalledWith('t1', 'Could not delete this ticket. Please try again.')
  })

  it('does not delete when there is no ticket', async () => {
    const { result } = setupDelete(null)
    await act(async () => {
      await result.current.submit()
    })

    expect(deleteTicket).not.toHaveBeenCalled()
  })

  // Same mount guard as the block flow: a delete that resolves after this instance died must
  // not report upward — the parent has already moved on and a fresh instance owns the ticket.
  it('reports nothing upward when the delete lands after the dialog unmounts', async () => {
    let resolveDelete: (value: DeleteTicketResult) => void = () => {}
    deleteTicket.mockReturnValue(new Promise<DeleteTicketResult>((r) => (resolveDelete = r)))
    const { result, unmount, onDeleted, setError } = setupDelete()

    act(() => {
      void result.current.submit()
    })
    unmount()
    await act(async () => {
      resolveDelete({ ok: true })
    })

    expect(deleteTicket).toHaveBeenCalledWith('t1')
    expect(onDeleted).not.toHaveBeenCalled()
    expect(setError).not.toHaveBeenCalled()
  })
})
