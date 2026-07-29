import type { ComponentType } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { BacklogTab } from './BacklogTab'
import type { ProjectShellContext } from './ProjectShell'

// SPRIN-61 AC6: "the same control works from the Backlog" — reaching the ticket detail
// dialog (and its keyboard-operable status picker) from a backlog row depends entirely on
// the row being a real `<button>`, not a clickable `<div>`. A `<div role="button"
// tabIndex={-1}>` renders identically to the eye and to every click-based test in
// `BoardTab.test.tsx`'s BacklogTab describe block, but is unreachable by Tab and does
// nothing on Enter. These two tests exist to catch exactly that regression.

const USER = { id: 'u1', email: 'dev@example.com' }

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
] as never

// Harness copied from `BoardTab.test.tsx` (`ctxWith` / `renderTab`) rather than
// reinvented, so both files exercise BacklogTab through the same router + outlet-context
// shape the real app renders it in.
function ctxWith(fields: Partial<ProjectShellContext> = {}): ProjectShellContext {
  return {
    project: {} as never,
    tickets: TICKETS,
    ticketsPhase: 'loaded',
    sprints: [],
    sprintsPhase: 'loaded',
    onRetry: vi.fn(),
    onSprintCreated: vi.fn(),
    onSprintUpdated: vi.fn(),
    onSprintCompleted: vi.fn(),
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

describe('BacklogTab keyboard reachability (SPRIN-61 AC6)', () => {
  it('is reachable by Tab', async () => {
    renderTab(BacklogTab)
    await userEvent.tab()
    expect(screen.getByRole('button', { name: /do the todo/i })).toHaveFocus()
  })

  it('opens the ticket on Enter, from the keyboard alone', async () => {
    const onOpenTicket = vi.fn()
    renderTab(BacklogTab, ctxWith({ onOpenTicket }))
    await userEvent.tab()
    expect(screen.getByRole('button', { name: /do the todo/i })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onOpenTicket).toHaveBeenCalledWith(TICKETS[0])
  })
})
