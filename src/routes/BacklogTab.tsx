import { useOutletContext } from 'react-router-dom'

import { TICKET_TYPE_LABELS } from '@/lib/domain'
import type { ProjectShellContext } from './ProjectShell'
import { BlockedBadge } from './BlockedBadge'

/**
 * The backlog: a flat list of the project's tickets, ordered by number (the order
 * `listTickets` returns). Empty and loading states keep the shell honest when a
 * project has no tickets yet.
 */
export function BacklogTab() {
  const { tickets, loadingTickets, onOpenTicket } = useOutletContext<ProjectShellContext>()

  if (loadingTickets && tickets.length === 0) {
    return <p className="text-muted-foreground text-sm">Loading…</p>
  }

  if (tickets.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed">
        <p className="text-muted-foreground text-sm">No tickets yet.</p>
      </div>
    )
  }

  return (
    <ul className="divide-y rounded-lg border">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <button
            type="button"
            onClick={() => onOpenTicket(ticket)}
            className="hover:bg-muted/60 flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors"
          >
            <span className="text-muted-foreground w-16 shrink-0 font-mono text-xs">
              {ticket.key}
            </span>
            <span className="text-muted-foreground w-14 shrink-0 text-xs uppercase">
              {TICKET_TYPE_LABELS[ticket.type]}
            </span>
            <span className="flex-1 truncate">{ticket.summary}</span>
            {ticket.is_blocked ? <BlockedBadge /> : null}
          </button>
        </li>
      ))}
    </ul>
  )
}
