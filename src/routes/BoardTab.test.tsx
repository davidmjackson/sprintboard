import { render, screen } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { BoardTab } from './BoardTab'
import { BacklogTab } from './BacklogTab'
import type { ProjectShellContext } from './ProjectShell'

const TICKETS = [
  { id: 't1', key: 'MP-1', number: 1, summary: 'Do the todo', type: 'story', status: 'todo' },
  { id: 't2', key: 'MP-2', number: 2, summary: 'Ship it', type: 'bug', status: 'done' },
] as never

function renderTab(
  Tab: () => JSX.Element,
  ctx: ProjectShellContext = {
    project: {} as never,
    tickets: TICKETS,
    loadingTickets: false,
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

  it('places each ticket in its status column and shows its key and summary', () => {
    renderTab(BoardTab)
    expect(screen.getByText('MP-1')).toBeInTheDocument()
    expect(screen.getByText('Do the todo')).toBeInTheDocument()
    expect(screen.getByText('Ship it')).toBeInTheDocument()
  })

  it('shows an empty state in columns with no tickets', () => {
    renderTab(BoardTab)
    // To Do and Done have one ticket each; In Progress and In Review are empty.
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(2)
  })

  it('renders every column empty when there are no tickets', () => {
    renderTab(BoardTab, { project: {} as never, tickets: [], loadingTickets: false })
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(4)
  })
})

describe('BacklogTab', () => {
  it('lists tickets with key, type and summary', () => {
    renderTab(BacklogTab)
    expect(screen.getByText('MP-1')).toBeInTheDocument()
    expect(screen.getByText('Ship it')).toBeInTheDocument()
  })

  it('shows an empty state when there are no tickets', () => {
    renderTab(BacklogTab, { project: {} as never, tickets: [], loadingTickets: false })
    expect(screen.getByText('No tickets yet.')).toBeInTheDocument()
  })

  it('shows a loading state while tickets load', () => {
    renderTab(BacklogTab, { project: {} as never, tickets: [], loadingTickets: true })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})
