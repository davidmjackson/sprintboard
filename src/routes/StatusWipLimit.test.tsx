import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { StatusWipLimitField } from './StatusWipLimit'
import type { ProjectStatus } from '@/lib/domain'
import { setStatusWipLimit } from '@/lib/project-statuses'
import type { StatusWriteResult } from '@/lib/project-statuses'

vi.mock('@/lib/project-statuses', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-statuses')>()),
  setStatusWipLimit: vi.fn(),
}))

const mockSet = vi.mocked(setStatusWipLimit)

/**
 * `wip_limit` is deliberately NOT equal to `position`, and the name is not the slug — the
 * same confound discipline as `StatusSettings.test.tsx`'s fixture, for the same reason: a
 * fixture whose values coincide cannot tell two different reads apart.
 */
function status(overrides: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    id: 'st2',
    project_id: 'p1',
    slug: 'in_build',
    name: 'Building',
    category: 'in_progress',
    position: 20,
    is_initial: false,
    wip_limit: 4,
    created_at: '2026-08-01T00:00:00+00:00',
    ...overrides,
  } as ProjectStatus
}

const onUpdated = vi.fn()

beforeEach(() => {
  mockSet.mockReset()
  onUpdated.mockReset()
})

function field(s: ProjectStatus = status()) {
  render(<StatusWipLimitField status={s} onUpdated={onUpdated} />)
  return screen.getByRole('spinbutton', { name: /wip limit for building/i })
}

