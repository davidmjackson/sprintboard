import type { ComponentType } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { BoardTab } from './BoardTab'
import { BacklogTab } from './BacklogTab'
import type { ProjectShellContext } from './ProjectShell'
import { DEFAULT_PROJECT_STATUSES } from '@/lib/domain'
import type { ProjectStatus } from '@/lib/domain'
import * as tickets from '@/lib/tickets'

vi.mock('@/lib/tickets', async (orig) => ({
  ...(await orig<typeof tickets>()),
  updateTicket: vi.fn(),
}))
const updateTicket = vi.mocked(tickets.updateTicket)

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

// The four rows `seed_project_statuses()` writes for every new project, shaped as the board
// receives them. Derived from the seed contract in `domain.ts` rather than retyped, so this
// harness cannot go on describing a vocabulary the database stopped seeding.
//
// The `id`s are deliberately NOTHING like the slugs. `tickets.status` is a text column with a
// composite fk to `project_statuses (project_id, slug)`, so the board must key and drop on the
// SLUG; ids that merely resembled slugs would let a `status.id` regression pass unnoticed.
const SEEDED_STATUSES = DEFAULT_PROJECT_STATUSES.map((status, i) => ({
  ...status,
  id: `1ecd8f0${i}-0000-4000-8000-000000000000`,
  project_id: 'p1',
  // Stated, never omitted, for the same reason `sprint_id` is stated on every ticket above:
  // `wip_limit` is `number | null` and `listProjectStatuses` selects every column, so a row
  // without the field is one the database cannot produce. SPRIN-86 reads it.
  wip_limit: null,
})) as unknown as ProjectStatus[]

