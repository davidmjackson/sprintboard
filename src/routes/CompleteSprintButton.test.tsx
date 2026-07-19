import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CompleteSprintButton } from './CompleteSprintButton'
import { completeSprint } from '@/lib/sprints'
import type { Sprint, Ticket } from '@/lib/domain'

vi.mock('@/lib/sprints', () => ({ completeSprint: vi.fn() }))
const mockComplete = vi.mocked(completeSprint)

const sprint: Sprint = {
  id: 's1',
  project_id: 'p1',
  name: 'Sprint 1',
  goal: null,
  status: 'active',
  start_date: null,
  end_date: null,
  created_at: '2026-07-15T00:00:00+00:00',
}

beforeEach(() => mockComplete.mockReset())

describe('CompleteSprintButton', () => {
  it('calls completeSprint and hands the sprint and returned tickets up on success', async () => {
    const completed: Sprint = { ...sprint, status: 'complete' }
    const returnedTickets = [{ id: 't1' } as Ticket]
    mockComplete.mockResolvedValue({ ok: true, sprint: completed, returnedTickets })
    const onCompleted = vi.fn()

    render(<CompleteSprintButton sprint={sprint} onCompleted={onCompleted} />)
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))

    expect(mockComplete).toHaveBeenCalledWith('s1')
    expect(onCompleted).toHaveBeenCalledWith(completed, returnedTickets)
  })

  it('shows a generic message and does not call onCompleted on failure', async () => {
    mockComplete.mockResolvedValue({ ok: false, error: 'unknown' })
    const onCompleted = vi.fn()

    render(<CompleteSprintButton sprint={sprint} onCompleted={onCompleted} />)
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('disables the button while the completion is in flight', async () => {
    let resolve!: (r: { ok: true; sprint: Sprint; returnedTickets: Ticket[] }) => void
    mockComplete.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )

    render(<CompleteSprintButton sprint={sprint} onCompleted={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))

    expect(screen.getByRole('button', { name: 'Completing…' })).toBeDisabled()
    resolve({ ok: true, sprint: { ...sprint, status: 'complete' }, returnedTickets: [] })
    await screen.findByRole('button', { name: 'Complete' })
  })
})
