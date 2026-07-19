import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StartSprintButton } from './StartSprintButton'
import { startSprint } from '@/lib/sprints'
import type { Sprint } from '@/lib/domain'

vi.mock('@/lib/sprints', () => ({ startSprint: vi.fn() }))
const mockStart = vi.mocked(startSprint)

const sprint: Sprint = {
  id: 's1',
  project_id: 'p1',
  name: 'Sprint 1',
  goal: null,
  status: 'future',
  start_date: null,
  end_date: null,
  created_at: '2026-07-15T00:00:00+00:00',
}

beforeEach(() => mockStart.mockReset())

describe('StartSprintButton', () => {
  it('calls startSprint and hands the started sprint up on success', async () => {
    const started: Sprint = { ...sprint, status: 'active' }
    mockStart.mockResolvedValue({ ok: true, sprint: started })
    const onStarted = vi.fn()

    render(<StartSprintButton sprint={sprint} onStarted={onStarted} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(mockStart).toHaveBeenCalledWith('s1')
    expect(onStarted).toHaveBeenCalledWith(started)
  })

  it('shows a clear message and does not call onStarted when one is already active', async () => {
    mockStart.mockResolvedValue({ ok: false, error: 'already_active' })
    const onStarted = vi.fn()

    render(<StartSprintButton sprint={sprint} onStarted={onStarted} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This project already has an active sprint. Complete it before starting another.',
    )
    expect(onStarted).not.toHaveBeenCalled()
  })

  it('shows a generic message on an unknown failure', async () => {
    mockStart.mockResolvedValue({ ok: false, error: 'unknown' })

    render(<StartSprintButton sprint={sprint} onStarted={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
  })

  it('disables the button while the start is in flight', async () => {
    let resolve!: (r: { ok: true; sprint: Sprint }) => void
    mockStart.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )

    render(<StartSprintButton sprint={sprint} onStarted={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled()
    resolve({ ok: true, sprint: { ...sprint, status: 'active' } })
    // Let the resolution flush so the pending state clears — avoids a dangling microtask.
    await screen.findByRole('button', { name: 'Start' })
  })
})