function ctxWith(fields: Partial<ProjectShellContext> = {}): ProjectShellContext {
  return {
    // Explicitly Scrum, which is what every test in this file assumed while the board did
    // not ask. `hasSprints({})` is false, so an empty object would silently make the whole
    // file a suite about a project WITHOUT sprints the moment BoardTab consults the project
    // (SPRIN-83). Stating it also turns every sprint-scoped test below into AC5's positive
    // control: they pass only because this says 'scrum'.
    project: { project_type: 'scrum' } as never,
    tickets: TICKETS,
    ticketsPhase: 'loaded',
    sprints: [],
    sprintsPhase: 'loaded',
    statuses: SEEDED_STATUSES,
    statusesPhase: 'loaded',
    // SPRIN-90. The board renders no custom fields, so these exist only to keep the context
    // shape identical to the one `ProjectShell` publishes — a harness missing them would be
    // a different shell from the real one.
    fields: [],
    fieldsPhase: 'loaded',
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

// An active sprint and tickets tagged to it: the board now shows the ACTIVE sprint's tickets.
const ACTIVE_SPRINT = {
  id: 's-active',
  status: 'active',
  name: 'Sprint 1',
  project_id: 'p1',
} as never

const SPRINT_TICKETS = [
  {
    id: 't1',
    key: 'MP-1',
    number: 1,
    summary: 'Do the todo',
    type: 'story',
    status: 'todo',
    sprint_id: 's-active',
  },
  {
    id: 't2',
    key: 'MP-2',
    number: 2,
    summary: 'Ship it',
    type: 'bug',
    status: 'done',
    sprint_id: 's-active',
  },
] as never

function boardCtx(fields: Partial<ProjectShellContext> = {}): ProjectShellContext {
  return ctxWith({ tickets: SPRINT_TICKETS, sprints: [ACTIVE_SPRINT] as never, ...fields })
}

// A vocabulary this project's rows could plausibly hold once SPRIN-77 lets them be edited:
// five statuses, and NOT in the order a hard-coded board would use. `listProjectStatuses`
// already returns rows ordered by `position`, so the board's job is to render the list it is
// handed — which is why the array order here deliberately disagrees with both the seeded
// board order (To Do first) and with sorting by `slug`. A fixture that happened to agree with
// either would prove nothing.
const FIVE_STATUSES = [
  { slug: 'in_progress', name: 'In Progress', category: 'in_progress', position: 2 },
  { slug: 'todo', name: 'To Do', category: 'todo', position: 1 },
  { slug: 'in_review', name: 'In Review', category: 'in_progress', position: 3 },
  { slug: 'done', name: 'Done', category: 'done', position: 4 },
  { slug: 'parked', name: 'Parked', category: 'todo', position: 5 },
].map((status, i) => ({
  ...status,
  id: `5ec0dd0${i}-0000-4000-8000-000000000000`,
  project_id: 'p1',
  is_initial: status.slug === 'todo',
})) as unknown as ProjectStatus[]

describe('BoardTab', () => {
  beforeEach(() => updateTicket.mockReset())

  it('renders one column per status row — five rows, five columns (AC2)', () => {
    renderTab(BoardTab, boardCtx({ statuses: FIVE_STATUSES }))
    // Count the columns. Asserting only that "Parked" exists would still pass with the four
    // constants in place plus a stray heading somewhere else on the page.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(5)
    expect(screen.getByRole('heading', { level: 2, name: 'Parked' })).toBeInTheDocument()
  })

  it('orders the columns by the list it is given, not by a hard-coded order', () => {
    renderTab(BoardTab, boardCtx({ statuses: FIVE_STATUSES }))
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'In Progress',
      'To Do',
      'In Review',
      'Done',
      'Parked',
    ])
  })

  it('shows a statuses failure with its own Retry, not an empty board', () => {
    // Without the status rows the board does not know what its columns ARE. Rendering the
    // four it used to hard-code would be the S4.6 defect again: an unknown state wearing a
    // known one's face.
    renderTab(BoardTab, boardCtx({ statuses: [], statusesPhase: 'failed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load statuses.')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'To Do' })).not.toBeInTheDocument()
  })

  // A SUCCESSFUL statuses read that returned nothing. Before the guard, this fell through to
  // `statuses.map([])`: a `<div class="grid">` with no children, no heading, no alert, no
  // `role="status"` — and the sprint name plus the filter chrome still painted above it,
  // implying a healthy board while every card in the sprint had vanished.
  //
  // Unreachable today; reachable at SPRIN-77/80 and SPRIN-75, because RLS FILTERS rather than
  // raises — a denied read is `{data: [], error: null}`, i.e. `loaded` with zero rows.
  it('says the board has no columns when the statuses read succeeds with none', () => {
    renderTab(BoardTab, boardCtx({ statuses: [], statusesPhase: 'loaded' }))
    // Announced, not merely visible. `role="status"` (informational), never `role="alert"` —
    // the read did not fail — and its own sentence, distinguishable from both neighbours.
    const announced = screen.getByRole('status')
    expect(announced).toHaveTextContent(/this board has no columns/i)
    expect(announced).toHaveTextContent(/this project has no statuses/i)
    // Not a failure: no alert and no Retry, which is what separates this from a failed read.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    // And it is not sitting on top of the columnless grid, the sprint caption or the filters:
    // the state replaces the board rather than decorating it.
    expect(screen.queryAllByRole('heading', { level: 2 })).toHaveLength(0)
    expect(screen.queryByText('Sprint 1')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /blocked only/i })).not.toBeInTheDocument()
    // The two sentences it must never be mistaken for.
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument()
    expect(screen.queryByText(/no active sprint/i)).not.toBeInTheDocument()
  })

  // The control on the test above: it must be asserting something the board does NOT always
  // say. Without this, inverting the guard to `statuses.length > 0` would still leave a green
  // suite for the empty case while every real board claimed it had no columns.
  it('says nothing about missing columns when the project HAS statuses', () => {
    renderTab(BoardTab, boardCtx())
    expect(screen.queryByText(/no columns/i)).not.toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(SEEDED_STATUSES.length)
  })

  it('claims neither empty nor failed while the STATUSES load', () => {
    renderTab(BoardTab, boardCtx({ statuses: [], statusesPhase: 'loading' }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a failed TICKETS read over a still-loading statuses read', () => {
    // `firstUnready`'s rule, at the board's own level: any `failed` beats any `loading`, so a
    // known failure is never replaced by a spinner that nothing will ever resolve.
    renderTab(
      BoardTab,
      boardCtx({ tickets: [], ticketsPhase: 'failed', statuses: [], statusesPhase: 'loading' }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tickets.')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  it('shows a failed STATUSES read over a still-loading tickets read', () => {
    // The mirror of the test above, so the precedence cannot be satisfied by a lucky order.
    renderTab(
      BoardTab,
      boardCtx({ tickets: [], ticketsPhase: 'loading', statuses: [], statusesPhase: 'failed' }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load statuses.')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })

  // Documented, not fixed. `tickets.status` carries a composite fk to `project_statuses
  // (project_id, slug)`, so the database cannot hold a ticket whose status names no column;
  // SPRIN-80 owns orphan safety in the app. This test exists so the behaviour can never
  // become SILENT if that fk is ever relaxed.
  it('renders no card for a ticket whose status matches no column', () => {
    const rows = [
      {
        id: 'x',
        key: 'MP-9',
        number: 9,
        summary: 'Orphaned status',
        type: 'story',
        status: 'ghost',
        sprint_id: 's-active',
      },
      {
        id: 'y',
        key: 'MP-8',
        number: 8,
        summary: 'Real status',
        type: 'story',
        status: 'todo',
        sprint_id: 's-active',
      },
    ] as never
    renderTab(BoardTab, boardCtx({ tickets: rows }))
    // The control, and it is what makes the assertions below mean anything: BOTH rows are in
    // the active sprint, so the orphan's absence is about its status and nothing else. The
    // board renders only the active sprint's tickets, so a `sprint_id: null` orphan would
    // vanish for a completely different reason and this test would pass vacuously.
    expect(screen.getByText('Real status')).toBeInTheDocument()
    expect(screen.queryByText('MP-9')).not.toBeInTheDocument()
    expect(screen.queryByText('Orphaned status')).not.toBeInTheDocument()
  })

  it('renders all four columns in board order', () => {
    renderTab(BoardTab, boardCtx())
    const headings = screen.getAllByRole('heading').map((h) => h.textContent)
    expect(headings).toEqual(['To Do', 'In Progress', 'In Review', 'Done'])
  })

  it('places each active-sprint ticket in its own status column, not merely on the page', () => {
    renderTab(BoardTab, boardCtx())
    const todo = screen.getByRole('heading', { name: 'To Do' }).closest('section')!
    const done = screen.getByRole('heading', { name: 'Done' }).closest('section')!
    expect(within(todo).getByText('MP-1')).toBeInTheDocument()
    expect(within(todo).getByText('Do the todo')).toBeInTheDocument()
    expect(within(done).getByText('MP-2')).toBeInTheDocument()
    expect(within(done).getByText('Ship it')).toBeInTheDocument()
    expect(within(todo).queryByText('Ship it')).not.toBeInTheDocument()
  })

  it('shows an empty state in the active sprint columns with no tickets', () => {
    renderTab(BoardTab, boardCtx())
    // To Do and Done have one ticket each; In Progress and In Review are empty.
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(2)
  })

  it('renders every column empty when the active sprint has no tickets', () => {
    renderTab(BoardTab, boardCtx({ tickets: [] }))
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(4)
  })

  it('shows only the active sprint tickets: backlog and other-sprint tickets are excluded (S7.1 AC2)', () => {
    // The board is the active-sprint board (reverses the S5.1 sprint-blind board). A backlog
    // ticket (sprint_id null) and a ticket in a DIFFERENT sprint must not appear.
    const mixed = [
      {
        id: 'a',
        key: 'MP-9',
        number: 9,
        summary: 'In the active sprint',
        type: 'story',
        status: 'todo',
        sprint_id: 's-active',
      },
      {
        id: 'b',
        key: 'MP-10',
        number: 10,
        summary: 'In the backlog',
        type: 'story',
        status: 'todo',
        sprint_id: null,
      },
      {
        id: 'c',
        key: 'MP-11',
        number: 11,
        summary: 'In another sprint',
        type: 'story',
        status: 'todo',
        sprint_id: 's-future',
      },
    ] as never
    renderTab(BoardTab, boardCtx({ tickets: mixed }))
    expect(screen.getByText('In the active sprint')).toBeInTheDocument()
    expect(screen.queryByText('In the backlog')).not.toBeInTheDocument()
    expect(screen.queryByText('In another sprint')).not.toBeInTheDocument()
  })

  it('shows a no-active-sprint caption and four empty columns when nothing is active', () => {
    // sprints loaded, none active: distinct from "active sprint, no tickets". The caption keeps
    // this state from wearing the empty state's face (the component's S4.6 principle).
    renderTab(BoardTab, boardCtx({ tickets: [], sprints: [] }))
    expect(screen.getByText(/no active sprint/i)).toBeInTheDocument()
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(4)
    expect(screen.getByRole('heading', { name: 'To Do' })).toBeInTheDocument()
  })

  it('does NOT show the no-active-sprint caption when a sprint is active', () => {
    // Positive control: the caption must be specific to the no-active-sprint state.
    renderTab(BoardTab, boardCtx())
    expect(screen.queryByText(/no active sprint/i)).not.toBeInTheDocument()
  })

  it('opens the ticket detail modal when a card is clicked', async () => {
    const onOpenTicket = vi.fn()
    renderTab(BoardTab, boardCtx({ onOpenTicket }))
    await userEvent.click(screen.getByRole('button', { name: /do the todo/i }))
    expect(onOpenTicket).toHaveBeenCalled()
  })

  it('shows a failed TICKET read as an error, not as empty columns (S4.6 AC 1)', () => {
    renderTab(BoardTab, boardCtx({ tickets: [], ticketsPhase: 'failed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tickets.')
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument()
  })

  it('shows a failed SPRINT read as an error, not as a confident empty board (S7.1 two-read)', () => {
    // The board can't know the active sprint if the sprints read failed. It must not render an
    // empty board — that would be the S4.6 defect: an unknown state wearing the empty face.
    renderTab(BoardTab, boardCtx({ sprints: [], sprintsPhase: 'failed' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load sprints.')
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument()
    expect(screen.queryByText(/no active sprint/i)).not.toBeInTheDocument()
  })

  it('prioritises the ticket failure when BOTH reads fail (one alert, one Retry)', () => {
    renderTab(
      BoardTab,
      boardCtx({ tickets: [], ticketsPhase: 'failed', sprints: [], sprintsPhase: 'failed' }),
    )
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tickets.')
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'To Do' })).not.toBeInTheDocument()
  })

  it('shows the sprints failure, not a loading spinner, when tickets are still loading but sprints failed', () => {
    // The failure checks run before the loading check, so a definite failure outranks an
    // in-flight load: a board that cannot know its active sprint offers Retry now rather than
    // spinning until the doomed sprints read is re-attempted. Honest, and never a wrong-empty
    // board. This pins the two-read priority ordering — the story's most novel logic.
    renderTab(
      BoardTab,
      boardCtx({ tickets: [], ticketsPhase: 'loading', sprints: [], sprintsPhase: 'failed' }),
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load sprints.')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument()
  })

  it('calls onRetry when Retry is clicked', async () => {
    const onRetry = vi.fn()
    renderTab(BoardTab, boardCtx({ tickets: [], ticketsPhase: 'failed', onRetry }))
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('shows the EMPTY state, not the error, for a genuinely empty loaded active sprint (S4.6 AC 2)', () => {
    renderTab(BoardTab, boardCtx({ tickets: [], ticketsPhase: 'loaded' }))
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(4)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('claims neither empty nor failed while TICKETS load', () => {
    renderTab(BoardTab, boardCtx({ tickets: [], ticketsPhase: 'loading' }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('claims neither empty nor failed while SPRINTS load (S7.1 two-read)', () => {
    renderTab(BoardTab, boardCtx({ sprints: [], sprintsPhase: 'loading' }))
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('No tickets yet.')).not.toBeInTheDocument()
    expect(screen.queryByText(/no active sprint/i)).not.toBeInTheDocument()
  })

  it('keeps a blocked active-sprint ticket in its status column and marks it blocked (S4.4)', () => {
    const blocked = [
      {
        id: 't1',
        key: 'MP-1',
        number: 1,
        summary: 'Do the todo',
        type: 'story',
        status: 'in_progress',
        sprint_id: 's-active',
        is_blocked: true,
        blocked_reason: 'waiting on API',
      },
    ] as never
    renderTab(BoardTab, boardCtx({ tickets: blocked }))
    const inProgress = screen.getByRole('heading', { name: 'In Progress' }).closest('section')!
    expect(within(inProgress).getByText('MP-1')).toBeInTheDocument()
    expect(within(inProgress).getByText(/blocked/i)).toBeInTheDocument()
  })

  it('marks active-sprint cards as draggable (S7.2)', () => {
    renderTab(BoardTab, boardCtx())
    expect(screen.getByRole('button', { name: /do the todo/i })).toHaveAttribute(
      'draggable',
      'true',
    )
  })

  it('optimistically moves a card to the drop column and persists the new status (S7.2 AC1/AC3)', async () => {
    updateTicket.mockResolvedValue({
      ok: true,
      // The reconcile reads only `status` and `updated_at` off the returned row; a minimal
      // object suffices (SPRINT_TICKETS is typed `as never`, so it cannot be spread here).
      ticket: {
        id: 't1',
        key: 'MP-1',
        status: 'in_progress',
        updated_at: '2026-07-20T00:00:00Z',
      },
    } as never)
    const onTicketUpdated = vi.fn()
    renderTab(BoardTab, boardCtx({ onTicketUpdated }))

    const card = screen.getByRole('button', { name: /do the todo/i }) // t1, status todo
    const inProgress = screen.getByRole('heading', { name: 'In Progress' }).closest('section')!
    fireEvent.dragStart(card)
    fireEvent.drop(inProgress)

    // Optimistic apply is synchronous (before the awaited write).
    expect(onTicketUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', status: 'in_progress' }),
    )
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { status: 'in_progress' }))
  })

  // The drop target is the column's SLUG, never its row id. `tickets.status` is a `text`
  // column with a composite fk to `project_statuses (project_id, slug)` — SPRIN-79 keyed it on
  // the slug precisely so no ticket row is rewritten when a status is renamed. Writing
  // `status.id` would put a uuid into that column and the fk would reject it, a failure the
  // board would only meet in production.
  //
  // BE HONEST ABOUT WHAT THIS PINS. It is exactly as fixture-dependent as the four drag tests
  // around it: give `SEEDED_STATUSES`/`FIVE_STATUSES` ids equal to their slugs and swapping in
  // `status.id` becomes a semantic no-op that NOTHING here can catch — measured, 68/68 still
  // green. This test is not structurally immune to that; no test can be. What it adds over its
  // siblings is that its NAME and the explicit negative assertion below make the fixture's role
  // visible, so an editor tidying those ids can see what they are load-bearing for instead of
  // discovering it in production. Keep the ids unlike the slugs.
  it("writes the dropped column's slug, not its row id (composite fk)", async () => {
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', key: 'MP-1', status: 'in_review', updated_at: '2026-07-31T00:00:00Z' },
    } as never)
    renderTab(BoardTab, boardCtx({ statuses: FIVE_STATUSES }))

    const card = screen.getByRole('button', { name: /do the todo/i }) // t1, status todo
    fireEvent.dragStart(card)
    fireEvent.drop(screen.getByRole('heading', { name: 'In Review' }).closest('section')!)

    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { status: 'in_review' }))
    // The row id for that column, spelled out: it must never reach the status column.
    expect(updateTicket).not.toHaveBeenCalledWith('t1', {
      status: '5ec0dd02-0000-4000-8000-000000000000',
    })
  })

  // The failed-move message names the column the user aimed at, and that name now comes from
  // the status ROW rather than a constant map. With a slug the project's rows do not contain,
  // `statusName` falls back to the slug itself (AC4) — never `undefined`.
  it('names the target column from its status row in the move-failure message', async () => {
    updateTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    renderTab(BoardTab, boardCtx({ statuses: FIVE_STATUSES }))

    fireEvent.dragStart(screen.getByRole('button', { name: /do the todo/i }))
    fireEvent.drop(screen.getByRole('heading', { name: 'Parked' }).closest('section')!)

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Could not move MP-1 to Parked.'),
    )
  })

  it('reverts the optimistic move and shows an error when the write fails (S7.2 AC3)', async () => {
    updateTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const onTicketUpdated = vi.fn()
    renderTab(BoardTab, boardCtx({ onTicketUpdated }))

    const card = screen.getByRole('button', { name: /do the todo/i }) // t1, status todo
    const inReview = screen.getByRole('heading', { name: 'In Review' }).closest('section')!
    fireEvent.dragStart(card)
    fireEvent.drop(inReview)

    // Optimistic to in_review, then reverted back to todo after the failed write.
    expect(onTicketUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', status: 'in_review' }),
    )
    await waitFor(() =>
      expect(onTicketUpdated).toHaveBeenCalledWith(
        expect.objectContaining({ id: 't1', status: 'todo' }),
      ),
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/could not move MP-1/i)
  })

  it('does not write when a card is dropped on its own column (no-op)', () => {
    const onTicketUpdated = vi.fn()
    renderTab(BoardTab, boardCtx({ onTicketUpdated }))

    const card = screen.getByRole('button', { name: /do the todo/i }) // t1 is already todo
    const todo = screen.getByRole('heading', { name: 'To Do' }).closest('section')!
    fireEvent.dragStart(card)
    fireEvent.drop(todo)

    expect(updateTicket).not.toHaveBeenCalled()
    expect(onTicketUpdated).not.toHaveBeenCalled()
  })

  const MIXED_BLOCKED = [
    {
      id: 't1',
      key: 'MP-1',
      number: 1,
      summary: 'Blocked one',
      type: 'story',
      status: 'todo',
      sprint_id: 's-active',
      is_blocked: true,
      blocked_reason: 'waiting on API',
    },
    {
      id: 't2',
      key: 'MP-2',
      number: 2,
      summary: 'Open one',
      type: 'bug',
      status: 'todo',
      sprint_id: 's-active',
      is_blocked: false,
    },
  ] as never

  it('offers a "Blocked only" filter when a sprint is active (S7.3 AC2)', () => {
    renderTab(BoardTab, boardCtx({ tickets: MIXED_BLOCKED }))
    expect(screen.getByRole('checkbox', { name: /blocked only/i })).toBeInTheDocument()
  })

  it('does NOT offer the filter when there is no active sprint (negative control)', () => {
    renderTab(BoardTab, boardCtx({ tickets: [], sprints: [] }))
    expect(screen.queryByRole('checkbox', { name: /blocked only/i })).not.toBeInTheDocument()
  })

  it('shows only blocked cards when the filter is on, and restores when off (S7.3 AC2)', async () => {
    renderTab(BoardTab, boardCtx({ tickets: MIXED_BLOCKED }))
    // Both visible initially.
    expect(screen.getByText('Blocked one')).toBeInTheDocument()
    expect(screen.getByText('Open one')).toBeInTheDocument()
    // Turn the filter on: the unblocked card disappears, the blocked one stays.
    await userEvent.click(screen.getByRole('checkbox', { name: /blocked only/i }))
    expect(screen.getByText('Blocked one')).toBeInTheDocument()
    expect(screen.queryByText('Open one')).not.toBeInTheDocument()
    // Turn it off: the unblocked card returns.
    await userEvent.click(screen.getByRole('checkbox', { name: /blocked only/i }))
    expect(screen.getByText('Open one')).toBeInTheDocument()
  })

  it('names the active sprint and its dates above the board (SPRIN-65 AC2)', () => {
    const dated = {
      ...(ACTIVE_SPRINT as object),
      start_date: '2026-07-20T00:00:00.000Z',
      end_date: '2026-08-03T00:00:00.000Z',
    }
    renderTab(BoardTab, boardCtx({ sprints: [dated] as never }))
    expect(screen.getByText('Sprint 1')).toBeInTheDocument()
    expect(screen.getByText('2026-07-20 – 2026-08-03')).toBeInTheDocument()
  })

  it('says the sprint has no dates rather than inventing a range', () => {
    renderTab(BoardTab, boardCtx())
    expect(screen.getByText('Sprint 1')).toBeInTheDocument()
    expect(screen.getByText(/no dates set/i)).toBeInTheDocument()
  })

  // Negative control: with no active sprint the caption must be absent, and the
  // existing "No active sprint" message must still be the thing on screen.
  it('shows no sprint caption when there is no active sprint', () => {
    renderTab(BoardTab, boardCtx({ tickets: [], sprints: [] }))
    expect(screen.queryByText('Sprint 1')).not.toBeInTheDocument()
    expect(screen.getByText(/no active sprint/i)).toBeInTheDocument()
  })

  // `screen.getByText` is unscoped (Task 2 review finding), so the three tests above pin the
  // caption's CONTENT but not its POSITION — a review of this task proved that by moving the
  // caption <p> inside the column grid (past the columns wrapper) and watching all 43 tests
  // stay green. This test pins the position too: the caption must render outside the grid of
  // columns, and before it in document order — "above the board", per the brief's title and
  // the component's own docstring (line 28, "a caption above the grid").
  it('renders the sprint caption above the grid of board columns, not nested inside it (SPRIN-65 AC2 position pin)', () => {
    const dated = {
      ...(ACTIVE_SPRINT as object),
      start_date: '2026-07-20T00:00:00.000Z',
      end_date: '2026-08-03T00:00:00.000Z',
    }
    renderTab(BoardTab, boardCtx({ sprints: [dated] as never }))
    const grid = screen.getByRole('heading', { name: 'To Do' }).closest('.grid') as HTMLElement
    const caption = screen.getByText('Sprint 1')
    expect(within(grid).queryByText('Sprint 1')).not.toBeInTheDocument()
    expect(caption.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  const POINTED = [
    {
      id: 't1',
      key: 'MP-1',
      number: 1,
      summary: 'Three pointer',
      type: 'story',
      status: 'todo',
      sprint_id: 's-active',
      is_blocked: false,
      story_points: 3,
    },
    {
      id: 't2',
      key: 'MP-2',
      number: 2,
      summary: 'Five pointer',
      type: 'story',
      status: 'todo',
      sprint_id: 's-active',
      is_blocked: true,
      blocked_reason: 'waiting',
      story_points: 5,
    },
    {
      id: 't3',
      key: 'MP-3',
      number: 3,
      summary: 'No estimate',
      type: 'task',
      status: 'todo',
      sprint_id: 's-active',
      is_blocked: false,
      story_points: null,
    },
    {
      id: 't4',
      key: 'MP-4',
      number: 4,
      summary: 'Shipped',
      type: 'bug',
      status: 'done',
      sprint_id: 's-active',
      is_blocked: false,
      story_points: 2,
    },
  ] as never

  // `within` is already imported at the top of this file. Scope every assertion to its
  // own column: the numbers are short strings and a page-wide `getByText('8')` would
  // happily match a different column, or a card's own points badge.
  function column(label: string) {
    return screen.getByRole('heading', { name: label }).closest('section') as HTMLElement
  }

  it('shows each column card count and point total (SPRIN-65 AC3)', () => {
    renderTab(BoardTab, boardCtx({ tickets: POINTED }))
    const todo = within(column('To Do'))
    expect(todo.getByText(/3 cards/i)).toBeInTheDocument()
    expect(todo.getByText(/8 points/i)).toBeInTheDocument()
    const done = within(column('Done'))
    expect(done.getByText(/1 card/i)).toBeInTheDocument()
    expect(done.getByText(/2 points/i)).toBeInTheDocument()
  })

  it('says when a column total is understated by unestimated work (AC5)', () => {
    renderTab(BoardTab, boardCtx({ tickets: POINTED }))
    expect(within(column('To Do')).getByText(/1 unestimated/i)).toBeInTheDocument()
    // Negative control: Done has no unestimated ticket, so it must not say so.
    expect(within(column('Done')).queryByText(/unestimated/i)).not.toBeInTheDocument()
  })

  it('gives an empty column no summary — "No tickets yet" already says it', () => {
    renderTab(BoardTab, boardCtx({ tickets: POINTED }))
    const review = within(column('In Review'))
    expect(review.getByText(/no tickets yet/i)).toBeInTheDocument()
    expect(review.queryByText(/points/i)).not.toBeInTheDocument()
  })

  // AC4: the numbers describe what is on screen. With the filter on, the To Do column
  // shows one card worth 5, not three cards worth 8.
  it('recounts against the visible cards when the blocked-only filter is on (AC4)', async () => {
    renderTab(BoardTab, boardCtx({ tickets: POINTED }))
    expect(within(column('To Do')).getByText(/8 points/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: /blocked only/i }))
    const todo = within(column('To Do'))
    expect(todo.getByText(/1 card/i)).toBeInTheDocument()
    expect(todo.getByText(/5 points/i)).toBeInTheDocument()
    expect(todo.queryByText(/8 points/i)).not.toBeInTheDocument()
    expect(todo.queryByText(/unestimated/i)).not.toBeInTheDocument()
  })
})

const S = { id: 's1', name: 'Sprint 1', status: 'active' }

const BOARD_TICKETS = [
  {
    id: 't1',
    key: 'MP-1',
    number: 1,
    summary: 'Wire the board',
    type: 'story',
    status: 'todo',
    sprint_id: 's1',
    is_blocked: false,
    story_points: 3,
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
    sprint_id: 's1',
    is_blocked: true,
    story_points: 5,
    assignee_id: null,
    labels: [],
  },
  // A ticket that matches the same query as MP-2 but is NOT in the active sprint (mirrors
  // BacklogTab.test.tsx's MP-3 "Login help center article"). Without this ticket, every row
  // in this fixture has `sprint_id: 's1'`, so `boardTickets` (active-sprint tickets) and
  // `tickets` (the whole project) are identical under test and a regression that widened the
  // board's search source from the former to the latter would ship green.
  {
    id: 't3',
    key: 'MP-3',
    number: 3,
    summary: 'Login onboarding guide',
    type: 'task',
    status: 'todo',
    sprint_id: null,
    is_blocked: false,
    story_points: null,
    assignee_id: null,
    labels: [],
  },
] as never

function renderBoard(extra: Partial<ProjectShellContext> = {}) {
  return renderTab(BoardTab, ctxWith({ tickets: BOARD_TICKETS, sprints: [S] as never, ...extra }))
}

describe('BoardTab search (SPRIN-68)', () => {
  it('narrows the cards to matches (AC2)', async () => {
    renderBoard()
    const box = screen.getByRole('searchbox', { name: /search/i })
    await userEvent.type(box, 'login')
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
    // The control on the other side: MP-3 also matches "login" by summary, but it is NOT in
    // the active sprint, so it must never appear here — the board searches the active
    // sprint's tickets, not the project's whole ticket list.
    expect(
      screen.queryByRole('button', { name: /login onboarding guide/i }),
    ).not.toBeInTheDocument()
    // Pins the box's own displayed value, not just its filtering effect — a hardcoded or
    // disconnected `value` prop can still filter correctly by coincidence of which key the
    // React state happens to hold (see the SPRIN-68 fix-round-1 review finding).
    expect(box).toHaveValue('login')
  })

  // Mirrors the existing "does NOT offer the filter when there is no active sprint" control
  // for the blocked-only checkbox below. Without this, rendering the search box OUTSIDE the
  // `offersFilters` guard — over a board with nothing to search — ships undetected. That
  // guard was spelled `activeSprint !== null` until SPRIN-83 separated "is there a sprint to
  // describe" from "is there anything to filter"; on a sprint-scoped project it still
  // answers the same way, which is what keeps this control meaning what it always meant.
  it('does NOT offer the search box when there is no active sprint (negative control)', () => {
    renderTab(BoardTab, boardCtx({ tickets: [], sprints: [] }))
    expect(screen.queryByRole('searchbox', { name: /search/i })).not.toBeInTheDocument()
  })

  // M5 (SPRIN-68 post-merge review): the negative control above sets BOTH `tickets: []` and
  // `sprints: []` at once, so it cannot tell "hidden because there is no active sprint" apart
  // from "hidden because there are no tickets" — gating the box on `boardTickets.length > 0`
  // instead of `offersFilters` would pass it just as happily. This is the other half: an
  // ACTIVE sprint with a genuinely empty ticket list must still show the box, because on a
  // sprint-scoped project the gate is the sprint, not the list. (Note the two are no longer
  // interchangeable at all since SPRIN-83: a project without sprints offers filters with an
  // empty ticket list too, which `boardTickets.length > 0` would also get wrong.)
  it('DOES offer the search box over an active sprint with no tickets yet (positive control)', () => {
    renderTab(BoardTab, boardCtx({ tickets: [] }))
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument()
  })

  // AC2's second half, and the reason the totals are worth a test rather than an assertion in
  // the spec: they must describe what is on screen. `summariseColumn` is not changed by this
  // story, so this test guards the COMPOSITION — that the query is applied before the column
  // split, not inside the render.
  it('column totals describe only the visible cards (AC2)', async () => {
    renderBoard()
    expect(screen.getByText(/2 cards · 8 points/i)).toBeInTheDocument()
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'login')
    expect(screen.getByText(/1 card · 5 points/i)).toBeInTheDocument()
    expect(screen.queryByText(/8 points/i)).not.toBeInTheDocument()
  })

  // AC3: both filters narrow, ANDed. 'Wire the board' matches the query but is NOT blocked,
  // so with both on, nothing survives — which also exercises the AC5 message.
  it('composes with the blocked-only filter (AC3)', async () => {
    renderBoard()
    await userEvent.click(screen.getByRole('checkbox', { name: /blocked only/i }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'login')
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
    await userEvent.clear(screen.getByRole('searchbox', { name: /search/i }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'wire')
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
  })

  // AC5. Note this ALSO covers a defect that exists on main today, before this story: with
  // blocked-only on, a column with no blocked cards already says "No tickets yet." — a claim
  // about the sprint made by a filter.
  it('an emptied column says No matches, not No tickets yet (AC5)', async () => {
    renderBoard()
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzz')
    expect(screen.getAllByText(/no matches/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/no tickets yet/i)).not.toBeInTheDocument()
  })

  // The pre-existing defect, pinned in its own right.
  it('an emptied column says No matches under the blocked filter alone (AC5)', async () => {
    renderBoard()
    await userEvent.click(screen.getByRole('checkbox', { name: /blocked only/i }))
    // 'In Progress'/'In Review'/'Done' hold nothing; To Do still holds the blocked bug.
    expect(screen.getAllByText(/no matches/i).length).toBeGreaterThan(0)
  })

  // The positive control: with no filter at all, the honest message is the original one.
  it('says No tickets yet when nothing is filtered', () => {
    renderBoard()
    expect(screen.getAllByText(/no tickets yet/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/no matches/i)).not.toBeInTheDocument()
  })

  // M4 (SPRIN-68 post-merge review): the column's empty message ("No matches." here, or "No
  // tickets yet." on an unfiltered column) was a plain <p>. `getByRole('status', ...)` resolves
  // ONLY an element carrying that role, so this fails if the attribute is dropped. Scoped to one
  // column since several columns can say "No matches." at once.
  it('announces a filtered-empty column to screen readers (M4)', async () => {
    renderBoard()
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzz')
    const inProgress = screen.getByRole('heading', { name: 'In Progress' }).closest('section')!
    expect(within(inProgress).getByRole('status')).toHaveTextContent(/no matches/i)
  })

  // I1 (SPRIN-68 post-merge review): the Backlog's mirror test (`BacklogTab.test.tsx`, "keeps
  // the search box rendered when the query matches nothing") had no Board equivalent. Gating
  // `<TicketSearchInput>` on the FILTERED list (e.g. `visibleTickets.length > 0`) is lint-clean,
  // build-clean and passed every OTHER test in this file — nothing pinned that the box itself
  // must survive a no-match query. Without this test, typing a non-matching query would unmount
  // the only control that could clear it, leaving four "No matches." columns with no way back.
  it('keeps the search box rendered when the query matches nothing', async () => {
    renderBoard()
    const box = screen.getByRole('searchbox', { name: /search/i })
    await userEvent.type(box, 'zzz')
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument()
    await userEvent.clear(box)
    expect(screen.getByRole('button', { name: /wire the board/i })).toBeInTheDocument()
  })

  // A whitespace-only query is not a filter — `selectMatchingTickets`'s own documented
  // contract returns the list unchanged for one. A genuinely empty column must still say
  // "No tickets yet.", not "No matches.", when the box holds only spaces.
  it('treats a whitespace-only query as no filter at all (AC5)', async () => {
    renderBoard()
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), '   ')
    expect(screen.getAllByText(/no tickets yet/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/no matches/i)).not.toBeInTheDocument()
  })
})

/**
 * SPRIN-83 — a project without sprints shows every ticket on its board.
 *
 * Before this story such a board was permanently empty under a caption telling the user to
 * start a sprint from a tab SPRIN-82 had already removed. Each absence assertion below is
 * paired with a positive control in the same test, because "the caption is not in the
 * document" passes just as well when nothing rendered at all.
 */
describe('BoardTab on a project without sprints (SPRIN-83)', () => {
  // One unsprinted ticket and one still carrying a sprint id. AC1 is that BOTH appear: the
  // second is precisely the row the sprint-scoped board filtered away.
  const FLAT_TICKETS = [
    {
      id: 't1',
      key: 'MP-1',
      number: 1,
      summary: 'Do the todo',
      type: 'story',
      status: 'todo',
      sprint_id: null,
      is_blocked: false,
    },
    {
      id: 't2',
      key: 'MP-2',
      number: 2,
      summary: 'Ship it',
      type: 'bug',
      status: 'done',
      sprint_id: 's-old',
      is_blocked: true,
      blocked_reason: 'waiting on API',
    },
  ] as never

  function flatCtx(fields: Partial<ProjectShellContext> = {}): ProjectShellContext {
    return ctxWith({
      project: { project_type: 'kanban' } as never,
      tickets: FLAT_TICKETS,
      ...fields,
    })
  }

  // AC1.
  it('renders every ticket in its status column, including one with a sprint_id', () => {
    renderTab(BoardTab, flatCtx())
    const todo = screen.getByRole('heading', { name: 'To Do' }).closest('section')!
    const done = screen.getByRole('heading', { name: 'Done' }).closest('section')!
    expect(within(todo).getByRole('button', { name: /do the todo/i })).toBeInTheDocument()
    expect(within(done).getByRole('button', { name: /ship it/i })).toBeInTheDocument()
    // The scoping control: each card is in its OWN column, not merely somewhere on the page.
    expect(within(todo).queryByRole('button', { name: /ship it/i })).not.toBeInTheDocument()
  })

  // AC2. The positive controls are the card and the column heading: the board really
  // rendered, it just says nothing about sprints. The context deliberately carries an ACTIVE
  // sprint row — unreachable today, and the rule is that such a board ignores it anyway.
  it('shows no sprint caption and no "No active sprint" message', () => {
    renderTab(BoardTab, flatCtx({ sprints: [ACTIVE_SPRINT] as never }))
    expect(screen.getByRole('button', { name: /do the todo/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'To Do' })).toBeInTheDocument()
    expect(screen.queryByText(/no active sprint/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Sprint 1')).not.toBeInTheDocument()
  })

  // AC3, and the non-obvious half of the story: both filters used to hang off the same
  // `activeSprint !== null` test as the caption, so removing the caption would have removed
  // them too. Each filter is asserted to NARROW, not merely to be present.
  it('offers the blocked-only filter, and it narrows the board', async () => {
    renderTab(BoardTab, flatCtx())
    const blockedOnly = screen.getByRole('checkbox', { name: /blocked only/i })
    expect(screen.getByRole('button', { name: /do the todo/i })).toBeInTheDocument()
    await userEvent.click(blockedOnly)
    expect(screen.getByRole('button', { name: /ship it/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /do the todo/i })).not.toBeInTheDocument()
  })

  it('offers the search box, and it narrows the board', async () => {
    renderTab(BoardTab, flatCtx())
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'Ship')
    expect(screen.getByRole('button', { name: /ship it/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /do the todo/i })).not.toBeInTheDocument()
  })
})

/**
 * AC5 — the sprint-scoped board is unchanged. The whole `BoardTab` describe at the top of
 * this file already exercises that, because `ctxWith` now says 'scrum' explicitly. These two
 * tests name the distinction, so a regression reads as "a Scrum board stopped being
 * sprint-scoped" rather than as an unrelated failure somewhere in a seventy-test suite.
 */
describe('BoardTab on a project with sprints (SPRIN-83 AC5)', () => {
  it("still shows only the active sprint's tickets, and still captions them", () => {
    renderTab(BoardTab, ctxWith({ tickets: SPRINT_TICKETS, sprints: [ACTIVE_SPRINT] as never }))
    expect(screen.getByText('Sprint 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /do the todo/i })).toBeInTheDocument()
  })

  it('still says so when no sprint is active, and offers no filters then', () => {
    renderTab(BoardTab, ctxWith({ tickets: SPRINT_TICKETS, sprints: [] }))
    expect(screen.getByText(/no active sprint/i)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /blocked only/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('searchbox', { name: /search/i })).not.toBeInTheDocument()
    // The positive control: the columns rendered, so the absences above are about the
    // filters and the caption rather than about a board that never painted at all.
    expect(screen.getByRole('heading', { name: 'To Do' })).toBeInTheDocument()
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
