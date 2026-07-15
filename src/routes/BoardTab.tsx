import { TICKET_STATUSES, TICKET_STATUS_LABELS } from '@/lib/domain'

/**
 * The board: the four fixed columns, in board order, read from the domain module —
 * never inlined here (CLAUDE.md). Columns are empty until tickets arrive in E4.
 */
export function BoardTab() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {TICKET_STATUSES.map((status) => (
        <section key={status} className="bg-muted/30 flex flex-col gap-3 rounded-lg border p-3">
          <h2 className="text-sm font-medium">{TICKET_STATUS_LABELS[status]}</h2>
          <p className="text-muted-foreground text-xs">No tickets yet.</p>
        </section>
      ))}
    </div>
  )
}
