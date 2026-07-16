import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'

import { listSprints } from '@/lib/sprints'
import { formatSprintDate } from '@/lib/sprint-dates'
import { SPRINT_STATUS_LABELS, type Sprint } from '@/lib/domain'
import type { ProjectShellContext } from './ProjectShell'
import { CreateSprintDialog } from './CreateSprintDialog'

/**
 * The project's sprints, newest first, with a create dialog.
 *
 * Sprints load here rather than in `ProjectShellContext` because they have exactly one
 * consumer: tickets are hoisted into the shell only because Board and Backlog both read
 * them. S6.2 will need sprints in the backlog and will hoist them then (YAGNI).
 *
 * The load is genuinely three-state — loading / loaded / failed. That is a deliberate
 * departure from the shell's ticket read, which swallows a rejection into an empty list
 * and derives `loadingTickets` purely from project-id tagging, so it *structurally cannot*
 * represent "failed" — which is why a paused database renders as "Nothing in the backlog."
 * New code does not inherit that.
 *
 * "loading" itself is still derived from project-id tagging (the same device the shell's
 * ticket read uses), rather than an explicit `setState({ phase: 'loading' })` at the top of
 * the effect — that would be a synchronous setState in an effect body, which
 * `react-hooks/set-state-in-effect` (this repo's lint gate) rejects as a cascading-render
 * hazard. Only "loaded" and "failed" need to be stored; "loading" is just "neither has
 * landed for this project yet".
 */
type Loaded = { projectId: string; phase: 'loaded'; sprints: Sprint[] } | { projectId: string; phase: 'failed' }

function SprintDates({ sprint }: { sprint: Sprint }) {
  if (!sprint.start_date && !sprint.end_date) {
    return <span className="text-muted-foreground text-xs">No dates set</span>
  }
  const start = sprint.start_date ? formatSprintDate(sprint.start_date) : '—'
  const end = sprint.end_date ? formatSprintDate(sprint.end_date) : '—'
  return (
    <span className="text-muted-foreground font-mono text-xs tabular-nums">
      {start} – {end}
    </span>
  )
}

export function SprintsTab() {
  const { project } = useOutletContext<ProjectShellContext>()
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let active = true
    listSprints(project.id)
      .then((sprints) => active && setLoaded({ projectId: project.id, phase: 'loaded', sprints }))
      .catch(() => active && setLoaded({ projectId: project.id, phase: 'failed' }))
    return () => {
      active = false
    }
  }, [project.id])

  // Not this project's result yet (still in flight, or a previous project's landed after
  // the switch) reads as "loading" — the same tagging device as the shell's ticket read.
  const current = loaded?.projectId === project.id ? loaded : null
  const phase = current?.phase ?? 'loading'
  const sprints = current?.phase === 'loaded' ? current.sprints : []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Sprints</h2>
        <CreateSprintDialog
          projectId={project.id}
          existing={sprints}
          onCreated={(sprint) =>
            // Prepend: the list is newest-first, so the new sprint belongs at the top.
            // A local mutation, not a refetch — the same reasoning as the shell's
            // append-on-create (S4.1): an unguarded refetch resolving after a project
            // switch would clobber the new project's list.
            setLoaded((prev) =>
              prev && prev.projectId === project.id && prev.phase === 'loaded'
                ? { projectId: prev.projectId, phase: 'loaded', sprints: [sprint, ...prev.sprints] }
                : prev,
            )
          }
        />
      </div>

      {phase === 'loading' ? <p className="text-muted-foreground text-sm">Loading…</p> : null}

      {phase === 'failed' ? (
        <div className="border-destructive/50 flex min-h-40 items-center justify-center rounded-lg border border-dashed">
          <p role="alert" className="text-destructive text-sm">
            Could not load sprints. Please refresh to try again.
          </p>
        </div>
      ) : null}

      {phase === 'loaded' && sprints.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed">
          <p className="text-muted-foreground text-sm">No sprints yet.</p>
        </div>
      ) : null}

      {sprints.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {sprints.map((sprint) => (
            <li key={sprint.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="flex-1 truncate font-medium">{sprint.name}</span>
              {sprint.goal ? (
                <span className="text-muted-foreground flex-1 truncate text-xs">{sprint.goal}</span>
              ) : null}
              <SprintDates sprint={sprint} />
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
                {SPRINT_STATUS_LABELS[sprint.status]}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
