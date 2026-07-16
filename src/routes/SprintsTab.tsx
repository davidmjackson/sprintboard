import { useOutletContext } from 'react-router-dom'

import { selectSprintTickets } from '@/lib/backlog'
import { formatSprintDate } from '@/lib/sprint-dates'
import { SPRINT_STATUS_LABELS, type Sprint } from '@/lib/domain'
import type { ProjectShellContext } from './ProjectShell'
import { CreateSprintDialog } from './CreateSprintDialog'
import { LoadFailure } from './LoadFailure'

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
    onRetry,
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

      {/* `onRetry` re-runs both of the shell's reads, so this one button also clears a
          failed ticket count in the rows below — the two reads usually fail together. */}
      {phase === 'failed' ? (
        <LoadFailure message="Could not load sprints." onRetry={onRetry} />
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

                  A count is only rendered once the tickets are actually IN HAND: `tickets` is
                  `[]` both while the read is in flight and when it failed, so anything short
                  of 'loaded' would count an empty array and render a confident "0 tickets" for
                  a list we do not have. Hence `!== 'loaded'` rather than a test per phase — a
                  gate naming only 'failed' would let the loading case fall through, and vice
                  versa, which is exactly how the false zero survived S6.2. This count is the
                  only observable evidence that a ticket joined a sprint, so a false zero
                  discredits the one thing the tab is meant to show. '—' is not a number and
                  cannot be misread as one.

                  The two non-loaded phases render the same '—' but are not the same fact —
                  one resolves on its own, the other will not — so the `sr-only` text differs.
                  There is no Retry here: a badge cannot hold one, and the sprint list around
                  it loaded fine. The Backlog and Board carry the retry for this same failed
                  read; a degraded badge is not a page-level error. */}
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
                {ticketsPhase !== 'loaded' ? (
                  <>
                    <span aria-hidden="true">—</span>
                    {/* Honest: the number is not known, rather than claiming a count. The
                        em-dash is aria-hidden, so this text is the only thing that carries
                        the distinction to a screen reader. */}
                    <span className="sr-only">
                      {ticketsPhase === 'loading'
                        ? 'Ticket count loading'
                        : 'Ticket count unavailable'}
                    </span>
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
