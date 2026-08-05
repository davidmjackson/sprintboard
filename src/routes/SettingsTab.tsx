import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'

import type { ProjectShellContext } from './ProjectShell'
import type { ProjectStatus } from '@/lib/domain'
import { hasWipLimits } from '@/lib/domain'
import { ticketCountsByStatus } from '@/lib/project-statuses'
import { CustomFieldSettings } from './CustomFieldSettings'
import { LoadFailure } from './LoadFailure'
import { StatusSettings } from './StatusSettings'

/**
 * Each status's ticket count, refetched whenever the project or its status list changes —
 * SPRIN-80's AC2, "the count is shown BEFORE the user commits to a delete".
 *
 * Defaults to, and resets to, an EMPTY map on failure — never to a map full of 0s.
 * `ticketCountsByStatus` THROWS rather than resolving a fabricated zero (see its own
 * docblock), and a `.catch` here that substituted zeros would silently undo that guard: zero
 * is the value that UNLOCKS a destructive delete, so a swallowed error becoming zero would
 * offer a delete the database is about to refuse. An empty map, by contrast, has no entry for
 * ANY status, which is what "we do not know" looks like to a caller.
 *
 * `ready` is checked INSIDE the effect, not around the hook call — this must run
 * unconditionally, before `SettingsTab`'s phase-gated early returns, same as any other hook.
 * Gating the fetch itself keeps the tab from issuing a pointless read while the status list
 * has not loaded (or has failed to), rather than fetching counts for a list of statuses that
 * is not really this project's.
 */
function useTicketCounts(
  projectId: string,
  statuses: readonly ProjectStatus[],
  ready: boolean,
): ReadonlyMap<string, number> {
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map())

  useEffect(() => {
    if (!ready) return
    let active = true
    ticketCountsByStatus(projectId, statuses)
      .then((result) => {
        if (active) setCounts(result)
      })
      .catch(() => {
        if (active) setCounts(new Map())
      })
    return () => {
      active = false
    }
  }, [projectId, statuses, ready])

  return counts
}

/**
 * The project's settings — a fourth tab beside Board, Backlog and Sprints (SPRIN-77).
 *
 * A tab rather than a dialog because the shell already publishes `statuses` and
 * `statusesPhase` on its context: a tab reads them for free and inherits the tab-scoped
 * `ErrorBoundary`, the shared Retry, and the phase-before-empty discipline. A dialog would
 * need all three threading again.
 *
 * Thin on purpose, in the shape `SprintsTab` has: the list, the add form and the writes are
 * `StatusSettings`'s, and this file is the context read, the counts fetch and the read-phase
 * gate.
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
    fields,
    fieldsPhase,
    onRetry,
    onStatusCreated,
    onStatusUpdated,
    onStatusDeleted,
    onStatusesReordered,
  } = useOutletContext<ProjectShellContext>()

  const counts = useTicketCounts(project.id, statuses, statusesPhase === 'loaded')

  if (statusesPhase === 'failed') return <LoadFailure resource="statuses" onRetry={onRetry} />
  if (statusesPhase !== 'loaded') return <p className="text-muted-foreground text-sm">Loading…</p>

  return (
    <div className="flex flex-col gap-8">
      <StatusSettings
        projectId={project.id}
        statuses={statuses}
        counts={counts}
        hasWipLimits={hasWipLimits(project)}
        onCreated={onStatusCreated}
        onUpdated={onStatusUpdated}
        onDeleted={onStatusDeleted}
        onReordered={onStatusesReordered}
      />

      {/* SPRIN-90. Carries its OWN phase rather than sharing the statuses gate above, so a
          failed fields read shows its own failure instead of an empty list — and, in the
          other direction, a healthy fields list is not hidden by a statuses failure any more
          than it has to be. The statuses gate above still short-circuits the whole tab when
          statuses fail; that is pre-existing behaviour and not this story's to change. */}
      <CustomFieldSettings fields={fields} phase={fieldsPhase} onRetry={onRetry} />
    </div>
  )
}
