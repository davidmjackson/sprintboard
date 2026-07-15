import { useOutletContext } from 'react-router-dom'

import { TICKET_STATUSES, TICKET_STATUS_LABELS } from '@/lib/domain'
import type { ProjectShellContext } from './ProjectShell'
import { TicketCard } from './TicketCard'

/**
 * The board: the four fixed columns, in board order (from the domain module — never
 * inlined). Each column holds its status's tickets; an empty column says so.
 */
export function BoardTab() {
  const { tickets } = useOutletContext<ProjectShellContext>()

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
              column.map((ticket) => <TicketCard key={ticket.id} ticket={ticket} />)
            )}
          </section>
        )
      })}
    </div>
  )
}
