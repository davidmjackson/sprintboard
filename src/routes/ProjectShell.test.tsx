import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectShell } from './ProjectShell'
import { BoardTab } from './BoardTab'
import { BacklogTab } from './BacklogTab'
import type { ProjectsContext } from './AppLayout'
import type { Ticket } from '@/lib/domain'
import { createTicket, listTickets } from '@/lib/tickets'

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ session: {}, user: { id: 'u1', email: 'a@example.com' }, loading: false }),
}))
vi.mock('@/lib/tickets', () => ({ listTickets: vi.fn(), createTicket: vi.fn() }))

const mockList = vi.mocked(listTickets)
beforeEach(() => {
  mockList.mockReset().mockResolvedValue([])
  vi.mocked(createTicket).mockReset()
})

const PROJECTS = [
  { id: 'p1', name: 'Apple', key: 'APP', owner_id: 'u1', project_type: 'scrum', created_at: '' },
] as never

const ticketBase: Ticket = {
  id: 'tA',
  project_id: 'p1',
  key: 'APP-1',
  number: 1,
  summary: 'Alpha summary',
  type: 'story',
  status: 'todo',
  description: null,
  assignee_id: null,
  story_points: null,
  acceptance_criteria: null,
  labels: [],
  sprint_id: null,
  parent_epic_id: null,
  context: null,
  deliverables: [],
  is_blocked: false,
  blocked_reason: null,
  blocked_since: null,
  created_at: '2026-07-15T00:00:00Z',
  updated_at: '2026-07-15T00:00:00Z',
}
const ticketA = ticketBase
const ticketB: Ticket = { ...ticketBase, id: 'tB', key: 'APP-2', number: 2, summary: 'Beta summary' }

/** Stands in for AppLayout: hands the project list down through the outlet context. */
function ContextProvider({ ctx }: { ctx: ProjectsContext }) {
  return <Outlet context={ctx} />
}

function renderShell(path: string, ctx: ProjectsContext = { projects: PROJECTS, loading: false }) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ContextProvider ctx={ctx} />}>
          <Route path="/" element={<p>home landing</p>} />
          <Route path="/projects/:projectId" element={<ProjectShell />}>
            <Route index element={<Navigate to="board" replace />} />
            <Route path="board" element={<BoardTab />} />
            <Route path="backlog" element={<BacklogTab />} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProjectShell', () => {
  it('shows a Board tab and a Backlog tab for an open project', () => {
    renderShell('/projects/p1')
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Backlog' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Apple/ })).toBeInTheDocument()
  })

  it('defaults to the Board tab (renders the four columns) with no tickets', () => {
    renderShell('/projects/p1')
    expect(screen.getByRole('heading', { name: 'To Do' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument()
  })

  it('opens the Backlog tab when clicked', async () => {
    const user = userEvent.setup()
    renderShell('/projects/p1')
    await user.click(screen.getByRole('link', { name: 'Backlog' }))
    expect(await screen.findByText('No tickets yet.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'To Do' })).not.toBeInTheDocument()
  })

  it('restores the Backlog tab from a deep link on load (survives a refresh)', async () => {
    renderShell('/projects/p1/backlog')
    expect(await screen.findByText('No tickets yet.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'To Do' })).not.toBeInTheDocument()
  })

  it('shows a New ticket button for an open project', async () => {
    renderShell('/projects/p1')
    expect(await screen.findByRole('button', { name: 'New ticket' })).toBeInTheDocument()
  })

  it('sends you home if the project id is not in your list', () => {
    renderShell('/projects/not-mine')
    expect(screen.getByText('home landing')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Board' })).not.toBeInTheDocument()
  })

  it('shows a loading state while the project list is loading', () => {
    renderShell('/projects/p1', { projects: [], loading: true })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('opens a ticket from its board card and resets edit state across a ticket switch (key remount)', async () => {
    const u = userEvent.setup()
    mockList.mockReset().mockResolvedValue([ticketA, ticketB])
    renderShell('/projects/p1')

    // The board renders both cards once the (mocked) fetch lands.
    await u.click(await screen.findByRole('button', { name: /Alpha summary/i }))

    // Dialog A opened from the card click; enter edit mode on its summary field.
    await u.click(await screen.findByRole('button', { name: /edit summary/i }))
    expect(screen.getByRole('textbox', { name: /summary/i })).toBeInTheDocument()

    // Close the modal (first Escape cancels the field edit, second dismisses the dialog),
    // then open ticket B — selection goes A → null → B, remounting the keyed dialog.
    await u.keyboard('{Escape}')
    await u.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /summary/i })).not.toBeInTheDocument(),
    )
    await u.click(await screen.findByRole('button', { name: /Beta summary/i }))

    // The remounted dialog shows B in VIEW mode — no textbox leaked across the switch.
    expect(await screen.findByRole('button', { name: /edit summary/i })).toHaveTextContent(
      'Beta summary',
    )
    expect(screen.queryByRole('textbox', { name: /summary/i })).not.toBeInTheDocument()
  })
})
