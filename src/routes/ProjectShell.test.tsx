import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Navigate, Outlet, Route, Routes, useOutletContext } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ProjectShell, type ProjectShellContext } from './ProjectShell'
import { BoardTab } from './BoardTab'
import { BacklogTab } from './BacklogTab'
import { SprintsTab } from './SprintsTab'
import type { ProjectsContext } from './AppLayout'
import type { Sprint, Ticket } from '@/lib/domain'
import { createTicket, deleteTicket, listTickets, updateTicket } from '@/lib/tickets'
import { createSprint, listSprints } from '@/lib/sprints'

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ session: {}, user: { id: 'u1', email: 'a@example.com' }, loading: false }),
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
}))

const mockList = vi.mocked(listTickets)
const mockDelete = vi.mocked(deleteTicket)
const mockListSprints = vi.mocked(listSprints)
beforeEach(() => {
  mockList.mockReset().mockResolvedValue([])
  vi.mocked(createTicket).mockReset()
  mockDelete.mockReset()
  vi.mocked(updateTicket).mockReset()
  mockListSprints.mockReset().mockResolvedValue([])
  vi.mocked(createSprint).mockReset()
})

const PROJECTS = [
  { id: 'p1', name: 'Apple', key: 'APP', owner_id: 'u1', project_type: 'scrum', created_at: '' },
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

/**
 * Reads back the sprint fields the shell publishes on its outlet context — the contract
 * Task 3's picker consumes from `TicketDetailDialog`.
 *
 * Deliberately NOT SprintsTab: while the tab still loaded sprints itself, "the tab shows a
 * sprint" and "the shell shows an error" were both true before the hoist, so a test driving
 * the real tab could not tell the two apart and passed against the un-hoisted code. This
 * probe can only see what the shell put on the context, so it fails until the load moves.
 */
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
  const { tickets, ticketsPhase, sprintsPhase, onRetry } = useOutletContext<ProjectShellContext>()
  return (
    <div>
      <p>tickets phase: {ticketsPhase}</p>
      <p>sprints phase: {sprintsPhase}</p>
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
            <Route path="probe" element={<SprintContextProbe />} />
            <Route path="ticket-probe" element={<TicketContextProbe />} />
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
    expect(screen.getByRole('heading', { name: /Apple/ })).toBeInTheDocument()
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
    mockList.mockReset().mockResolvedValue([ticketA, ticketB])
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
    mockList.mockResolvedValue([epic, story])
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
      { ...ticketBase, id: 't1', key: 'MP-1', number: 1, summary: 'Keep me' },
      { ...ticketBase, id: 't2', key: 'MP-2', number: 2, summary: 'Delete me', type: 'bug' },
    ])
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
})
