import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom'

import { SprintsTab } from './SprintsTab'
import type { ProjectShellContext, SprintsPhase, TicketsPhase } from './ProjectShell'
import type { ReadPhase } from '@/lib/project-reads'
import type { Project, ProjectStatus, Sprint, SprintCadence, Ticket } from '@/lib/domain'
import { completeSprint, startSprint } from '@/lib/sprints'

vi.mock('@/lib/sprints', () => ({ startSprint: vi.fn(), completeSprint: vi.fn() }))
const mockStart = vi.mocked(startSprint)
const mockComplete = vi.mocked(completeSprint)

// The dialog is exercised by its own suite; here it is a button that reports its props
// and, on click, invokes `onCreated` with a fixture sprint — so the tab's hand-off to
// the shell's `onSprintCreated` is exercised here, not just by the dialog's own tests.
//
// `cadence` is folded into the button's text too (S1 review finding): the tab passes
// `cadence={project}` straight through, and until this reported it, nothing in this file
// would have noticed if that were swapped for a hardcoded default — `project`'s own fixture
// now differs from the schema default in both fields so a wrong wire shows up as wrong text.
vi.mock('./CreateSprintDialog', () => ({
  CreateSprintDialog: ({
    existing,
    cadence,
    onCreated,
  }: {
    existing: readonly Sprint[]
    cadence: SprintCadence
    onCreated?: (sprint: Sprint) => void
  }) => (
    <button
      type="button"
      onClick={() =>
        onCreated?.({
          id: 'new-sprint',
          project_id: 'p1',
          name: 'Newly created',
          goal: null,
          status: 'future',
          start_date: null,
          end_date: null,
          created_at: '2026-07-16T12:00:00+00:00',
        })
      }
    >
      New sprint ({existing.length} existing, cadence:{cadence.sprint_length_weeks}/
      {cadence.sprint_start_weekday})
    </button>
  ),
}))

// `project_type` arrived with SPRIN-82: the tab now redirects a continuously-delivered
// project to its board, so a fixture without one is a project whose type reads `undefined`
// and every test in this file lands on the board stub instead of the tab. The `as Project`
// cast is an assertion rather than a check, so nothing warned about the missing field — the
// suite simply went red all at once. Kept explicit rather than defaulted inside `renderTab`,
// because "these tests are about a project that HAS sprints" is a fact worth reading here.
const project = {
  id: 'p1',
  name: 'Sprintboard',
  key: 'SPB',
  project_type: 'scrum',
  sprint_length_weeks: 3,
  sprint_start_weekday: 4,
} as Project

/** The same project delivered continuously. Built by spreading the fixture above so the two
 *  differ in `project_type` and nothing else — a pair that also differed in, say, its id
 *  could not say which field the component read. */
const kanbanProject = { ...project, project_type: 'kanban' } as Project

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    project_id: 'p1',
    name: 'Sprint 1',
    goal: null,
    status: 'future',
    start_date: null,
    end_date: null,
    created_at: '2026-07-16T00:00:00+00:00',
    ...overrides,
  }
}

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    project_id: 'p1',
    key: 'SPB-1',
    number: 1,
    summary: 'A ticket',
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
    created_at: '2026-07-16T00:00:00Z',
    updated_at: '2026-07-16T00:00:00Z',
    ...overrides,
  }
}

/** A project whose statuses are NOT the seeded four: the terminal one is slugged 'shipped',
 *  and a status slugged 'done' is deliberately categorised `in_progress`. A fixture that
 *  reused the seeded vocabulary could not tell "reads the category" from "reads the slug". */
const STATUSES = [
  { id: 'st1', slug: 'triage', name: 'Triage', category: 'todo', position: 1 },
  { id: 'st2', slug: 'done', name: 'Done (not really)', category: 'in_progress', position: 2 },
  { id: 'st3', slug: 'shipped', name: 'Shipped', category: 'done', position: 3 },
] as unknown as ProjectStatus[]

type ContextOverrides = {
  project?: Project
  sprints?: Sprint[]
  sprintsPhase?: SprintsPhase
  onSprintCreated?: (s: Sprint) => void
  onSprintUpdated?: (s: Sprint) => void
  onSprintCompleted?: (s: Sprint, tickets: Ticket[]) => void
  onRetry?: () => void
  tickets?: Ticket[]
  ticketsPhase?: TicketsPhase
  statuses?: ProjectStatus[]
  statusesPhase?: ReadPhase
}

