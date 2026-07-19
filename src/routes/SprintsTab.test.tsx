import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

import { SprintsTab } from './SprintsTab'
import type { ProjectShellContext, SprintsPhase, TicketsPhase } from './ProjectShell'
import type { Project, Sprint, Ticket } from '@/lib/domain'

vi.mock('@/lib/sprints', () => ({ startSprint: vi.fn(), completeSprint: vi.fn() }))

// The dialog is exercised by its own suite; here it is a button that reports its props
// and, on click, invokes `onCreated` with a fixture sprint — so the tab's hand-off to
// the shell's `onSprintCreated` is exercised here, not just by the dialog's own tests.
vi.mock('./CreateSprintDialog', () => ({
  CreateSprintDialog: ({
    existing,
    onCreated,
  }: {
    existing: readonly Sprint[]
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
      New sprint ({existing.length} existing)
    </button>
  ),
}))

const project = { id: 'p1', name: 'Sprintboard', key: 'SPB' } as Project

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

// The parent route's element is an `<Outlet context={...}>`, per the established pattern
// in BoardTab.test.tsx — a bare `<div />` has no outlet, so the nested route could never
// mount and the fixture would wire to nothing (the suite would pass vacuously).
//
// S6.2: sprints arrive through this context rather than a mocked `listSprints`, because
// the tab no longer owns the read. `sprintsPhase` is supplied per test, so the three-state
// read is still driven from here — the load itself is pinned in ProjectShell.test.tsx.
function renderTab(
  ctx: {
    sprints?: Sprint[]
    sprintsPhase?: SprintsPhase
    onSprintCreated?: (s: Sprint) => void
    onSprintUpdated?: (s: Sprint) => void
    onSprintCompleted?: (s: Sprint, tickets: Ticket[]) => void
    onRetry?: () => void
    tickets?: Ticket[]
    ticketsPhase?: TicketsPhase
  } = {},
) {
  // `ticketsPhase` defaults to 'loaded' — the landed state every other test here means.
  // It has to be passed explicitly: the `as ProjectShellContext` cast below is an
  // assertion, not a check, so omitting a field the component reads is not a type error.
  // It would arrive as `undefined`, which is neither 'loading' nor 'loaded' — the count
  // tests would pass for the wrong reason and the loading test could never fail.
  const context = {
    project,
    sprints: ctx.sprints ?? [],
    sprintsPhase: ctx.sprintsPhase ?? 'loaded',
    onSprintCreated: ctx.onSprintCreated ?? vi.fn(),
    onSprintUpdated: ctx.onSprintUpdated ?? vi.fn(),
    onSprintCompleted: ctx.onSprintCompleted ?? vi.fn(),
    onRetry: ctx.onRetry ?? vi.fn(),
    tickets: ctx.tickets ?? [],
    ticketsPhase: ctx.ticketsPhase ?? 'loaded',
  } as ProjectShellContext
  return render(
    <MemoryRouter initialEntries={['/sprints']}>
      <Routes>
        <Route path="/" element={<Outlet context={context} />}>
          <Route path="sprints" element={<SprintsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('SprintsTab', () => {
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

  it('passes the loaded sprints to the create dialog for auto-naming', () => {
    renderTab({ sprints: [sprint(), sprint({ id: 's2' })] })

    expect(screen.getByRole('button', { name: 'New sprint (2 existing)' })).toBeVisible()
  })

  // The prepend itself now lives in the shell (it owns the list), so the tab's half of the
  // contract is that a created sprint is handed to `onSprintCreated`. The prepend *result*
  // — new sprint on top, existing one still below — is pinned end-to-end against the real
  // dialog in ProjectShell.test.tsx, so the behaviour is not lost at the task seam.
  it('hands a newly created sprint to the shell via onSprintCreated', async () => {
    const onSprintCreated = vi.fn()
    renderTab({ sprints: [sprint({ id: 's1', name: 'Older sprint' })], onSprintCreated })
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'New sprint (1 existing)' }))

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
})
