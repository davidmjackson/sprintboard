import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Navigate, Outlet, Route, Routes, useOutletContext } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectShell, type ProjectShellContext } from './ProjectShell'
import { BoardTab } from './BoardTab'
import { BacklogTab } from './BacklogTab'
import { SprintsTab } from './SprintsTab'
import { SettingsTab } from './SettingsTab'
import type { ProjectsContext } from './AppLayout'
import { DEFAULT_PROJECT_STATUSES } from '@/lib/domain'
import type { ProjectField, ProjectStatus, Sprint, Ticket } from '@/lib/domain'
import { createTicket, deleteTicket, listTickets, updateTicket } from '@/lib/tickets'
import { completeSprint, createSprint, listSprints, startSprint } from '@/lib/sprints'
import { listProjectFields } from '@/lib/project-fields'
import {
  createProjectStatus,
  deleteProjectStatus,
  listProjectStatuses,
  renameProjectStatus,
  reorderProjectStatuses,
  ticketCountsByStatus,
} from '@/lib/project-statuses'

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ session: {}, user: { id: 'u1', email: 'a@example.com' }, loading: false }),
}))
vi.mock('@/lib/project-statuses', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-statuses')>()),
  listProjectStatuses: vi.fn(),
  createProjectStatus: vi.fn(),
  renameProjectStatus: vi.fn(),
  reorderProjectStatuses: vi.fn(),
  deleteProjectStatus: vi.fn(),
  ticketCountsByStatus: vi.fn(),
}))
// Spread the real module so pure helpers (e.g. parseBlockReason, which the detail
// dialog calls during render) stay real; only the network-touching functions are mocked.
vi.mock('@/lib/tickets', async (orig) => ({
  ...(await orig<typeof import('@/lib/tickets')>()),
  listTickets: vi.fn(),
  createTicket: vi.fn(),
  updateTicket: vi.fn(),
  deleteTicket: vi.fn(),
  blockTicket: vi.fn(),
  unblockTicket: vi.fn(),
}))
// Same spread-the-real-module reasoning: `defaultSprintName` is a pure helper the real
// CreateSprintDialog calls, so only the network-touching reads/writes are mocked.
vi.mock('@/lib/sprints', async (orig) => ({
  ...(await orig<typeof import('@/lib/sprints')>()),
  listSprints: vi.fn(),
  createSprint: vi.fn(),
  startSprint: vi.fn(),
  completeSprint: vi.fn(),
}))
// SPRIN-90's fourth read. NOT optional, and not merely tidiness: without this mock the real
// `listProjectFields` runs in every test in this file and issues a live PostgREST request.
// MEASURED at review: 63 entries and 90 outbound requests from this one file. They are
// invisible because `useTaggedRead` catches the rejection — so the suite stays green while
// the "unit" half hammers the shared database, which in CI is the REAL project. CLAUDE.md
// attributes the moving 5s-timeout flake to exactly that kind of self-inflicted traffic, and
// it also made `fieldsPhase` nondeterministic in ~60 tests that never meant to exercise it.
vi.mock('@/lib/project-fields', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-fields')>()),
  listProjectFields: vi.fn(),
}))

// What `seed_project_statuses()` writes for every new project, so the default mock describes
// a project the database could actually produce. It resolved `[]` when Task 4 first wired this
// read, which was harmless only while nothing consumed the rows; since SPRIN-76's task 5 the
// board renders one column per row, and `[]` is a project with NO columns — a state SPRIN-80
// exists to make impossible. Tests about the read itself still override this locally.
const SEEDED_STATUSES = DEFAULT_PROJECT_STATUSES.map((status, i) => ({
  ...status,
  id: `1ecd8f0${i}-0000-4000-8000-000000000000`,
  project_id: 'p1',
})) as unknown as ProjectStatus[]

const mockList = vi.mocked(listTickets)
const mockDelete = vi.mocked(deleteTicket)
const mockListSprints = vi.mocked(listSprints)
const mockListStatuses = vi.mocked(listProjectStatuses)
const mockListFields = vi.mocked(listProjectFields)
beforeEach(() => {
  mockListFields.mockReset().mockResolvedValue([])
  mockList.mockReset().mockResolvedValue([])
  vi.mocked(createTicket).mockReset()
  mockDelete.mockReset()
  vi.mocked(updateTicket).mockReset()
  mockListSprints.mockReset().mockResolvedValue([])
  vi.mocked(createSprint).mockReset()
  vi.mocked(startSprint).mockReset()
  vi.mocked(completeSprint).mockReset()
  mockListStatuses.mockReset().mockResolvedValue(SEEDED_STATUSES)
  vi.mocked(createProjectStatus).mockReset()
  vi.mocked(renameProjectStatus).mockReset()
  vi.mocked(reorderProjectStatuses).mockReset()
  vi.mocked(deleteProjectStatus).mockReset()
  // Real StatusSettings now renders through this on every visit to the Settings tab (AC2), so
  // every test that reaches it needs a default — not just the ones about deleting. A REAL,
  // successful fetch of all-zero counts, not an empty map: since the fix for the "unknown
  // count must block" finding, an empty map now means "we do not know" and blocks every
  // Delete, which would make every test in this file that reaches Settings unable to click
  // one. Deriving the map from whatever `statuses` argument each call receives keeps it
  // honest for both the seeded four and any status a test adds locally first.
  vi.mocked(ticketCountsByStatus)
    .mockReset()
    .mockImplementation(async (_projectId, statuses) => new Map(statuses.map((s) => [s.slug, 0])))
})

const PROJECTS = [
  { id: 'p1', name: 'Apple', key: 'APP', owner_id: 'u1', project_type: 'scrum', created_at: '' },
] as never
/** The same project as `PROJECTS`, delivered continuously — the other half of SPRIN-81's
 *  header badge, which renders for BOTH types rather than only for Kanban. */
const KANBAN_PROJECTS = [
  { id: 'p1', name: 'Apple', key: 'APP', owner_id: 'u1', project_type: 'kanban', created_at: '' },
] as never

const ticketBase: Ticket = {
  id: 'tA',
  project_id: 'p1',
  key: 'APP-1',
  number: 1,
  summary: 'Alpha summary',
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
  created_at: '2026-07-15T00:00:00Z',
  updated_at: '2026-07-15T00:00:00Z',
}
const sprintBase: Sprint = {
  id: 's1',
  project_id: 'p1',
  name: 'Sprint 1',
  goal: null,
  status: 'future',
  start_date: null,
  end_date: null,
  created_at: '2026-07-15T00:00:00+00:00',
}
const ticketA = ticketBase
const ticketB: Ticket = {
  ...ticketBase,
  id: 'tB',
  key: 'APP-2',
  number: 2,
  summary: 'Beta summary',
}
// The board renders only the ACTIVE sprint's tickets (S7.1), so a test that opens a ticket from
// its board card must supply an active sprint and tag the ticket to it — a backlog ticket
// (sprint_id null) no longer appears on the board.
const activeSprint: Sprint = { ...sprintBase, id: 's-active', status: 'active' }
const onBoard = (t: Ticket): Ticket => ({ ...t, sprint_id: activeSprint.id })

/**
 * Reads back the sprint fields the shell publishes on its outlet context — the contract
 * Task 3's picker consumes from `TicketDetailDialog`.
 *
 * Deliberately NOT SprintsTab: while the tab still loaded sprints itself, "the tab shows a
 * sprint" and "the shell shows an error" were both true before the hoist, so a test driving
 * the real tab could not tell the two apart and passed against the un-hoisted code. This
 * probe can only see what the shell put on the context, so it fails until the load moves.
 */
/**
 * SPRIN-90. Reads `fields`/`fieldsPhase` straight off the context, for the same reason the
 * two probes below it exist: driving the real Settings tab cannot distinguish what the SHELL
 * published from what the tab computed.
 *
 * It renders `statusesPhase` alongside deliberately. `SettingsTab` gates the whole tab on
 * statuses, so a `fieldsPhase` accidentally sourced from `statusesPhase` is invisible through
 * any real surface — the tab only renders once statuses are loaded, by which time the two
 * agree. Showing both, and driving them to DIFFERENT values in the test below, is what makes
 * that substitution observable at all.
 */
function FieldContextProbe() {
  const { fields, fieldsPhase, statusesPhase, onRetry } = useOutletContext<ProjectShellContext>()
  return (
    <div>
      <p>fields phase: {fieldsPhase}</p>
      <p>statuses phase: {statusesPhase}</p>
      <ul>
        {fields.map((f) => (
          <li key={f.id}>{f.name}</li>
        ))}
      </ul>
      <button type="button" onClick={onRetry}>
        probe retry
      </button>
    </div>
  )
}

