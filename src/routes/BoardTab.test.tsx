import type { ComponentType } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { BoardTab } from './BoardTab'
import { BacklogTab } from './BacklogTab'
import type { ProjectShellContext } from './ProjectShell'

const TICKETS = [
  { id: 't1', key: 'MP-1', number: 1, summary: 'Do the todo', type: 'story', status: 'todo' },
  { id: 't2', key: 'MP-2', number: 2, summary: 'Ship it', type: 'bug', status: 'done' },
] as never

function renderTab(
  Tab: ComponentType,
  ctx: ProjectShellContext = {
    project: {} as never,
    tickets: TICKETS,
    loadingTickets: false,
    onOpenTicket: vi.fn(),
    onTicketUpdated: vi.fn(),
    onTicketDeleted: vi.fn(),
  },
) {
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
    renderTab(BoardTab, {
      project: {} as never,
      tickets: [],
      loadingTickets: false,
      onOpenTicket: vi.fn(),
      onTicketUpdated: vi.fn(),
      onTicketDeleted: vi.fn(),
    })
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(4)
  })

  it('opens the ticket detail modal when a card is clicked', async () => {
    const onOpenTicket = vi.fn()
    renderTab(BoardTab, {
      project: {} as never,
      tickets: TICKETS,
      loadingTickets: false,
      onOpenTicket,
      onTicketUpdated: vi.fn(),
      onTicketDeleted: vi.fn(),
    })
    await userEvent.click(screen.getByRole('button', { name: /do the todo/i }))
    expect(onOpenTicket).toHaveBeenCalled()
  })
})

describe('BacklogTab', () => {
  it('lists tickets with key, type and summary', () => {
    renderTab(BacklogTab)
    expect(screen.getByText('MP-1')).toBeInTheDocument()
    expect(screen.getByText('Ship it')).toBeInTheDocument()
  })

  it('shows an empty state when there are no tickets', () => {
    renderTab(BacklogTab, {
      project: {} as never,
      tickets: [],
      loadingTickets: false,
      onOpenTicket: vi.fn(),
      onTicketUpdated: vi.fn(),
      onTicketDeleted: vi.fn(),
    })
    expect(screen.getByText('No tickets yet.')).toBeInTheDocument()
  })

  it('shows a loading state while tickets load', () => {
    renderTab(BacklogTab, {
      project: {} as never,
      tickets: [],
      loadingTickets: true,
      onOpenTicket: vi.fn(),
      onTicketUpdated: vi.fn(),
      onTicketDeleted: vi.fn(),
    })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('opens the ticket detail modal when a row is clicked', async () => {
    const onOpenTicket = vi.fn()
    renderTab(BacklogTab, {
      project: {} as never,
      tickets: TICKETS,
      loadingTickets: false,
      onOpenTicket,
      onTicketUpdated: vi.fn(),
      onTicketDeleted: vi.fn(),
    })
    await userEvent.click(screen.getByRole('button', { name: /do the todo/i }))
    expect(onOpenTicket).toHaveBeenCalledWith(TICKETS[0])
  })
})
