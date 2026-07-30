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

// SPRIN-63. Until this block existed the loading branch was pinned by NOTHING — every case
// above defaults to `ticketsPhase: 'loaded'` — so removing the vacuous
// `&& backlog.length === 0` conjunct from its guard would have gone green whether it was
// right or wrong. These two tests are what make the branch load-bearing, and they fail in
// opposite directions on purpose.
describe('BacklogTab does not claim an empty backlog while the read is in flight', () => {
  // Kills DELETING the branch: fall through and an in-flight read renders
  // "Nothing in the backlog." — a confident claim about work we have not seen yet, the
  // same defect the `failed`-before-empty ordering exists to prevent.
  it('renders Loading, not the empty state, while tickets are loading', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [] as never, ticketsPhase: 'loading' }))

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('Nothing in the backlog.')).not.toBeInTheDocument()
  })

  // Kills RE-ADDING the conjunct: with it back, a loading phase carrying rows falls
  // through and paints a list the read has not confirmed. The state is unreachable today
  // (`useTaggedRead` derives phase and items from one binding), which is exactly why the
  // guard must not depend on it — a guard that is only correct because of a coupling
  // enforced somewhere else is one refactor away from being wrong.
  it('renders Loading even if a row is somehow present in the loading phase', () => {
    renderTab(BacklogTab, ctxWith({ ticketsPhase: 'loading' }))

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /do the todo/i })).not.toBeInTheDocument()
  })
})
