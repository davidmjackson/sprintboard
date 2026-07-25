import { useRef, useState } from 'react'

import { useBlockFlow, useDeleteFlow } from '@/lib/ticket-actions'
import { useTicketCommit } from '@/lib/ticket-commit'
import { useDecomposition } from '@/lib/ticket-decomposition'
import { useDeliverables } from '@/lib/ticket-deliverables'
import type { Sprint, Ticket } from '@/lib/domain'
import type { SprintsPhase } from './ProjectShell'
import { TicketDetailHeader, TicketBlockedBanner } from './TicketDetailHeader'
import { TicketBlockDialog, TicketDeleteDialog } from './TicketActionDialogs'
import { TicketMainFields } from './TicketMainFields'
import { TicketDetailSidebar } from './TicketDetailSidebar'
import { TicketEpicSection } from './TicketEpicSection'
import { Dialog, DialogContent } from '@/components/ui/dialog'

/**
 * Jira-style ticket detail modal. Every field edits in place and commits independently.
 * Saves are optimistic against `onUpdated`, persisted with `updateTicket`, and rolled
 * back on failure. `updated_at` comes from the DB trigger via the reconciled row.
 * Assignee is deliberately `{ Unassigned, current user }` — Phase 1 is single-owner, and
 * widening the profiles read would leak every user's email.
 */
export function TicketDetailDialog({
  ticket,
  currentUser,
  epics = [],
  sprints = [],
  sprintsPhase = 'loading',
  onOpenChange,
  onUpdated,
  onDeleted,
  onTicketsCreated,
}: {
  ticket: Ticket | null
  currentUser: { id: string; email: string }
  /** The project's epics, for the parent-epic picker shown on non-epic tickets. Optional
   *  and defaulted so the dialog renders standalone (and in tests) without wiring it. */
  epics?: Ticket[]
  /** The project's sprints, for the sprint picker. */
  sprints?: Sprint[]
  /** Whether that list is trustworthy yet. Defaults to 'loading' — i.e. unknown, so the
   *  picker is disabled — which is the honest default for a standalone render. */
  sprintsPhase?: SprintsPhase
  onOpenChange: (open: boolean) => void
  onUpdated: (ticket: Ticket) => void
  onDeleted: (id: string) => void
  /** Appends AI-created child tickets to the shared board/backlog list. Optional so the
   *  dialog still renders in isolation (tests, non-epic tickets). */
  onTicketsCreated?: (tickets: Ticket[]) => void
}) {
  // How many fields are currently mid-edit. Read by `onEscapeKeyDown` below: Radix
  // dismisses the whole dialog on Escape at the document level (capture phase), which
  // would fire even while a field's own input has focus. When this is > 0 we
  // preventDefault the dialog dismissal — the field's own Esc handler still cancels
  // just that field's edit (see `EditableText.cancel`).
  const [editingCount, setEditingCount] = useState(0)
  function handleEditingChange(editing: boolean) {
    setEditingCount((count) => count + (editing ? 1 : -1))
  }

  // The add-deliverable input, so the dialog's Escape handler can tell "Esc in the add
  // field" (clear the draft, stay open) from "Esc anywhere else" (dismiss the dialog).
  // Stays HERE rather than moving into `useDeliverables`: Radix dismisses the dialog at the
  // document level in the capture phase, so a child's stopPropagation cannot keep it open —
  // the escape policy has to live with the dialog. The hook owns the draft state; the dialog
  // owns the ref.
  const newDeliverableRef = useRef<HTMLInputElement>(null)

  // The AI decomposition trace (epic only): the proposal list, its traceability signals,
  // and the two async operations that fill and drain it. `reset()` drops the whole trace.
  const decomposition = useDecomposition({ ticket, onTicketsCreated })

  // The optimistic write engine: field-scoped commit/rollback/reconcile, the ticket-scoped
  // error, and the mounted flag every async continuation checks after its `await`.
  const { commit, error, setError, clearError, applyServerRow, isMounted } = useTicketCommit({
    ticket,
    onUpdated,
  })

  // The epic's deliverables list, its add-input draft, and the serialized add/remove/edit
  // writes. Declared AFTER `useDecomposition` because it invalidates that trace on every
  // successful write — the write shifts the `covers` indices the trace was computed against.
  const deliverables = useDeliverables({
    ticket,
    commit,
    isMounted,
    onWritten: decomposition.reset,
  })

  // Block/unblock (the reason dialog's draft, and the two writes behind Block and Unblock)
  // and the delete confirm. Both are declared AFTER `useTicketCommit` because they reconcile
  // through its field-scoped `applyServerRow` and report through its shared ticket error.
  const blockFlow = useBlockFlow({ ticket, applyServerRow, setError, clearError })
  const deleteFlow = useDeleteFlow({ ticket, onDeleted, setError })

  if (!ticket) return null

  return (
    <Dialog open={ticket !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 p-0 sm:max-w-3xl"
        onEscapeKeyDown={(e) => {
          // A field is mid-edit: let its own handler cancel just that field (see
          // EditableText.cancel) and keep the dialog open.
          if (editingCount > 0) {
            e.preventDefault()
            return
          }
          // Esc in the add-deliverable input clears its draft rather than dismissing the
          // whole dialog — the same "Esc cancels the field, not the modal" contract every
          // other editable field has.
          if (document.activeElement === newDeliverableRef.current && deliverables.draft) {
            e.preventDefault()
            deliverables.setDraft('')
          }
        }}
      >
        <TicketDetailHeader
          ticket={ticket}
          onBlock={blockFlow.open}
          onUnblock={() => void blockFlow.unblock()}
          onDelete={() => deleteFlow.setConfirming(true)}
        />

        <div className="grid gap-x-8 gap-y-6 px-6 py-5 sm:grid-cols-[1fr_240px]">
          {ticket.is_blocked ? (
            <TicketBlockedBanner ticket={ticket} unblockPending={blockFlow.unblockPending} />
          ) : null}

          {/* Main column: summary + description */}
          <div className="flex min-w-0 flex-col gap-6">
            <TicketMainFields
              ticket={ticket}
              commit={commit}
              setError={setError}
              onEditingChange={handleEditingChange}
            />

            {/* Epic-only: the context and deliverables that feed Rung 2 AI decomposition. */}
            {ticket.type === 'epic' ? (
              <TicketEpicSection
                ticket={ticket}
                deliverables={deliverables}
                decomposition={decomposition}
                inputRef={newDeliverableRef}
                commit={commit}
                onEditingChange={handleEditingChange}
              />
            ) : null}
          </div>

          <TicketDetailSidebar
            ticket={ticket}
            currentUser={currentUser}
            epics={epics}
            sprints={sprints}
            sprintsPhase={sprintsPhase}
            commit={commit}
            setError={setError}
            onEditingChange={handleEditingChange}
          />
        </div>

        {error ? (
          <p role="alert" className="text-destructive border-border/70 border-t px-6 py-3 text-sm">
            {error}
          </p>
        ) : null}

        <TicketBlockDialog ticketKey={ticket.key} blockFlow={blockFlow} />
        <TicketDeleteDialog ticketKey={ticket.key} deleteFlow={deleteFlow} />
      </DialogContent>
    </Dialog>
  )
}
