import { useState } from 'react'
import { Navigate, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom'

import type { ProjectsContext } from './AppLayout'
import {
  hasSprints,
  type Project,
  type ProjectField,
  type ProjectFieldOption,
  type ProjectStatus,
  type Sprint,
  type Ticket,
} from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import { useTaggedRead } from '@/lib/project-reads'
import { listTickets } from '@/lib/tickets'
import { listSprints } from '@/lib/sprints'
import { doneSlugs, listProjectStatuses, removeStatus } from '@/lib/project-statuses'
import { listProjectFields } from '@/lib/project-fields'
import { listProjectFieldOptions } from '@/lib/project-field-options'
import { useAuth } from '@/lib/auth-context'
import { CrashFallback, ErrorBoundary } from './ErrorBoundary'
import { ProjectShellHeader } from './ProjectShellHeader'
import { TicketDetailDialog } from './TicketDetailDialog'

/**
 * All three of this shell's reads are three-state, and symmetrically so (S4.6).
 *
 * The ticket read used to be the odd one out: its `.catch()` *resolved* the load with an
 * empty list, so "loading" — derived purely from project-id tagging — was false on failure
 * and the read looked finished AND successful. "Failed" was unrepresentable, which is why a
 * paused database rendered as "Nothing in the backlog." rather than an error. Both reads now
 * record `failed` rather than `[]`, and both tabs must consult the phase before treating an
 * empty list as "none".
 *
 * The invariant now lives in `useTaggedRead` (`@/lib/project-reads`), enforced once for both
 * reads. These two aliases are kept because four other modules import them by name, and
 * because "the sprints phase" reads better at a call site than "a read phase".
 */
export type SprintsPhase = ReadPhase
export type TicketsPhase = ReadPhase

/** What the shell hands to its Board/Backlog/Sprints tabs via the nested <Outlet context>. */
export type ProjectShellContext = {
  project: Project
  /** The project's tickets. `[]` while loading and when the read failed — always read
   *  `ticketsPhase` before treating an empty list as "no tickets". */
  tickets: Ticket[]
  ticketsPhase: TicketsPhase
  /** The project's sprints, newest first. `[]` while loading and when the read failed —
   *  always read `sprintsPhase` before treating an empty list as "no sprints". */
  sprints: Sprint[]
  sprintsPhase: SprintsPhase
  /** The project's statuses, in column (`position`) order. `[]` while loading and when the
   *  read failed — always read `statusesPhase` before treating an empty list as "no
   *  statuses". Shared for the same reason as sprints: the board's columns and the detail
   *  dialog's status picker (both later tasks of this same story, SPRIN-76) both need the
   *  same rows. */
  statuses: ProjectStatus[]
  statusesPhase: ReadPhase
  /** The project's custom field definitions, in creation order (SPRIN-90). `[]` while
   *  loading AND when the read failed — always read `fieldsPhase` before treating an empty
   *  list as "no custom fields", which here is the COMMON case rather than an edge one:
   *  every project starts with zero and nothing seeds them, so an empty list is exactly what
   *  a degraded read looks like. Shared from the shell for the same reason as statuses —
   *  story 3's detail sidebar and story 2's settings form need the same rows. */
  fields: ProjectField[]
  fieldsPhase: ReadPhase
  /** The project's `select`-field options, across every `select` field it has (SPRIN-92 task
   *  9). `[]` while loading AND when the read failed — always read `optionsPhase` before
   *  treating an empty list as "this field has no options", which is the COMMON case, exactly
   *  as with `fields` above: most fields are not `select`, and a `select` field starts with
   *  none. Shared from the shell for the same reason as `fields` — `CustomFieldOptions` renders
   *  one field's slice per `select` row, so a per-field fetch would multiply reads with the
   *  number of `select` fields on the project. `CustomFieldOptions` itself takes no phase prop
   *  (a Task 7 decision), so the CALLER — `CustomFieldSettings` — is where a failed read must
   *  be told apart from a genuinely empty list; see that component's own gate. */
  options: ProjectFieldOption[]
  optionsPhase: ReadPhase
  /** An option was added to a `select` field from the Settings tab (SPRIN-92 task 9). Appended,
   *  mirroring `onFieldCreated` — `createProjectFieldOption` derives `position` as
   *  `max(position)+1` from the rows it is handed, so the end of the list (for that field) is
   *  where the database itself would put it. */
  onOptionCreated: (option: ProjectFieldOption) => void
  /** An option was renamed (SPRIN-92 task 9). Replaces one row by its key, `(field_id, slug)` —
   *  there is no surrogate id on this table — mirroring `onFieldUpdated`. A rename never
   *  touches `slug`, so no other row's identity is affected. */
  onOptionUpdated: (option: ProjectFieldOption) => void
  /** An option was deleted (SPRIN-92 task 9). Removes it from the shared list by the same
   *  `(field_id, slug)` key — the value rows it gated go with it via `tfv_option_fk`'s cascade,
   *  which is the database's job, not this reducer's. */
  onOptionDeleted: (fieldId: string, slug: string) => void
  /** A custom field was added from the Settings tab (SPRIN-91). Appended, and appending is
   *  the CORRECT order rather than a convenient one: `listProjectFields` sorts by
   *  `(created_at, slug)` and a row created just now carries the newest `created_at`, so the
   *  end of the list is where the database itself would put it. A client-side re-sort here
   *  would be a second derivation of the ordering rule, which is exactly what `doneSlugs`
   *  exists to avoid elsewhere in this file. */
  onFieldCreated: (field: ProjectField) => void
  /** A custom field was renamed (SPRIN-91). Replaces one row by id; nothing moves, because a
   *  rename never touches `slug` and `slug` is half the sort key. Story 3's value rows key on
   *  `field_id`, so they are unaffected too — which is the whole point of the name/slug
   *  division this epic rests on. */
  onFieldUpdated: (field: ProjectField) => void
  /** A status was added from the Settings tab (SPRIN-77). Appended, because the write gives
   *  it `max(position)+1` — so appending IS the board's column order, not a guess at it. */
  onStatusCreated: (status: ProjectStatus) => void
  /** A status was renamed. Replaces one row by id; no other row moves, and no ticket row
   *  changes at all — `tickets_status_fk` references the slug, which a rename never touches. */
  onStatusUpdated: (status: ProjectStatus) => void
  /** The statuses were reordered. Takes the DATABASE's own post-update rows (the RPC's
   *  `RETURNING`), not a locally computed guess — the same discipline as
   *  `onSprintCompleted`'s `returnedTickets`. */
  onStatusesReordered: (statuses: ProjectStatus[]) => void
  /** A status was deleted (SPRIN-80). Removes it from the shared list via `removeStatus`,
   *  which ALSO applies the promotion `project_statuses_promote_initial()` performs when the
   *  deleted status was the project's initial one — mirrored here rather than re-derived,
   *  because `ProjectShell` is at cyclomatic 10 of 10 and a promotion branch in this file
   *  would redden `npm run lint`. */
  onStatusDeleted: (id: string) => void
  /** Re-runs ALL THREE reads for this project. Manual only — there is no automatic retry,
   *  backoff or polling — and it returns every phase to `loading` immediately, so a click
   *  is never mistaken for a no-op. */
  onRetry: () => void
  onSprintCreated: (sprint: Sprint) => void
  /** Replaces one sprint in the shared list by id — e.g. after it is started (S6.3). A local
   *  mutation, not a refetch, mirroring `onTicketUpdated`. */
  onSprintUpdated: (sprint: Sprint) => void
  /** Completing a sprint changes TWO of the shell's lists at once: the sprint's status and
   *  the `sprint_id` of every incomplete ticket that returned to the backlog. This applies
   *  both in one update so the count badge and the status badge never render out of step.
   *  A local mutation from the DB's own returned rows, not a refetch. "Incomplete" is decided
   *  by `doneSlugs(statuses)` — the status's CATEGORY, not the slug 'done' (SPRIN-77). */
  onSprintCompleted: (sprint: Sprint, returnedTickets: Ticket[]) => void
  /** The signed-in user. Resolved once here (the shell is inside `RequireAuth`, so it
   *  always exists) and shared, so a tab never reaches for the auth context itself and
   *  the detail dialog and the backlog row agree on who "you" is. */
  currentUser: { id: string; email: string }
  onOpenTicket: (ticket: Ticket) => void
  onTicketUpdated: (ticket: Ticket) => void
  onTicketDeleted: (id: string) => void
}

/**
 * The project shell, addressed by `:projectId` — a refresh keeps you here, and the
 * chosen tab (a nested route) survives too. The project is looked up in the RLS-scoped
 * list the layout already loaded; an id not in that list is not the user's to see, so
 * we send them home. The shell owns the project's ticket list and shares it with both
 * tabs, so Board and Backlog stay in sync and the list is fetched once.
 *
 * It owns the sprint list for the same reason (S6.2): the Sprints tab renders it, and the
 * detail dialog's sprint picker — rendered here, not in a tab — needs the same options.
 *
 * It owns the project's status list for the same reason again (SPRIN-76): the board's
 * columns and the detail dialog's status picker both need the same rows, so it is fetched
 * once here rather than by each consumer.
 */
export function ProjectShell() {
  const { projects, loading } = useOutletContext<ProjectsContext>()
  const { projectId } = useParams()
  const { user } = useAuth()
  const location = useLocation()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const project = loading ? undefined : projects.find((p) => p.id === projectId)
  const activeProjectId = project?.id

  // One nonce drives BOTH reads: retry means "reload this project's data", and the two
  // reads fail together far more often than apart (a paused database takes both). Bumping
  // it re-runs both effects and — because it is part of each result's tag, not just the
  // effect deps — instantly invalidates the stale result, so the phases derive back to
  // `loading` on the click rather than when the new result lands. A Retry that leaves the
  // error on screen reads as a no-op, and gets hammered.
  const [reloadNonce, setReloadNonce] = useState(0)
  const onRetry = () => setReloadNonce((n) => n + 1)

  // Five reads, one implementation. `listTickets`/`listSprints`/`listProjectStatuses`/
  // `listProjectFields`/`listProjectFieldOptions` are module-level functions, so the
  // references are stable and the effects do not re-run every render. All five share
  // `reloadNonce`, so Retry covers all five.
  //
  // The fourth (SPRIN-90) was added while this component sat at exactly 10 of 10 cyclomatic.
  // It costs ZERO points, measured rather than assumed: `useTaggedRead` is a hook CALL, not
  // a branch, and so is the destructure below. That is why this epic needed no
  // `StatusSettings`-style split story before it could begin — a conditional here would have
  // been unaffordable, but a read is not. The FIFTH (SPRIN-92 task 9) is the same call again,
  // for the same reason: still zero cyclomatic points, still measured with
  // `npx eslint src/routes/ProjectShell.tsx --rule '{"complexity":["error",1]}'` rather than
  // assumed from the fourth's precedent.
  const ticketRead = useTaggedRead(activeProjectId, reloadNonce, listTickets)
  const sprintRead = useTaggedRead(activeProjectId, reloadNonce, listSprints)
  const statusRead = useTaggedRead(activeProjectId, reloadNonce, listProjectStatuses)
  const fieldRead = useTaggedRead(activeProjectId, reloadNonce, listProjectFields)
  const optionRead = useTaggedRead(activeProjectId, reloadNonce, listProjectFieldOptions)

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    )
  }

  if (!project) return <Navigate to="/" replace />

  const { phase: ticketsPhase, items: tickets } = ticketRead
  const { phase: sprintsPhase, items: sprints } = sprintRead
  const { phase: statusesPhase, items: statuses } = statusRead
  const { phase: fieldsPhase, items: fields } = fieldRead
  const { phase: optionsPhase, items: options } = optionRead

  const selected = selectedId ? (tickets.find((t) => t.id === selectedId) ?? null) : null

  // Every reducer below is a LOCAL mutation, never a refetch: an unguarded refetch resolving
  // after a project switch would clobber the new project's list.
  //
  // The guard that used to be repeated at each of these call sites — "only patch a list that
  // belongs to this project and actually loaded" — now lives once in `patchLoaded`
  // (`@/lib/project-reads`). It is load-bearing, not decoration: patching a failed or loading
  // variant would mean reading items off a variant that has none and constructing a `loaded`
  // state out of a `failed` one, resurrecting the "a failed read looks successful" defect
  // S4.6 removed.
  const onTicketUpdated = (updated: Ticket) =>
    ticketRead.patch(project.id, (ts) => ts.map((t) => (t.id === updated.id ? updated : t)))

  const onTicketDeleted = (id: string) =>
    ticketRead.patch(project.id, (ts) => ts.filter((t) => t.id !== id))

  // Prepend: the list is newest-first, so a new sprint belongs at the top.
  const onSprintCreated = (sprint: Sprint) => sprintRead.patch(project.id, (ss) => [sprint, ...ss])

  // Replace by id. Starting a sprint touches only that sprint — enforcing one-active by
  // REJECTING a second start (not deactivating the current one) means no other row changes.
  const onSprintUpdated = (updated: Sprint) =>
    sprintRead.patch(project.id, (ss) => ss.map((s) => (s.id === updated.id ? updated : s)))

  // Completing swaps the sprint by id AND clears sprint_id on the sprint's still-incomplete
  // tickets. The ticket patch is NOT driven solely by `returnedTickets`: a prior attempt can
  // already have moved a ticket in the DB (returning it) and then failed on the status flip,
  // so the retry's bulk update matches zero rows and returns []. Deriving the move from the
  // completed sprint itself — by the same rule the DB applies — makes the patch idempotent and
  // correct on both the happy path and the retry path. Terminal tickets keep their sprint_id
  // (retained history), exactly as the DB leaves them.
  //
  // "The same rule" is literal, and as of SPRIN-77 it is load-bearing rather than incidental:
  // `terminal` comes from `doneSlugs`, the SAME derivation `SprintsTab` handed to
  // `completeSprint` for the database filter. This used to read `t.status !== 'done'`, which
  // agreed with the DB only while the vocabulary was immutable — a user-added terminal status
  // would have had its tickets painted back into the backlog here while the database kept
  // them. Two independent derivations of "terminal" could drift; one cannot, and the
  // idempotency argument above depends on them agreeing.
  //
  // Both lists are patched so the count badge and the status badge never render out of step.
  const onSprintCompleted = (updated: Sprint, returnedTickets: Ticket[]) => {
    sprintRead.patch(project.id, (ss) => ss.map((s) => (s.id === updated.id ? updated : s)))
    const terminal = doneSlugs(statuses)
    const returnedById = new Map(returnedTickets.map((t) => [t.id, t]))
    ticketRead.patch(project.id, (ts) =>
      ts.map(
        (t) =>
          returnedById.get(t.id) ??
          (t.sprint_id === updated.id && !terminal.has(t.status) ? { ...t, sprint_id: null } : t),
      ),
    )
  }

  // The three status reducers (SPRIN-77). Local mutations like every other one here, and for
  // the same reason: an unguarded refetch resolving after a project switch clobbers the new
  // project's list. They matter beyond this tab — `statuses` is what BoardTab renders its
  // columns from, so patching it here is the whole of AC1 ("appears as a board column without
  // a reload").
  const onStatusCreated = (status: ProjectStatus) =>
    statusRead.patch(project.id, (ss) => [...ss, status])

  const onStatusUpdated = (updated: ProjectStatus) =>
    statusRead.patch(project.id, (ss) => ss.map((s) => (s.id === updated.id ? updated : s)))

  // Merged by id and re-sorted by `position` rather than swapped in place: `position` order IS
  // the board's column order (`listProjectStatuses` sorts by it and nothing re-sorts
  // downstream), and the RPC returns its rows in no guaranteed order. Merging rather than
  // replacing the list wholesale keeps any row the RPC did not return — there are none today,
  // since the caller sends the complete list and the write layer rejects a short result — so a
  // future partial reorder degrades to "some rows moved", never to "the rest vanished".
  const onStatusesReordered = (rows: ProjectStatus[]) => {
    const byId = new Map(rows.map((s) => [s.id, s]))
    statusRead.patch(project.id, (ss) =>
      ss.map((s) => byId.get(s.id) ?? s).sort((a, b) => a.position - b.position),
    )
  }

  // Branch-free HERE on purpose: the promotion rule lives entirely in `removeStatus`, because
  // a ternary in THIS file would push ProjectShell past its cyclomatic budget (10 of 10) and
  // redden `npm run lint`. See `removeStatus`'s own docblock for why the rule is expressed
  // twice (once in SQL, once there) rather than shared, and how that duplication is tested.
  const onStatusDeleted = (id: string) => statusRead.patch(project.id, (ss) => removeStatus(ss, id))

  // The two custom-field reducers (SPRIN-91), local mutations for the same reason as every
  // other one here. Both cost ZERO cyclomatic points and that was measured, not assumed:
  // `ProjectShell` sits at exactly 10 of 10, but ESLint's `complexity` rule counts PER
  // FUNCTION, and these are `const` arrow declarations — this file already holds seven nested
  // arrows at complexity 2 or more while `ProjectShell` itself still reads 10. A conditional
  // written INLINE here would be a different matter and would redden the gate.
  const onFieldCreated = (field: ProjectField) =>
    fieldRead.patch(project.id, (fs) => [...fs, field])

  const onFieldUpdated = (updated: ProjectField) =>
    fieldRead.patch(project.id, (fs) => fs.map((f) => (f.id === updated.id ? updated : f)))

  // The three option reducers (SPRIN-92 task 9), local mutations for the same reason as every
  // other one here — and costing ZERO cyclomatic points for the same reason `onFieldCreated`/
  // `onFieldUpdated` do: these are `const` arrow declarations, not branches written INLINE in
  // `ProjectShell` itself. `project_field_options` has no surrogate id, so every reducer keys
  // on `(field_id, slug)` rather than `id` — the same substitution `onStatusUpdated` would need
  // if `project_statuses` ever dropped its own surrogate key.
  const onOptionCreated = (option: ProjectFieldOption) =>
    optionRead.patch(project.id, (os) => [...os, option])

  const onOptionUpdated = (updated: ProjectFieldOption) =>
    optionRead.patch(project.id, (os) =>
      os.map((o) =>
        o.field_id === updated.field_id && o.slug === updated.slug ? updated : o,
      ),
    )

  const onOptionDeleted = (fieldId: string, slug: string) =>
    optionRead.patch(project.id, (os) =>
      os.filter((o) => !(o.field_id === fieldId && o.slug === slug)),
    )

  const currentUser = { id: user!.id, email: user!.email ?? '' }

  return (
    <div className="flex min-h-svh flex-col">
      <ProjectShellHeader
        project={project}
        ticketsPhase={ticketsPhase}
        // SPRIN-89. Passed as VALUES, not as another branch — the shell is at 10 of 10
        // cyclomatic, so this can only be a call/read, the same constraint `hasSprints` and
        // the detail dialog's own `fields`/`fieldsPhase` below satisfy. No `onRetryFields`
        // here: the create dialog's failed-read notice offers no Retry, deliberately — the
        // Board and Backlog already carry the Retry for this same read.
        fields={fields}
        fieldsPhase={fieldsPhase}
        // A new ticket always carries the highest number, so appending it keeps the number
        // order the board and backlog use — no refetch needed. That also avoids a
        // stale-response race: an unguarded refetch resolving after a project switch would
        // clobber the new project's list.
        onTicketCreated={(ticket) => ticketRead.patch(project.id, (ts) => [...ts, ticket])}
      />
      <div className="flex-1 p-8">
        {/* Keyed on the path so a crash on one tab doesn't linger as a stale fallback when the
         * user switches to another: `ErrorBoundary` only clears its `crashed` state via
         * `reset`, never on its own re-render, so without this key the boundary would stay
         * mounted (and stuck showing the fallback) across a tab change that only swaps the
         * Outlet's children. `TicketDetailDialog` stays OUTSIDE this boundary on purpose: this
         * boundary is scoped to TAB content, and the dialog is shell-level furniture, not a
         * tab — it is still covered by the app-scope boundary in `App.tsx`. Keying it on
         * pathname the way the tab content is keyed would remount it on every tab switch,
         * which is a real behaviour change no test currently exercises (the dialog is modal,
         * so reaching a tab link to trigger that remount would require closing it first) —
         * kept out to keep this boundary's blast radius minimal, not because the remount is
         * demonstrated to be harmful. */}
        <ErrorBoundary
          key={location.pathname}
          fallback={(reset) => <CrashFallback scope="tab" onRetry={reset} />}
        >
          <Outlet
            context={
              {
                project,
                tickets,
                ticketsPhase,
                sprints,
                sprintsPhase,
                statuses,
                statusesPhase,
                fields,
                fieldsPhase,
                options,
                optionsPhase,
                onOptionCreated,
                onOptionUpdated,
                onOptionDeleted,
                onFieldCreated,
                onFieldUpdated,
                onStatusCreated,
                onStatusUpdated,
                onStatusesReordered,
                onStatusDeleted,
                onRetry,
                onSprintCreated,
                onSprintUpdated,
                onSprintCompleted,
                currentUser,
                onOpenTicket: (t) => setSelectedId(t.id),
                onTicketUpdated,
                onTicketDeleted,
              } satisfies ProjectShellContext
            }
          />
        </ErrorBoundary>
        <TicketDetailDialog
          key={selected?.id ?? 'none'}
          ticket={selected}
          epics={tickets.filter((t) => t.type === 'epic')}
          sprints={sprints}
          sprintsPhase={sprintsPhase}
          statuses={statuses}
          statusesPhase={statusesPhase}
          // SPRIN-82 AC3. A CALL, not a branch — which is the only reason this fits: the
          // shell is at 10 of 10 cyclomatic, so the question has to be asked here (where the
          // project is) and answered further down (where there is headroom to act on it).
          hasSprints={hasSprints(project)}
          // SPRIN-88. Passed as VALUES, not as another branch — same constraint as
          // `hasSprints` above: this component is at 10 of 10 cyclomatic. `onRetry` is the
          // shell's own, and is the right retry for these specifically because the definitions
          // are one of the four project reads it reloads.
          fields={fields}
          fieldsPhase={fieldsPhase}
          onRetryFields={onRetry}
          currentUser={currentUser}
          onOpenChange={(open) => {
            if (!open) setSelectedId(null)
          }}
          onUpdated={onTicketUpdated}
          onDeleted={onTicketDeleted}
        />
      </div>
    </div>
  )
}
