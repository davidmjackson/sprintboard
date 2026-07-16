import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CreateSprintDialog } from './CreateSprintDialog'
import { createSprint } from '@/lib/sprints'
import type { Sprint } from '@/lib/domain'

vi.mock('@/lib/sprints', async (importOriginal) => ({
  // defaultSprintName is real — only the network call is stubbed.
  ...(await importOriginal<typeof import('@/lib/sprints')>()),
  createSprint: vi.fn(),
}))

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    project_id: 'p1',
    name: 'Sprint 1',
    goal: null,
    status: 'future',
    start_date: null,
    end_date: null,
    created_at: '2026-07-16T00:00:00+00:00',
    ...overrides,
  }
}

beforeEach(() => {
  vi.mocked(createSprint).mockReset()
  vi.mocked(createSprint).mockResolvedValue({ ok: true, sprint: sprint() })
})

async function open() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'New sprint' }))
  return user
}

describe('CreateSprintDialog', () => {
  it('creates a sprint with a typed name, goal and dates', async () => {
    const onCreated = vi.fn()
    render(<CreateSprintDialog projectId="p1" existing={[]} onCreated={onCreated} />)
    const user = await open()

    await user.type(screen.getByLabelText('Name'), 'Hardening push')
    await user.type(screen.getByLabelText('Goal'), 'Ship the board')
    await user.type(screen.getByLabelText('Start date'), '2026-07-20')
    await user.type(screen.getByLabelText('End date'), '2026-08-03')
    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    await waitFor(() =>
      expect(createSprint).toHaveBeenCalledWith({
        projectId: 'p1',
        name: 'Hardening push',
        goal: 'Ship the board',
        startDate: '2026-07-20',
        endDate: '2026-08-03',
        existing: [],
      }),
    )
    expect(onCreated).toHaveBeenCalledWith(sprint())
  })

  it('creates with every field blank — the name is optional', async () => {
    render(<CreateSprintDialog projectId="p1" existing={[]} onCreated={vi.fn()} />)
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    await waitFor(() =>
      expect(createSprint).toHaveBeenCalledWith({
        projectId: 'p1',
        name: undefined,
        goal: undefined,
        startDate: undefined,
        endDate: undefined,
        existing: [],
      }),
    )
  })

  it('passes the existing sprints through so the auto-name numbers correctly', async () => {
    const existing = [sprint(), sprint({ id: 's2' })]
    render(<CreateSprintDialog projectId="p1" existing={existing} onCreated={vi.fn()} />)
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    await waitFor(() =>
      expect(createSprint).toHaveBeenCalledWith(expect.objectContaining({ existing })),
    )
  })

  it('shows the field error and does not submit when the end date precedes the start', async () => {
    render(<CreateSprintDialog projectId="p1" existing={[]} onCreated={vi.fn()} />)
    const user = await open()

    await user.type(screen.getByLabelText('Start date'), '2026-08-03')
    await user.type(screen.getByLabelText('End date'), '2026-07-20')
    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    expect(await screen.findByText('End date must not be before the start date')).toBeVisible()
    expect(createSprint).not.toHaveBeenCalled()
  })

  it('keeps the dialog open and reports a failed create', async () => {
    vi.mocked(createSprint).mockResolvedValue({ ok: false, error: 'unknown' })
    const onCreated = vi.fn()
    render(<CreateSprintDialog projectId="p1" existing={[]} onCreated={onCreated} />)
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Name')).toBeVisible()
  })
})
