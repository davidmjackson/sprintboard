import { useRef, useState } from 'react'

import { useBlockFlow, useDeleteFlow } from '@/lib/ticket-actions'
import { useTicketCommit } from '@/lib/ticket-commit'
import { useDeliverables } from '@/lib/ticket-deliverables'
import type { ProjectField, ProjectFieldOption, ProjectStatus, Sprint, Ticket } from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import { statusName } from '@/lib/project-statuses'
import type { SprintsPhase } from './ProjectShell'
import { TicketDetailHeader, TicketBlockedBanner } from './TicketDetailHeader'
import { TicketBlockDialog, TicketDeleteDialog } from './TicketActionDialogs'
import { TicketMainFields } from './TicketMainFields'
import { TicketDetailSidebar } from './TicketDetailSidebar'
import { TicketEpicSection } from './TicketEpicSection'
import { Dialog, DialogContent } from '@/components/ui/dialog'

/**
 * Jira-style ticket detail modal. This component is the composition root: it owns the
 * public prop contract, calls the extracted hooks (`useTicketCommit`, `useDeliverables`,
 * `useBlockFlow`, `useDeleteFlow`), and assembles their state into the
 * header, fields, sidebar and action dialogs below. The optimistic-save write engine —
 * commit/rollback/reconcile against `updateTicket`, with `updated_at` coming from the DB
 * trigger via the reconciled row — lives in `useTicketCommit` (`src/lib/ticket-commit.ts`),
 * not here. The Escape-key policy also stays here rather than in a child: Radix dismisses
 * the whole dialog at the document level, so only the component holding `onEscapeKeyDown`
 * can decide whether a field's own edit or the add-deliverable draft should swallow it
 * instead of dismissing the dialog. Assignee is deliberately `{ Unassigned, current user }`
 * — Phase 1 is single-owner, and widening the profiles read would leak every user's email.
 */
export function TicketDetailDialog({
  ticket,
  currentUser,
  epics = [],
  sprints = [],
  sprintsPhase = 'loading',
  statuses = [],
  statusesPhase = 'loading',
  hasSprints,
  fields,
  fieldsPhase,
  options,
  optionsPhase,
  onRetryFields,
  onOpenChange,
  onUpdated,
  onDeleted,
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
  /** The project's status rows, in column (`position`) order (SPRIN-76). The sidebar's
   *  status picker offers them; the header shows the one this ticket is on. Optional and
   *  defaulted for the same reason as `sprints`. */
  statuses?: ProjectStatus[]
  /** Whether that list is trustworthy yet. Defaults to 'loading' — i.e. unknown, so the
   *  status picker is disabled — which is the honest default for a standalone render. */
  statusesPhase?: ReadPhase
  /** Whether the project delivers in sprints — `hasSprints(project)`, resolved by
   *  `ProjectShell` (SPRIN-82). Forwarded to the sidebar and on to `TicketSprintField`,
   *  which owns the conditional and the default.
   *
   *  UNLIKE every other optional prop above, this one is deliberately NOT defaulted here.
   *  A destructuring default costs a cyclomatic point in this repo's eslint config
   *  (measured), and this component is at 10 of 10 — `hasSprints = true` would take it to
   *  11 and turn `npm run lint` red. The default lives one hop further down instead, which
   *  is also where it reads as a decision rather than as plumbing. */
  hasSprints?: boolean
  /** The project's custom field definitions and that read's phase (SPRIN-88). Threaded
   *  straight through to the sidebar and on to `TicketCustomFields`, which owns both
   *  defaults.
   *
   *  UNDEFAULTED HERE FOR THE SAME REASON AS `hasSprints`, and the reason has only got
   *  sharper: this component is still at 10 of 10, so `fields = []` and
   *  `fieldsPhase = 'loading'` would take it to 12 on their own. That is why the story's
   *  design says the dialog "threads them straight through" — it is a lint-budget
   *  constraint stated as an architecture, not a preference. */
  fields?: ProjectField[]
  fieldsPhase?: ReadPhase
  /** The project's `select`-field options (SPRIN-92 task 10). UNDEFAULTED HERE for the same
   *  reason as `fields`: this component is still at 10 of 10, so `options = []` and
   *  `optionsPhase = 'loading'` would take it over. Threaded straight through to the sidebar
   *  and on to `TicketCustomFields`, which owns both defaults. */
  options?: ProjectFieldOption[]
  optionsPhase?: ReadPhase
  /** The shell's retry, for the definitions read the shell owns. */
  onRetryFields?: () => void
  onOpenChange: (open: boolean) => void
  onUpdated: (ticket: Ticket) => void
  onDeleted: (id: string) => void
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

  // The optimistic write engine: field-scoped commit/rollback/reconcile, the ticket-scoped
  // error, and the mounted flag every async continuation checks after its `await`.
  const { commit, error, setError, clearError, applyServerRow, isMounted } = useTicketCommit({
    ticket,
    onUpdated,
  })

  // The epic's deliverables list, its add-input draft, and the serialized add/remove/edit
  // writes.
  const deliverables = useDeliverables({ ticket, commit, isMounted })

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
        {/* The header takes the RESOLVED name, not the rows: it renders one label, and a
            second lookup site would be a second place the AC4 slug fallback could drift
            from the picker's. Resolved once, here. */}
        <TicketDetailHeader
          ticket={ticket}
          statusName={statusName(statuses, ticket.status)}
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

            {/* Epic-only: the epic's context and its deliverables list. */}
            {ticket.type === 'epic' ? (
              <TicketEpicSection
                ticket={ticket}
                deliverables={deliverables}
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
            statuses={statuses}
            statusesPhase={statusesPhase}
            commit={commit}
            setError={setError}
            onEditingChange={handleEditingChange}
            hasSprints={hasSprints}
            fields={fields}
            fieldsPhase={fieldsPhase}
            options={options}
            optionsPhase={optionsPhase}
            onRetryFields={onRetryFields}
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
