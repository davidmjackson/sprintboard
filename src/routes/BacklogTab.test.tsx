import type { ComponentType } from 'react'
import { render, screen, within } from '@testing-library/react'
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

// SPRIN-63, and the scope of this test is narrower than it first looks — stated precisely
// because the first draft of this comment got it wrong.
//
// DELETING the `ticketsPhase === 'loading'` branch was ALREADY pinned, by
// `BoardTab.test.tsx:551` and `:556`, which render this same component through the same
// harness with an empty, loading context. Nothing here is needed for that.
//
// What was pinned by nothing is the `&& backlog.length === 0` CONJUNCT that guard used to
// carry: no test anywhere renders BacklogTab loading AND holding rows, so removing the
// conjunct would have gone green whether it was right or wrong. That single gap is what
// this test closes.
describe('BacklogTab does not paint an unconfirmed list while the read is in flight', () => {
  // Kills RE-ADDING the conjunct: with it back, a loading phase carrying rows falls through
  // and paints a list the read has not confirmed. The state is unreachable today
  // (`useTaggedRead` derives phase and items from one binding), which is exactly why the
  // guard must not depend on it — a guard that is only correct because of a coupling
  // enforced somewhere else is one refactor away from being wrong.
  it('renders Loading even if a row is somehow present in the loading phase', () => {
    renderTab(BacklogTab, ctxWith({ ticketsPhase: 'loading' }))

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /do the todo/i })).not.toBeInTheDocument()
  })
})

// SPRIN-67. Every other part of a backlog row says what it is — the key looks like a key,
// the type is a word, the points badge carries its unit via S5.1's `sr-only` text. The
// assignee was the one bare value, so the row's accessible name ended
// "… 5 story points dev@example.com" with nothing naming it.
//
// These tests deliberately do NOT assert an exact accessible name, and that is the whole
// design. Under jsdom `dom-accessibility-api` performs no layout, so it cannot see that a
// row's flex children are blockified and it concatenates them with no separator — a string
// no browser ever produces. Asserting it would pin a fiction. What is asserted here is DOM
// text and the container it sits in: both are true in every engine. See CLAUDE.md.
const ASSIGNED_TICKETS = [
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

describe('BacklogTab says who a ticket is assigned to (SPRIN-67)', () => {
  // Scoped to the row's <button> ON PURPOSE, and that scoping is the test. The entire
  // `sr-only`-over-`aria-label` decision rests on the text joining the BUTTON's accessible
  // name, so an unscoped `screen.getByText` would sit green with the prefix rendered
  // outside the button — exactly how SPRIN-65's points badge escaped all 12 of its tests.
  it('prefixes the assignee with a screen-reader-only label, inside the row button', () => {
    renderTab(BacklogTab, ctxWith({ tickets: ASSIGNED_TICKETS }))

    const row = screen.getByRole('button', { name: /do the todo/i })
    const prefix = within(row).getByText(/assigned to/i)

    expect(prefix).toBeInTheDocument()
    // The only control available for "carries no visible weight": jsdom applies no real
    // stylesheet, so `sr-only` cannot be observed as invisibility, only as the class that
    // Tailwind hides. Without this a plainly visible "Assigned to" would ship green.
    expect(prefix).toHaveClass('sr-only')
    expect(within(row).getByText(USER.email)).toBeInTheDocument()
  })

  // The negative half. Its positive control is the test above — on its own this would pass
  // just as happily if the prefix were never rendered anywhere at all.
  it('does not say "assigned to" on an unassigned row', () => {
    renderTab(BacklogTab)

    const row = screen.getByRole('button', { name: /do the todo/i })

    expect(within(row).queryByText(/assigned to/i)).not.toBeInTheDocument()
    expect(within(row).getByText('Unassigned')).toBeInTheDocument()
  })
})
