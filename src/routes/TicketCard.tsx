import type { Ticket } from '@/lib/domain'
import { TICKET_TYPE_LABELS } from '@/lib/domain'

/** A ticket at a glance: its key, type, and summary. Clicking opens the detail modal. */
export function TicketCard({ ticket, onOpen }: { ticket: Ticket; onOpen?: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="bg-background hover:border-ring flex w-full flex-col gap-1 rounded-md border p-2 text-left shadow-xs transition-colors"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground font-mono text-xs">{ticket.key}</span>
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
          {TICKET_TYPE_LABELS[ticket.type]}
        </span>
      </div>
      <p className="text-sm">{ticket.summary}</p>
    </button>
  )
}
