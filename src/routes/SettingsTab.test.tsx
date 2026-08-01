import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

import { SettingsTab } from './SettingsTab'
import type { ProjectShellContext } from './ProjectShell'
import type { ReadPhase } from '@/lib/project-reads'
import type { Project, ProjectStatus } from '@/lib/domain'

// The list, the add form and the writes are exercised by `StatusSettings.test.tsx`. Here it is
// a probe that reports the props the tab handed down, so this suite pins the SEAM — which
// context fields reach the list — rather than re-testing the list.
vi.mock('./StatusSettings', () => ({
  StatusSettings: ({ projectId, statuses }: { projectId: string; statuses: ProjectStatus[] }) => (
    <p>
      settings for {projectId}: {statuses.map((s) => s.name).join(', ')}
    </p>
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
  it("hands the project's own status rows to the list", () => {
    renderTab()

    expect(screen.getByText('settings for p1: Triage, Shipped')).toBeVisible()
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
