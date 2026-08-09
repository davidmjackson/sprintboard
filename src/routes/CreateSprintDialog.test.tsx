import { useState } from 'react'
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

vi.mock('@/lib/sprint-dates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sprint-dates')>()),
  // 2026-07-14 is a Tuesday, so a Monday cadence must move the suggestion forward.
  todayUtc: vi.fn(() => '2026-07-14'),
}))

const cadence = { sprint_length_weeks: 2, sprint_start_weekday: 1 }

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
    render(
      <CreateSprintDialog projectId="p1" cadence={cadence} existing={[]} onCreated={onCreated} />,
    )
    const user = await open()

    await user.type(screen.getByLabelText('Name'), 'Hardening push')
    await user.type(screen.getByLabelText('Goal'), 'Ship the board')
    await user.clear(screen.getByLabelText('Start date'))
    await user.type(screen.getByLabelText('Start date'), '2026-07-20')
    await user.clear(screen.getByLabelText('End date'))
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

  it('creates with the name and goal blank, sending the suggested dates', async () => {
    render(
      <CreateSprintDialog projectId="p1" cadence={cadence} existing={[]} onCreated={vi.fn()} />,
    )
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    await waitFor(() =>
      expect(createSprint).toHaveBeenCalledWith({
        projectId: 'p1',
        name: undefined,
        goal: undefined,
        startDate: '2026-07-20',
        endDate: '2026-08-02',
        existing: [],
      }),
    )
  })

  it('passes the existing sprints through so the auto-name numbers correctly', async () => {
    const existing = [sprint(), sprint({ id: 's2' })]
    render(
      <CreateSprintDialog
        projectId="p1"
        cadence={cadence}
        existing={existing}
        onCreated={vi.fn()}
      />,
    )
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    await waitFor(() =>
      expect(createSprint).toHaveBeenCalledWith(expect.objectContaining({ existing })),
    )
  })

  it('shows the field error and does not submit when the end date precedes the start', async () => {
    render(
      <CreateSprintDialog projectId="p1" cadence={cadence} existing={[]} onCreated={vi.fn()} />,
    )
    const user = await open()

    await user.clear(screen.getByLabelText('Start date'))
    await user.type(screen.getByLabelText('Start date'), '2026-08-03')
    await user.clear(screen.getByLabelText('End date'))
    await user.type(screen.getByLabelText('End date'), '2026-07-20')
    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    expect(await screen.findByText('End date must not be before the start date')).toBeVisible()
    expect(createSprint).not.toHaveBeenCalled()
  })

  it('closes the dialog on a successful create', async () => {
    render(
      <CreateSprintDialog projectId="p1" cadence={cadence} existing={[]} onCreated={vi.fn()} />,
    )
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    // Asserted here rather than only through ProjectShell: its two sibling create dialogs
    // both pin their own close, and removing `close()` from this one used to go red only
    // in ProjectShell.test.tsx — a failure that names the wrong component.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('keeps the dialog open and reports a failed create', async () => {
    vi.mocked(createSprint).mockResolvedValue({ ok: false, error: 'unknown' })
    const onCreated = vi.fn()
    render(
      <CreateSprintDialog projectId="p1" cadence={cadence} existing={[]} onCreated={onCreated} />,
    )
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong. Please try again.',
    )
    expect(onCreated).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Name')).toBeVisible()
  })

  it('pre-fills both dates from the cadence when there are no sprints yet (AC1, AC2, AC4)', async () => {
    render(<CreateSprintDialog projectId="p1" cadence={cadence} existing={[]} />)
    await open()

    // Tuesday the 14th -> the next Monday, and a 2-week sprint ends inclusively 13 days later.
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-07-20')
    expect(screen.getByLabelText('End date')).toHaveValue('2026-08-02')
  })

  // S1 review finding: every other test in this file (and in sprint-cadence.test.ts) reuses
  // the schema-default cadence, which cannot tell "the prop reached the arithmetic" from "the
  // arithmetic is hardcoded to the default" — three mutations proved exactly that, hardcoding
  // the length, the weekday, or the whole prop and leaving every other test green. A cadence
  // that differs from the default in BOTH fields is the only fixture that can catch all three.
  it('pre-fills from a NON-DEFAULT cadence, proving the prop reaches the arithmetic (S1)', async () => {
    render(
      <CreateSprintDialog
        projectId="p1"
        cadence={{ sprint_length_weeks: 3, sprint_start_weekday: 4 }}
        existing={[]}
      />,
    )
    await open()

    // Tuesday the 14th -> the next Thursday (weekday 4), and a 3-week sprint ends inclusively
    // 3*7-1 = 20 days later. Verified against the calendar.
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-07-16')
    expect(screen.getByLabelText('End date')).toHaveValue('2026-08-05')
  })

  it('chains the pre-fill onto the latest sprint end date (AC3)', async () => {
    const existing = [sprint({ end_date: '2026-08-02T00:00:00+00:00' })]
    render(<CreateSprintDialog projectId="p1" cadence={cadence} existing={existing} />)
    await open()

    // The 2nd is a Sunday; the day after is the cadence Monday, so no week is skipped.
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-08-03')
    expect(screen.getByLabelText('End date')).toHaveValue('2026-08-16')
  })

  it('saves an edited date rather than the suggested one (AC5)', async () => {
    render(<CreateSprintDialog projectId="p1" cadence={cadence} existing={[]} />)
    const user = await open()

    await user.clear(screen.getByLabelText('End date'))
    await user.type(screen.getByLabelText('End date'), '2026-07-26')
    await user.click(screen.getByRole('button', { name: 'Create sprint' }))

    await waitFor(() =>
      expect(createSprint).toHaveBeenCalledWith(
        expect.objectContaining({ startDate: '2026-07-20', endDate: '2026-07-26' }),
      ),
    )
  })

  it('recomputes the pre-fill on a REOPEN, against the sprint just created', async () => {
    // The staleness case: `useForm` captures defaults once, so a pre-fill computed at mount
    // would re-offer the dates of the sprint the user just made.
    const created = sprint({ id: 's9', end_date: '2026-08-02T00:00:00+00:00' })
    vi.mocked(createSprint).mockResolvedValue({ ok: true, sprint: created })

    function Host() {
      const [existing, setExisting] = useState<Sprint[]>([])
      return (
        <CreateSprintDialog
          projectId="p1"
          cadence={cadence}
          existing={existing}
          onCreated={(s) => setExisting((prev) => [...prev, s])}
        />
      )
    }

    render(<Host />)
    const user = await open()
    expect(screen.getByLabelText('Start date')).toHaveValue('2026-07-20')

    await user.click(screen.getByRole('button', { name: 'Create sprint' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await open()

    expect(screen.getByLabelText('Start date')).toHaveValue('2026-08-03')
    expect(screen.getByLabelText('End date')).toHaveValue('2026-08-16')
  })
})
