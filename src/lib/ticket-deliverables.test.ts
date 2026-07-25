import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useDeliverables } from './ticket-deliverables'
import type { Ticket } from './domain'

const epic = { id: 'e1', deliverables: ['A', 'B'] } as unknown as Ticket
const alwaysMounted = () => true

function setup(commit: (patch: unknown) => Promise<boolean>, isMounted = alwaysMounted) {
  const onWritten = vi.fn()
  const result = renderHook(() => useDeliverables({ ticket: epic, commit, isMounted, onWritten }))
  return { ...result, onWritten }
}

describe('useDeliverables', () => {
  it('parses the jsonb column into a clean string list', () => {
    // A dirty jsonb row on purpose: untrimmed, blank and non-string elements. A passthrough
    // cast (`ticket.deliverables as string[]`) would satisfy a clean fixture but not this.
    const dirty = { id: 'e1', deliverables: ['  A  ', '', 7, 'B', null] } as unknown as Ticket
    const { result } = renderHook(() =>
      useDeliverables({
        ticket: dirty,
        commit: vi.fn().mockResolvedValue(true),
        isMounted: alwaysMounted,
        onWritten: vi.fn(),
      }),
    )
    expect(result.current.items).toEqual(['A', 'B'])
  })

  it('has no items when there is no ticket', () => {
    const { result } = renderHook(() =>
      useDeliverables({
        ticket: null,
        commit: vi.fn().mockResolvedValue(true),
        isMounted: alwaysMounted,
        onWritten: vi.fn(),
      }),
    )
    expect(result.current.items).toEqual([])
  })

  it('appends the trimmed draft and clears it only on a successful add', async () => {
    const commit = vi.fn().mockResolvedValue(true)
    const { result, onWritten } = setup(commit)

    act(() => {
      result.current.setDraft('  C  ')
    })
    await act(async () => {
      await result.current.add()
    })

    expect(commit).toHaveBeenCalledWith({ deliverables: ['A', 'B', 'C'] })
    expect(result.current.draft).toBe('')
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft and does not invalidate when the add fails', async () => {
    const commit = vi.fn().mockResolvedValue(false)
    const { result, onWritten } = setup(commit)

    act(() => {
      result.current.setDraft('C')
    })
    await act(async () => {
      await result.current.add()
    })

    expect(commit).toHaveBeenCalledWith({ deliverables: ['A', 'B', 'C'] })
    expect(result.current.draft).toBe('C')
    expect(onWritten).not.toHaveBeenCalled()
  })

  it('ignores a blank or whitespace-only draft', async () => {
    const commit = vi.fn().mockResolvedValue(true)
    const { result } = setup(commit)

    act(() => {
      result.current.setDraft('   ')
    })
    await act(async () => {
      await result.current.add()
    })

    expect(commit).not.toHaveBeenCalled()
  })

  it('serializes writes: a second mutation is dropped while the first is in flight', async () => {
    let resolve: (value: boolean) => void = () => {}
    const commit = vi.fn().mockReturnValue(new Promise<boolean>((r) => (resolve = r)))
    const { result } = setup(commit)

    act(() => {
      result.current.remove(0)
    })
    expect(result.current.pending).toBe(true)

    act(() => {
      result.current.remove(1)
    })
    expect(commit).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolve(true)
    })
    expect(result.current.pending).toBe(false)
  })

  it('removes an item by index', async () => {
    const commit = vi.fn().mockResolvedValue(true)
    const { result, onWritten } = setup(commit)
    await act(async () => {
      result.current.remove(0)
    })
    expect(commit).toHaveBeenCalledWith({ deliverables: ['B'] })
    expect(onWritten).toHaveBeenCalledTimes(1)
  })

  it('treats an edit to blank as a removal', async () => {
    const commit = vi.fn().mockResolvedValue(true)
    const { result } = setup(commit)
    await act(async () => {
      result.current.edit(0, '   ')
    })
    expect(commit).toHaveBeenCalledWith({ deliverables: ['B'] })
  })

  it('trims an edited value', async () => {
    const commit = vi.fn().mockResolvedValue(true)
    const { result } = setup(commit)
    await act(async () => {
      result.current.edit(1, '  B2  ')
    })
    expect(commit).toHaveBeenCalledWith({ deliverables: ['A', 'B2'] })
  })

  // `isMounted` must be CALLED after the await, never snapshotted before it: a write that
  // resolves after this dialog instance unmounted must touch no state and must not
  // invalidate the trace. Passing a boolean instead of the function would leave every
  // other test in this file green while breaking exactly this.
  it('touches no state and does not invalidate when the write lands after unmount', async () => {
    let mounted = true
    const commit = vi.fn().mockImplementation(async () => {
      mounted = false
      return true
    })
    const { result, onWritten } = setup(commit, () => mounted)

    act(() => {
      result.current.setDraft('C')
    })
    await act(async () => {
      await result.current.add()
    })

    expect(commit).toHaveBeenCalledWith({ deliverables: ['A', 'B', 'C'] })
    expect(onWritten).not.toHaveBeenCalled()
    expect(result.current.pending).toBe(true)
    expect(result.current.draft).toBe('C')
  })
})
