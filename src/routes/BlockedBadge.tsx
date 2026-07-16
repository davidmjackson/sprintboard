import { Ban } from 'lucide-react'

/**
 * The small "Blocked" flag shown wherever a ticket appears in a list — the board card
 * and the backlog row. Blocked is a flag, never a board column (CLAUDE.md), so this
 * rides along with the ticket in whatever status column it already sits in; it never
 * moves it. The fuller reason lives in the ticket detail dialog's banner.
 */
export function BlockedBadge() {
  return (
    <span className="border-destructive/30 bg-destructive/10 text-destructive inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase">
      <Ban aria-hidden="true" className="size-3" />
      Blocked
    </span>
  )
}