describe('StatusWipLimitField', () => {
  it('shows the status’s current limit', () => {
    expect(field()).toHaveValue(4)
  })

  it('shows an empty field when there is no limit', () => {
    expect(field(status({ wip_limit: null }))).toHaveValue(null)
  })

  /**
   * THE POSITIVE CONTROL for every "sends nothing" assertion below. A spy asserted
   * `not.toHaveBeenCalled()` passes just as happily when the component never rendered, so
   * at least one case in this file must prove the same spy CAN be called.
   */
  it('commits a changed value on blur', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: true, value: status({ wip_limit: 7 }) })
    const input = field()

    await user.clear(input)
    await user.type(input, '7')
    await user.tab()

    expect(mockSet).toHaveBeenCalledWith('st2', 7)
    expect(onUpdated).toHaveBeenCalledWith(status({ wip_limit: 7 }))
  })

  it('commits on Enter', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: true, value: status({ wip_limit: 9 }) })
    const input = field()

    await user.clear(input)
    await user.type(input, '9{Enter}')

    expect(mockSet).toHaveBeenCalledWith('st2', 9)
  })

  it('clears the limit to null when emptied', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: true, value: status({ wip_limit: null }) })
    const input = field()

    await user.clear(input)
    await user.tab()

    expect(mockSet).toHaveBeenCalledWith('st2', null)
  })

  it('sends nothing when the value is unchanged', async () => {
    const user = userEvent.setup()
    const input = field()

    await user.click(input)
    await user.tab()

    expect(mockSet).not.toHaveBeenCalled()
  })

  it('refuses 0 with a message and sends nothing', async () => {
    const user = userEvent.setup()
    const input = field()

    await user.clear(input)
    await user.type(input, '0')
    await user.tab()

    expect(mockSet).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^A limit must be at least 1\. Leave it empty for no limit\.$/,
    )
  })

  /**
   * Pins the ordering the component's docblock claims but nothing else tests: the error is
   * cleared BEFORE the no-op check runs, not after it. A no-op commit still reaches
   * `setError(null)` even though it sends nothing, so a stale refusal from an earlier attempt
   * does not linger on screen describing a request the user never made.
   */
  it('clears a stale error message on a no-op commit', async () => {
    const user = userEvent.setup()
    const input = field()

    await user.clear(input)
    await user.type(input, '0')
    await user.tab()
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await user.clear(input)
    await user.type(input, '4')
    await user.tab()

    expect(mockSet).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('reverts the draft on Escape without committing', async () => {
    const user = userEvent.setup()
    const input = field()

    await user.clear(input)
    await user.type(input, '8{Escape}')

    expect(mockSet).not.toHaveBeenCalled()
    expect(input).toHaveValue(4)
  })

  it('shows a message when the write fails', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: false, error: 'stale' })
    const input = field()

    await user.clear(input)
    await user.type(input, '5')
    await user.tab()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onUpdated).not.toHaveBeenCalled()
  })

  /**
   * Fix round 1, finding 3. `useState(() => toDraft(status.wip_limit))` only ever runs at
   * mount, so a parent-driven change to `status` — another status's write, a rename, a
   * refetch — used to leave this field showing a number the database no longer holds.
   * `rerender` with a NEW `status` object is what stands in for that: `StatusSettings.tsx`
   * keys each row on `status.id`, so React reuses this exact instance rather than remounting
   * it, which `render` alone cannot exercise.
   */
  it('resyncs the shown limit when the status prop changes while the field is idle', () => {
    const { rerender } = render(<StatusWipLimitField status={status()} onUpdated={onUpdated} />)
    const input = screen.getByRole('spinbutton', { name: /wip limit for building/i })
    expect(input).toHaveValue(4)

    rerender(<StatusWipLimitField status={status({ wip_limit: 9 })} onUpdated={onUpdated} />)

    expect(input).toHaveValue(9)
  })

  /**
   * The other half of finding 3, and the one that stops the fix from being worse than the
   * bug: a user mid-edit must not have their own typing overwritten by a resync that fires
   * for an unrelated reason.
   */
  it('does NOT resync the draft while the field is focused', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<StatusWipLimitField status={status()} onUpdated={onUpdated} />)
    const input = screen.getByRole('spinbutton', { name: /wip limit for building/i })

    await user.click(input)
    await user.clear(input)
    await user.type(input, '2')

    rerender(<StatusWipLimitField status={status({ wip_limit: 9 })} onUpdated={onUpdated} />)

    expect(input).toHaveValue(2)
  })

  /**
   * Fix round 1, finding 4. Two commits fired close together (Enter, then blur before the
   * first settles) can resolve out of order; without a generation guard the OLDER response
   * would win, silently reverting the parent's state to a value the user already changed.
   * Held promises rather than `mockResolvedValue`, so the resolution order can be forced to
   * be the opposite of the commit order — the exact shape that reproduces the bug.
   */
  it('applies only the latest commit’s result when responses resolve out of order', async () => {
    const user = userEvent.setup()
    let resolveFirst!: (r: StatusWriteResult<ProjectStatus>) => void
    let resolveSecond!: (r: StatusWriteResult<ProjectStatus>) => void
    mockSet
      .mockImplementationOnce(
        () =>
          new Promise<StatusWriteResult<ProjectStatus>>((resolve) => {
            resolveFirst = resolve
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<StatusWriteResult<ProjectStatus>>((resolve) => {
            resolveSecond = resolve
          }),
      )
    const input = field()

    await user.clear(input)
    await user.type(input, '5{Enter}')
    await user.clear(input)
    await user.type(input, '9')
    await user.tab()

    // The SECOND commit resolves FIRST.
    resolveSecond({ ok: true, value: status({ wip_limit: 9 }) })
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(status({ wip_limit: 9 })))

    // The FIRST commit's stale response arrives after — and must be ignored.
    resolveFirst({ ok: true, value: status({ wip_limit: 5 }) })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(onUpdated).toHaveBeenCalledTimes(1)
    expect(onUpdated).toHaveBeenLastCalledWith(status({ wip_limit: 9 }))
  })

  /**
   * Fix round 1, finding 5. `revert()`'s `setError(null)` has no test that first puts the
   * field into an error state, so deleting that line left all existing tests green. Type an
   * invalid value, see the message, then back out with Escape — the message must go with it,
   * or the user is left staring at a refusal describing a request they cancelled.
   */
  it('clears an error message on Escape', async () => {
    const user = userEvent.setup()
    const input = field()

    await user.clear(input)
    await user.type(input, '0')
    await user.tab()
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await user.click(input)
    await user.type(input, '{Escape}')

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
