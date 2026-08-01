import { useOutletContext } from 'react-router-dom'

import type { ProjectShellContext } from './ProjectShell'
import { LoadFailure } from './LoadFailure'
import { StatusSettings } from './StatusSettings'

/**
 * The project's settings — a fourth tab beside Board, Backlog and Sprints (SPRIN-77).
 *
 * A tab rather than a dialog because the shell already publishes `statuses` and
 * `statusesPhase` on its context: a tab reads them for free and inherits the tab-scoped
 * `ErrorBoundary`, the shared Retry, and the phase-before-empty discipline. A dialog would
 * need all three threading again.
 *
 * Thin on purpose, in the shape `SprintsTab` has: the list, the add form and the writes are
 * `StatusSettings`'s, and this file is the context read plus the read-phase gate.
 *
 * **The phase is consulted before the list**, the rule every other tab follows. `statuses` is
 * `[]` while loading AND when the read failed, so treating `[]` as "this project has no
 * statuses" would render a confident claim over a list we do not have — S4.6's defect, a
 * distinct state wearing another state's face. On this surface it is worse than cosmetic:
 * `createProjectStatus` derives `max(position)+1` and its collision-free slug from the rows
 * it is handed, so an add against a degraded read would append at position 1 on top of rows
 * that exist.
 */
export function SettingsTab() {
  const {
    project,
    statuses,
    statusesPhase,
    onRetry,
    onStatusCreated,
    onStatusUpdated,
    onStatusesReordered,
  } = useOutletContext<ProjectShellContext>()

  if (statusesPhase === 'failed') return <LoadFailure resource="statuses" onRetry={onRetry} />
  if (statusesPhase !== 'loaded') return <p className="text-muted-foreground text-sm">Loading…</p>

  return (
    <StatusSettings
      projectId={project.id}
      statuses={statuses}
      onCreated={onStatusCreated}
      onUpdated={onStatusUpdated}
      onReordered={onStatusesReordered}
    />
  )
}