function SprintContextProbe() {
  const { sprints, sprintsPhase } = useOutletContext<ProjectShellContext>()
  return (
    <div>
      <p>phase: {sprintsPhase}</p>
      <ul>
        {sprints.map((s) => (
          <li key={s.id}>{s.name}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Reads back the ticket fields the shell publishes on its outlet context, plus the retry
 * affordance. Same reasoning as `SprintContextProbe`: driving a real tab cannot distinguish
 * what the shell *published* from what the tab computed — a tab rendering "Nothing in the
 * backlog." is true both when the list is empty and when the read failed. Only a probe
 * reading the context directly can pin the phase itself.
 */
function TicketContextProbe() {
  const { tickets, ticketsPhase, sprintsPhase, statusesPhase, onRetry } =
    useOutletContext<ProjectShellContext>()
  return (
    <div>
      <p>tickets phase: {ticketsPhase}</p>
      <p>sprints phase: {sprintsPhase}</p>
      <p>statuses phase: {statusesPhase}</p>
      <ul>
        {tickets.map((t) => (
          <li key={t.id}>{t.summary}</li>
        ))}
      </ul>
      <button type="button" onClick={onRetry}>
        probe retry
      </button>
    </div>
  )
}

/** Stands in for AppLayout: hands the project list down through the outlet context. */
function ContextProvider({ ctx }: { ctx: ProjectsContext }) {
  return <Outlet context={ctx} />
}

const CRASH_CANARY = 'canary-rls-policy-detail'

/** A tab that throws during render — drives the tab-scope boundary through a real route. */
function CrashProbe(): never {
  throw new Error(CRASH_CANARY)
}

// Module-level flag, reset per test in the tab-scope boundary describe block's beforeEach —
// same shape as `Flaky` in ErrorBoundary.test.tsx. `CrashProbe` above always throws (other
// tests in this file depend on that), so recovery needs a SEPARATE probe that can be made to
// stop throwing mid-test, to observe what the fallback's button actually does.
let flakyCrashShouldThrow = true

/** Throws until `flakyCrashShouldThrow` is flipped false, then renders real content — lets a
 *  click on the tab fallback's button be observed as an actual in-place re-render. */
function FlakyCrashProbe() {
  if (flakyCrashShouldThrow) throw new Error(CRASH_CANARY)
  return <p>recovered tab content</p>
}

function renderShell(path: string, ctx: ProjectsContext = { projects: PROJECTS, loading: false }) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ContextProvider ctx={ctx} />}>
          <Route path="/" element={<p>home landing</p>} />
          <Route path="/projects/:projectId" element={<ProjectShell />}>
            <Route index element={<Navigate to="board" replace />} />
            <Route path="board" element={<BoardTab />} />
            <Route path="backlog" element={<BacklogTab />} />
            <Route path="sprints" element={<SprintsTab />} />
            <Route path="settings" element={<SettingsTab />} />
            <Route path="probe" element={<SprintContextProbe />} />
            <Route path="ticket-probe" element={<TicketContextProbe />} />
            <Route path="field-probe" element={<FieldContextProbe />} />
            <Route path="crash" element={<CrashProbe />} />
            <Route path="crash-flaky" element={<FlakyCrashProbe />} />
          </Route>
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('ProjectShell', () => {
  it('shows a Board tab and a Backlog tab for an open project', () => {
    renderShell('/projects/p1')
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Backlog' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sprints' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /Apple/ })).toBeInTheDocument()
  })

  // SPRIN-81. The badge renders for BOTH project types — a Scrum project is not the absence of
  // a badge, it is a badge reading "Scrum". That is deliberate: it gives the Kanban stories that
  // follow a positive control rather than another absence to prove, so a badge that silently
  // stopped rendering at all cannot pass as "this project is Scrum".
  //
  // TWO assertions per type, and both are needed — this is verbatim the SPRIN-67 lesson in
  // CLAUDE.md, re-earned here by mutation.
  //
  //  * DOM text SCOPED to the heading proves the badge renders IN THE HEADER rather than
  //    merely somewhere in the document. An unscoped getByText says the text exists and
  //    nothing about where it sits.
  //  * A SUBSTRING NAME QUERY proves it reaches the accessibility tree. `getByText` ignores
  //    only <script>/<style>, so it matches an `aria-hidden` subtree perfectly happily:
  //    adding aria-hidden="true" to the badge deletes it from every screen reader while
  //    leaving the whole suite green. A role+name query honours aria-hidden, so it does not.
  //
  // The name query is a REGEX and must stay one. The badge is `uppercase`, and Chrome's AX
  // tree applies `text-transform` when computing a name while jsdom does not — so an exact
  // name here ('APP Kanban Apple') would pin a string no browser produces. A substring match
  // is engine-independent, which is exactly the carve-out CLAUDE.md permits.
  it("badges a scrum project's header with its type", () => {
    renderShell('/projects/p1')
    const heading = screen.getByRole('heading', { name: /Apple/ })
    expect(within(heading).getByText('Scrum')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /scrum/i })).toBeInTheDocument()
  })

  it("badges a kanban project's header with its type", () => {
    renderShell('/projects/p1', { projects: KANBAN_PROJECTS, loading: false })
    const heading = screen.getByRole('heading', { name: /Apple/ })
    expect(within(heading).getByText('Kanban')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /kanban/i })).toBeInTheDocument()
  })

  // SPRIN-82 AC1. A Kanban project delivers continuously: sprints are not merely empty for
  // it, they have no meaning, so the nav must not offer the tab at all.
  //
  // THE POSITIVE CONTROLS SIT IN THIS SAME TEST DELIBERATELY, and splitting them out would
  // defeat them. A bare "the Sprints link is not in the document" passes just as happily on
  // a header that never rendered — a throw inside `ProjectShellHeader`, a fixture the shell
  // rejected as "not in your list" and redirected home, a route table that lost the shell —
  // and that is this epic's single named failure mode, because every story in it is about
  // something disappearing. Board, the ticket-list tab and Settings prove the nav rendered;
  // the Kanban badge proves it rendered for THIS project rather than silently falling back to
  // the scrum fixture, which would make the absence true for the wrong reason.
  //
  // SPRIN-83 renamed the ticket-list link to "All tickets" for this project type (AC4), so the
  // control below asks for that name. It is still a control and still exact: it must keep
  // saying "a link with this precise name really is in the nav". Relaxing it to a regex, or
  // dropping it, would give back exactly the cover the comment above says this test exists to
  // remove.
  //
  // TWO ABSENCE ASSERTIONS, ONE SCOPED AND ONE NOT, and they say different things — this
  // is not belt-and-braces. A reviewer proved it by leaking a Sprints link OUTSIDE the
  // `<nav>` for kanban only: 849/849 stayed green while a Kanban project rendered a live,
  // clickable Sprints link into the dead tab, because the only query pointed inside the
  // element the link had just left.
  //
  //  * The SCOPED one (`within(nav)`) is the one that says "not in the tab bar", which is
  //    where AC1's requirement actually lives, and it stops "the word sprint appears
  //    somewhere on the page" standing in for "the link exists" — the tab content
  //    underneath is free to mention sprints in prose.
  //  * The UNSCOPED one says "and nowhere else either". A link is a link wherever it is
  //    rendered: the harm AC1 names is a user reaching a tab that has no meaning for this
  //    project, and the `<nav>` is not what makes that reachable. It is safe to make this
  //    one document-wide precisely because it queries the LINK ROLE rather than text —
  //    the board underneath renders no links at all, and the tab content's prose is not a
  //    link.
  //
  // Both queries are REGEXes by design. An exact `'Sprints'` would go green on a link
  // relabelled to anything else while still routing to the dead tab; `/sprint/i` catches
  // the rename too. The positive controls keep the repo's existing exact names — each is a
  // single text node, which is the carve-out CLAUDE.md permits.
  it('offers no Sprints tab for a kanban project (SPRIN-82 AC1)', () => {
    renderShell('/projects/p1/board', { projects: KANBAN_PROJECTS, loading: false })

    const nav = screen.getByRole('navigation')
    expect(within(nav).queryByRole('link', { name: /sprint/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /sprint/i })).not.toBeInTheDocument()

    // Controls: the header, its nav and its other three tabs all really rendered…
    expect(within(nav).getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'All tickets' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeInTheDocument()
    // …for a project this suite can see is the Kanban one.
    expect(within(screen.getByRole('heading', { name: /Apple/ })).getByText('Kanban')).toBeVisible()
  })

  // The other half of AC4, and not redundant with the four-link test at the top of this
  // file: that one renders the default fixture without ever naming a project type, so a
  // predicate wired backwards (or to `undefined`) would be visible there only by accident.
  // This one asserts the link against the scrum fixture explicitly, scoped to the nav, so
  // the pair above and below say "shown for scrum, hidden for kanban" rather than "hidden".
  it('offers the Sprints tab for a scrum project (SPRIN-82 AC4)', () => {
    renderShell('/projects/p1/board')

    const nav = screen.getByRole('navigation')
    expect(within(nav).getByRole('link', { name: /sprint/i })).toBeInTheDocument()
    expect(within(screen.getByRole('heading', { name: /Apple/ })).getByText('Scrum')).toBeVisible()
  })

  // SPRIN-83 AC4. The tab is the same route either way — only its name changes, because a
  // project without sprints has no "outside a sprint" for a backlog to mean. The pair says
  // "Backlog for one type, All tickets for the other" rather than either name alone: a header
  // that hard-coded whichever string was written last would satisfy one of these and fail the
  // other, which is the point of writing both.
  //
  // Each carries the Board link as its positive control, in the SAME test and deliberately so:
  // "there is no Backlog link" is equally true of a header that never rendered at all — a
  // throw inside `ProjectShellHeader`, or a fixture the shell bounced home as "not in your
  // list". That is this epic's standing failure mode, named in the SPRIN-82 block above.
  //
  // Exact names, not regexes, and here that is the stronger choice rather than the weaker one:
  // the requirement IS the literal wording, "Backlog" is a substring of nothing else in the
  // nav, and the two names share no substring, so an exact query is what makes the absence
  // half mean anything. Both are single text nodes with no `text-transform`, which is the
  // carve-out CLAUDE.md permits.
  it('names the ticket-list tab "Backlog" on a scrum project (SPRIN-83 AC4)', () => {
    renderShell('/projects/p1/board')

    const nav = screen.getByRole('navigation')
    expect(within(nav).getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Backlog' })).toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'All tickets' })).not.toBeInTheDocument()
  })

  it('names it "All tickets" on a kanban project (SPRIN-83 AC4)', () => {
    renderShell('/projects/p1/board', { projects: KANBAN_PROJECTS, loading: false })

    const nav = screen.getByRole('navigation')
    expect(within(nav).getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'All tickets' })).toBeInTheDocument()
    expect(within(nav).queryByRole('link', { name: 'Backlog' })).not.toBeInTheDocument()
    // The second control: this really is the Kanban fixture, not a silent fallback to the
    // scrum projects — which would make the absence above true for entirely the wrong reason.
    expect(within(screen.getByRole('heading', { name: /Apple/ })).getByText('Kanban')).toBeVisible()
  })

  // The link's TARGET is unchanged, and that is a requirement rather than an incidental: AC4
  // renames the tab, it does not move it. Nothing else in this file opens the ticket list on a
  // project without sprints, so without this a `to="all-tickets"` typo — or a rename that
  // reached for a new route — would ship with every assertion above green and the tab dead.
  it('still routes to the same tab under its kanban name (SPRIN-83 AC4)', async () => {
    const user = userEvent.setup()
    renderShell('/projects/p1/board', { projects: KANBAN_PROJECTS, loading: false })

    await user.click(screen.getByRole('link', { name: 'All tickets' }))

    expect(await screen.findByText('This project has no tickets.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'To Do' })).not.toBeInTheDocument()
  })

  // SPRIN-82 AC2. Hiding the nav link (the pair of tests above) closes the door a user is
  // offered; it does nothing about the door they already have the key to. A bookmark, a
  // shared link, a back button, or a project converted before SPRIN-81 fixed the type all
  // arrive at `/projects/:id/sprints` directly, and until this redirect existed that URL
  // rendered the whole tab — CreateSprintDialog included — on a project with no sprint
  // concept. AC1 and AC2 are therefore two different holes, not one stated twice.
  //
  // THE BOARD CONTENT IS THE POSITIVE CONTROL, and it is the assertion that makes this test
  // worth anything. "No Sprints heading" is equally true of a route that rendered nothing at
  // all — a redirect to a path with no matching route, a `<Navigate>` that threw, a shell
  // that bounced the whole project home as "not in your list". Naming a real board column
  // proves the redirect LANDED somewhere the user can work, which is the actual requirement;
  // absence alone would let a dead end pass. The Kanban badge is the second control: it
  // proves the fixture under test is the Kanban one rather than a silent fallback to the
  // scrum projects, which would make the absence true for entirely the wrong reason.
  //
  // Queried by regex (`/sprints/i`) rather than the exact 'Sprints': a heading renamed to
  // "Sprint planning" would still be the dead tab, and an exact query would go green on it.
  it('redirects a kanban project away from the sprints URL to its board (SPRIN-82 AC2)', async () => {
    renderShell('/projects/p1/sprints', { projects: KANBAN_PROJECTS, loading: false })

    // Controls first: the redirect landed on the REAL BoardTab, for the Kanban fixture.
    expect(await screen.findByRole('heading', { name: 'To Do' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument()
    expect(within(screen.getByRole('heading', { name: /Apple/ })).getByText('Kanban')).toBeVisible()

    // …and the sprints tab is nowhere: not its heading, and not the create affordance that
    // is the concrete harm — a dialog that would write a sprint row for a project whose UI
    // has no other way to see one.
    expect(screen.queryByRole('heading', { name: /sprints/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /new sprint/i })).not.toBeInTheDocument()
  })

  // The other half of AC4, and the reason the test above cannot stand alone: a `<Navigate>`
  // rendered unconditionally — the predicate wired backwards, or to a field that is always
  // falsy — satisfies every assertion up there perfectly. This is the test that fails for
  // that mutation. It also pins the deep link itself, which the nav-link pair cannot: a
  // scrum user's bookmark must still open the tab.
  it('keeps the sprints URL for a scrum project (SPRIN-82 AC4)', async () => {
    renderShell('/projects/p1/sprints')

    expect(await screen.findByRole('heading', { name: /sprints/i })).toBeInTheDocument()
    // And it stayed on that route rather than falling through to the board.
    expect(screen.queryByRole('heading', { name: 'To Do' })).not.toBeInTheDocument()
  })

  // The LINK, and the shell's ability to render a settings tab underneath it — NOT the app's
  // route table. `renderShell` above builds its own `<Routes>`, settings route included, so
  // nothing in this file can observe `src/App.tsx`: the real `<Route path="settings">` was
  // deletable with every test here still green. `App.test.tsx` covers the real table.
  it('opens the Settings tab from its nav link', async () => {
    const user = userEvent.setup()
    renderShell('/projects/p1')
    await user.click(screen.getByRole('link', { name: 'Settings' }))
    expect(await screen.findByRole('heading', { name: 'Statuses' })).toBeInTheDocument()
  })

  it('defaults to the Board tab (renders the four columns) with no tickets', async () => {
    renderShell('/projects/p1')
    // Awaited, not synchronous: since S4.6 the board renders "Loading…" until the read
    // lands, rather than four confident "No tickets yet." columns over a list that is
    // merely `[]` so far. The assertion under test is which TAB is the default, so it
    // waits for the read the same way the Backlog test below does.
    expect(await screen.findByRole('heading', { name: 'To Do' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Done' })).toBeInTheDocument()
  })

  it('opens the Backlog tab when clicked', async () => {
    const user = userEvent.setup()
    renderShell('/projects/p1')
    await user.click(screen.getByRole('link', { name: 'Backlog' }))
    expect(await screen.findByText('Nothing in the backlog.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'To Do' })).not.toBeInTheDocument()
  })

  it('restores the Backlog tab from a deep link on load (survives a refresh)', async () => {
    renderShell('/projects/p1/backlog')
    expect(await screen.findByText('Nothing in the backlog.')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'To Do' })).not.toBeInTheDocument()
  })

  it('shows a New ticket button for an open project', async () => {
    renderShell('/projects/p1')
    expect(await screen.findByRole('button', { name: 'New ticket' })).toBeInTheDocument()
  })

  it('sends you home if the project id is not in your list', () => {
    renderShell('/projects/not-mine')
    expect(screen.getByText('home landing')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Board' })).not.toBeInTheDocument()
  })

  it('shows a loading state while the project list is loading', () => {
    renderShell('/projects/p1', { projects: [], loading: true })
    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })

  it('opens a ticket from its board card and resets edit state across a ticket switch (key remount)', async () => {
    const u = userEvent.setup()
    mockList.mockReset().mockResolvedValue([onBoard(ticketA), onBoard(ticketB)])
    mockListSprints.mockResolvedValue([activeSprint])
    renderShell('/projects/p1')

    // The board renders both cards once the (mocked) fetch lands.
    await u.click(await screen.findByRole('button', { name: /Alpha summary/i }))

    // Dialog A opened from the card click; enter edit mode on its summary field.
    await u.click(await screen.findByRole('button', { name: /edit summary/i }))
    expect(screen.getByRole('textbox', { name: /summary/i })).toBeInTheDocument()

    // Close the modal (first Escape cancels the field edit, second dismisses the dialog),
    // then open ticket B — selection goes A → null → B, remounting the keyed dialog.
    await u.keyboard('{Escape}')
    await u.keyboard('{Escape}')
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: /summary/i })).not.toBeInTheDocument(),
    )
    await u.click(await screen.findByRole('button', { name: /Beta summary/i }))

    // The remounted dialog shows B in VIEW mode — no textbox leaked across the switch.
    expect(await screen.findByRole('button', { name: /edit summary/i })).toHaveTextContent(
      'Beta summary',
    )
    expect(screen.queryByRole('textbox', { name: /summary/i })).not.toBeInTheDocument()
  })

  it("offers the project's epics in a non-epic ticket's parent-epic picker (real wiring)", async () => {
    const u = userEvent.setup()
    const epic: Ticket = {
      ...ticketBase,
      id: 'tE',
      key: 'APP-3',
      number: 3,
      summary: 'Platform epic',
      type: 'epic',
    }
    const story: Ticket = {
      ...ticketBase,
      id: 'tS',
      key: 'APP-4',
      number: 4,
      summary: 'Child story',
      type: 'story',
    }
    // The story is opened from its board card, so it must be in the active sprint. The epic need
    // not be — the parent-epic picker draws from all of the project's tickets, not the board.
    mockList.mockResolvedValue([epic, onBoard(story)])
    mockListSprints.mockResolvedValue([activeSprint])
    renderShell('/projects/p1')

    await u.click(await screen.findByRole('button', { name: /Child story/i }))
    const picker = await screen.findByRole('combobox', { name: /parent epic/i })
    expect(picker).toBeInTheDocument()
    // The epic from this project is a selectable parent — proves ProjectShell wired `epics`.
    expect(screen.getByRole('option', { name: /Platform epic/i })).toBeInTheDocument()
  })

  it('removes a ticket from the board after confirming delete', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue([
      onBoard({ ...ticketBase, id: 't1', key: 'MP-1', number: 1, summary: 'Keep me' }),
      onBoard({
        ...ticketBase,
        id: 't2',
        key: 'MP-2',
        number: 2,
        summary: 'Delete me',
        type: 'bug',
      }),
    ])
    mockListSprints.mockResolvedValue([activeSprint])
    mockDelete.mockResolvedValue({ ok: true })
    renderShell('/projects/p1')

    await user.click(await screen.findByRole('button', { name: /delete me/i }))
    await user.click(await screen.findByRole('button', { name: /ticket actions/i }))
    await user.click(await screen.findByRole('menuitem', { name: /delete/i }))
    await user.click(await screen.findByRole('button', { name: /^delete$/i }))

    await waitFor(() => expect(screen.queryByText('Delete me')).not.toBeInTheDocument())
    expect(screen.getByText('Keep me')).toBeInTheDocument()
  })

  it('shows a ticket created from the Backlog tab in the backlog immediately (S5.2 AC)', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue([])
    const created: Ticket = {
      ...ticketBase,
      id: 'tNew',
      key: 'APP-3',
      number: 3,
      summary: 'Fresh backlog work',
    }
    vi.mocked(createTicket).mockResolvedValue({ ok: true, ticket: created })

    renderShell('/projects/p1/backlog')
    expect(await screen.findByText('Nothing in the backlog.')).toBeInTheDocument()

    // The New ticket button lives in the shell header, so it is the create affordance on
    // the Backlog tab as much as on the Board — this drives the real dialog, not a stub.
    await user.click(screen.getByRole('button', { name: 'New ticket' }))
    await user.type(await screen.findByLabelText('Summary'), 'Fresh backlog work')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    // "Appears immediately": from the shell's append, with no second listTickets call —
    // a refetch here is what reintroduces the stale-response race S4.1 removed.
    expect(await screen.findByText('Fresh backlog work')).toBeInTheDocument()
    expect(screen.queryByText('Nothing in the backlog.')).not.toBeInTheDocument()
    expect(mockList).toHaveBeenCalledTimes(1)

    // "Leaves sprint_id null": the create call carries no sprint at all. Asserted on the
    // real arguments the dialog built, so a sprint leaking into the create path fails here.
    expect(vi.mocked(createTicket).mock.calls[0]![0]).toEqual({
      projectId: 'p1',
      summary: 'Fresh backlog work',
      type: 'story',
      description: undefined,
      storyPoints: undefined,
      labels: [],
      acceptanceCriteria: undefined,
    })
  })

  it('keeps a created ticket out of the backlog if it carries a sprint (the filter is live, not decorative)', async () => {
    // The inverse of the test above. Nothing in the app can produce this today, so
    // without it "appears immediately" would pass equally well against an unfiltered
    // list — this pins that the backlog is showing the ticket *because* it has no sprint.
    const user = userEvent.setup()
    mockList.mockResolvedValue([])
    vi.mocked(createTicket).mockResolvedValue({
      ok: true,
      ticket: {
        ...ticketBase,
        id: 'tS',
        key: 'APP-4',
        number: 4,
        summary: 'Sprinted',
        sprint_id: 's1',
      },
    })

    renderShell('/projects/p1/backlog')
    await user.click(await screen.findByRole('button', { name: 'New ticket' }))
    await user.type(await screen.findByLabelText('Summary'), 'Sprinted')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(vi.mocked(createTicket)).toHaveBeenCalled())
    expect(await screen.findByText('Nothing in the backlog.')).toBeInTheDocument()
    expect(screen.queryByText('Sprinted')).not.toBeInTheDocument()
  })

  // S6.2: the sprint read lives in the shell, because the detail dialog's sprint picker is
  // rendered here. These drive the REAL SprintsTab, as the suite does for Board/Backlog, so
  // they pin the shell→context→tab wiring rather than a stub's props.
  // Driven from a route with NO Sprints tab, so only the shell can be doing the reading.
  it("loads the project's sprints itself, scoped to the project id", async () => {
    renderShell('/projects/p1/probe')
    await waitFor(() => expect(mockListSprints).toHaveBeenCalledWith('p1'))
    expect(mockListSprints).toHaveBeenCalledTimes(1)
  })

  it('publishes the loaded sprints on the outlet context', async () => {
    mockListSprints.mockResolvedValue([{ ...sprintBase, name: 'Hardening push' }])
    renderShell('/projects/p1/probe')

    expect(await screen.findByText('Hardening push')).toBeVisible()
    expect(screen.getByText('phase: loaded')).toBeVisible()
  })

  // The three-state read, pinned THROUGH the hoist. The shell's ticket read next door
  // swallows a rejection into an empty list — moving sprints into the same file is exactly
  // how that defect spreads by osmosis. A failed sprint read must reach the context as
  // `failed`, never as a loaded-but-empty list.
  it("publishes phase 'failed' on the context when the read rejects, never an empty list", async () => {
    mockListSprints.mockRejectedValue(new Error('offline'))
    renderShell('/projects/p1/probe')

    expect(await screen.findByText('phase: failed')).toBeVisible()
    expect(screen.queryByText('phase: loaded')).not.toBeInTheDocument()
  })

  // End-to-end through the REAL tab: the shell's context actually drives the rendered
  // error state, not just a probe's text.
  it('renders the sprint error state — not the empty state — in the Sprints tab', async () => {
    mockListSprints.mockRejectedValue(new Error('offline'))
    renderShell('/projects/p1/sprints')

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load sprints.')
    expect(screen.queryByText('No sprints yet.')).not.toBeInTheDocument()
  })

  /**
   * SPRIN-90's fourth read, pinned at the SHELL boundary.
   *
   * Added after review, and these are not speculative: four type-valid, lint-clean, typecheck-
   * clean mutations of this wiring ALL SURVIVED the suite as originally shipped —
   * `fieldsPhase` sourced from `statusesPhase`, the published list forced empty, the read
   * pinned to nonce 0 so Retry stopped refetching, and the read given `undefined` for the
   * project id. The same four mutations applied to `sprints` were killed 41 and 13 tests deep,
   * which is how we know the gap was in the coverage rather than in the technique.
   *
   * `SettingsTab.test.tsx` covers the tab → component seam. It cannot see this one: it hands
   * the props in itself, so it passes just as well when the shell forwards nothing.
   */
  describe("the project's custom fields (SPRIN-90)", () => {
    const FIELD = {
      id: 'f1',
      project_id: 'p1',
      slug: 'customer_ref',
      name: 'Customer ref',
      type: 'text',
      created_at: '2026-08-05T10:00:00Z',
    } as unknown as ProjectField

    it("loads the project's custom fields itself, scoped to the project id", async () => {
      renderShell('/projects/p1/field-probe')
      await waitFor(() => expect(mockListFields).toHaveBeenCalledWith('p1'))
      expect(mockListFields).toHaveBeenCalledTimes(1)
    })

    it('publishes the loaded fields on the outlet context', async () => {
      mockListFields.mockResolvedValue([FIELD])
      renderShell('/projects/p1/field-probe')

      expect(await screen.findByText('Customer ref')).toBeVisible()
      expect(screen.getByText('fields phase: loaded')).toBeVisible()
    })

    /**
     * The one that matters most, and the reason the probe renders BOTH phases.
     *
     * Statuses resolve, fields reject — so the two phases must disagree. A `fieldsPhase`
     * derived from `statusesPhase` reads `loaded` here and renders "No custom fields yet."
     * over a failed read, which is S4.6's defect on the surface `CustomFieldSettings`'s own
     * docblock calls the easiest place to ship it. Driving them apart is what makes the
     * substitution observable; with both reads resolving, the mutation is invisible.
     */
    it("publishes 'failed' for a rejected fields read even while statuses load fine", async () => {
      mockListStatuses.mockResolvedValue(SEEDED_STATUSES)
      mockListFields.mockRejectedValue(new Error('offline'))
      renderShell('/projects/p1/field-probe')

      expect(await screen.findByText('fields phase: failed')).toBeVisible()
      // The positive control that makes the assertion above mean something: the OTHER read
      // succeeded, so `failed` is this read's own outcome and not a shell-wide collapse.
      expect(screen.getByText('statuses phase: loaded')).toBeVisible()
    })

    it('re-runs the fields read on Retry, so one nonce still drives all four', async () => {
      mockListFields.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([FIELD])
      renderShell('/projects/p1/field-probe')

      expect(await screen.findByText('fields phase: failed')).toBeVisible()

      await userEvent.click(screen.getByRole('button', { name: 'probe retry' }))

      expect(await screen.findByText('Customer ref')).toBeVisible()
      expect(screen.getByText('fields phase: loaded')).toBeVisible()
    })
  })

  // The prepend moved from SprintsTab's own state into the shell, so the assertion that
  // pinned it moved here with it — driven through the REAL CreateSprintDialog, so the
  // whole chain (dialog → tab → context → shell state → tab) is live. Without this, the
  // hoist would silently drop the behaviour the tab suite used to cover.
  it('prepends a newly created sprint to the top of the Sprints tab list', async () => {
    const user = userEvent.setup()
    mockListSprints.mockResolvedValue([{ ...sprintBase, id: 'sOld', name: 'Older sprint' }])
    vi.mocked(createSprint).mockResolvedValue({
      ok: true,
      sprint: { ...sprintBase, id: 'sNew', name: 'Newly created' },
    })
    renderShell('/projects/p1/sprints')

    await user.click(await screen.findByRole('button', { name: 'New sprint' }))
    await user.click(await screen.findByRole('button', { name: 'Create sprint' }))

    await waitFor(() => expect(screen.getByText('Newly created')).toBeInTheDocument())
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('Newly created')
    expect(items[1]).toHaveTextContent('Older sprint')
    // Local mutation, not a refetch: a second read is the stale-response race S4.1 removed.
    expect(mockListSprints).toHaveBeenCalledTimes(1)
  })

  // THE SEAM (S6.2 AC 1), both directions, through the REAL BacklogTab and the REAL
  // TicketDetailDialog — no stubs on either side.
  //
  // This test exists because the dialog's `sprints`/`sprintsPhase` props are optional and
  // defaulted: forget to pass them from the shell and the picker renders permanently
  // disabled while every per-task unit test still passes. Neither suite either side of this
  // seam can see that — the dialog's own tests pass the props by hand, and the shell's tests
  // never touched the picker. Deleting `sprints={sprints}` from the call site must turn this
  // test red; that has been verified by doing it.
  it('moves a ticket into a sprint and back to the backlog from the detail dialog (real wiring)', async () => {
    const u = userEvent.setup()
    mockList.mockResolvedValue([ticketA])
    mockListSprints.mockResolvedValue([{ ...sprintBase, id: 's1', name: 'Hardening push' }])
    // Echo the patch back as the server row would, so the reconcile after the optimistic
    // update agrees with it rather than reverting the field under test.
    vi.mocked(updateTicket).mockImplementation(async (id, patch) => ({
      ok: true,
      ticket: { ...ticketA, id, ...patch } as Ticket,
    }))

    renderShell('/projects/p1/backlog')
    await u.click(await screen.findByRole('button', { name: /Alpha summary/i }))

    // Enabled at all only because `sprintsPhase` arrived: the picker is
    // `disabled={sprintsPhase !== 'loaded'}`, and its default is 'loading'.
    const picker = await screen.findByRole('combobox', { name: 'sprint' })
    expect(picker).toBeEnabled()
    // Populated only because `sprints` arrived.
    expect(within(picker).getByRole('option', { name: /Hardening push/ })).toBeInTheDocument()

    // Into the sprint.
    await u.selectOptions(picker, 's1')
    await waitFor(() =>
      expect(vi.mocked(updateTicket)).toHaveBeenCalledWith('tA', { sprint_id: 's1' }),
    )
    // …and it leaves the backlog: the optimistic update flowed back through
    // `onTicketUpdated` into the shell's list, which the real BacklogTab filters.
    expect(await screen.findByText('Nothing in the backlog.')).toBeInTheDocument()

    // Back out to the backlog. '' is the domain's "no sprint", so the patch is `null`.
    await u.selectOptions(picker, '')
    await waitFor(() =>
      expect(vi.mocked(updateTicket)).toHaveBeenLastCalledWith('tA', { sprint_id: null }),
    )
    await waitFor(() =>
      expect(screen.queryByText('Nothing in the backlog.')).not.toBeInTheDocument(),
    )
    // The row is back. Close the modal first: the open dialog renders the summary too, and
    // `aria-hidden`s the backlog behind it, so a role query can only see the row once the
    // dialog is gone.
    await u.keyboard('{Escape}')
    expect(await screen.findByRole('button', { name: /Alpha summary/i })).toBeVisible()
  })

  // THE SAME SEAM, one story later, for SPRIN-76's per-project statuses — through the REAL
  // BacklogTab and the REAL TicketDetailDialog, for the identical reason: `statuses` and
  // `statusesPhase` are optional and defaulted on the dialog, so forgetting either at the call
  // site leaves the picker permanently disabled, or showing raw slugs, while every per-task
  // unit test still passes. Per-task mocking is blind to this seam by construction — the
  // dialog's own tests pass the props by hand, and the shell's tests never touched the picker.
  //
  // Measured, not assumed. At review of SPRIN-76 task 6 the two halves behaved differently:
  // `sprints={[]}` at the call site was caught by the sprint test above, while `statuses={[]}`
  // left all 668 unit tests green. This test closes that half. Deleting `statuses={statuses}`
  // or `statusesPhase={statusesPhase}` from `<TicketDetailDialog>` must turn it red; that has
  // been verified by doing it.
  it("offers the project's own status rows in the detail dialog's picker (real wiring)", async () => {
    const u = userEvent.setup()
    // A vocabulary the seeded four cannot account for. If the dialog ever went back to a
    // hard-coded list, or the shell stopped handing over the rows it read, 'Parked' vanishes —
    // whereas a fixture of exactly the seeded four would agree with a hard-coded list and prove
    // nothing.
    const parked = {
      ...SEEDED_STATUSES[0]!,
      id: '5ec0dd09-0000-4000-8000-000000000000',
      slug: 'parked',
      name: 'Parked',
      position: 5,
      is_initial: false,
    }
    mockListStatuses.mockResolvedValue([...SEEDED_STATUSES, parked])
    mockList.mockResolvedValue([ticketA])
    // Echo the patch back as the server row would, so the reconcile after the optimistic
    // update agrees with it rather than reverting the field under test.
    vi.mocked(updateTicket).mockImplementation(async (id, patch) => ({
      ok: true,
      ticket: { ...ticketA, id, ...patch } as Ticket,
    }))

    renderShell('/projects/p1/backlog')
    await u.click(await screen.findByRole('button', { name: /Alpha summary/i }))

    // Enabled at all only because `statusesPhase` arrived: the picker is
    // `disabled={statusesPhase !== 'loaded'}`, and its default is 'loading'.
    const picker = await screen.findByRole('combobox', { name: 'status' })
    expect(picker).toBeEnabled()
    // Populated from the rows the shell READ — including one no constant ever held.
    expect(within(picker).getByRole('option', { name: 'Parked' })).toBeInTheDocument()
    // And by NAME, not slug: `statuses={[]}` would leave `statusOptions` appending the ticket's
    // own status as `{ slug: 'todo', name: 'todo' }`, so 'To Do' is unreachable without the rows.
    expect(within(picker).getByRole('option', { name: 'To Do' })).toBeInTheDocument()

    // The header's label runs through the OTHER consumer of the same rows — `statusName` in the
    // dialog — so it fails independently of the picker. Scoped to the title row (a regex name
    // query: the heading's accessible name is composed from styled spans, see CLAUDE.md).
    expect(
      within(screen.getByRole('heading', { name: /APP-1/ })).getByText('To Do'),
    ).toBeInTheDocument()

    // And the seam is live, not merely rendered: a status only this project's rows contain is
    // selectable and commits.
    await u.selectOptions(picker, 'parked')
    await waitFor(() =>
      expect(vi.mocked(updateTicket)).toHaveBeenCalledWith('tA', { status: 'parked' }),
    )
  })

  // THE SAME SEAM AGAIN, for SPRIN-82 AC3 — and this pair is the only place in the repo that
  // can see it. The rule spans four components: `ProjectShell` asks the predicate,
  // `TicketDetailDialog` forwards the answer, `TicketDetailSidebar` forwards it again, and
  // `TicketSprintField` acts on it. Every one of those has its own tests, and every one of
  // them would stay green if the prop were wired to nothing whatsoever — the field's suite
  // passes the flag by hand, and the dialog's 52 render sites never mention it. A per-component
  // test cannot observe a seam by construction; only a render of the real chain can.
  //
  // Driven from the BACKLOG tab rather than a board card, which is a deliberate deviation from
  // the plan's suggestion: the board renders only the ACTIVE SPRINT's tickets today (S7.1, and
  // SPRIN-83 is the story that changes it), so opening a card there would mean handing a Kanban
  // project an active sprint — a fixture that contradicts the very rule under test. The backlog
  // needs no sprint to exist, which is exactly the state a Kanban project is in.
  //
  // THE POSITIVE CONTROLS ARE THE OTHER THREE PICKERS, asserted in this same test and scoped to
  // the dialog. "No sprint picker" is equally true of a dialog that never opened, a sidebar that
  // threw, and a ticket the backlog filtered away — and each of those would make this test green
  // while the Kanban rule did nothing. Status, type and assignee prove the Details panel
  // rendered in full; the sprint field is then the only thing missing from it.
  it('offers no sprint picker in the detail dialog for a kanban project (SPRIN-82 AC3)', async () => {
    const u = userEvent.setup()
    mockList.mockResolvedValue([ticketA])

    renderShell('/projects/p1/backlog', { projects: KANBAN_PROJECTS, loading: false })
    await u.click(await screen.findByRole('button', { name: /Alpha summary/i }))

    // Controls first: the dialog opened and its sidebar rendered its other three pickers.
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByRole('combobox', { name: 'status' })).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'type' })).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'assignee' })).toBeInTheDocument()

    // …and the sprint field is absent, label and all — not merely disabled or empty, which is
    // what a picker over a project with no sprints would otherwise degrade to.
    expect(within(dialog).queryByRole('combobox', { name: 'sprint' })).not.toBeInTheDocument()
    expect(within(dialog).queryByText('Sprint')).not.toBeInTheDocument()
  })

  // The other half of AC4, and the reason the test above cannot stand alone: a `hasSprints`
  // wired backwards, or a `TicketSprintField` that returns null unconditionally, satisfies
  // every assertion up there perfectly. This one fails for both of those.
  it('offers the sprint picker in the detail dialog for a scrum project (SPRIN-82 AC4)', async () => {
    const u = userEvent.setup()
    mockList.mockResolvedValue([ticketA])
    mockListSprints.mockResolvedValue([{ ...sprintBase, id: 's1', name: 'Hardening push' }])

    renderShell('/projects/p1/backlog')
    await u.click(await screen.findByRole('button', { name: /Alpha summary/i }))

    const dialog = await screen.findByRole('dialog')
    const picker = within(dialog).getByRole('combobox', { name: 'sprint' })
    // Populated from the shell's own read, so the extraction kept the props flowing through
    // both forwarding hops rather than merely rendering a picker.
    expect(within(picker).getByRole('option', { name: /Hardening push/ })).toBeInTheDocument()
    expect(picker).toBeEnabled()
  })

  // S4.6: the ticket read is three-state, like the sprint read beside it. Before this, the
  // shell's `.catch()` *resolved* the load with an empty list, so a rejected `listTickets`
  // looked finished AND successful — which is why a paused database claimed the backlog was
  // empty. These pin the phase on the context itself, via the probe, because a tab rendering
  // "Nothing in the backlog." cannot tell "empty" from "broken" apart either.
  describe('the ticket read phase (S4.6)', () => {
    it("publishes 'failed' on the context when listTickets rejects, never an empty loaded list", async () => {
      mockList.mockRejectedValue(new Error('offline'))
      renderShell('/projects/p1/ticket-probe')

      expect(await screen.findByText('tickets phase: failed')).toBeVisible()
      expect(screen.queryByText('tickets phase: loaded')).not.toBeInTheDocument()
    })

    it("publishes 'loaded' with the tickets once the read lands", async () => {
      mockList.mockResolvedValue([ticketA])
      renderShell('/projects/p1/ticket-probe')

      expect(await screen.findByText('tickets phase: loaded')).toBeVisible()
      expect(screen.getByText('Alpha summary')).toBeVisible()
    })

    it("publishes 'loading' while the read is in flight", async () => {
      mockList.mockReturnValue(new Promise(() => {}))
      renderShell('/projects/p1/ticket-probe')

      expect(await screen.findByText('tickets phase: loading')).toBeVisible()
    })

    // Retry means "reload this project's data": one nonce drives BOTH reads. This also
    // closes S6.2's sticky sprint read — a failed sprint read used to persist until a page
    // refresh purely because nothing could re-run the effect.
    it('re-runs BOTH reads on retry and recovers to loaded with the data', async () => {
      const u = userEvent.setup()
      mockList.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([ticketA])
      mockListSprints.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([sprintBase])
      renderShell('/projects/p1/ticket-probe')

      expect(await screen.findByText('tickets phase: failed')).toBeVisible()
      expect(await screen.findByText('sprints phase: failed')).toBeVisible()
      expect(mockList).toHaveBeenCalledTimes(1)
      expect(mockListSprints).toHaveBeenCalledTimes(1)

      await u.click(screen.getByRole('button', { name: 'probe retry' }))

      await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
      expect(mockListSprints).toHaveBeenCalledTimes(2)
      expect(await screen.findByText('tickets phase: loaded')).toBeVisible()
      expect(await screen.findByText('sprints phase: loaded')).toBeVisible()
      expect(screen.getByText('Alpha summary')).toBeVisible()
    })

    // The recovery path driven entirely through REAL components — real shell, real
    // BacklogTab, the real Retry button inside the real LoadFailure. The probe test above
    // pins the shell's half (the nonce re-runs both reads) and the tabs' own suites pin
    // theirs (Retry calls the prop they were handed), but nothing joined the two: a Retry
    // wired to the wrong callback, or a tab handed no `onRetry` at all, satisfies both
    // halves and still leaves a user stranded on an error screen with a dead button. This
    // is the test the design doc claims — the recovery path, end to end, through the tabs.
    it('recovers the backlog when the real Retry button in the real tab is clicked', async () => {
      const u = userEvent.setup()
      mockList.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([ticketA])
      renderShell('/projects/p1/backlog')

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tickets.')

      await u.click(screen.getByRole('button', { name: 'Retry' }))

      // The ticket the second read returned is on screen, and the error is gone — so the
      // click reached the shell's nonce and the new list flowed back out to this tab.
      expect(await screen.findByRole('button', { name: /Alpha summary/i })).toBeVisible()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(mockList).toHaveBeenCalledTimes(2)
    })

    // The create trigger is withheld unless the read landed. `onCreated` can only append to
    // a `loaded` list, so an ungated trigger over a failed read writes a real row to the
    // database and shows the user nothing at all — they retry and get duplicates. Pins the
    // gate in ProjectShell; deleting it must turn this red.
    it('offers no create trigger while the ticket read has failed (no invisible create)', async () => {
      mockList.mockRejectedValue(new Error('offline'))
      renderShell('/projects/p1/backlog')

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tickets.')
      expect(screen.queryByRole('button', { name: 'New ticket' })).not.toBeInTheDocument()
    })

    // The `loading` half of the same gate, and it is NOT covered by the two tests either side
    // of it: both drive failed→loaded, so weakening the gate to `ticketsPhase !== 'failed'`
    // leaves them green while reopening the invisible create through a narrower window. A read
    // in flight is not a list — click "New ticket" before it lands and `onCreated`'s
    // `phase === 'loaded'` guard drops the append, then the already-in-flight read resolves
    // with the pre-create rows and overwrites the state. The row is written, the UI never shows
    // it, and the user creates it again. Same defect as the failed case, smaller window.
    it('offers no create trigger while the ticket read is still in flight', async () => {
      // Never resolves: the read stays in flight, so the phase stays `loading` for the
      // whole test rather than racing the assertion.
      mockList.mockReturnValue(new Promise(() => {}))
      renderShell('/projects/p1/backlog')

      // Proves we are actually in `loading` — without this the assertion below could pass
      // simply because the shell had not rendered the header yet.
      expect(await screen.findByText('Loading…')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'New ticket' })).not.toBeInTheDocument()
    })

    // The other side of the gate: it must be a phase gate, not a blanket removal. Without
    // this, deleting the whole dialog passes the test above.
    it('offers the create trigger again once the read recovers', async () => {
      const u = userEvent.setup()
      mockList.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
      renderShell('/projects/p1/backlog')

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not load tickets.')
      expect(screen.queryByRole('button', { name: 'New ticket' })).not.toBeInTheDocument()

      await u.click(screen.getByRole('button', { name: 'Retry' }))

      expect(await screen.findByRole('button', { name: 'New ticket' })).toBeVisible()
    })

    // The nonce-in-the-TAG behaviour. Without the nonce in the match test, the stale
    // `failed` result still matches the current project, so the error stays on screen until
    // the new result lands — a Retry that appears to do nothing, which is how a user ends up
    // hammering it. With it in the tag, the stale result stops matching the instant the
    // nonce bumps and the phase derives back to 'loading', with no synchronous setState in
    // the effect (which `react-hooks/set-state-in-effect` forbids).
    it('returns the phase to loading the moment retry is clicked, before the new result lands', async () => {
      const u = userEvent.setup()
      mockList.mockRejectedValueOnce(new Error('offline')).mockReturnValue(new Promise(() => {}))
      mockListSprints
        .mockRejectedValueOnce(new Error('offline'))
        .mockReturnValue(new Promise(() => {}))
      renderShell('/projects/p1/ticket-probe')

      expect(await screen.findByText('tickets phase: failed')).toBeVisible()

      await u.click(screen.getByRole('button', { name: 'probe retry' }))

      // The second read never settles, so 'loading' here can only come from the nonce bump
      // invalidating the stale `failed` tag.
      expect(await screen.findByText('tickets phase: loading')).toBeVisible()
      expect(screen.queryByText('tickets phase: failed')).not.toBeInTheDocument()
      expect(await screen.findByText('sprints phase: loading')).toBeVisible()
    })
  })

  // SPRIN-76 Task 4: the shell's third project-scoped read, wired the same way as tickets
  // and sprints — same reloadNonce, so Retry covers it too.
  describe('the project statuses read', () => {
    it('reads the project statuses for the active project', async () => {
      renderShell('/projects/p1')
      await waitFor(() => expect(mockListStatuses).toHaveBeenCalledWith('p1'))
    })

    // The one that matters: a statuses read wired to its OWN nonce instead of the shared
    // `reloadNonce` would pass the test above and still leave Retry silently partial — the
    // user clicks Retry, tickets and sprints reload, statuses never do, and nothing is red.
    it('Retry reloads the statuses too, not only tickets and sprints', async () => {
      const u = userEvent.setup()
      mockListStatuses.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([])
      renderShell('/projects/p1/ticket-probe')

      await waitFor(() => expect(mockListStatuses).toHaveBeenCalledTimes(1))

      await u.click(await screen.findByRole('button', { name: 'probe retry' }))

      await waitFor(() => expect(mockListStatuses).toHaveBeenCalledTimes(2))
    })

    // Fix round 1 (Critical): the two tests above only assert the read was CALLED, never
    // what phase it produced — a regression that swapped `statusesPhase`'s source (e.g. for
    // `sprintRead.phase`) would call `listProjectStatuses` correctly and still ship a
    // permanently wrong phase, undetected. These pin the phase itself, through both
    // transitions, the same way the ticket/sprint phase tests below already do.
    it("publishes 'loaded' with statusesPhase once the read lands", async () => {
      mockListStatuses.mockResolvedValue([])
      renderShell('/projects/p1/ticket-probe')

      expect(await screen.findByText('statuses phase: loaded')).toBeVisible()
    })

    it("publishes 'failed' on statusesPhase when listProjectStatuses rejects, never 'loaded'", async () => {
      mockListStatuses.mockRejectedValue(new Error('offline'))
      renderShell('/projects/p1/ticket-probe')

      expect(await screen.findByText('statuses phase: failed')).toBeVisible()
      expect(screen.queryByText('statuses phase: loaded')).not.toBeInTheDocument()
    })
  })

  it('starts a future sprint from the Sprints tab and flips its badge to Active (real wiring)', async () => {
    const user = userEvent.setup()
    mockListSprints.mockResolvedValue([
      { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'future' },
    ])
    vi.mocked(startSprint).mockResolvedValue({
      ok: true,
      sprint: { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'active' },
    })

    renderShell('/projects/p1/sprints')

    const row = (await screen.findByText('Sprint 1')).closest('li') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Start' }))

    // The shell's onSprintUpdated replaced the sprint by id; the row now shows the Active badge
    // and no longer offers a Start button.
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(vi.mocked(startSprint)).toHaveBeenCalledWith('s1')
  })

  it('completes an active sprint: badge flips and its incomplete tickets leave the sprint', async () => {
    const user = userEvent.setup()
    // An active sprint with one incomplete ticket that belongs to it.
    mockList.mockResolvedValue([{ ...ticketA, id: 'tA', sprint_id: 's1', status: 'todo' }])
    mockListSprints.mockResolvedValue([
      { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'active' },
    ])
    vi.mocked(completeSprint).mockResolvedValue({
      ok: true,
      sprint: { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'complete' },
      returnedTickets: [{ ...ticketA, id: 'tA', sprint_id: null, status: 'todo' }],
    })

    renderShell('/projects/p1/sprints')

    const row = (await screen.findByText('Sprint 1')).closest('li') as HTMLElement
    // Before completing: the count badge shows the sprint's one ticket.
    expect(within(row).getByText('1')).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Complete' }))

    // The shell's onSprintCompleted swapped the sprint row and nulled the ticket's sprint_id.
    expect(within(row).getByText('Complete')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
    // The returned ticket left the sprint: the count badge drops to 0. Local mutation only.
    expect(within(row).getByText('0')).toBeInTheDocument()
    // The terminal set, derived by `doneSlugs` from the seeded rows the statuses read landed.
    expect(vi.mocked(completeSprint)).toHaveBeenCalledWith('s1', new Set(['done']))
    expect(mockListSprints).toHaveBeenCalledTimes(1)
    expect(mockList).toHaveBeenCalledTimes(1)
  })

  // SPRIN-77, and the point of the whole story: the shell's optimistic reducer must ask the
  // status's CATEGORY, not its slug. Both directions in one assertion, because a fix that read
  // the category for one and the slug for the other would still pass a one-sided test.
  //
  // `returnedTickets: []` is deliberate — it forces the reducer to derive the move itself
  // rather than copying the database's answer, which is the code path under test.
  //
  // The counts are DELIBERATELY LOPSIDED — two terminal tickets against one merely slugged
  // 'done'. An even split leaves the badge reading 1 under both rules, so the first draft of
  // this test passed against the unchanged `t.status !== 'done'` reducer: the count says how
  // many stayed, never which ones. Two-against-one makes the two rules give different numbers.
  it('keeps tickets on a terminal-CATEGORY status in the sprint and returns one merely slugged done', async () => {
    const user = userEvent.setup()
    // A vocabulary where the two rules disagree: 'shipped' is terminal, 'done' is not.
    mockListStatuses.mockResolvedValue([
      { id: 'st1', slug: 'triage', name: 'Triage', category: 'todo', position: 1 },
      { id: 'st2', slug: 'done', name: 'Done (not really)', category: 'in_progress', position: 2 },
      { id: 'st3', slug: 'shipped', name: 'Shipped', category: 'done', position: 3 },
    ] as unknown as ProjectStatus[])
    mockList.mockResolvedValue([
      { ...ticketA, id: 'tShipped1', key: 'APP-1', number: 1, sprint_id: 's1', status: 'shipped' },
      { ...ticketB, id: 'tShipped2', key: 'APP-2', number: 2, sprint_id: 's1', status: 'shipped' },
      { ...ticketB, id: 'tDone', key: 'APP-3', number: 3, sprint_id: 's1', status: 'done' },
    ])
    mockListSprints.mockResolvedValue([
      { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'active' },
    ])
    vi.mocked(completeSprint).mockResolvedValue({
      ok: true,
      sprint: { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'complete' },
      returnedTickets: [],
    })

    renderShell('/projects/p1/sprints')

    const row = (await screen.findByText('Sprint 1')).closest('li') as HTMLElement
    expect(within(row).getByText('3')).toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: 'Complete' }))

    // Two stayed (categorised done), one left (categorised in_progress despite its slug). A
    // reducer still reading the slug would leave exactly ONE attached instead.
    expect(within(row).getByText('2')).toBeInTheDocument()
    expect(vi.mocked(completeSprint)).toHaveBeenCalledWith('s1', new Set(['shipped']))
  })

  // A project with NO done-category status has nothing terminal, so every ticket comes back —
  // including one whose slug happens to be 'done'. The empty set is a real state, not an error.
  it('returns every ticket to the backlog when the project has no terminal status', async () => {
    const user = userEvent.setup()
    mockListStatuses.mockResolvedValue([
      { id: 'st1', slug: 'triage', name: 'Triage', category: 'todo', position: 1 },
      { id: 'st2', slug: 'done', name: 'Done (not really)', category: 'in_progress', position: 2 },
    ] as unknown as ProjectStatus[])
    mockList.mockResolvedValue([{ ...ticketA, id: 'tDone', sprint_id: 's1', status: 'done' }])
    mockListSprints.mockResolvedValue([
      { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'active' },
    ])
    vi.mocked(completeSprint).mockResolvedValue({
      ok: true,
      sprint: { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'complete' },
      returnedTickets: [],
    })

    renderShell('/projects/p1/sprints')

    const row = (await screen.findByText('Sprint 1')).closest('li') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Complete' }))

    expect(within(row).getByText('0')).toBeInTheDocument()
    expect(vi.mocked(completeSprint)).toHaveBeenCalledWith('s1', new Set())
  })

  it('completes a sprint on retry after a failed attempt already moved the ticket: badge still drops to 0', async () => {
    const user = userEvent.setup()
    // An active sprint with one incomplete ticket that belongs to it.
    mockList.mockResolvedValue([{ ...ticketA, id: 'tA', sprint_id: 's1', status: 'todo' }])
    mockListSprints.mockResolvedValue([
      { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'active' },
    ])

    renderShell('/projects/p1/sprints')

    const row = (await screen.findByText('Sprint 1')).closest('li') as HTMLElement
    expect(within(row).getByText('1')).toBeInTheDocument()

    // First attempt: the DB already moved the ticket (sprint_id nulled) and returned it, but
    // the status flip failed, so the shell never hears about the move. The sprint is still
    // Active and the local ticket list still has tA pointing at it.
    vi.mocked(completeSprint).mockResolvedValueOnce({ ok: false, error: 'unknown' })

    await user.click(within(row).getByRole('button', { name: 'Complete' }))

    expect(await within(row).findByRole('alert')).toBeVisible()
    expect(within(row).getByText('Active')).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: 'Complete' })).toBeInTheDocument()
    expect(within(row).getByText('1')).toBeInTheDocument()

    // Retry: the bulk ticket-move now matches zero rows (tA is already null in the DB), so
    // returnedTickets is empty, but the status flip succeeds this time.
    vi.mocked(completeSprint).mockResolvedValueOnce({
      ok: true,
      sprint: { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'complete' },
      returnedTickets: [],
    })

    await user.click(within(row).getByRole('button', { name: 'Complete' }))

    // Despite the empty returnedTickets, tA must still leave the sprint locally — the shell
    // derives the move from the completed sprint's id, not just the returned rows.
    expect(within(row).getByText('Complete')).toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument()
    expect(within(row).getByText('0')).toBeInTheDocument()
    expect(vi.mocked(completeSprint)).toHaveBeenCalledTimes(2)
  })

  // SPRIN-64 review, AC3: this is the REAL composition the earlier fix broke. Both button
  // suites (StartSprintButton.test.tsx / CompleteSprintButton.test.tsx) pin the stale message
  // against a stubbed `onRetry={vi.fn()}` — a no-op that cannot observe what the shell's real
  // `onRetry` does. `SprintsTab.test.tsx`'s own harness is no better: it hands `SprintsTab` a
  // static context object built once, so calling that mock `onRetry` mutates nothing either.
  // Only the real `ProjectShell` owns the `reloadNonce` state that `onRetry` bumps — bumping it
  // makes `useTaggedRead` drop the in-flight sprints and re-render `sprints: []`, which
  // unmounts this row (and the alert with it) in the same commit that set the message. Render
  // the real shell so that mechanism is actually exercised.
  it('shows the stale Complete message in the real shell composition, and it stays visible', async () => {
    const user = userEvent.setup()
    mockListSprints.mockResolvedValue([
      { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'active' },
    ])
    vi.mocked(completeSprint).mockResolvedValue({ ok: false, error: 'stale' })

    renderShell('/projects/p1/sprints')

    const row = (await screen.findByText('Sprint 1')).closest('li') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Complete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sprint is no longer active. Refresh to see its current state.',
    )
  })

  // SPRIN-77. The three status reducers, driven through the REAL SettingsTab and the REAL
  // StatusSettings, then read back off the REAL BoardTab — because the thing each one is for is
  // not "the context callback ran", it is "the board changed without a reload". A test that
  // asserted the callback fired would pass with the reducer patching nothing at all.
  //
  // Each also asserts `mockListStatuses` was called exactly ONCE across the whole interaction:
  // a reducer "fixed" into a refetch would show the same board and reintroduce the stale-response
  // race every other reducer in this file exists to avoid.
  describe('managing statuses from the Settings tab', () => {
    /** Board column headings, left to right — `position` order IS the column order. */
    function columnNames(): string[] {
      return screen
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent ?? '')
        .filter((name) => name !== 'Statuses')
    }

    it('adds a status and it becomes a board column with no reload (AC1)', async () => {
      const u = userEvent.setup()
      const blocked = {
        ...SEEDED_STATUSES[0]!,
        id: 'b10c4ed0-0000-4000-8000-000000000000',
        slug: 'blocked',
        name: 'Blocked',
        category: 'in_progress',
        position: 5,
        is_initial: false,
      } as ProjectStatus
      vi.mocked(createProjectStatus).mockResolvedValue({ ok: true, value: blocked })

      renderShell('/projects/p1/settings')

      await u.type(await screen.findByRole('textbox', { name: 'Name' }), 'Blocked')
      await u.click(screen.getByRole('button', { name: 'Add status' }))
      await waitFor(() => expect(vi.mocked(createProjectStatus)).toHaveBeenCalledTimes(1))

      await u.click(screen.getByRole('link', { name: 'Board' }))

      // Appended, so it is the LAST column — `max(position)+1` is what the write assigns.
      expect(await screen.findByRole('heading', { name: 'Blocked' })).toBeInTheDocument()
      expect(columnNames()).toEqual(['To Do', 'In Progress', 'In Review', 'Done', 'Blocked'])
      expect(mockListStatuses).toHaveBeenCalledTimes(1)
    })

    it('renames a status and the board column heading follows', async () => {
      const u = userEvent.setup()
      const renamed = { ...SEEDED_STATUSES[0]!, name: 'Backlogged' }
      vi.mocked(renameProjectStatus).mockResolvedValue({ ok: true, value: renamed })

      renderShell('/projects/p1/settings')

      await u.click(await screen.findByRole('button', { name: /edit name of To Do/i }))
      const input = screen.getByRole('textbox', { name: /name of To Do/i })
      await u.clear(input)
      await u.type(input, 'Backlogged{Enter}')
      await waitFor(() => expect(vi.mocked(renameProjectStatus)).toHaveBeenCalledTimes(1))

      await u.click(screen.getByRole('link', { name: 'Board' }))

      expect(await screen.findByRole('heading', { name: 'Backlogged' })).toBeInTheDocument()
      expect(columnNames()).toEqual(['Backlogged', 'In Progress', 'In Review', 'Done'])
      expect(mockListStatuses).toHaveBeenCalledTimes(1)
    })

    it('reorders the statuses and the board columns move with them', async () => {
      const u = userEvent.setup()
      // The RPC's own post-update rows, deliberately returned in an order that is NOT the new
      // column order: the reducer must re-sort by `position`. Handed back shuffled, a reducer
      // that merely spliced the array in the order it received would produce a different board.
      const reordered = [
        { ...SEEDED_STATUSES[3]!, position: 3 },
        { ...SEEDED_STATUSES[2]!, position: 4 },
        { ...SEEDED_STATUSES[0]!, position: 1 },
        { ...SEEDED_STATUSES[1]!, position: 2 },
      ] as ProjectStatus[]
      vi.mocked(reorderProjectStatuses).mockResolvedValue({ ok: true, value: reordered })

      renderShell('/projects/p1/settings')

      await u.click(await screen.findByRole('button', { name: /move Done up/i }))
      await waitFor(() =>
        // The COMPLETE list, in the intended order — a partial one leaves the omitted rows on
        // their old positions and can collide on the deferred unique index at commit.
        expect(vi.mocked(reorderProjectStatuses)).toHaveBeenCalledWith('p1', [
          'todo',
          'in_progress',
          'done',
          'in_review',
        ]),
      )

      await u.click(screen.getByRole('link', { name: 'Board' }))

      expect(await screen.findByRole('heading', { name: 'To Do' })).toBeInTheDocument()
      expect(columnNames()).toEqual(['To Do', 'In Progress', 'Done', 'In Review'])
      expect(mockListStatuses).toHaveBeenCalledTimes(1)
    })

    // SPRIN-80: the last of the four status reducers. Also proves the PROMOTION half of
    // `onStatusDeleted` — not just that the deleted column vanishes, but that the database's
    // AFTER DELETE trigger's promotion is mirrored locally: deleting 'To Do' (the seeded
    // initial status) must make 'In Progress' (the lowest-position survivor) the new initial
    // one, and the only place that is externally observable is the confirm dialog's hand-off
    // sentence on a SUBSEQUENT delete of that promoted status.
    it('deletes a status: it leaves the board with no reload, and promotes the next initial', async () => {
      const u = userEvent.setup()
      vi.mocked(deleteProjectStatus).mockResolvedValue({ ok: true, value: undefined })

      renderShell('/projects/p1/settings')

      await u.click(await screen.findByRole('button', { name: 'Delete To Do' }))
      await u.click(await screen.findByRole('button', { name: /^delete$/i }))
      await waitFor(() => expect(vi.mocked(deleteProjectStatus)).toHaveBeenCalledTimes(1))

      await u.click(screen.getByRole('link', { name: 'Board' }))

      expect(columnNames()).toEqual(['In Progress', 'In Review', 'Done'])
      expect(mockListStatuses).toHaveBeenCalledTimes(1)

      // 'In Progress' is now the initial status — `removeStatus`'s promotion, applied by the
      // shell's local reducer, not a refetch (the read above already pinned that at 1 call).
      await u.click(screen.getByRole('link', { name: 'Settings' }))
      await u.click(await screen.findByRole('button', { name: 'Delete In Progress' }))
      expect(await screen.findByRole('alertdialog')).toHaveTextContent(/will start in in review/i)
    })
  })

  it('shows the stale Start message in the real shell composition, and it stays visible', async () => {
    const user = userEvent.setup()
    mockListSprints.mockResolvedValue([
      { ...sprintBase, id: 's1', name: 'Sprint 1', status: 'future' },
    ])
    vi.mocked(startSprint).mockResolvedValue({ ok: false, error: 'stale' })

    renderShell('/projects/p1/sprints')

    const row = (await screen.findByText('Sprint 1')).closest('li') as HTMLElement
    await user.click(within(row).getByRole('button', { name: 'Start' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sprint is no longer waiting to start. Refresh to see its current state.',
    )
  })
})

