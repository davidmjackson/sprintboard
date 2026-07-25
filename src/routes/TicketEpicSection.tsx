import { X } from 'lucide-react'

import type { Decomposition } from '@/lib/ticket-decomposition'
import type { Deliverables } from '@/lib/ticket-deliverables'
import type { Ticket, TicketUpdate } from '@/lib/domain'
import { EditableText, FieldLabel } from './EditableText'
import { TicketDecompositionPanel } from './TicketDecompositionPanel'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

/** The epic's deliverables list, its add-input draft, and the remove buttons. `inputRef` is
 *  threaded down from the dialog rather than owned here: Radix dismisses the dialog at the
 *  document level in the capture phase, so a child's `stopPropagation` cannot keep it open —
 *  the dialog's own `onEscapeKeyDown` must read the ref, so it has to stay there. */
export function TicketDeliverablesEditor({
  deliverables,
  inputRef,
  onEditingChange,
}: {
  deliverables: Deliverables
  inputRef: React.RefObject<HTMLInputElement | null>
  onEditingChange: (editing: boolean) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <FieldLabel>Deliverables</FieldLabel>
      {deliverables.items.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {deliverables.items.map((d, i) => (
            // Key by index+value, not index alone: if a structural change (a
            // failed remove's rollback, or an edit-to-blank) shifts a row's value
            // while another row is mid-edit, the key changes and React remounts
            // it — discarding the stale draft rather than writing it onto the
            // wrong item.
            <li key={`${i}-${d}`} className="flex items-start gap-2">
              <span
                aria-hidden="true"
                className="bg-foreground/40 mt-2.5 size-1.5 shrink-0 rounded-full"
              />
              <div className="min-w-0 flex-1">
                <EditableText
                  value={d}
                  ariaLabel={`deliverable ${i + 1}`}
                  onCommit={(v) => deliverables.edit(i, v)}
                  onEditingChange={onEditingChange}
                />
              </div>
              <button
                type="button"
                aria-label={`Remove deliverable ${i + 1}`}
                onClick={() => deliverables.remove(i)}
                disabled={deliverables.pending}
                className="text-muted-foreground hover:bg-muted hover:text-destructive focus-visible:bg-muted mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md outline-none disabled:pointer-events-none disabled:opacity-50"
              >
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">No deliverables yet.</p>
      )}
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          aria-label="new deliverable"
          value={deliverables.draft}
          placeholder="Add a deliverable…"
          disabled={deliverables.pending}
          onChange={(e) => deliverables.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void deliverables.add()
            }
            // Escape is handled by the dialog's onEscapeKeyDown below (Radix
            // dismisses at the document level, so a local stopPropagation can't
            // keep the dialog open) — it clears the draft and stays open.
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label="Add deliverable"
          onClick={() => void deliverables.add()}
          disabled={!deliverables.draft.trim() || deliverables.pending}
        >
          Add
        </Button>
      </div>
    </div>
  )
}

/** Epic-only: the context and deliverables that feed Rung 2 AI decomposition. Rendered by
 *  the dialog's main column, beneath the always-visible fields, only when `ticket.type ===
 *  'epic'`. */
export function TicketEpicSection({
  ticket,
  deliverables,
  decomposition,
  inputRef,
  commit,
  onEditingChange,
}: {
  ticket: Ticket
  deliverables: Deliverables
  decomposition: Decomposition
  inputRef: React.RefObject<HTMLInputElement | null>
  commit: (patch: TicketUpdate) => Promise<boolean>
  onEditingChange: (editing: boolean) => void
}) {
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <FieldLabel>Context</FieldLabel>
        <EditableText
          value={ticket.context ?? ''}
          ariaLabel="context"
          multiline
          placeholder="Add context for this epic…"
          onCommit={(v) => commit({ context: v.trim() || null })}
          onEditingChange={onEditingChange}
        />
      </div>

      <TicketDeliverablesEditor
        deliverables={deliverables}
        inputRef={inputRef}
        onEditingChange={onEditingChange}
      />

      <TicketDecompositionPanel decomposition={decomposition} items={deliverables.items} />
    </>
  )
}
