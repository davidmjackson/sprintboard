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
          {/* `!= null`, not a falsy check: 0 is a real estimate, not "unestimated" — the
              same rule the backlog row follows. The unit is real `sr-only` text rather
              than an `aria-label`, because a <span> is `role="generic"` and ARIA 1.2
              prohibits aria-label there; the card is a <button>, so this text joins its
              accessible name. */}
          {ticket.story_points != null ? (
            <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums">
              {ticket.story_points}
              <span className="sr-only"> story points</span>
            </span>
          ) : null}
        </div>
      </div>
      <p className="text-sm">{ticket.summary}</p>
    </button>
  )
}
