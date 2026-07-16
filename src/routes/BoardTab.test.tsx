import type { ComponentType } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { BoardTab } from './BoardTab'
import { BacklogTab } from './BacklogTab'
import type { ProjectShellContext } from './ProjectShell'

const USER = { id: 'u1', email: 'dev@example.com' }

// `sprint_id` is stated on every fixture, never left off: the backlog rule is
// `sprint_id === null` (strict), so an omitted field would be a silently different row
// from anything the database returns — `select()` always sends the column.
const TICKETS = [
  {
    id: 't1',
    key: 'MP-1',
    number: 1,
    summary: 'Do the todo',
    type: 'story',
    status: 'todo',
    sprint_id: null,
  },
  {
    id: 't2',
    key: 'MP-2',
    number: 2,
    summary: 'Ship it',
    type: 'bug',
    status: 'done',
    sprint_id: null,
  },
] as never

function ctxWith(fields: Partial<ProjectShellContext> = {}): ProjectShellContext {
  return {
    project: {} as never,
    tickets: TICKETS,
    ticketsPhase: 'loaded',
    sprints: [],
    sprintsPhase: 'loaded',
    onRetry: vi.fn(),
    onSprintCreated: vi.fn(),
    currentUser: USER,
    onOpenTicket: vi.fn(),
    onTicketUpdated: vi.fn(),
    onTicketDeleted: vi.fn(),
    ...fields,
  }
}

