import { useEffect, useState } from 'react'
import { Navigate, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom'

import type { ProjectsContext } from './AppLayout'
import type { Project, Sprint, Ticket } from '@/lib/domain'
import { listTickets } from '@/lib/tickets'
import { listSprints } from '@/lib/sprints'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-context'
import { CreateTicketDialog } from './CreateTicketDialog'
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
 */
export type SprintsPhase = 'loading' | 'loaded' | 'failed'
export type TicketsPhase = 'loading' | 'loaded' | 'failed'

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

  // Each result is tagged with the project AND the nonce it belongs to. That makes "loading"
  // a derived fact — "no result has landed for this project at this nonce yet" — so the
  // effect never resets a loading flag synchronously (which `react-hooks/set-state-in-effect`
  // rejects as a cascading-render hazard), and switching projects can never flash the
  // previous project's tickets under the new header. `phase` is a real discriminant: a
  // rejection is recorded as `failed`, never flattened into an empty list.
  type TicketsLoaded =
    | { projectId: string; nonce: number; phase: 'loaded'; tickets: Ticket[] }
    | { projectId: string; nonce: number; phase: 'failed' }
  const [loaded, setLoaded] = useState<TicketsLoaded | null>(null)

  useEffect(() => {
    if (!activeProjectId) return
    let active = true
    listTickets(activeProjectId)
      .then(
        (tickets) =>
          active &&
          setLoaded({ projectId: activeProjectId, nonce: reloadNonce, phase: 'loaded', tickets }),
      )
      .catch(
        () =>
          active && setLoaded({ projectId: activeProjectId, nonce: reloadNonce, phase: 'failed' }),
      )
    return () => {
      active = false
    }
  }, [activeProjectId, reloadNonce])

  // Tagged the same way, for the same reasons.
  const [sprintsLoaded, setSprintsLoaded] = useState<
    | { projectId: string; nonce: number; phase: 'loaded'; sprints: Sprint[] }
    | { projectId: string; nonce: number; phase: 'failed' }
    | null
  >(null)

  useEffect(() => {
    if (!activeProjectId) return
    let active = true
    listSprints(activeProjectId)
      .then(
        (sprints) =>
          active &&
          setSprintsLoaded({
            projectId: activeProjectId,
            nonce: reloadNonce,
            phase: 'loaded',
            sprints,
          }),
      )
      .catch(
        () =>
          active &&
          setSprintsLoaded({ projectId: activeProjectId, nonce: reloadNonce, phase: 'failed' }),
      )
    return () => {
      active = false
    }
  }, [activeProjectId, reloadNonce])

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    )
  }

  if (!project) return <Navigate to="/" replace />

  const currentTickets =
    loaded?.projectId === project.id && loaded.nonce === reloadNonce ? loaded : null
  const ticketsPhase: TicketsPhase = currentTickets?.phase ?? 'loading'
  const tickets = currentTickets?.phase === 'loaded' ? currentTickets.tickets : []

  const currentSprints =
    sprintsLoaded?.projectId === project.id && sprintsLoaded.nonce === reloadNonce
      ? sprintsLoaded
      : null
  const sprintsPhase: SprintsPhase = currentSprints?.phase ?? 'loading'
  const sprints = currentSprints?.phase === 'loaded' ? currentSprints.sprints : []

  const selected = selectedId ? (tickets.find((t) => t.id === selectedId) ?? null) : null

  // `prev.phase === 'loaded'` is not decoration: without it these would read `.tickets` off a
  // variant that has none, and construct a `loaded` state out of a `failed` one — resurrecting
  // exactly the "a failed read looks successful" defect S4.6 removed. Spreading `prev`
  // preserves the tag (project id and nonce) rather than rebuilding it.
  const onTicketUpdated = (updated: Ticket) =>
    setLoaded((prev) =>
      prev && prev.projectId === project.id && prev.phase === 'loaded'
        ? { ...prev, tickets: prev.tickets.map((t) => (t.id === updated.id ? updated : t)) }
        : prev,
    )

  const onTicketDeleted = (id: string) =>
    setLoaded((prev) =>
      prev && prev.projectId === project.id && prev.phase === 'loaded'
        ? { ...prev, tickets: prev.tickets.filter((t) => t.id !== id) }
        : prev,
    )

  // Prepend: the list is newest-first, so a new sprint belongs at the top. A local mutation,
  // not a refetch — the same reasoning as the append-on-create above.
  const onSprintCreated = (sprint: Sprint) =>
    setSprintsLoaded((prev) =>
      prev && prev.projectId === project.id && prev.phase === 'loaded'
        ? { ...prev, sprints: [sprint, ...prev.sprints] }
        : prev,
    )

  const currentUser = { id: user!.id, email: user!.email ?? '' }

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
      isActive
        ? 'border-foreground text-foreground'
        : 'text-muted-foreground hover:text-foreground border-transparent',
    )

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex flex-col gap-3 border-b px-8 pt-6">
        <div className="flex items-start justify-between gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="text-muted-foreground mr-2 font-mono text-lg">{project.key}</span>
            {project.name}
          </h1>
          <CreateTicketDialog
            projectId={project.id}
            onCreated={(ticket) => {
              // A new ticket always carries the highest number, so appending it keeps
              // the number order the board and backlog use — no refetch needed. That
              // also avoids a stale-response race: an unguarded refetch resolving after
              // a project switch would clobber the new project's list.
              setLoaded((prev) =>
                prev && prev.projectId === project.id && prev.phase === 'loaded'
                  ? { ...prev, tickets: [...prev.tickets, ticket] }
                  : prev,
              )
            }}
          />
        </div>
        <nav className="flex gap-4">
          <NavLink to="board" className={tabClass}>
            Board
          </NavLink>
          <NavLink to="backlog" className={tabClass}>
            Backlog
          </NavLink>
          <NavLink to="sprints" className={tabClass}>
            Sprints
          </NavLink>
        </nav>
      </header>
      <div className="flex-1 p-8">
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
              currentUser,
              onOpenTicket: (t) => setSelectedId(t.id),
              onTicketUpdated,
              onTicketDeleted,
            } satisfies ProjectShellContext
          }
        />
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
