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
 * The sprint read is genuinely three-state, unlike the ticket read below it in this file.
 *
 * That asymmetry is deliberate, not an oversight: the ticket read swallows a rejection into
 * an empty list and derives `loadingTickets` purely from project-id tagging, so it
 * *structurally cannot* represent "failed" — which is why a paused database renders as
 * "Nothing in the backlog." rather than an error. That is known app-wide debt with its own
 * story. New code does not inherit it, and hoisting sprints into this file must not launder
 * the distinction away: `sprintsPhase` is a real discriminant and the `.catch()` records
 * `failed`, never `[]`.
 */
export type SprintsPhase = 'loading' | 'loaded' | 'failed'

/** What the shell hands to its Board/Backlog/Sprints tabs via the nested <Outlet context>. */
export type ProjectShellContext = {
  project: Project
  tickets: Ticket[]
  loadingTickets: boolean
  /** The project's sprints, newest first. `[]` while loading and when the read failed —
   *  always read `sprintsPhase` before treating an empty list as "no sprints". */
  sprints: Sprint[]
  sprintsPhase: SprintsPhase
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

  // The loaded set is tagged with the project it belongs to. That makes "loading" a
  // derived fact — "this project's fetch has not landed yet" — so the effect never
  // resets loading synchronously, and switching projects can never flash the previous
  // project's tickets under the new header.
  const [loaded, setLoaded] = useState<{ projectId: string; tickets: Ticket[] } | null>(null)

  useEffect(() => {
    if (!activeProjectId) return
    let active = true
    listTickets(activeProjectId)
      .then((tickets) => active && setLoaded({ projectId: activeProjectId, tickets }))
      .catch(() => active && setLoaded({ projectId: activeProjectId, tickets: [] }))
    return () => {
      active = false
    }
  }, [activeProjectId])

  // Tagged with its project the same way, and for the same reason — but with a real `phase`,
  // so a rejection is recorded as `failed` rather than being flattened into an empty list.
  // "loading" stays derived ("neither result has landed for this project yet") rather than a
  // synchronous `setState` at the top of the effect, which `react-hooks/set-state-in-effect`
  // rejects as a cascading-render hazard.
  const [sprintsLoaded, setSprintsLoaded] = useState<
    | { projectId: string; phase: 'loaded'; sprints: Sprint[] }
    | { projectId: string; phase: 'failed' }
    | null
  >(null)

  useEffect(() => {
    if (!activeProjectId) return
    let active = true
    listSprints(activeProjectId)
      .then(
        (sprints) =>
          active && setSprintsLoaded({ projectId: activeProjectId, phase: 'loaded', sprints }),
      )
      .catch(() => active && setSprintsLoaded({ projectId: activeProjectId, phase: 'failed' }))
    return () => {
      active = false
    }
  }, [activeProjectId])

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    )
  }

  if (!project) return <Navigate to="/" replace />

  const loadingTickets = loaded?.projectId !== project.id
  const tickets = loadingTickets ? [] : loaded.tickets

  const currentSprints = sprintsLoaded?.projectId === project.id ? sprintsLoaded : null
  const sprintsPhase: SprintsPhase = currentSprints?.phase ?? 'loading'
  const sprints = currentSprints?.phase === 'loaded' ? currentSprints.sprints : []

  const selected = selectedId ? (tickets.find((t) => t.id === selectedId) ?? null) : null

  const onTicketUpdated = (updated: Ticket) =>
    setLoaded((prev) =>
      prev && prev.projectId === project.id
        ? {
            projectId: prev.projectId,
            tickets: prev.tickets.map((t) => (t.id === updated.id ? updated : t)),
          }
        : prev,
    )

  const onTicketDeleted = (id: string) =>
    setLoaded((prev) =>
      prev && prev.projectId === project.id
        ? { projectId: prev.projectId, tickets: prev.tickets.filter((t) => t.id !== id) }
        : prev,
    )

  // Prepend: the list is newest-first, so a new sprint belongs at the top. A local mutation,
  // not a refetch — the same reasoning as the append-on-create above.
  const onSprintCreated = (sprint: Sprint) =>
    setSprintsLoaded((prev) =>
      prev && prev.projectId === project.id && prev.phase === 'loaded'
        ? { projectId: prev.projectId, phase: 'loaded', sprints: [sprint, ...prev.sprints] }
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
                prev && prev.projectId === project.id
                  ? { projectId: prev.projectId, tickets: [...prev.tickets, ticket] }
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
              loadingTickets,
              sprints,
              sprintsPhase,
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
