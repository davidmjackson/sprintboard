import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

import { SprintsTab } from './SprintsTab'
import type { ProjectShellContext } from './ProjectShell'
import { listSprints } from '@/lib/sprints'
import type { Project, Sprint } from '@/lib/domain'

vi.mock('@/lib/sprints', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sprints')>()),
  listSprints: vi.fn(),
}))

// The dialog is exercised by its own suite; here it is a button that reports its props.
vi.mock('./CreateSprintDialog', () => ({
  CreateSprintDialog: ({ existing }: { existing: readonly Sprint[] }) => (
    <button type="button">New sprint ({existing.length} existing)</button>
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

// The brief's original renderTab() used a bare `<div />` as the parent route's
// element, with no `<Outlet>` — so the nested "sprints" route could never mount, and
// the `project` fixture above was declared but never wired to any outlet context.
// Fixed to match the established pattern in BoardTab.test.tsx: the parent route
// element is an `<Outlet context={...}>` so the nested route actually renders and
// `useOutletContext<ProjectShellContext>()` resolves to something real.
function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/sprints']}>
      <Routes>
        <Route path="/" element={<Outlet context={{ project } as ProjectShellContext} />}>
          <Route path="sprints" element={<SprintsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.mocked(listSprints).mockReset()
  vi.mocked(listSprints).mockResolvedValue([])
})

describe('SprintsTab', () => {
  it('lists a sprint with its name, status, goal and ISO dates', async () => {
    vi.mocked(listSprints).mockResolvedValue([
      sprint({
        name: 'Hardening push',
        goal: 'Ship the board',
        start_date: '2026-07-20T00:00:00+00:00',
        end_date: '2026-08-03T00:00:00+00:00',
      }),
    ])
    renderTab()

    expect(await screen.findByText('Hardening push')).toBeVisible()
    expect(screen.getByText('Future')).toBeVisible()
    expect(screen.getByText('Ship the board')).toBeVisible()
    // ISO, UTC-pinned: the day reads the same in every timezone.
    expect(screen.getByText('2026-07-20 – 2026-08-03')).toBeVisible()
  })

  it('renders a sprint with no dates or goal', async () => {
    vi.mocked(listSprints).mockResolvedValue([sprint()])
    renderTab()

    expect(await screen.findByText('Sprint 1')).toBeVisible()
    expect(screen.getByText('No dates set')).toBeVisible()
  })

  it('shows the empty state when the project has no sprints', async () => {
    renderTab()

    expect(await screen.findByText('No sprints yet.')).toBeVisible()
  })

  it('shows an error state — not an empty one — when the read fails', async () => {
    vi.mocked(listSprints).mockRejectedValue(new Error('offline'))
    renderTab()

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load sprints.')
    expect(screen.queryByText('No sprints yet.')).not.toBeInTheDocument()
  })

  it('passes the loaded sprints to the create dialog for auto-naming', async () => {
    vi.mocked(listSprints).mockResolvedValue([sprint(), sprint({ id: 's2' })])
    renderTab()

    expect(await screen.findByRole('button', { name: 'New sprint (2 existing)' })).toBeVisible()
  })
})
