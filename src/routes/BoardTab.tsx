import { useOutletContext } from 'react-router-dom'

import { TICKET_STATUSES, TICKET_STATUS_LABELS } from '@/lib/domain'
import { selectActiveSprint } from '@/lib/board'
import { selectSprintTickets } from '@/lib/backlog'
import type { ProjectShellContext } from './ProjectShell'
import { LoadFailure } from './LoadFailure'
import { TicketCard } from './TicketCard'

/**
 * The board: the four fixed columns, in board order (from the domain module — never inlined).
 * It renders the ACTIVE sprint's tickets (S7.1), each in its status column; an empty column
 * says so. The active-sprint rule lives in `selectActiveSprint`; the membership rule in
 * `selectSprintTickets` — the board only composes them.
 *
 * The board depends on BOTH reads. Tickets tell it what exists; sprints tell it which sprint is
 * active — without that it cannot know what belongs on the board. So a failed or still-loading
 * SPRINTS read is handled exactly like the tickets read: it must not render a confident empty
 * board, which would be the S4.6 defect of a distinct state wearing the empty state's face.
 * Ticket failure is shown first when both fail — one alert, one Retry, and `onRetry` reloads
 * both reads together.
 *
 * "No active sprint" (sprints loaded, none active) is its own honest state: a caption above the
 * grid, so four empty columns are never mistaken for "you have no tickets".
 */
export function BoardTab() {
  const { tickets, ticketsPhase, sprints, sprintsPhase, onRetry, onOpenTicket } =
    useOutletContext<ProjectShellContext>()

  if (ticketsPhase === 'failed') {
    return <LoadFailure resource="tickets" onRetry={onRetry} />
  }
  if (sprintsPhase === 'failed') {
    return <LoadFailure resource="sprints" onRetry={onRetry} />
  }
  if (ticketsPhase === 'loading' || sprintsPhase === 'loading') {
    return <p className="text-muted-foreground text-sm">Loading…</p>
  }

  const activeSprint = selectActiveSprint(sprints)
  const boardTickets = activeSprint ? selectSprintTickets(tickets, activeSprint.id) : []

  return (
    <div className="flex flex-col gap-4">
      {activeSprint === null ? (
        <p className="text-muted-foreground text-sm">
          No active sprint — start one from the Sprints tab.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {TICKET_STATUSES.map((status) => {
          const column = boardTickets.filter((ticket) => ticket.status === status)
          return (
            <section key={status} className="bg-muted/30 flex flex-col gap-3 rounded-lg border p-3">
              <h2 className="text-sm font-medium">{TICKET_STATUS_LABELS[status]}</h2>
              {column.length === 0 ? (
                <p className="text-muted-foreground text-xs">No tickets yet.</p>
              ) : (
                column.map((ticket) => (
                  <TicketCard key={ticket.id} ticket={ticket} onOpen={() => onOpenTicket(ticket)} />
                ))
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
