import { useCallback, useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'

import type { ProjectShellContext } from './ProjectShell'
import type { Project, ProjectMemberWithProfile, ProjectStatus } from '@/lib/domain'
import { hasSprints, hasWipLimits } from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import { listProjectMembers, roleOf } from '@/lib/project-members'
import { ticketCountsByStatus } from '@/lib/project-statuses'
import { useAuth } from '@/lib/auth-context'
import { CadenceSettings } from './CadenceSettings'
import { CustomFieldSettings } from './CustomFieldSettings'
import { LoadFailure } from './LoadFailure'
import { MemberSettings } from './MemberSettings'
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
 * The project's members, read HERE rather than on `ProjectShellContext`.
 *
 * Every other list this tab renders comes from the shell, because the board tabs need them
 * too. Nothing outside Settings renders the member list today, so putting it on the context
 * would publish state with exactly one reader and make every tab re-render when it changed.
 * `useTicketCounts` directly above is the same judgement for the same reason. SPRIN-104 --
 * which makes the OTHER settings sections role-aware -- is where this moves up, because that
 * is the story with a second reader.
 *
 * `reload` is what every successful write calls. There is deliberately NO local mirror of
 * the list and no optimistic patch: the RPCs return a TAG, not a row, so a client-side patch
 * would have to reconstruct what the database did from what it asked for -- and the
 * last-admin guard means the answer is sometimes "nothing happened". Refetching keeps one
 * source of truth, and the same discipline `CadenceSettings` applies to the cadence.
 *
 * A failed read resets to an EMPTY list rather than keeping stale rows, and the phase is what
 * the section renders on -- so an empty list is never mistaken for "this project has one
 * member", which is a state the schema cannot produce.
 */
function useProjectMembers(projectId: string): {
  members: readonly ProjectMemberWithProfile[]
  phase: ReadPhase
  reload: () => void
} {
  // ONE state object carrying the id it describes, not three independent pieces. The
  // alternative -- separate `members`/`phase` plus a `setPhase('loading')` at the top of the
  // effect -- is what the first draft did, and it was wrong twice over. `react-hooks/
  // set-state-in-effect` rejects the synchronous setState outright, and the reason the rule
  // exists is the second problem: between a project switch and the new read resolving, the
  // hook would hand back the PREVIOUS project's members under the new project's id. Pairing
  // the rows with the id they came from makes that state unrepresentable rather than merely
  // brief.
  const [state, setState] = useState<{
    projectId: string
    members: readonly ProjectMemberWithProfile[]
    phase: ReadPhase
  }>({ projectId, members: [], phase: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let active = true
    listProjectMembers(projectId)
      .then((rows) => {
        if (active) setState({ projectId, members: rows, phase: 'loaded' })
      })
      .catch(() => {
        if (active) setState({ projectId, members: [], phase: 'failed' })
      })
    return () => {
      active = false
    }
  }, [projectId, nonce])

  // DERIVED, never stored. While the id we hold differs from the one asked for, the read for
  // THIS project has not come back, so the honest answer is "loading" and an empty list --
  // not the rows we happen to still be holding for a different project.
  const stale = state.projectId !== projectId
  const reload = useCallback(() => setNonce((n) => n + 1), [])

  return {
    members: stale ? [] : state.members,
    phase: stale ? 'loading' : state.phase,
    reload,
  }
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
  const { user } = useAuth()
  const { members, phase: membersPhase, reload: reloadMembers } = useProjectMembers(project.id)

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

      {/* SPRIN-102. Above the status list because who belongs to a project frames how it is
          configured, and because this is the only section on the tab a non-admin can act on
          at all. It carries its OWN phase rather than riding the statuses gate, so a failed
          members read shows its own failure instead of blanking the tab.

          `key` REMOUNTS on a project switch, for the reason CadenceSettings
          documents below: this tab is a nested route element, so moving between projects
          re-renders rather than unmounts it. Without the key the add form's `useForm`
          defaults -- captured once, at mount -- would keep a half-typed address from the
          PREVIOUS project while the list beneath updated, and Add would send it to the new
          one. The hook's effect deps handle the DATA; they do not touch form state.

          THE PREFIX IS NOT COSMETIC. `CadenceSettings` above is a SIBLING in this same
          children list and already keys on `project.id`, so a bare `key={project.id}` here
          is a DUPLICATE KEY among siblings -- React then duplicates and omits children, and
          the measured symptom was TWO cadence sections in the tab after a project switch,
          which broke two SPRIN-97 tests that had nothing to do with members. React warns
          ("Encountered two children with the same key") but does not fail, so the only
          signal was a sibling suite going red. Any future keyed section here needs its own
          prefix too. */}
      <MemberSettings
        key={`members-${project.id}`}
        projectId={project.id}
        members={members}
        phase={membersPhase}
        role={roleOf(members, user?.id)}
        currentUserId={user?.id}
        onRetry={reloadMembers}
        onChanged={reloadMembers}
      />

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
