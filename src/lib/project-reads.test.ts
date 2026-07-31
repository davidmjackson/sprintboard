import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { firstUnready, useTaggedRead } from './project-reads'

type Row = { id: string }

/** A promise whose settlement this test controls, so "still loading" is observable. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function setup(projectId: string | undefined, nonce: number, read: (id: string) => Promise<Row[]>) {
  return renderHook(({ p, n }) => useTaggedRead<Row>(p, n, read), {
    initialProps: { p: projectId, n: nonce },
  })
}

describe('useTaggedRead', () => {
  it('starts loading, with an empty list that must not be read as "none"', () => {
    const { result } = setup('p1', 0, () => deferred<Row[]>().promise)

    expect(result.current.phase).toBe('loading')
    expect(result.current.items).toEqual([])
  })

  it('resolves to loaded with the rows', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }]
    const { result } = setup('p1', 0, () => Promise.resolve(rows))

    await waitFor(() => expect(result.current.phase).toBe('loaded'))
    expect(result.current.items).toEqual(rows)
  })

  it('records a rejection as failed, NOT as a loaded empty list', async () => {
    // The S4.6 invariant, and the whole reason `failed` is a variant rather than `[]`.
    // Flattening a rejection into an empty loaded list is what made a paused database
    // render as "Nothing in the backlog." instead of an error.
    const { result } = setup('p1', 0, () => Promise.reject(new Error('database paused')))

    await waitFor(() => expect(result.current.phase).toBe('failed'))
    expect(result.current.phase).not.toBe('loaded')
    expect(result.current.items).toEqual([])
  })

  it('ignores a result that lands after the project changed', async () => {
    // The slow first project resolves LAST. Without tagging it would overwrite the second
    // project's list, flashing one project's rows under the other's header.
    const first = deferred<Row[]>()
    const read = vi.fn((id: string) =>
      id === 'p1' ? first.promise : Promise.resolve([{ id: 'p2-row' }]),
    )
    const { result, rerender } = setup('p1', 0, read)

    rerender({ p: 'p2', n: 0 })
    await waitFor(() => expect(result.current.phase).toBe('loaded'))
    expect(result.current.items).toEqual([{ id: 'p2-row' }])

    await act(async () => {
      first.resolve([{ id: 'p1-row' }])
      await first.promise
    })

    expect(result.current.items).toEqual([{ id: 'p2-row' }])
  })

  it('ignores a late REJECTION from the project we navigated away from', async () => {
    // The rejection twin of the test above, and it guards a nastier failure. Without the
    // `active` check on the `.catch` path, project A's late rejection overwrites state with
    // an A-tagged `failed`; `isCurrent` then rejects that as stale, so project B sits on
    // `loading` FOREVER. No further effect fires, and the tabs only render Retry on
    // `failed` — so there is no way out of it but a page reload.
    const p1 = deferred<Row[]>()
    const read = vi.fn((id: string) =>
      id === 'p1' ? p1.promise : Promise.resolve([{ id: 'p2-row' }]),
    )
    const { result, rerender } = setup('p1', 0, read)

    rerender({ p: 'p2', n: 0 })
    await waitFor(() => expect(result.current.phase).toBe('loaded'))

    await act(async () => {
      p1.reject(new Error('database paused'))
      await p1.promise.catch(() => {})
    })

    expect(result.current.phase).toBe('loaded')
    expect(result.current.items).toEqual([{ id: 'p2-row' }])
  })

  it('does not show the previous project rows while the new project is still loading', async () => {
    // The actual cross-project-flash guard, and it is `isCurrent`'s project check that
    // provides it — NOT the `active` cleanup flag. The test above cannot reach this code:
    // there the cleanup discards the old project's late result before it ever reaches
    // state. Here the old result is ALREADY in state and the new read has not landed, so
    // dropping the project comparison would render p1's rows under p2's header.
    const pending = deferred<Row[]>()
    let call = 0
    const read = () => (call++ === 0 ? Promise.resolve([{ id: 'p1-row' }]) : pending.promise)
    const { result, rerender } = setup('p1', 0, read)

    await waitFor(() => expect(result.current.phase).toBe('loaded'))
    expect(result.current.items).toEqual([{ id: 'p1-row' }])

    rerender({ p: 'p2', n: 0 })

    expect(result.current.phase).toBe('loading')
    expect(result.current.items).toEqual([])
  })

  it('returns to loading the instant the nonce is bumped, not when the retry lands', async () => {
    // A Retry that leaves the stale error on screen reads as a no-op, and gets hammered.
    const second = deferred<Row[]>()
    let call = 0
    const read = () => (call++ === 0 ? Promise.resolve([{ id: 'stale' }]) : second.promise)
    const { result, rerender } = setup('p1', 0, read)

    await waitFor(() => expect(result.current.phase).toBe('loaded'))

    rerender({ p: 'p1', n: 1 })
    expect(result.current.phase).toBe('loading')
    expect(result.current.items).toEqual([])
    // Assert the REFETCH, not just the phase flip. Dropping `nonce` from the effect deps
    // still shows this spinner — and then never resolves it, because no new read is issued.
    expect(call).toBe(2)
  })

  it('does not read at all without a project id', () => {
    const read = vi.fn(() => Promise.resolve([]))
    const { result } = setup(undefined, 0, read)

    expect(read).not.toHaveBeenCalled()
    expect(result.current.phase).toBe('loading')
  })

  describe('patch', () => {
    it('applies the change to a loaded list', async () => {
      const { result } = setup('p1', 0, () => Promise.resolve([{ id: 'a' }]))
      await waitFor(() => expect(result.current.phase).toBe('loaded'))

      act(() => result.current.patch('p1', (rows) => [...rows, { id: 'b' }]))

      expect(result.current.items).toEqual([{ id: 'a' }, { id: 'b' }])
    })

    it('is a no-op on a failed read, and never promotes it to loaded', async () => {
      // Patching a failed variant would mean reading rows off a variant that has none and
      // building a `loaded` state out of a `failed` one — the defect S4.6 removed.
      const { result } = setup('p1', 0, () => Promise.reject(new Error('nope')))
      await waitFor(() => expect(result.current.phase).toBe('failed'))

      act(() => result.current.patch('p1', () => [{ id: 'invented' }]))

      expect(result.current.phase).toBe('failed')
      expect(result.current.items).toEqual([])
    })

    it('is a no-op while still loading', () => {
      const { result } = setup('p1', 0, () => deferred<Row[]>().promise)

      act(() => result.current.patch('p1', () => [{ id: 'invented' }]))

      expect(result.current.phase).toBe('loading')
      expect(result.current.items).toEqual([])
    })

    it('refuses a patch aimed at a different project', async () => {
      const { result } = setup('p1', 0, () => Promise.resolve([{ id: 'a' }]))
      await waitFor(() => expect(result.current.phase).toBe('loaded'))

      act(() => result.current.patch('p2', () => [{ id: 'wrong-project' }]))

      expect(result.current.items).toEqual([{ id: 'a' }])
    })
  })

  // There is deliberately NO "does not set state after unmount" test here.
  //
  // The obvious one — unmount, resolve late, assert `console.error` was not called — cannot
  // fail: React removed the setState-after-unmount warning in 18.3 and this repo is on 19.2,
  // so it passes just as happily with the cleanup deleted entirely. Verified by mutation.
  //
  // The `active` cleanup is genuinely covered, by the two project-switch tests above: the
  // cleanup function runs on a dependency change exactly as it does on unmount, and those
  // tests DO go red when it is removed — on both the resolve and the reject path.
})

describe('firstUnready', () => {
  it('returns null when every read has loaded', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'loaded' },
        { resource: 'sprints', phase: 'loaded' },
      ]),
    ).toBeNull()
  })

  it('reports a failed read', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'loaded' },
        { resource: 'sprints', phase: 'failed' },
      ]),
    ).toEqual({ resource: 'sprints', phase: 'failed' })
  })

  it('reports a loading read when nothing has failed', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'loaded' },
        { resource: 'sprints', phase: 'loading' },
      ]),
    ).toEqual({ resource: 'sprints', phase: 'loading' })
  })

  // THE test. A single ordered scan returns the LOADING one here and silently changes
  // what the board shows: an error replaced by a spinner that never resolves.
  it('prefers a failure that comes AFTER a loading read in the list', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'loading' },
        { resource: 'sprints', phase: 'failed' },
      ]),
    ).toEqual({ resource: 'sprints', phase: 'failed' })
  })

  it('reports the first of several failures, in source order', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'failed' },
        { resource: 'sprints', phase: 'failed' },
      ]),
    ).toEqual({ resource: 'tickets', phase: 'failed' })
  })

  it('reports the first of several loading reads, in source order', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'loading' },
        { resource: 'sprints', phase: 'loading' },
      ]),
    ).toEqual({ resource: 'tickets', phase: 'loading' })
  })

  it('returns null for an empty list', () => {
    expect(firstUnready([])).toBeNull()
  })
})
