import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

import { SettingsTab } from './SettingsTab'
import type { ProjectShellContext } from './ProjectShell'
import type { ReadPhase } from '@/lib/project-reads'
import type { Project, ProjectStatus } from '@/lib/domain'
import { ticketCountsByStatus } from '@/lib/project-statuses'

// Only the counts read is network-touching from this tab's point of view; every pure helper
// stays real.
vi.mock('@/lib/project-statuses', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-statuses')>()),
  ticketCountsByStatus: vi.fn(),
}))

// The list, the add form and the writes are exercised by `StatusSettings.test.tsx`. Here it is
// a probe that reports the props the tab handed down, so this suite pins the SEAM — which
// context fields reach the list — rather than re-testing the list.
//
// `counts` is rendered with `.has()`, deliberately NOT the real component's `?? 0` fallback:
// this probe exists to pin what the TAB passes down, and `.has()` is the only rendering that
// can tell "we fetched a real count" apart from "we have no data for this status at all" —
// exactly the distinction the failed-fetch test below depends on.
vi.mock('./StatusSettings', () => ({
  StatusSettings: ({
    projectId,
    statuses,
    counts,
  }: {
    projectId: string
    statuses: ProjectStatus[]
    counts: ReadonlyMap<string, number>
  }) => (
    <div>
      <p>
        settings for {projectId}: {statuses.map((s) => s.name).join(', ')}
      </p>
      <ul>
        {statuses.map((s) => (
          <li key={s.id}>
            <span>{counts.has(s.slug) ? `${counts.get(s.slug)} tickets` : 'unknown count'}</span>
            <button type="button" disabled={!counts.has(s.slug)}>
              Delete {s.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  ),
}))

const project = { id: 'p1', name: 'Sprintboard', key: 'SPB' } as Project

const STATUSES = [
  { id: 'st1', slug: 'triage', name: 'Triage', category: 'todo', position: 1 },
  { id: 'st2', slug: 'shipped', name: 'Shipped', category: 'done', position: 2 },
] as unknown as ProjectStatus[]

function renderTab(
  ctx: { statuses?: ProjectStatus[]; statusesPhase?: ReadPhase; onRetry?: () => void } = {},
) {
  const context = {
    project,
    statuses: STATUSES,
    statusesPhase: 'loaded',
    onRetry: vi.fn(),
    onStatusCreated: vi.fn(),
    onStatusUpdated: vi.fn(),
    onStatusDeleted: vi.fn(),
    onStatusesReordered: vi.fn(),
    ...ctx,
  } as unknown as ProjectShellContext
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/" element={<Outlet context={context} />}>
          <Route path="settings" element={<SettingsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
  return context
}

describe('SettingsTab', () => {
  beforeEach(() => {
    vi.mocked(ticketCountsByStatus).mockReset().mockResolvedValue(new Map())
  })

  it("hands the project's own status rows to the list", () => {
    renderTab()

    expect(screen.getByText('settings for p1: Triage, Shipped')).toBeVisible()
  })

  // AC2: the count is shown BEFORE the user commits to a delete. Keyed on `project.id` and the
  // status list — the tab's own set-state-in-effect fetch, not something `StatusSettings` does
  // for itself (it has no project id to read `tickets` with beyond the one it already gets for
  // `AddStatusForm`).
  it('fetches ticket counts for the project statuses and passes them down', async () => {
    vi.mocked(ticketCountsByStatus).mockResolvedValue(new Map([['triage', 3]]))

    renderTab()

    expect(await screen.findByText('3 tickets')).toBeInTheDocument()
    expect(ticketCountsByStatus).toHaveBeenCalledWith('p1', STATUSES)
  })

  // The single most important behaviour in this task. `ticketCountsByStatus` THROWS rather
  // than resolving a fabricated zero, and a `.catch` here that substituted zeros anyway would
  // silently undo that: zero is the value that UNLOCKS a destructive delete, so a swallowed
  // error becoming zero would offer a delete the database is about to refuse. The tab must
  // default to an EMPTY map instead — this probe's `.has()` rendering is what makes that
  // observable, since the real component's own fallback for a genuinely fresh status looks
  // the same as "no data" from the outside.
  it('does not claim a count of zero when the count read fails', async () => {
    vi.mocked(ticketCountsByStatus).mockRejectedValue(new Error('down'))

    renderTab()

    // Delete stays blocked rather than unlocking on a count we do not have.
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /^delete /i })[0]).toBeDisabled(),
    )
  })

  // The phase-before-empty rule every other tab follows. `statuses` is `[]` during BOTH
  // loading and failed, so a tab that only looked at the list would render a confident
  // "this project has no statuses" over a list it does not have — S4.6's defect, a distinct
  // state wearing another state's face. And with writes now on this surface it is worse than
  // cosmetic: adding a status against a failed read computes `max(position)+1` from `[]`.
  it('shows a loading state, not an empty list, while the read is in flight', () => {
    renderTab({ statuses: [], statusesPhase: 'loading' })

    expect(screen.getByText('Loading…')).toBeVisible()
    expect(screen.queryByText(/settings for p1/)).toBeNull()
  })

  it('shows an error state with a Retry, not an empty list, when the read failed', async () => {
    const u = userEvent.setup()
    const ctx = renderTab({ statuses: [], statusesPhase: 'failed' })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load statuses.')
    expect(screen.queryByText(/settings for p1/)).toBeNull()

    await u.click(screen.getByRole('button', { name: 'Retry' }))
    expect(ctx.onRetry).toHaveBeenCalled()
  })
})
