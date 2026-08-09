import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'

import type { ProjectShellContext } from './ProjectShell'
import type { Project, ProjectStatus } from '@/lib/domain'
import { hasSprints, hasWipLimits } from '@/lib/domain'
import { ticketCountsByStatus } from '@/lib/project-statuses'
import { CadenceSettings } from './CadenceSettings'
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
 * The project row this tab RENDERS, plus the patch a successful project write applies to it
 * (SPRIN-97).
 *
 * **The patch lives here rather than in `ProjectShell`, and that is a deviation worth stating.**
 * Every other write on this tab hands its row to a reducer on `ProjectShellContext`, because the
 * shell owns those lists. It does not own `project`: the shell finds it in `AppLayout`'s
 * `projects` list (`projects.find((p) => p.id === projectId)`), so a project reducer would have
 * to be threaded from `AppLayout` down through `ProjectShell` and published on the context.
 * That is the right end state and SPRIN-96 — which reads the cadence to pre-fill a sprint's
 * dates from a DIFFERENT tab — is where it starts paying for itself. Today nothing outside this
 * section renders the cadence, so the patch is kept where its only reader is.
 *
 * **The id guard is not defensive dressing.** This tab is a nested route element, so switching
 * projects re-renders it with a new `project` instead of remounting it — the same hazard
 * `useTicketCounts`'s effect deps and `patchLoaded`'s "does this belong to this project" check
 * exist for. Without the comparison, a cadence saved on one project would go on being shown
 * over the next project's real values.
 */
function usePatchedProject(project: Project): [Project, (updated: Project) => void] {
  const [patched, setPatched] = useState<Project | null>(null)
  return [patched && patched.id === project.id ? patched : project, setPatched]
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
    options,
    optionsPhase,
    onRetry,
    onFieldCreated,
    onFieldUpdated,
    onFieldDeleted,
    onOptionCreated,
    onOptionUpdated,
    onOptionDeleted,
    onStatusCreated,
    onStatusUpdated,
    onStatusDeleted,
    onStatusesReordered,
  } = useOutletContext<ProjectShellContext>()

  const counts = useTicketCounts(project.id, statuses, statusesPhase === 'loaded')
  const [shown, onCadenceUpdated] = usePatchedProject(project)

  if (statusesPhase === 'failed') return <LoadFailure resource="statuses" onRetry={onRetry} />
  if (statusesPhase !== 'loaded') return <p className="text-muted-foreground text-sm">Loading…</p>

  return (
    <div className="flex flex-col gap-8">
      {/* SPRIN-94. Above the status list because a project's rhythm frames the columns rather
          than the other way round. Gated on hasSprints, not on !hasWipLimits: they are two
          different questions that share an answer only while there are exactly two project
          types. No phase gate of its own — the cadence rides on `project`, which the shell has
          already resolved by the time this tab renders at all.

          SPRIN-97 makes it a form. The gate stays exactly here — the project-type comparison
          belongs in the one place `project-type-single-expression.test.ts` can see it — and it
          reads the CONTEXT's `project`, not the patched copy: `project_type` has no UPDATE
          grant at all, so a patch can never change the answer, and reading `shown` here would
          make the gate look like it depended on a write. `cadence` is the patched row, so a
          saved cadence is stated in words without a reload. */}
      {/* `key={project.id}` REMOUNTS the section on a project switch, and it is load-bearing
          rather than a hint to the reconciler. This tab is a nested route element, so moving
          between projects RE-RENDERS it instead of unmounting it — and `useForm`'s
          `defaultValues` are captured once, at mount. Without the key the summary line updates
          (it reads the `cadence` prop) while the two pickers keep showing the PREVIOUS
          project's cadence, so a user who switches project and presses Save writes the old
          project's numbers onto the new one. `usePatchedProject`'s id guard does NOT cover
          this: it fixes what is displayed above the form, not the form's own state. Found by
          the SPRIN-97 review; pinned by "resets the cadence pickers, not just the summary". */}
      {hasSprints(project) && (
        <CadenceSettings
          key={project.id}
          projectId={project.id}
          cadence={shown}
          onUpdated={onCadenceUpdated}
        />
      )}

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
      <CustomFieldSettings
        projectId={project.id}
        fields={fields}
        phase={fieldsPhase}
        options={options}
        optionsPhase={optionsPhase}
        onRetry={onRetry}
        onCreated={onFieldCreated}
        onUpdated={onFieldUpdated}
        onDeleted={onFieldDeleted}
        onOptionCreated={onOptionCreated}
        onOptionUpdated={onOptionUpdated}
        onOptionDeleted={onOptionDeleted}
      />
    </div>
  )
}