/**
 * The outlet context every render in this file hands the tab.
 *
 * Every field the component reads is defaulted HERE, and `ctx` is spread over the top.
 * Both phases default to 'loaded' — the landed state every other test here means — and
 * both have to be supplied: the `as ProjectShellContext` cast is an assertion, not a
 * check, so omitting a field the component reads is not a type error. It would arrive as
 * `undefined`, which is neither 'loading' nor 'loaded' — the ticket-count tests would pass
 * for the wrong reason, and the Complete button would be absent from every test because
 * `statusesPhase !== 'loaded'`, not because the case under test made it so.
 *
 * Spread rather than a `??` per field: eleven of those put the caller over T2's
 * cyclomatic 10, and the defaults do not need a branch each.
 *
 * It is a function of its own rather than a literal inside `renderTab` because the
 * back-navigation harness below needs the identical context under a different router, and
 * a second copy of these eleven lines would be a fixture that can silently drift from the
 * one thirty tests are written against.
 */
function buildContext(ctx: ContextOverrides = {}): ProjectShellContext {
  return {
    project,
    sprints: [],
    sprintsPhase: 'loaded',
    onSprintCreated: vi.fn(),
    onSprintUpdated: vi.fn(),
    onSprintCompleted: vi.fn(),
    onRetry: vi.fn(),
    tickets: [],
    ticketsPhase: 'loaded',
    statuses: STATUSES,
    statusesPhase: 'loaded',
    ...ctx,
  } as ProjectShellContext
}