describe('the tab-scope error boundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    flakyCrashShouldThrow = true
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('contains a tab crash and leaves the header and tab bar usable', async () => {
    renderShell('/projects/p1/crash')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong displaying this view.',
    )
    // AC1: the shell around the tab survives, so the user can navigate away.
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Backlog' })).toBeInTheDocument()
    expect(screen.getByText('Apple')).toBeInTheDocument()
  })

  it('does not render the thrown error text', async () => {
    renderShell('/projects/p1/crash')
    await screen.findByRole('alert')
    expect(document.body.textContent).not.toContain(CRASH_CANARY)
  })

  it('clears the crash when the user navigates to another tab', async () => {
    const user = userEvent.setup()
    renderShell('/projects/p1/crash')
    await screen.findByRole('alert')

    await user.click(screen.getByRole('link', { name: 'Backlog' }))

    // AC4: the fallback must not survive the navigation.
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('contains the real formatSprintDate crash, the case this story exists for', async () => {
    // `timestamptz` would reject this at the database edge; the point is that when a value
    // Date cannot parse does reach render, the tab degrades instead of the app dying.
    mockListSprints.mockResolvedValue([{ ...sprintBase, start_date: 'not-a-timestamp' }])
    renderShell('/projects/p1/sprints')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong displaying this view.',
    )
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
  })

  // AC5: the tab fallback's action re-renders the subtree IN PLACE, not a full page reload.
  // None of the tests above ever click the button, so a call site that swapped `onRetry={reset}`
  // for `onRetry={() => window.location.reload()}` left them all green — this is the one that
  // must go red for that change, because it is the only one that observes what the click does.
  it('re-renders the tab content in place when Try again is clicked (AC5)', async () => {
    const user = userEvent.setup()
    renderShell('/projects/p1/crash-flaky')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong displaying this view.',
    )

    flakyCrashShouldThrow = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    // The subtree re-rendered with real content, in the SAME shell — no reload, no reset of
    // component state elsewhere (the header/tab bar never unmounted).
    expect(await screen.findByText('recovered tab content')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
  })
})
