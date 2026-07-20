import type { DragEvent } from 'react'
import type { Ticket } from '@/lib/domain'
import { TICKET_TYPE_LABELS } from '@/lib/domain'
import { BlockedBadge } from './BlockedBadge'

/** A ticket at a glance: its key, type, and summary. Clicking opens the detail modal;
 *  on the board, dragging it to another column changes its status (S7.2). The card is
 *  draggable ONLY when `onDragStart` is supplied — the backlog and other non-board usages
 *  pass nothing and stay non-draggable. A click and a drag are distinct gestures, so
 *  click-to-open coexists with drag. */
export function TicketCard({
  ticket,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  ticket: Ticket
  onOpen?: () => void
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: (e: DragEvent) => void
}) {
  return (
    <button
      type="button"
      draggable={onDragStart != null}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      className="bg-background hover:border-ring flex w-full flex-col gap-1 rounded-md border p-2 text-left shadow-xs transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground font-mono text-xs">{ticket.key}</span>
        <div className="flex items-center gap-1.5">
          {ticket.is_blocked ? <BlockedBadge reason={ticket.blocked_reason} /> : null}
          <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
            {TICKET_TYPE_LABELS[ticket.type]}
          </span>
        </div>
      </div>
      <p className="text-sm">{ticket.summary}</p>
    </button>
  )
}
