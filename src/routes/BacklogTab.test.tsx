import type { ComponentType } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { BacklogTab } from './BacklogTab'
import type { ProjectShellContext } from './ProjectShell'
import { DEFAULT_PROJECT_STATUSES } from '@/lib/domain'
import type { ProjectStatus } from '@/lib/domain'

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
// The four seeded rows, as `BoardTab.test.tsx` builds them. The backlog does not render
// columns, so these exist only to keep the context shape identical to the one `ProjectShell`
// publishes — a harness that omitted them would be a different shell from the real one.
const SEEDED_STATUSES = DEFAULT_PROJECT_STATUSES.map((status, i) => ({
  ...status,
  id: `1ecd8f0${i}-0000-4000-8000-000000000000`,
  project_id: 'p1',
})) as unknown as ProjectStatus[]

function ctxWith(fields: Partial<ProjectShellContext> = {}): ProjectShellContext {
  return {
    // Explicitly Scrum — the same note as in `BoardTab.test.tsx`. `hasSprints({})` is
    // `undefined === 'scrum'` → false, so an empty object would silently turn this whole file
    // into a Kanban suite the moment the tab consults the project (SPRIN-83). Stating it also
    // makes every "Nothing in the backlog." expectation below a positive control for AC4:
    // they pass only because this says 'scrum'.
    project: { project_type: 'scrum' } as never,
    tickets: TICKETS,
    ticketsPhase: 'loaded',
    sprints: [],
    sprintsPhase: 'loaded',
    statuses: SEEDED_STATUSES,
    statusesPhase: 'loaded',
    // SPRIN-90. Shape parity with `ProjectShell`'s real context; the backlog reads neither.
    fields: [],
    fieldsPhase: 'loaded',
    onStatusCreated: vi.fn(),
    onStatusUpdated: vi.fn(),
    onStatusDeleted: vi.fn(),
    onStatusesReordered: vi.fn(),
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
  // SPRIN-68 put the search box ahead of the list in DOM order, so it is now the first real
  // tab stop — a second `Tab` is what reaches the row, not a change in reachability itself.
  it('is reachable by Tab', async () => {
    renderTab(BacklogTab)
    await userEvent.tab()
    await userEvent.tab()
    expect(screen.getByRole('button', { name: /do the todo/i })).toHaveFocus()
  })

  it('opens the ticket on Enter, from the keyboard alone', async () => {
    const onOpenTicket = vi.fn()
    renderTab(BacklogTab, ctxWith({ onOpenTicket }))
    await userEvent.tab()
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
// design. In this test environment no stylesheet is loaded, so Tailwind's `flex` never
// enters the cascade and every <span> falls back to the UA default `inline` — and jsdom
// does not blockify flex children even when `display:flex` IS set. A browser does both, so
// it separates the parts where jsdom fuses them, producing a string no user ever hears.
// (`dom-accessibility-api` DOES read computed `display` and separate on non-inline — an
// earlier draft of this comment said it "performs no layout", which is false and was
// corrected in review.) What is asserted here is DOM text, its container, and its presence
// in the name — all true in every engine. See CLAUDE.md.
function ticketsWith(fields: Record<string, unknown>) {
  return [
    {
      id: 't1',
      key: 'MP-1',
      number: 1,
      summary: 'Do the todo',
      type: 'story',
      status: 'todo',
      sprint_id: null,
      ...fields,
    },
  ] as never
}

const ASSIGNED_TICKETS = ticketsWith({ assignee_id: USER.id })
// A real uuid belonging to SOMEBODY ELSE. `assignee_id uuid references auth.users(id)` has
// nothing tying it to `owner_id`, so this value is storable today.
const FOREIGN_TICKETS = ticketsWith({ assignee_id: '99999999-9999-4999-8999-999999999999' })

describe('BacklogTab says who a ticket is assigned to (SPRIN-67)', () => {
  // Scoped to the row's <button> because the entire `sr-only`-over-`aria-label` decision
  // rests on the text joining the BUTTON's accessible name.
  //
  // Honest note on what that scoping now buys, because the first version of this comment
  // overclaimed and review caught it: with only `getByText`, the scoping WAS the sole
  // control — unscoped, moving the prefix out of the button stayed green. The name query
  // added below now *also* reddens that mutation, so the two overlap and removing the
  // scoping alone no longer goes green for the right reason. Keep it anyway: it is the
  // assertion that names the property, and a defence that is currently redundant is not
  // the same as one that is unnecessary.
  it('prefixes the assignee with a screen-reader-only label, inside the row button', () => {
    renderTab(BacklogTab, ctxWith({ tickets: ASSIGNED_TICKETS }))

    const row = screen.getByRole('button', { name: /do the todo/i })
    const prefix = within(row).getByText(/assigned to/i)

    // The text must reach the ACCESSIBILITY TREE, not merely the DOM — which is the whole
    // point of the story and which `getByText` says nothing about. A **substring** name
    // query, never an exact one: the exact string differs per engine (see CLAUDE.md), but
    // "the name contains this" is true in all of them. Without this line, adding
    // `aria-hidden="true"` to the prefix reverts the entire fix with every test green —
    // `getByText` ignores only `<script>`/`<style>` and happily matches hidden subtrees,
    // while the name computation correctly excludes them.
    expect(screen.getByRole('button', { name: /assigned to/i })).toBe(row)

    // Exact class, NOT `toHaveClass` — that is a subset check, so `sr-only hidden` (the
    // likelier accident, added while tidying) passes it while the prefix stops rendering
    // at all. jsdom loads no stylesheet, so the class string is the only available handle
    // on "carries no visible weight"; the browser-level version of this is disclosed in
    // the PR's "Not verified here".
    expect(prefix).toHaveAttribute('class', 'sr-only')

    // Order, not merely presence. The spec requires a PREFIX: a suffix reads as a trailing
    // fragment ("… dev@example.com assigned to") and survives every other assertion here.
    // `parentElement` is the assignee cell that holds the prefix and the value together.
    const cell = prefix.parentElement
    expect(cell).toHaveTextContent(/^Assigned to dev@example\.com$/)

    // The VALUE must stay visible while only its label is hidden. `getByText` resolves to
    // the element whose *direct* text children match, so wrapping the email in any element
    // — `sr-only` included, which would blank the cell on screen — moves this away from the
    // cell and reddens the assertion. Without it that mutation ships green.
    expect(within(row).getByText(USER.email)).toBe(cell)
  })

  // The negative half. Its positive control is the test above — on its own this would pass
  // just as happily if the prefix were never rendered anywhere at all.
  it('does not say "assigned to" on an unassigned row', () => {
    renderTab(BacklogTab)

    const row = screen.getByRole('button', { name: /do the todo/i })

    expect(within(row).queryByText(/assigned to/i)).not.toBeInTheDocument()
    expect(within(row).getByText('Unassigned')).toBeInTheDocument()
  })

  // The row above has NO assignee, so it cannot tell "mine" from "somebody else's" — and
  // that distinction is the one this story put a sentence on top of. Widening the predicate
  // to `assignee_id != null` announced "Assigned to dev@example.com" over another user's
  // ticket — the viewer's own address, a false ownership claim — with all 65 tests green.
  //
  // Unreachable today only because Phase 1 is single-owner; the schema does not enforce it
  // (`assignee_id uuid references auth.users(id)`, with nothing tying it to `owner_id`).
  // That is the argument FOR pinning it, exactly as the `backlog.length === 0` conjunct
  // above was pinned for being unreachable-but-not-guaranteed.
  it('does not claim a ticket that is assigned to somebody else', () => {
    renderTab(BacklogTab, ctxWith({ tickets: FOREIGN_TICKETS }))

    const row = screen.getByRole('button', { name: /do the todo/i })

    expect(within(row).queryByText(/assigned to/i)).not.toBeInTheDocument()
    expect(within(row).queryByText(USER.email)).not.toBeInTheDocument()
    expect(within(row).getByText('Unassigned')).toBeInTheDocument()
  })
})

const SEARCH_TICKETS = [
  {
    id: 't1',
    key: 'MP-1',
    number: 1,
    summary: 'Wire the board',
    type: 'story',
    status: 'todo',
    sprint_id: null,
    is_blocked: false,
    story_points: null,
    assignee_id: null,
    labels: [],
  },
  {
    id: 't2',
    key: 'MP-2',
    number: 2,
    summary: 'Fix the login redirect',
    type: 'bug',
    status: 'todo',
    sprint_id: null,
    is_blocked: false,
    story_points: null,
    assignee_id: null,
    labels: [],
  },
  // A ticket that matches the same query as MP-2 but is IN A SPRINT — the Backlog must
  // search the backlog, not every ticket in the project. Without this ticket, `backlog`
  // and `tickets` are the same array under test (every fixture ticket has `sprint_id:
  // null`), so `selectMatchingTickets(tickets, query)` and `selectMatchingTickets(backlog,
  // query)` cannot be told apart and a regression that widened the search to all tickets
  // would ship green.
  {
    id: 't3',
    key: 'MP-3',
    number: 3,
    summary: 'Login help center article',
    type: 'task',
    status: 'in_progress',
    sprint_id: 's1',
    is_blocked: false,
    story_points: null,
    assignee_id: null,
    labels: [],
  },
] as never

describe('BacklogTab search (SPRIN-68)', () => {
  it('filters rows by summary as you type', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    const box = screen.getByRole('searchbox', { name: /search/i })
    await userEvent.type(box, 'login')
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
    // The control on the other side: MP-3 also matches "login" by summary, but it is IN A
    // SPRINT, so it must never appear here — the Backlog searches the backlog, not the
    // project's whole ticket list.
    expect(
      screen.queryByRole('button', { name: /login help center article/i }),
    ).not.toBeInTheDocument()
    // Pins the box's own displayed value, not just its filtering effect — a hardcoded or
    // disconnected `value` prop can still filter correctly by coincidence of which key the
    // React state happens to hold (SPRIN-68 fix-round-1 review finding).
    expect(box).toHaveValue('login')
  })

  // I4 (SPRIN-68 final review): every query used elsewhere in this suite is a single token.
  // A query containing a SPACE is the feature's headline use case ("login redirect") and
  // nothing had ever typed one — `onChange(e.target.value.trim())` in `TicketSearchInput`
  // eats interior spaces too (`.trim()` only strips the ends, but this mutation applies it
  // on every keystroke, so by the time "login redirect" is fully typed the trailing " r" of
  // "login r" would have been trimmed mid-type and the final value corrupted), turning
  // "login redirect" into a query that matches nothing. This test also pins the placeholder,
  // which nothing else in the suite asserts.
  it('matches on a multi-word query, including the interior space (I4)', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    const box = screen.getByRole('searchbox', { name: /search/i })
    expect(box).toHaveAttribute('placeholder', 'Key or summary')
    await userEvent.type(box, 'login redirect')
    expect(box).toHaveValue('login redirect')
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
  })

  it('filters rows by ticket key', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'MP-2')
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
  })

  it('shows everything again when the query is cleared (AC4)', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    const box = screen.getByRole('searchbox', { name: /search/i })
    await userEvent.type(box, 'login')
    // Proves the list was actually narrowed BEFORE the clear — without this, the end state
    // asserted below is also the start state, and a fully disconnected `onChange` would
    // stay green (nothing was ever filtered, so nothing needed to come back).
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
    await userEvent.clear(box)
    expect(screen.getByRole('button', { name: /wire the board/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
  })

  // AC5. The negative assertion is the point: a filtered-empty backlog must NOT claim the
  // project has no backlog. Asserting only the new message would stay green if both rendered.
  it('says no matches, and does not claim the backlog is empty', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzz')
    expect(screen.getByText(/no tickets match your search/i)).toBeInTheDocument()
    expect(screen.queryByText(/nothing in the backlog/i)).not.toBeInTheDocument()
  })

  // The positive control for the test above: the real empty backlog still says the real thing.
  it('still says the backlog is empty when it genuinely is', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [] as never }))
    expect(screen.getByText(/nothing in the backlog/i)).toBeInTheDocument()
  })

  // The stranding guard: the box that got you here must still be there to get you out.
  it('keeps the search box rendered when the query matches nothing', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    const box = screen.getByRole('searchbox', { name: /search/i })
    await userEvent.type(box, 'zzz')
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument()
    await userEvent.clear(box)
    expect(screen.getByRole('button', { name: /wire the board/i })).toBeInTheDocument()
  })

  // A search box over an empty backlog is furniture with nothing to do.
  it('does not render the search box when the backlog is genuinely empty', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [] as never }))
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })

  // M4 (SPRIN-68 post-merge review): the filtered-empty message appears in direct response to
  // typing, the same as this project's other informational messages (`TicketDetailHeader.tsx`'s
  // `role="status"`), but it was a plain <p> announcing nothing. `getByRole('status', ...)`
  // resolves ONLY an element with that role, so this fails if the attribute is dropped.
  it('announces the no-matches message to screen readers (M4)', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzz')
    expect(screen.getByRole('status')).toHaveTextContent(/no tickets match your search/i)
  })
})

