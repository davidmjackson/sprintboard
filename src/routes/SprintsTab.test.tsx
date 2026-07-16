import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

import { SprintsTab } from './SprintsTab'
import type { ProjectShellContext, SprintsPhase } from './ProjectShell'
import type { Project, Sprint } from '@/lib/domain'

// The dialog is exercised by its own suite; here it is a button that reports its props
// and, on click, invokes `onCreated` with a fixture sprint — so the tab's hand-off to
// the shell's `onSprintCreated` is exercised here, not just by the dialog's own tests.
vi.mock('./CreateSprintDialog', () => ({
  CreateSprintDialog: ({
    existing,
    onCreated,
  }: {
    existing: readonly Sprint[]
    onCreated?: (sprint: Sprint) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onCreated?.({
          id: 'new-sprint',
          project_id: 'p1',
          name: 'Newly created',
          goal: null,
          status: 'future',
          start_date: null,
          end_date: null,
          created_at: '2026-07-16T12:00:00+00:00',
        })
      }
    >
      New sprint ({existing.length} existing)
    </button>
  ),
}))

const project = { id: 'p1', name: 'Sprintboard', key: 'SPB' } as Project

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

// The parent route's element is an `<Outlet context={...}>`, per the established pattern
// in BoardTab.test.tsx — a bare `<div />` has no outlet, so the nested route could never
// mount and the fixture would wire to nothing (the suite would pass vacuously).
//
// S6.2: sprints arrive through this context rather than a mocked `listSprints`, because
// the tab no longer owns the read. `sprintsPhase` is supplied per test, so the three-state
// read is still driven from here — the load itself is pinned in ProjectShell.test.tsx.
function renderTab(
  ctx: {
    sprints?: Sprint[]
    sprintsPhase?: SprintsPhase
    onSprintCreated?: (s: Sprint) => void
  } = {},
) {
  const context = {
    project,
    sprints: ctx.sprints ?? [],
    sprintsPhase: ctx.sprintsPhase ?? 'loaded',
    onSprintCreated: ctx.onSprintCreated ?? vi.fn(),
  } as ProjectShellContext
  return render(
    <MemoryRouter initialEntries={['/sprints']}>
      <Routes>
        <Route path="/" element={<Outlet context={context} />}>
          <Route path="sprints" element={<SprintsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('SprintsTab', () => {
  it('lists a sprint with its name, status, goal and ISO dates', () => {
    renderTab({
      sprints: [
        sprint({
          name: 'Hardening push',
          goal: 'Ship the board',
          start_date: '2026-07-20T00:00:00+00:00',
          end_date: '2026-08-03T00:00:00+00:00',
        }),
      ],
    })

    expect(screen.getByText('Hardening push')).toBeVisible()
    expect(screen.getByText('Future')).toBeVisible()
    expect(screen.getByText('Ship the board')).toBeVisible()
    // ISO, UTC-pinned: the day reads the same in every timezone.
    expect(screen.getByText('2026-07-20 – 2026-08-03')).toBeVisible()
  })

  it('renders a sprint with no dates or goal', () => {
    renderTab({ sprints: [sprint()] })

    expect(screen.getByText('Sprint 1')).toBeVisible()
    expect(screen.getByText('No dates set')).toBeVisible()
  })

  it('shows the empty state when the project has no sprints', () => {
    renderTab({ sprints: [] })

    expect(screen.getByText('No sprints yet.')).toBeVisible()
  })

  it('shows an error state — not an empty one — when the read has failed', () => {
    renderTab({ sprintsPhase: 'failed' })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load sprints.')
    expect(screen.queryByText('No sprints yet.')).not.toBeInTheDocument()
  })

  it('passes the loaded sprints to the create dialog for auto-naming', () => {
    renderTab({ sprints: [sprint(), sprint({ id: 's2' })] })

    expect(screen.getByRole('button', { name: 'New sprint (2 existing)' })).toBeVisible()
  })

  // The prepend itself now lives in the shell (it owns the list), so the tab's half of the
  // contract is that a created sprint is handed to `onSprintCreated`. The prepend *result*
  // — new sprint on top, existing one still below — is pinned end-to-end against the real
  // dialog in ProjectShell.test.tsx, so the behaviour is not lost at the task seam.
  it('hands a newly created sprint to the shell via onSprintCreated', async () => {
    const onSprintCreated = vi.fn()
    renderTab({ sprints: [sprint({ id: 's1', name: 'Older sprint' })], onSprintCreated })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'New sprint (1 existing)' }))

    expect(onSprintCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-sprint', name: 'Newly created' }),
    )
  })

  it('does not render the create trigger while sprints are still loading', () => {
    renderTab({ sprintsPhase: 'loading' })

    expect(screen.getByText('Loading…')).toBeVisible()
    expect(screen.queryByRole('button', { name: /New sprint/ })).not.toBeInTheDocument()
  })

  it('does not render the create trigger when the read has failed', () => {
    renderTab({ sprintsPhase: 'failed' })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load sprints.')
    expect(screen.queryByRole('button', { name: /New sprint/ })).not.toBeInTheDocument()
  })
})
