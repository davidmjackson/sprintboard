import { useOutletContext } from 'react-router-dom'

import { TICKET_STATUSES, TICKET_STATUS_LABELS } from '@/lib/domain'
import type { ProjectShellContext } from './ProjectShell'
import { LoadFailure } from './LoadFailure'
import { TicketCard } from './TicketCard'

/**
 * The board: the four fixed columns, in board order (from the domain module — never
 * inlined). Each column holds its status's tickets; an empty column says so.
 *
 * "An empty column says so" is only honest once the read has landed, which is why the phase
 * is checked before the grid renders at all. Until S4.6 this component read `tickets` alone,
 * so a board still loading — or one whose read had failed — showed four confident "No tickets
 * yet." columns. That was invisible rather than wrong-looking: an empty board is exactly what
 * a new project looks like, so the failure wore the empty state's face.
 *
 * On failure the grid is REPLACED, not decorated: a `LoadFailure` per column would be four
 * identical messages and four Retry buttons that all do the same thing. There is also nothing
 * truthful to render under the headings — we do not know what is in any column — so the
 * columns go with it.
 */
export function BoardTab() {
  const { tickets, ticketsPhase, onRetry, onOpenTicket } = useOutletContext<ProjectShellContext>()

  if (ticketsPhase === 'loading') {
    return <p className="text-muted-foreground text-sm">Loading…</p>
  }

  if (ticketsPhase === 'failed') {
    return <LoadFailure resource="tickets" onRetry={onRetry} />
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {TICKET_STATUSES.map((status) => {
        const column = tickets.filter((ticket) => ticket.status === status)
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
  )
}