// The parent route's element is an `<Outlet context={...}>`, per the established pattern
// in BoardTab.test.tsx — a bare `<div />` has no outlet, so the nested route could never
// mount and the fixture would wire to nothing (the suite would pass vacuously).
//
// S6.2: sprints arrive through this context rather than a mocked `listSprints`, because
// the tab no longer owns the read. `sprintsPhase` is supplied per test, so the three-state
// read is still driven from here — the load itself is pinned in ProjectShell.test.tsx.
function renderTab(ctx: ContextOverrides = {}) {
  const context = buildContext(ctx)
  return render(
    <MemoryRouter initialEntries={['/sprints']}>
      <Routes>
        <Route path="/" element={<Outlet context={context} />}>
          <Route path="sprints" element={<SprintsTab />} />
          {/* SPRIN-82. The tab's redirect target, as a sibling of `sprints` under the same
              parent — `../board` climbs one ROUTE level, not one URL segment, so this is
              where it resolves. A stub rather than the real BoardTab: this suite is about
              what SprintsTab does, and the real board would drag its reads in. It exists to
              give the redirect somewhere observable to land, which is what turns "the sprint
              UI is gone" from an assertion that a blank render also satisfies into one that
              only a working redirect does. Every other test here enters at '/sprints' and
              never sees it. */}
          <Route path="board" element={<p>board tab stub</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

/**
 * A location readout and a real Back button, rendered OUTSIDE `<Routes>` so it survives
 * every navigation and can report where the router actually ended up.
 *
 * `navigate(-1)` rather than a click on an anchor: browser Back is the specific gesture
 * `replace` exists to protect, and it is the only one that can observe the difference
 * between a history entry that was replaced and one that was pushed.
 */
function BackNavigationProbe() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return (
    <div>
      <p>at: {pathname}</p>
      <button type="button" onClick={() => navigate(-1)}>
        go back
      </button>
    </div>
  )
}

/**
 * A router with TWO REAL HISTORY ENTRIES — the user was on the backlog, then followed a
 * stale link to `/sprints` — so that pressing Back has somewhere genuine to return to.
 * Every other test in this file enters at `/sprints` with nothing behind it, where Back
 * is unobservable and `replace` therefore looks free.
 *
 * Deliberately a SEPARATE harness rather than an option on `renderTab`: this is the only
 * test that needs a history, a backlog route or a location readout, and threading a
 * `<p>at: /sprints</p>` through the shared harness would put that string in front of the
 * thirty text queries in this file for no benefit to any of them.
 */
function renderWithHistory() {
  const context = buildContext({ project: kanbanProject })
  return render(
    <MemoryRouter initialEntries={['/backlog', '/sprints']} initialIndex={1}>
      <BackNavigationProbe />
      <Routes>
        <Route path="/" element={<Outlet context={context} />}>
          <Route path="backlog" element={<p>backlog tab stub</p>} />
          <Route path="sprints" element={<SprintsTab />} />
          <Route path="board" element={<p>board tab stub</p>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockStart.mockReset()
  mockComplete.mockReset()
})

describe('SprintsTab', () => {
  // SPRIN-82 AC2, at the component rather than the shell. `ProjectShell.test.tsx` pins the
  // same behaviour through the real route table and the real BoardTab; this one pins that
  // the decision is SPRINTSTAB'S, taken before anything else it renders. The two are not
  // redundant: move the guard up into the shell's route table and the shell test stays
  // green while this one goes red, which is the distinction worth keeping — a tab that
  // renders sprint UI whenever someone mounts it is a landmine for every future route.
  //
  // BOTH HALVES IN ONE TEST, deliberately. The Kanban half is entirely absence assertions,
  // and absence is the one thing that passes just as well when the fixture never built, the
  // context never arrived, or the component threw. Its controls are the board stub (the
  // redirect landed on a real route rather than rendering nothing) and, after the remount,
  // the scrum case showing the very sprint the Kanban case could not find — same sprint,
  // same harness, one field different. Split into two `it`s, the absence half could pass in
  // a run where the presence half had already failed.
  //
  // The scrum half deliberately uses the DEFAULT fixture rather than a locally built scrum
  // project: that fixture is what every other test in this file renders, so if it ever stops
  // being a project with sprints, this test says so first.
  it('redirects a kanban project off the sprints route, and leaves scrum alone (AC2/AC4)', () => {
    const kanban = renderTab({
      project: kanbanProject,
      sprints: [sprint({ name: 'Hardening push' })],
    })

    // Absent, not empty: no heading, no sprint row, and above all no create trigger — a
    // dialog that would write a sprint row this project's UI can never show again.
    expect(screen.queryByRole('heading', { name: /sprints/i })).not.toBeInTheDocument()
    expect(screen.queryByText('Hardening push')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New sprint/ })).not.toBeInTheDocument()
    // The control: the redirect resolved to a real route rather than rendering nothing.
    expect(screen.getByText('board tab stub')).toBeVisible()
    kanban.unmount()

    renderTab({ sprints: [sprint({ name: 'Hardening push' })] })

    expect(screen.getByRole('heading', { name: /sprints/i })).toBeVisible()
    expect(screen.getByText('Hardening push')).toBeVisible()
    expect(screen.queryByText('board tab stub')).not.toBeInTheDocument()
  })

  /**
   * The `replace` on that `<Navigate>`, which nothing else in the repo could observe.
   * Deleting it left all 849 tests green — including the redirect test directly above,
   * because the user still LANDS on the board either way. The harm `replace` prevents is
   * not about where the redirect goes; it is about what it leaves behind it in history.
   *
   * IT LIVES HERE RATHER THAN IN `ProjectShell.test.tsx` because it is a property of the
   * `<Navigate>` element in `SprintsTab.tsx` and of nothing else — the shell has no say in
   * it, and asserting it through the shell's route table would mean a red there could be
   * the shell's fault. This suite already owns the redirect at the component level for the
   * same reason.
   *
   * WHAT A PUSHED ENTRY ACTUALLY COSTS, since "Back is a bit odd" undersells it. With
   * `replace`, history is `['/backlog', '/board']` and Back returns the user to the
   * backlog — where they genuinely came from. WITHOUT it the redirect pushes, leaving
   * `['/backlog', '/sprints', '/board']`; Back lands on `/sprints`, which redirects
   * forward to `/board` again, so the user watches the board reappear and cannot get out
   * of it with the button that exists for exactly that. That is why the assertion is
   * `/backlog` and not merely "not /sprints": the trapped user never sees `/sprints`
   * either — the redirect is instant — so a test asserting only its absence passes on both
   * versions and pins nothing.
   *
   * The controls come first: the redirect must have fired at all (we are on the board,
   * not the sprints route) before "and Back goes somewhere sensible" means anything.
   */
  it('replaces the sprints history entry so Back is not a trap (SPRIN-82 AC2)', async () => {
    const user = userEvent.setup()
    renderWithHistory()

    // Control: the redirect fired and landed on the board, from the second history entry.
    expect(await screen.findByText('board tab stub')).toBeVisible()
    expect(screen.getByText('at: /board')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'go back' }))

    // The whole assertion: Back reached the page BEFORE the dead link, not the board again.
    expect(await screen.findByText('at: /backlog')).toBeInTheDocument()
    expect(screen.getByText('backlog tab stub')).toBeVisible()
    expect(screen.queryByText('board tab stub')).not.toBeInTheDocument()
  })

  it('lists a sprint with its name, status, goal and ISO dates', () => {
    renderTab({
      sprints: [
        sprint({
          name: 'Hardening push',
          goal: 'Ship the board',
          start_date: '2026-07-20T00:00:00+00:00',
          end_date: '2026-08-03T00:00:00+00:00',
        }),
      ],
    })

    expect(screen.getByText('Hardening push')).toBeVisible()
    expect(screen.getByText('Future')).toBeVisible()
    expect(screen.getByText('Ship the board')).toBeVisible()
    // ISO, UTC-pinned: the day reads the same in every timezone.
    expect(screen.getByText('2026-07-20 – 2026-08-03')).toBeVisible()
  })

  it('renders a sprint with no dates or goal', () => {
    renderTab({ sprints: [sprint()] })

    expect(screen.getByText('Sprint 1')).toBeVisible()
    expect(screen.getByText('No dates set')).toBeVisible()
  })

  it('shows the empty state when the project has no sprints', () => {
    renderTab({ sprints: [] })

    expect(screen.getByText('No sprints yet.')).toBeVisible()
  })

  it('shows an error state — not an empty one — when the read has failed', () => {
    renderTab({ sprintsPhase: 'failed' })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load sprints.')
    expect(screen.queryByText('No sprints yet.')).not.toBeInTheDocument()
  })

  it('passes the loaded sprints and the project cadence to the create dialog', () => {
    renderTab({ sprints: [sprint(), sprint({ id: 's2' })] })

    // S1 review finding: `cadence:3/4` is the project fixture's cadence, not the schema
    // default of `2/1` — the only shape that can tell "the prop reached the dialog" from
    // "the dialog hardcoded the default".
    expect(
      screen.getByRole('button', { name: 'New sprint (2 existing, cadence:3/4)' }),
    ).toBeVisible()
  })

  // The prepend itself now lives in the shell (it owns the list), so the tab's half of the
  // contract is that a created sprint is handed to `onSprintCreated`. The prepend *result*
  // — new sprint on top, existing one still below — is pinned end-to-end against the real
  // dialog in ProjectShell.test.tsx, so the behaviour is not lost at the task seam.
  it('hands a newly created sprint to the shell via onSprintCreated', async () => {
    const onSprintCreated = vi.fn()
    renderTab({ sprints: [sprint({ id: 's1', name: 'Older sprint' })], onSprintCreated })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'New sprint (1 existing, cadence:3/4)' }))

    expect(onSprintCreated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-sprint', name: 'Newly created' }),
    )
  })

  // The count is the sprint's ticket membership, read through `selectSprintTickets` — the
  // same `sprint_id` rule the backlog reads from the other side. The unit is real `sr-only`
  // text, not an `aria-label`: a <span> is `role="generic"`, on which ARIA 1.2 prohibits
  // aria-label (axe-core flags it), and real text gives the negative assertions below a
  // positive control.
  it("shows the count of a sprint's tickets, with a unit for screen readers", () => {
    renderTab({
      sprints: [sprint({ id: 's1', name: 'Hardening push' })],
      tickets: [
        ticket({ id: 't1', sprint_id: 's1' }),
        ticket({ id: 't2', sprint_id: 's1' }),
        ticket({ id: 't3', sprint_id: 's1' }),
      ],
    })

    const row = screen.getByRole('listitem')
    expect(within(row).getByText('3')).toBeVisible()
    expect(within(row).getByText('tickets')).toBeInTheDocument()
  })

  it('shows 0 for a sprint with no tickets', () => {
    renderTab({ sprints: [sprint({ id: 's1' })], tickets: [] })

    expect(within(screen.getByRole('listitem')).getByText('0')).toBeVisible()
  })

  // The shell serves `tickets: []` while its read is in flight, so a count rendered
  // ungated reads "0 tickets" on every sprint until it lands, then flips to the truth.
  // The `not('0')` assertion is the point of the test — asserting only that '—' is
  // present would also pass for a badge that rendered both.
  it('shows — rather than a false 0 while the ticket list has not landed', () => {
    renderTab({
      sprints: [sprint({ id: 's1', name: 'Hardening push' })],
      tickets: [], // what the shell serves before `listTickets` resolves
      ticketsPhase: 'loading',
    })

    const row = screen.getByRole('listitem')
    expect(within(row).getByText('—')).toBeVisible()
    expect(within(row).queryByText('0')).toBeNull()
    // The em-dash is aria-hidden, so the count's meaning has to reach a screen reader as
    // real text; "loading" is honest where "0 tickets" would be a claim we cannot make.
    expect(within(row).getByText('Ticket count loading')).toBeInTheDocument()
    expect(within(row).queryByText('tickets')).toBeNull()
  })

  // The failure twin of the test above, and the defect S4.6 exists to kill: a FAILED ticket
  // read served `[]` too, so a count gated on 'loading' alone fell through and rendered a
  // confident "0 tickets" for a list we never received. The `not('0')` assertion is the whole
  // test — '—' being present would also pass for a badge that rendered both.
  it('shows — rather than a false 0 when the ticket read has failed', () => {
    renderTab({
      sprints: [sprint({ id: 's1', name: 'Hardening push' })],
      tickets: [], // what the shell serves when `listTickets` rejects
      ticketsPhase: 'failed',
    })

    const row = screen.getByRole('listitem')
    expect(within(row).getByText('—')).toBeVisible()
    expect(within(row).queryByText('0')).toBeNull()
    expect(within(row).queryByText('tickets')).toBeNull()
  })

  // '—' is honest for BOTH non-loaded phases, but they are not the same fact: one resolves on
  // its own, the other needs the Retry the Backlog and Board carry. The em-dash is aria-hidden
  // and identical in both, so the distinction reaches a screen reader only as `sr-only` text —
  // if these two strings were ever collapsed into one, this is the test that notices.
  it('distinguishes an unavailable count from a loading one for screen readers', () => {
    const loading = renderTab({
      sprints: [sprint({ id: 's1' })],
      ticketsPhase: 'loading',
    })
    const loadingText = within(screen.getByRole('listitem')).getByText(/Ticket count/).textContent
    loading.unmount()

    renderTab({ sprints: [sprint({ id: 's1' })], ticketsPhase: 'failed' })
    const failedText = within(screen.getByRole('listitem')).getByText(/Ticket count/).textContent

    expect(loadingText).toBe('Ticket count loading')
    expect(failedText).toBe('Ticket count unavailable')
    expect(failedText).not.toBe(loadingText)
  })

  // The count badge deliberately has no Retry of its own — it cannot hold one, and the sprint
  // list around it is fine. The sprint read failing is a different matter: that block IS the
  // page, so it carries the recovery. Before S4.6 its copy told the user to refresh, because
  // there was nothing in-app to click.
  it('offers a Retry when the sprint read has failed, and calls onRetry when clicked', async () => {
    const onRetry = vi.fn()
    renderTab({ sprintsPhase: 'failed', onRetry })
    const user = userEvent.setup()

    expect(screen.queryByText(/refresh/i)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  // The counterweight to the test above: without this, a count that ignored `sprint_id`
  // entirely (`tickets.length`) would pass every assertion here.
  it("counts only that sprint's tickets — not the backlog's, and not another sprint's", () => {
    renderTab({
      sprints: [sprint({ id: 's1', name: 'First' }), sprint({ id: 's2', name: 'Second' })],
      tickets: [
        ticket({ id: 't1', sprint_id: 's1' }),
        ticket({ id: 't2', sprint_id: 's1' }),
        ticket({ id: 't3', sprint_id: 's2' }),
        ticket({ id: 't4', sprint_id: null }), // backlog
      ],
    })

    const [first, second] = screen.getAllByRole('listitem')
    expect(within(first!).getByText('2')).toBeVisible()
    expect(within(second!).getByText('1')).toBeVisible()
  })

  it('does not render the create trigger while sprints are still loading', () => {
    renderTab({ sprintsPhase: 'loading' })

    expect(screen.getByText('Loading…')).toBeVisible()
    expect(screen.queryByRole('button', { name: /New sprint/ })).not.toBeInTheDocument()
  })

  it('does not render the create trigger when the read has failed', () => {
    renderTab({ sprintsPhase: 'failed' })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load sprints.')
    expect(screen.queryByRole('button', { name: /New sprint/ })).not.toBeInTheDocument()
  })

  it('offers a Start button on a future sprint', () => {
    renderTab({ sprints: [sprint({ id: 's1', status: 'future' })] })
    const row = screen.getByText('Sprint 1').closest('li') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Start' })).toBeInTheDocument()
  })

  it('does not offer Start on an active or complete sprint', () => {
    renderTab({
      sprints: [
        sprint({ id: 's1', name: 'Active one', status: 'active' }),
        sprint({ id: 's2', name: 'Done one', status: 'complete' }),
      ],
    })
    const active = screen.getByText('Active one').closest('li') as HTMLElement
    const complete = screen.getByText('Done one').closest('li') as HTMLElement
    expect(within(active).queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(within(complete).queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  })

  it('offers Complete only for an active sprint', () => {
    renderTab({
      sprints: [
        sprint({ id: 'sf', name: 'Future one', status: 'future' }),
        sprint({ id: 'sa', name: 'Active one', status: 'active' }),
        sprint({ id: 'sc', name: 'Done one', status: 'complete' }),
      ],
    })

    const activeRow = screen.getByText('Active one').closest('li') as HTMLElement
    expect(within(activeRow).getByRole('button', { name: 'Complete' })).toBeInTheDocument()

    const futureRow = screen.getByText('Future one').closest('li') as HTMLElement
    expect(within(futureRow).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
    // Future keeps its Start button; Complete is only for active.
    expect(within(futureRow).getByRole('button', { name: 'Start' })).toBeInTheDocument()

    const completeRow = screen.getByText('Done one').closest('li') as HTMLElement
    expect(within(completeRow).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
  })

  // SPRIN-64 review: the button-level suites stub `onRetry={vi.fn()}` and pin only that the
  // message renders against a no-op parent — a contract the REAL composition negated. This
  // test is a step up from that (real `SprintsTab` rendering a real button, not a mocked one),
  // but it is NOT the test that catches the regression: this file's `renderTab` hands
  // `SprintsTab` a static context object built once per `render()` call, so the mock `onRetry`
  // it supplies mutates nothing and calling it here is inert. The actual bug lives one level up
  // — the shell's real `onRetry` bumps `reloadNonce`, which is what makes `useTaggedRead` drop
  // the in-flight sprints and unmount this row. Proven: re-adding the reverted `onRetry()` call
  // on the stale path does NOT turn this test red. The test that DOES catch it renders the real
  // `ProjectShell` — see "shows the stale Complete/Start message in the real shell composition"
  // in `ProjectShell.test.tsx`. Kept here anyway because it still pins something real: the
  // message reaches the DOM through the actual `SprintsTab` → `CompleteSprintButton` wiring,
  // not just a component tested in isolation.
  // SPRIN-77. The tab is the one place that turns the project's status ROWS into the terminal
  // slug set, once, and hands it to every Complete button. `doneSlugs` reads the CATEGORY, so
  // the fixture's `shipped` is terminal and its `done` — categorised `in_progress` — is not.
  it('derives the terminal slugs from the statuses by CATEGORY and passes them to complete', async () => {
    mockComplete.mockResolvedValue({ ok: false, error: 'unknown' })
    const user = userEvent.setup()
    renderTab({ sprints: [sprint({ id: 's1', status: 'active' })] })

    await user.click(screen.getByRole('button', { name: 'Complete' }))

    expect(mockComplete).toHaveBeenCalledWith('s1', new Set(['shipped']))
  })

  // A project with nothing terminal is a real state, not a broken one: the set is empty and
  // `completeSprint` omits its filter, so every ticket returns to the backlog.
  // ⚠ THIS FIXTURE'S NON-EMPTINESS IS LOAD-BEARING, and became so silently in SPRIN-101.
  //
  // The filter below leaves TWO non-terminal rows, so `statuses.length > 0` holds and the
  // Complete button still renders. That is the whole point: this test pins the fail-safe for
  // "a project with no terminal status", which is a legitimate instruction — distinct from
  // "the statuses read gave us nothing", which SPRIN-101's guard now hides the button for.
  //
  // "Simplify" this to `statuses: []` and the test does not fail. It silently inverts: the
  // button disappears, `getByRole` below throws, and if anyone then "fixes" that by asserting
  // absence instead, the empty-set fail-safe path stops being covered ANYWHERE with no red
  // in the suite. The two cases look identical in the data and are opposite in meaning.
  it('passes an EMPTY set when no status is in the done category', async () => {
    mockComplete.mockResolvedValue({ ok: false, error: 'unknown' })
    const user = userEvent.setup()
    renderTab({
      sprints: [sprint({ id: 's1', status: 'active' })],
      statuses: STATUSES.filter((s) => s.category !== 'done'),
    })

    await user.click(screen.getByRole('button', { name: 'Complete' }))

    expect(mockComplete).toHaveBeenCalledWith('s1', new Set())
  })

  // The teeth on the derivation. `statuses` is `[]` both while loading and when the read
  // failed, and an empty terminal set makes `completeSprint` omit its filter — so completing
  // against a degraded read would return every Done ticket to the backlog too. Hiding the
  // button is the honest degradation; Start is untouched, which is what proves the gate is
  // about the STATUSES read and not about sprints.
  it.each(['loading', 'failed'] as const)(
    'hides Complete while the statuses read is %s, rather than completing with an empty set',
    (statusesPhase) => {
      renderTab({
        sprints: [sprint({ id: 's1', name: 'Active one', status: 'active' })],
        statusesPhase,
      })

      const row = screen.getByText('Active one').closest('li') as HTMLElement
      expect(within(row).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
    },
  )

  // SPRIN-101. The THIRD source of an empty `statuses`, and the only one wearing the 'loaded'
  // phase — so the `it.each` above cannot see it and every existing test in this file stays
  // green without the guard. `projects` now resolves to MEMBERSHIP while `project_statuses` is
  // still owner-scoped until SPRIN-99, so a non-owner member reaches this tab and
  // `listProjectStatuses` SUCCEEDS with zero rows. Phase 'loaded', `statuses` `[]`, empty
  // terminal set, `completeSprint` drops its filter, every Done ticket returns to the backlog.
  //
  // The role query is paired with a raw DOM one on purpose: `queryByRole` skips `aria-hidden`
  // subtrees, so on its own it would prove only "not exposed to assistive tech" and would go
  // green with the button still rendered and clickable. `querySelectorAll('button')` sees the
  // element whatever its ARIA state, which is what makes this an ABSENCE assertion.
  it('hides Complete when the statuses read LOADED but returned zero rows', () => {
    renderTab({
      sprints: [sprint({ id: 's1', name: 'Active one', status: 'active' })],
      statuses: [],
      statusesPhase: 'loaded',
    })

    const row = screen.getByText('Active one').closest('li') as HTMLElement
    expect(within(row).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
    expect([...row.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Complete')
  })

  it('still offers Start while the statuses read is failed — the gate is statuses-only', () => {
    renderTab({
      sprints: [sprint({ id: 's1', name: 'Future one', status: 'future' })],
      statusesPhase: 'failed',
    })

    const row = screen.getByText('Future one').closest('li') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Start' })).toBeInTheDocument()
  })

  it('shows the stale Complete message in the real SprintsTab composition, not a stubbed parent', async () => {
    mockComplete.mockResolvedValue({ ok: false, error: 'stale' })
    const user = userEvent.setup()
    renderTab({ sprints: [sprint({ id: 's1', name: 'Hardening push', status: 'active' })] })

    await user.click(screen.getByRole('button', { name: 'Complete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sprint is no longer active. Refresh to see its current state.',
    )
  })

  it('shows the stale Start message in the real SprintsTab composition, not a stubbed parent', async () => {
    mockStart.mockResolvedValue({ ok: false, error: 'stale' })
    const user = userEvent.setup()
    renderTab({ sprints: [sprint({ id: 's1', name: 'Hardening push', status: 'future' })] })

    await user.click(screen.getByRole('button', { name: 'Start' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sprint is no longer waiting to start. Refresh to see its current state.',
    )
  })
})
