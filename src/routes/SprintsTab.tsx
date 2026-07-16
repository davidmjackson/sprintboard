import { useOutletContext } from 'react-router-dom'

import { selectSprintTickets } from '@/lib/backlog'
import { formatSprintDate } from '@/lib/sprint-dates'
import { SPRINT_STATUS_LABELS, type Sprint } from '@/lib/domain'
import type { ProjectShellContext } from './ProjectShell'
import { CreateSprintDialog } from './CreateSprintDialog'

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

/**
 * The project's sprints, newest first, with a create dialog.
 *
 * The sprints themselves live in `ProjectShellContext` (S6.2): the shell renders the ticket
 * detail dialog, whose sprint picker needs the same list this tab shows, so the read was
 * hoisted there and this tab became a pure view of it. The three-state discriminant
 * (`sprintsPhase`) and the reasoning behind it moved with it — see `ProjectShell`.
 *
 * The create trigger only renders once `sprintsPhase === 'loaded'`. `sprints` is `[]` during
 * both loading and failed, so `defaultSprintName` would otherwise number off an empty array —
 * a duplicate 'Sprint 1' if sprints are still in flight, and an invisible create (the shell's
 * `onSprintCreated` guard drops it) if the read failed.
 */
export function SprintsTab() {
  const {
    project,
    sprints,
    sprintsPhase: phase,
    onSprintCreated,
    tickets,
    ticketsPhase,
  } = useOutletContext<ProjectShellContext>()

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Sprints</h2>
        {phase === 'loaded' ? (
          <CreateSprintDialog
            projectId={project.id}
            existing={sprints}
            onCreated={onSprintCreated}
          />
        ) : null}
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
              <span className="min-w-0 flex-[2] truncate font-medium">{sprint.name}</span>
              {sprint.goal ? (
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                  {sprint.goal}
                </span>
              ) : null}
              <SprintDates sprint={sprint} />
              {/* Membership comes from `selectSprintTickets`, never an inline filter: the
                  `sprint_id` rule lives in `backlog.ts` and is read from both sides there —
                  the backlog is `sprint_id is null`, a sprint's tickets are the ones naming
                  it. The bare number needs a unit for screen readers, and it is real
                  `sr-only` text rather than an `aria-label`: a <span> maps to
                  `role="generic"`, on which ARIA 1.2 *prohibits* aria-label — browsers
                  honour it so it looks fine, but axe-core flags it.

                  The count is gated on the ticket phase because `tickets` is `[]` before the
                  shell's read lands: deep-linking to this tab would otherwise render a
                  confident "0 tickets" per sprint and then flip to real numbers. This count
                  is S6.2's only observable evidence that a ticket joined a sprint, so a
                  false zero discredits the one thing the story is meant to show. '—' is not
                  a number and cannot be misread as one.

                  TODO(S4.6): a FAILED ticket read still shows "0 tickets" here, because this
                  gates on `'loading'` alone. `ticketsPhase` now makes `'failed'` readable —
                  the state exists, unlike before, when the shell's `.catch()` flattened a
                  rejection into `{ tickets: [] }` and there was nothing here to read. Widening
                  this gate is a later task in this same story. */}
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
                {ticketsPhase === 'loading' ? (
                  <>
                    <span aria-hidden="true">—</span>
                    {/* Honest: the number is not known yet, rather than claiming a count. */}
                    <span className="sr-only">Ticket count loading</span>
                  </>
                ) : (
                  <>
                    {selectSprintTickets(tickets, sprint.id).length}
                    <span className="sr-only"> tickets</span>
                  </>
                )}
              </span>
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
