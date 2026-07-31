import { Ban, CircleCheck, MoreHorizontal, Trash2 } from 'lucide-react'

import { TICKET_TYPE_LABELS, type Ticket } from '@/lib/domain'
import { DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The dialog's title row (key, type, status) and its kebab menu (block/unblock, delete).
 *
 * `statusName` arrives ALREADY RESOLVED rather than as the project's status rows: this row
 * renders exactly one status label, so handing it the whole list would give it a lookup it
 * does not need and create a second site where the SPRIN-76 AC4 fallback (an unknown slug
 * renders as itself) could drift from the picker's. The dialog resolves it once.
 */
export function TicketDetailHeader({
  ticket,
  statusName,
  onBlock,
  onUnblock,
  onDelete,
}: {
  ticket: Ticket
  /** The display name of `ticket.status` — the slug itself when no row matches (AC4). */
  statusName: string
  onBlock: () => void
  onUnblock: () => void
  onDelete: () => void
}) {
  return (
    <DialogHeader className="border-border/70 flex-row items-center gap-2 space-y-0 border-b px-6 py-4">
      <DialogTitle className="flex items-center gap-2.5 text-base font-normal">
        <span className="text-muted-foreground font-mono text-sm font-medium tracking-tight">
          {ticket.key}
        </span>
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium uppercase">
          {TICKET_TYPE_LABELS[ticket.type]}
        </span>
        <span className="bg-border/60 h-3.5 w-px" aria-hidden="true" />
        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs font-medium">
          <span className="bg-foreground/40 size-1.5 rounded-full" aria-hidden="true" />
          {statusName}
        </span>
      </DialogTitle>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Ticket actions"
            className="hover:bg-muted focus-visible:bg-muted text-muted-foreground mr-7 ml-auto inline-flex size-7 items-center justify-center rounded-md outline-none"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {ticket.is_blocked ? (
            <DropdownMenuItem onSelect={onUnblock}>
              <CircleCheck />
              Unblock
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onSelect={onBlock}>
              <Ban />
              Block
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onDelete}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </DialogHeader>
  )
}

/** The blocked-state banner shown at the top of the grid when `ticket.is_blocked`. Spans both
 *  grid columns — `sm:col-span-2` — since it sits inside the parent's two-column grid. */
export function TicketBlockedBanner({
  ticket,
  unblockPending,
}: {
  ticket: Ticket
  unblockPending: boolean
}) {
  return (
    <div
      role="status"
      className="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm sm:col-span-2"
    >
      <Ban aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{unblockPending ? 'Unblocking…' : 'Blocked'}</span>
        {ticket.blocked_reason ? (
          <span className="text-destructive/90 break-words">{ticket.blocked_reason}</span>
        ) : null}
        {ticket.blocked_since ? (
          <span className="text-destructive/70 text-xs">
            Since {new Date(ticket.blocked_since).toLocaleString()}
          </span>
        ) : null}
      </div>
    </div>
  )
}
