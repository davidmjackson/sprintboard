import { parseSummary } from '@/lib/tickets'
import type { Ticket, TicketUpdate } from '@/lib/domain'
import { EditableText, FieldLabel } from './EditableText'

/** The main column's three always-visible fields: summary, description and acceptance
 *  criteria. Rendered as a fragment — the caller's own `flex flex-col gap-6` wrapper
 *  supplies the column layout, and the epic-only section renders into that same column
 *  beneath these three. */
export function TicketMainFields({
  ticket,
  commit,
  setError,
  onEditingChange,
}: {
  ticket: Ticket
  commit: (patch: TicketUpdate) => Promise<boolean>
  setError: (ticketId: string, message: string) => void
  onEditingChange: (editing: boolean) => void
}) {
  return (
    <>
      <EditableText
        value={ticket.summary}
        ariaLabel="summary"
        heading
        onCommit={(v) => {
          const parsed = parseSummary(v)
          if (!parsed.ok) {
            setError(ticket.id, parsed.message)
            return
          }
          commit({ summary: parsed.value })
        }}
        onEditingChange={onEditingChange}
      />

      <div className="flex flex-col gap-1.5">
        <FieldLabel>Description</FieldLabel>
        <EditableText
          value={ticket.description ?? ''}
          ariaLabel="description"
          multiline
          placeholder="Add a description…"
          onCommit={(v) => commit({ description: v.trim() || null })}
          onEditingChange={onEditingChange}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <FieldLabel>Acceptance criteria</FieldLabel>
        <EditableText
          value={ticket.acceptance_criteria ?? ''}
          ariaLabel="acceptance criteria"
          multiline
          placeholder="Add acceptance criteria…"
          onCommit={(v) => commit({ acceptance_criteria: v.trim() || null })}
          onEditingChange={onEditingChange}
        />
      </div>
    </>
  )
}