/**
 * SPRIN-83 AC4 — on a project without sprints this tab is a flat list of every ticket, so its
 * empty state must speak about the PROJECT rather than about a backlog the project does not
 * have. `selectBacklogTickets` is unchanged: `sprint_id is null` is simply true of every
 * ticket there, which is what makes the flat reading honest.
 *
 * The two wordings are asserted as a PAIR, in both directions. A test that only checked the
 * new sentence would pass just as well on an implementation that returned it for every
 * project type — the Scrum copy would have been silently overwritten and nothing here would
 * have noticed. Each test therefore names the sentence it expects AND denies the other one.
 */
describe('the empty state names what the list is (SPRIN-83 AC4)', () => {
  it('speaks of the backlog on a project with sprints', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [] as never }))
    expect(screen.getByText('Nothing in the backlog.')).toBeInTheDocument()
    expect(screen.queryByText('This project has no tickets.')).not.toBeInTheDocument()
  })

  it('speaks of the project on a project without sprints', () => {
    renderTab(
      BacklogTab,
      ctxWith({ tickets: [] as never, project: { project_type: 'kanban' } as never }),
    )
    expect(screen.getByText('This project has no tickets.')).toBeInTheDocument()
    expect(screen.queryByText('Nothing in the backlog.')).not.toBeInTheDocument()
  })

  // AC4's second half, and the reason the empty-state pair above is not the whole story: on
  // this project type the tab is a flat list of EVERYTHING, so it must really be everything.
  // Without this, a "fix" that emptied the list for a project without sprints would satisfy
  // both tests above perfectly.
  //
  // The sprinted ticket is the review finding, not padding. `selectBoardScope` deliberately
  // ignores `sprint_id` on a project without sprints, so a tab still filtering on
  // `sprint_id is null` would SHOW this ticket on the board and HIDE it here — two tabs
  // disagreeing about the same ticket, under a nav link that now reads "All tickets".
  // `BoardTab.test.tsx`'s own fixture holds exactly this ticket and asserts it renders, so
  // without this line the two suites pin contradictory behaviour and both stay green. The
  // state is unreachable today (the type is immutable and SPRIN-82 removed the sprint-create
  // path) and pinned anyway, for the same reason `selectBoardScope` states its own half.
  it("lists every one of the project's tickets on a project without sprints", () => {
    const tickets = [
      ...(TICKETS as unknown as Record<string, unknown>[]),
      {
        id: 't2',
        key: 'MP-2',
        number: 2,
        summary: 'Carried a sprint id',
        type: 'story',
        status: 'todo',
        sprint_id: 's1',
      },
    ] as never
    renderTab(BacklogTab, ctxWith({ tickets, project: { project_type: 'kanban' } as never }))
    expect(screen.getByRole('button', { name: /do the todo/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /carried a sprint id/i })).toBeInTheDocument()
    expect(screen.queryByText('This project has no tickets.')).not.toBeInTheDocument()
  })

  // The other side of the same pair: the backlog RULE is untouched, so a project WITH sprints
  // still hides a sprinted ticket from this tab. Without it, `selectTicketList` could return
  // every ticket for every project type and the test above would not notice.
  it('still hides a sprinted ticket on a project with sprints', () => {
    const tickets = [
      ...(TICKETS as unknown as Record<string, unknown>[]),
      {
        id: 't2',
        key: 'MP-2',
        number: 2,
        summary: 'Carried a sprint id',
        type: 'story',
        status: 'todo',
        sprint_id: 's1',
      },
    ] as never
    renderTab(BacklogTab, ctxWith({ tickets }))
    expect(screen.getByRole('button', { name: /do the todo/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /carried a sprint id/i })).not.toBeInTheDocument()
  })
})
