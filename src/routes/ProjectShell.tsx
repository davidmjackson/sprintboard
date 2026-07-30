import { useState } from 'react'
import { Navigate, Outlet, useLocation, useOutletContext, useParams } from 'react-router-dom'

import type { ProjectsContext } from './AppLayout'
import type { Project, Sprint, Ticket } from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import { useTaggedRead } from '@/lib/project-reads'
import { listTickets } from '@/lib/tickets'
import { listSprints } from '@/lib/sprints'
import { useAuth } from '@/lib/auth-context'
import { CrashFallback, ErrorBoundary } from './ErrorBoundary'
import { ProjectShellHeader } from './ProjectShellHeader'
import { TicketDetailDialog } from './TicketDetailDialog'

/**
 * Both of this shell's reads are three-state, and symmetrically so (S4.6).
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
  /** Re-runs BOTH reads for this project. Manual only — there is no automatic retry,
   *  backoff or polling — and it returns both phases to `loading` immediately, so a click
   *  is never mistaken for a no-op. */
  onRetry: () => void
  onSprintCreated: (sprint: Sprint) => void
  /** Replaces one sprint in the shared list by id — e.g. after it is started (S6.3). A local
   *  mutation, not a refetch, mirroring `onTicketUpdated`. */
  onSprintUpdated: (sprint: Sprint) => void
  /** Completing a sprint changes TWO of the shell's lists at once: the sprint's status and
   *  the `sprint_id` of every incomplete ticket that returned to the backlog. This applies
   *  both in one update so the count badge and the status badge never render out of step.
   *  A local mutation from the DB's own returned rows, not a refetch. */
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

  // Two reads, one implementation. `listTickets`/`listSprints` are module-level functions,
  // so the references are stable and the effects do not re-run every render.
  const ticketRead = useTaggedRead(activeProjectId, reloadNonce, listTickets)
  const sprintRead = useTaggedRead(activeProjectId, reloadNonce, listSprints)

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
  // completed sprint itself — by the same rule the DB applies
  // (`sprint_id=null where sprint_id=id and status<>'done'`) — makes the patch idempotent and
  // correct on both the happy path and the retry path. Done tickets keep their sprint_id
  // (retained history), exactly as the DB leaves them.
  //
  // Both lists are patched so the count badge and the status badge never render out of step.
  const onSprintCompleted = (updated: Sprint, returnedTickets: Ticket[]) => {
    sprintRead.patch(project.id, (ss) => ss.map((s) => (s.id === updated.id ? updated : s)))
    const returnedById = new Map(returnedTickets.map((t) => [t.id, t]))
    ticketRead.patch(project.id, (ts) =>
      ts.map(
        (t) =>
          returnedById.get(t.id) ??
          (t.sprint_id === updated.id && t.status !== 'done' ? { ...t, sprint_id: null } : t),
      ),
    )
  }

  const currentUser = { id: user!.id, email: user!.email ?? '' }

  return (
    <div className="flex min-h-svh flex-col">
      <ProjectShellHeader
        project={project}
        ticketsPhase={ticketsPhase}
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
         * Outlet's children. `TicketDetailDialog` stays OUTSIDE this boundary — keying on
         * pathname would otherwise remount it on every tab switch and reset its inline-edit
         * state. */}
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
