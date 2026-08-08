import type { ComponentType } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { BoardTab } from './BoardTab'
import type { ProjectShellContext } from './ProjectShell'
import type { ProjectStatus, ProjectType } from '@/lib/domain'
import * as tickets from '@/lib/tickets'

/**
 * SPRIN-86 — the board flags an over-limit column.
 *
 * Its own file rather than more of `BoardTab.test.tsx`, which is already the largest suite in
 * the repo, and these cases are a coherent group with their own fixtures: Kanban projects,
 * two columns, and a `wip_limit` stated on every status row. The repo's precedent for a
 * focused second suite beside a large one is `LoginPage.security.test.tsx`,
 * `CreateProjectDialog.reopen.test.tsx` and `AuthCredentialFields.wiring.test.tsx`.
 */
vi.mock('@/lib/tickets', async (orig) => ({
  ...(await orig<typeof tickets>()),
  updateTicket: vi.fn(),
}))
const updateTicket = vi.mocked(tickets.updateTicket)

// Two columns is enough for every case here and keeps each assertion's scope obvious.
// `wip_limit` is stated on both rows, always: it is the column this suite is about, and an
// omitted field would be a row `.select()` can never return.
function statuses(limits: { todo: number | null; doing: number | null }): ProjectStatus[] {
  return [
    {
      id: '1ecd8f00-0000-4000-8000-000000000000',
      project_id: 'p1',
      slug: 'todo',
      name: 'To Do',
      category: 'todo',
      position: 1,
      is_initial: true,
      wip_limit: limits.todo,
    },
    {
      id: '1ecd8f01-0000-4000-8000-000000000000',
      project_id: 'p1',
      slug: 'doing',
      name: 'Doing',
      category: 'in_progress',
      position: 2,
      is_initial: false,
      wip_limit: limits.doing,
    },
  ] as unknown as ProjectStatus[]
}

// Three cards in To Do — one of them blocked, one unestimated — and one in Doing. Every row
// states `sprint_id: null`: these boards are Kanban, where `selectBoardScope` shows every
// ticket whatever its sprint, and an omitted field would be a row the database never returns.
const TICKET_ROWS = [
  {
    id: 't1',
    key: 'MP-1',
    number: 1,
    summary: 'First',
    type: 'story',
    status: 'todo',
    sprint_id: null,
    story_points: 3,
    is_blocked: true,
  },
  {
    id: 't2',
    key: 'MP-2',
    number: 2,
    summary: 'Second',
    type: 'story',
    status: 'todo',
    sprint_id: null,
    story_points: 5,
    is_blocked: false,
  },
  {
    id: 't3',
    key: 'MP-3',
    number: 3,
    summary: 'Third',
    type: 'bug',
    status: 'todo',
    sprint_id: null,
    story_points: null,
    is_blocked: false,
  },
  {
    id: 't4',
    key: 'MP-4',
    number: 4,
    summary: 'Fourth',
    type: 'task',
    status: 'doing',
    sprint_id: null,
    story_points: 2,
    is_blocked: false,
  },
]

const TICKETS = TICKET_ROWS as never

/**
 * The same cards, but inside a running sprint — needed only by the Scrum case below.
 *
 * A Scrum board shows the ACTIVE sprint's tickets, so without a sprint it renders no cards,
 * every column is empty, and `BoardColumnSummary` returns null before it ever consults a
 * limit. An AC5 test written that way passes with the `hasWipLimits` gate DELETED. That is not
 * a hypothetical: the first draft of this suite was written that way and a mutation run proved
 * it vacuous — the gate was removed and this file stayed green.
 */
const ACTIVE_SPRINT = [{ id: 's1', project_id: 'p1', name: 'Sprint 1', status: 'active' }] as never
const SPRINT_TICKETS = TICKET_ROWS.map((t) => ({ ...t, sprint_id: 's1' })) as never