function renderTab(Tab: ComponentType, ctx: ProjectShellContext = ctxWith()) {
  function Provider() {
    return <Outlet context={ctx} />
  }
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<Provider />}>
          <Route index element={<Tab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('BoardTab', () => {
  it('renders all four columns in board order', () => {
    renderTab(BoardTab)
    const headings = screen.getAllByRole('heading').map((h) => h.textContent)
    expect(headings).toEqual(['To Do', 'In Progress', 'In Review', 'Done'])
  })

  it('places each ticket in its own status column, not merely on the page', () => {
    renderTab(BoardTab)
    const todo = screen.getByRole('heading', { name: 'To Do' }).closest('section')!
    const done = screen.getByRole('heading', { name: 'Done' }).closest('section')!
    // Scoped to the section, so a status→column mapping bug fails here rather than
    // passing because the text is present somewhere on the page.
    expect(within(todo).getByText('MP-1')).toBeInTheDocument()
    expect(within(todo).getByText('Do the todo')).toBeInTheDocument()
    expect(within(done).getByText('MP-2')).toBeInTheDocument()
    expect(within(done).getByText('Ship it')).toBeInTheDocument()
    expect(within(todo).queryByText('Ship it')).not.toBeInTheDocument()
  })

  it('shows an empty state in columns with no tickets', () => {
    renderTab(BoardTab)
    // To Do and Done have one ticket each; In Progress and In Review are empty.
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(2)
  })

  it('renders every column empty when there are no tickets', () => {
    renderTab(BoardTab, ctxWith({ tickets: [] }))
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(4)
  })

  it('shows a sprinted ticket on the board (S5.1: the sprint filter is the backlog, not the board)', () => {
    // The board is status-partitioned and sprint-blind. Only the backlog filters on
    // sprint_id — if that filter ever leaked into the board, a sprinted ticket would
    // vanish from the very view a sprint exists to drive.
    const sprinted = [
      {
        id: 't9',
        key: 'MP-9',
        number: 9,
        summary: 'In the sprint',
        type: 'story',
        status: 'todo',
        sprint_id: 's1',
      },
    ] as never
    renderTab(BoardTab, ctxWith({ tickets: sprinted }))
    const todo = screen.getByRole('heading', { name: 'To Do' }).closest('section')!
    expect(within(todo).getByText('In the sprint')).toBeInTheDocument()
  })

  it('opens the ticket detail modal when a card is clicked', async () => {
    const onOpenTicket = vi.fn()
    renderTab(BoardTab, ctxWith({ onOpenTicket }))
    await userEvent.click(screen.getByRole('button', { name: /do the todo/i }))
    expect(onOpenTicket).toHaveBeenCalled()
  })

  it('shows a failed read as an error, not as four empty columns (S4.6 AC 1)', () => {
    renderTab(BoardTab, ctxWith({ tickets: [], ticketsPhase: 'failed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tickets.')
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument()
  })

  it('renders ONE failure block instead of the column grid, not one per column', () => {
    // Four identical error boxes and four Retry buttons is not an error state. The grid
    // is replaced, so the column headings go too — there is nothing truthful to put
    // under them.
    renderTab(BoardTab, ctxWith({ tickets: [], ticketsPhase: 'failed' }))
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'To Do' })).not.toBeInTheDocument()
  })

  it('calls onRetry when Retry is clicked', async () => {
    const onRetry = vi.fn()
    renderTab(BoardTab, ctxWith({ tickets: [], ticketsPhase: 'failed', onRetry }))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows the EMPTY state, not the error, for a genuinely empty loaded board (S4.6 AC 2)', () => {
    // The positive control. Without it a board that rendered the error unconditionally
    // would pass every other test above: this is the assertion that failed and
    // genuinely-empty stay distinguishable.
    renderTab(BoardTab, ctxWith({ tickets: [], ticketsPhase: 'loaded' }))
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(4)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('claims neither empty nor failed while tickets load', () => {
    renderTab(BoardTab, ctxWith({ tickets: [], ticketsPhase: 'loading' }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps a blocked ticket in its status column and marks it blocked (S4.4 AC: it does not move)', () => {
    const blocked = [
      {
        id: 't1',
        key: 'MP-1',
        number: 1,
        summary: 'Do the todo',
        type: 'story',
        status: 'in_progress',
        sprint_id: null,
        is_blocked: true,
        blocked_reason: 'waiting on API',
      },
    ] as never
    renderTab(BoardTab, ctxWith({ tickets: blocked }))
    // Blocked is a flag, never a column: the ticket sits in In Progress with a marker.
    const inProgress = screen.getByRole('heading', { name: 'In Progress' }).closest('section')!
    expect(within(inProgress).getByText('MP-1')).toBeInTheDocument()
    expect(within(inProgress).getByText(/blocked/i)).toBeInTheDocument()
  })
})

describe('BacklogTab', () => {
  it('lists tickets with key, type and summary', () => {
    renderTab(BacklogTab)
    expect(screen.getByText('MP-1')).toBeInTheDocument()
    expect(screen.getByText('Ship it')).toBeInTheDocument()
  })

  it('shows only tickets with no sprint (S5.1 AC)', () => {
    const rows = [
      {
        id: 't1',
        key: 'MP-1',
        number: 1,
        summary: 'Unsprinted work',
        type: 'story',
        status: 'todo',
        sprint_id: null,
      },
      {
        id: 't2',
        key: 'MP-2',
        number: 2,
        summary: 'Sprinted work',
        type: 'story',
        status: 'todo',
        sprint_id: 's1',
      },
    ] as never
    renderTab(BacklogTab, ctxWith({ tickets: rows }))
    expect(screen.getByText('Unsprinted work')).toBeInTheDocument()
    expect(screen.queryByText('Sprinted work')).not.toBeInTheDocument()
  })

  it('does not show a Done ticket from a completed sprint (S5.1 AC)', () => {
    // The backlog is `sprint_id is null`, not "outside the active sprint" — sprint
    // history (S6.4) must not leak back in.
    const rows = [
      {
        id: 't2',
        key: 'MP-2',
        number: 2,
        summary: 'Finished last sprint',
        type: 'story',
        status: 'done',
        sprint_id: 's-past',
      },
    ] as never
    renderTab(BacklogTab, ctxWith({ tickets: rows }))
    expect(screen.queryByText('Finished last sprint')).not.toBeInTheDocument()
    expect(screen.getByText('Nothing in the backlog.')).toBeInTheDocument()
  })

  it('shows story points and the assignee on a row (S5.1 AC)', () => {
    const rows = [
      {
        id: 't1',
        key: 'MP-1',
        number: 1,
        summary: 'Do the todo',
        type: 'story',
        status: 'todo',
        sprint_id: null,
        story_points: 5,
        assignee_id: USER.id,
      },
    ] as never
    renderTab(BacklogTab, ctxWith({ tickets: rows }))
    const row = screen.getByRole('button', { name: /do the todo/i })
    expect(within(row).getByText('5')).toBeInTheDocument()
    // The positive control for the negative assertion in the next test: proves the
    // "story points" text exists to be missing, so that test cannot pass because the
    // label was renamed or dropped.
    expect(within(row).getByText(/story points/i)).toBeInTheDocument()
    expect(within(row).getByText(USER.email)).toBeInTheDocument()
  })

  it('falls back to "You" rather than a blank cell when the session has no email', () => {
    const rows = [
      {
        id: 't1',
        key: 'MP-1',
        number: 1,
        summary: 'Do the todo',
        type: 'story',
        status: 'todo',
        sprint_id: null,
        assignee_id: USER.id,
      },
    ] as never
    // The shell builds `email: user.email ?? ''`, so '' is representable. An assigned
    // ticket must never render an empty assignee cell — that reads as broken, not as
    // assigned-to-you.
    renderTab(BacklogTab, ctxWith({ tickets: rows, currentUser: { id: USER.id, email: '' } }))
    const row = screen.getByRole('button', { name: /do the todo/i })
    expect(within(row).getByText('You')).toBeInTheDocument()
    expect(within(row).queryByText('Unassigned')).not.toBeInTheDocument()
  })

  it('shows Unassigned and no points when the row has neither', () => {
    const rows = [
      {
        id: 't1',
        key: 'MP-1',
        number: 1,
        summary: 'Do the todo',
        type: 'story',
        status: 'todo',
        sprint_id: null,
        story_points: null,
        assignee_id: null,
      },
    ] as never
    renderTab(BacklogTab, ctxWith({ tickets: rows }))
    const row = screen.getByRole('button', { name: /do the todo/i })
    expect(within(row).getByText('Unassigned')).toBeInTheDocument()
    expect(within(row).queryByText(/story points/i)).not.toBeInTheDocument()
  })

  it('shows a zero-point row as 0, not as unestimated', () => {
    // 0 is a real estimate and must not be swallowed by a falsy check.
    const rows = [
      {
        id: 't1',
        key: 'MP-1',
        number: 1,
        summary: 'Do the todo',
        type: 'story',
        status: 'todo',
        sprint_id: null,
        story_points: 0,
        assignee_id: null,
      },
    ] as never
    renderTab(BacklogTab, ctxWith({ tickets: rows }))
    const row = screen.getByRole('button', { name: /do the todo/i })
    expect(within(row).getByText('0')).toBeInTheDocument()
  })

  it('shows an empty state when there are no tickets', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [] }))
    expect(screen.getByText('Nothing in the backlog.')).toBeInTheDocument()
  })

  it('shows a loading state while tickets load', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [], ticketsPhase: 'loading' }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('claims neither empty nor failed while tickets load', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [], ticketsPhase: 'loading' }))
    expect(screen.queryByText('Nothing in the backlog.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a failed read as an error, not as an empty backlog (S4.6 AC 1)', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [], ticketsPhase: 'failed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tickets.')
    expect(screen.queryByText('Nothing in the backlog.')).not.toBeInTheDocument()
  })

  it('calls onRetry when Retry is clicked', async () => {
    const onRetry = vi.fn()
    renderTab(BacklogTab, ctxWith({ tickets: [], ticketsPhase: 'failed', onRetry }))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows the EMPTY state, not the error, for a genuinely empty loaded backlog (S4.6 AC 2)', () => {
    // The positive control — see the board's twin. A backlog that rendered the error
    // unconditionally would pass every other failure test in this file.
    renderTab(BacklogTab, ctxWith({ tickets: [], ticketsPhase: 'loaded' }))
    expect(screen.getByText('Nothing in the backlog.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the empty state when every ticket is sprinted and the read succeeded', () => {
    // The other genuinely-empty case: rows exist, none belong in the backlog. Distinct
    // from a failed read, which returns [] for a different reason entirely.
    const rows = [
      {
        id: 't2',
        key: 'MP-2',
        number: 2,
        summary: 'Sprinted work',
        type: 'story',
        status: 'todo',
        sprint_id: 's1',
      },
    ] as never
    renderTab(BacklogTab, ctxWith({ tickets: rows, ticketsPhase: 'loaded' }))
    expect(screen.getByText('Nothing in the backlog.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('opens the ticket detail modal when a row is clicked', async () => {
    const onOpenTicket = vi.fn()
    renderTab(BacklogTab, ctxWith({ onOpenTicket }))
    await userEvent.click(screen.getByRole('button', { name: /do the todo/i }))
    expect(onOpenTicket).toHaveBeenCalledWith(TICKETS[0])
  })

  it('shows a Blocked marker on a blocked ticket row', () => {
    const rows = [
      {
        id: 't1',
        key: 'MP-1',
        number: 1,
        summary: 'Do the todo',
        type: 'story',
        status: 'todo',
        sprint_id: null,
        is_blocked: true,
        blocked_reason: 'waiting on API',
      },
    ] as never
    renderTab(BacklogTab, ctxWith({ tickets: rows }))
    const row = screen.getByRole('button', { name: /do the todo/i })
    expect(within(row).getByText(/blocked/i)).toBeInTheDocument()
  })
})