function ctxWith(
  project_type: ProjectType,
  rows: ProjectStatus[],
  fields: Partial<ProjectShellContext> = {},
): ProjectShellContext {
  return {
    project: { project_type } as never,
    tickets: TICKETS,
    ticketsPhase: 'loaded',
    sprints: [],
    sprintsPhase: 'loaded',
    statuses: rows,
    statusesPhase: 'loaded',
    // SPRIN-90. Shape parity with `ProjectShell`'s real context; the board reads neither.
    fields: [],
    fieldsPhase: 'loaded',
    // SPRIN-92 task 9. Same shape-parity reasoning as `fields`/`fieldsPhase` above.
    options: [],
    optionsPhase: 'loaded',
    onOptionCreated: vi.fn(),
    onOptionUpdated: vi.fn(),
    onOptionDeleted: vi.fn(),
    onFieldCreated: vi.fn(),
    onFieldUpdated: vi.fn(),
    onStatusCreated: vi.fn(),
    onStatusUpdated: vi.fn(),
    onStatusDeleted: vi.fn(),
    onStatusesReordered: vi.fn(),
    onRetry: vi.fn(),
    onSprintCreated: vi.fn(),
    onSprintUpdated: vi.fn(),
    onSprintCompleted: vi.fn(),
    currentUser: { id: 'u1', email: 'dev@example.com' },
    onOpenTicket: vi.fn(),
    onTicketUpdated: vi.fn(),
    onTicketDeleted: vi.fn(),
    ...fields,
  }
}

function renderTab(Tab: ComponentType, ctx: ProjectShellContext) {
  function Provider() {
    return <Outlet context={ctx} />
  }
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<Provider />}>
          <Route path="*" element={<Tab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

// Scope every assertion to its own column. These strings are short, and an unscoped
// `getByText(/limit 3/i)` would happily match the other column — SPRIN-65 moved a badge
// outside its own button with all twelve of its tests still green.
function column(label: string) {
  return screen.getByRole('heading', { name: label }).closest('section') as HTMLElement
}

describe('a Kanban column with a WIP limit', () => {
  // AC1.
  it('shows its count against the limit when under it', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: null, doing: 3 })))
    const doing = within(column('Doing'))
    // The WHOLE line, exactly as rendered, separators included. A substring regex anchored on
    // "limit" leaves the ` · ` join unpinned — a review mutation dropped it and rendered
    // "1 card · 2 points limit 3" with every assertion in this file still green.
    expect(doing.getByText('1 card · 2 points · limit 3')).toBeInTheDocument()
    expect(doing.queryByText(/over limit/i)).not.toBeInTheDocument()
  })

  // AC1 at the boundary: three cards against a limit of three is AT the limit, not over it.
  // The comparison is `>`, and this is the case that fails if anyone makes it `>=`.
  it('does not say over at exactly the limit', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: 3, doing: null })))
    const todo = within(column('To Do'))
    // Exact, so this test cannot stop being a BOUNDARY test without failing: with the loose
    // `/limit 3/i`, changing this fixture to a limit of 30 left it green while no longer
    // exercising the boundary at all. Measured in review.
    expect(todo.getByText('3 cards · 8 points · 1 unestimated · limit 3')).toBeInTheDocument()
    expect(todo.queryByText(/over limit/i)).not.toBeInTheDocument()
  })

  // AC2 — the WORDS. This is the assertion that fails if anyone conveys the state with colour
  // alone. Deliberately NOT combined with the class assertion below: one test holding both
  // would still pass with either half deleted.
  it('says "over limit" in words when the count exceeds it', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: 2, doing: null })))
    const summary = within(column('To Do')).getByText(
      '3 cards · 8 points · 1 unestimated · over limit 2',
    )
    // `toBeInTheDocument` is not `toBeVisible`, and `getByText` ignores only script/style — it
    // matches an aria-hidden subtree happily. Review mutations added `aria-hidden="true"` and
    // `hidden` to this span and both survived the first version of this test: AC2's text would
    // have been in the DOM and reaching nobody.
    expect(summary).toBeVisible()
    expect(summary).not.toHaveAttribute('aria-hidden')
  })

  // AC2 — colour as REINFORCEMENT, never the carrier. The second expectation is the negative
  // control: without it, a component that painted every summary red would pass.
  //
  // The EXACT class list, not `toHaveClass`, which is a SUBSET check. A review mutation
  // rendered `text-destructive text-muted-foreground` together — both `toHaveClass`
  // assertions passed while Tailwind's emitted rule order, not the `over` branch, decided the
  // colour. The same exactness catches an `sr-only` added to this span, which no visibility
  // assertion can see under jsdom because no stylesheet is ever loaded.
  it('renders the over-limit summary in the destructive colour', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: 2, doing: null })))
    expect(within(column('To Do')).getByText(/over limit 2/i)).toHaveAttribute(
      'class',
      'text-destructive text-xs tabular-nums',
    )
    expect(within(column('Doing')).getByText(/1 card/i)).toHaveAttribute(
      'class',
      'text-muted-foreground text-xs tabular-nums',
    )
  })
})

describe('a column with no limit to show', () => {
  // AC4. The whole of today's line is asserted, not just the absence of the new segment: a
  // change that dropped the points or the unestimated tally would otherwise pass here.
  it('renders exactly as it does today when the status has no limit', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: null, doing: null })))
    const todo = within(column('To Do'))
    expect(todo.getByText(/3 cards/i)).toBeInTheDocument()
    expect(todo.getByText(/8 points/i)).toBeInTheDocument()
    expect(todo.getByText(/1 unestimated/i)).toBeInTheDocument()
    expect(todo.queryByText(/limit/i)).not.toBeInTheDocument()
  })

  /**
   * AC5. The status rows carry REAL limits and the board must still show none, because the
   * project is Scrum. SPRIN-85 §3.4: a CHECK body may not contain a subquery, so it cannot
   * reach the type column on `projects`, and the database will genuinely store these. Written
   * with null limits instead, this test would pass with the `hasWipLimits` gate deleted.
   *
   * TWO THINGS MAKE THIS TEST NON-VACUOUS, and it needs both. The limits above are real, and
   * the board is given a running sprint so its columns actually hold cards — an empty column
   * renders no summary at all, so the absence of the word "limit" would otherwise prove
   * nothing about the gate. The first assertion is the positive control for exactly that.
   */
  it('shows nothing on a Scrum board whose rows carry limits', () => {
    renderTab(
      BoardTab,
      ctxWith('scrum', statuses({ todo: 2, doing: 3 }), {
        sprints: ACTIVE_SPRINT,
        tickets: SPRINT_TICKETS,
      }),
    )
    // Positive control: the cards ARE on screen, so a summary is rendering and a missing gate
    // would have put "over limit 2" in it.
    expect(within(column('To Do')).getByText(/3 cards/i)).toBeInTheDocument()
    expect(screen.queryByText(/limit/i)).not.toBeInTheDocument()
  })

  /**
   * The design's §5.1. Under a filter the column is showing fewer cards than it holds, so the
   * board makes no WIP claim at all rather than an understated one. To Do holds three cards
   * against a limit of two — over — and exactly one of them is blocked.
   */
  it('drops the limit segment while a filter is active', async () => {
    const user = userEvent.setup()
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: 2, doing: null })))
    expect(within(column('To Do')).getByText(/over limit 2/i)).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /blocked only/i }))

    const todo = within(column('To Do'))
    expect(todo.getByText(/1 card/i)).toBeInTheDocument()
    expect(todo.queryByText(/limit/i)).not.toBeInTheDocument()
  })
})

/**
 * AC3, and the reason this suite matters more than the rest of the story. The WIP limit is
 * SOFT: it warns, it never blocks. Dragging a card into a column already AT its limit must
 * succeed and persist.
 *
 * A hard limit was rejected for reasons recorded in the epic design §2.2 — enforcing it at
 * both edges would need a trigger on `tickets` counting sibling rows in the target column, the
 * exact shape that broke the cascade in SPRIN-80, and lowering a limit below a column's
 * occupancy would strand that column with no in-app way out.
 *
 * This test is what makes "improving" the limit into a block go RED rather than ship. Three
 * assertions, because a block could be built three ways: refusing the write, painting the card
 * back, or refusing with a message.
 */
describe('the WIP limit is soft', () => {
  it('lets a card drop into a column that is already at its limit (AC3)', async () => {
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', key: 'MP-1', status: 'doing', updated_at: '2026-08-05T00:00:00Z' },
    } as never)
    const onTicketUpdated = vi.fn()
    // Doing holds one card against a limit of one — full. To Do is the source.
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: null, doing: 1 }), { onTicketUpdated }))
    expect(within(column('Doing')).getByText(/limit 1/i)).toBeInTheDocument()

    fireEvent.dragStart(screen.getByRole('button', { name: /first/i })) // t1, status todo
    fireEvent.drop(column('Doing'))

    // 1. The optimistic apply happened — the card is not painted back.
    expect(onTicketUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', status: 'doing' }),
    )
    // 2. The write was actually sent, keyed on the SLUG rather than the row id.
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { status: 'doing' }))
    // 3. Nothing was refused: no error alert appeared.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
