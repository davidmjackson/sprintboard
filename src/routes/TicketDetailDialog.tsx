import { useRef, useState } from 'react'
import { X } from 'lucide-react'

import { useBlockFlow, useDeleteFlow } from '@/lib/ticket-actions'
import { useTicketCommit } from '@/lib/ticket-commit'
import { useDecomposition } from '@/lib/ticket-decomposition'
import { useDeliverables } from '@/lib/ticket-deliverables'
import { TICKET_TYPE_LABELS, type Sprint, type Ticket } from '@/lib/domain'
import type { SprintsPhase } from './ProjectShell'
import { EditableText, FieldLabel } from './EditableText'
import { TicketDetailHeader, TicketBlockedBanner } from './TicketDetailHeader'
import { TicketBlockDialog, TicketDeleteDialog } from './TicketActionDialogs'
import { TicketMainFields } from './TicketMainFields'
import { TicketDetailSidebar } from './TicketDetailSidebar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
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

  // Proposal indices flagged as not tied to any deliverable (R2.1 scope-creep signal).
  const creepIndices = new Set(decomposition.scopeCreep.map((c) => c.proposal_index))

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
              <>
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>Context</FieldLabel>
                  <EditableText
                    value={ticket.context ?? ''}
                    ariaLabel="context"
                    multiline
                    placeholder="Add context for this epic…"
                    onCommit={(v) => commit({ context: v.trim() || null })}
                    onEditingChange={handleEditingChange}
                  />
                </div>

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
                              onEditingChange={handleEditingChange}
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
                      ref={newDeliverableRef}
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

                <div className="space-y-2 border-t pt-4">
                  <FieldLabel>AI decomposition</FieldLabel>
                  {decomposition.proposals === null ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={decomposition.decomposing}
                      onClick={() => void decomposition.runDecompose()}
                    >
                      {decomposition.decomposing ? 'Thinking…' : 'Decompose with AI'}
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      {deliverables.items.length > 0 ? (
                        <p className="text-muted-foreground text-xs">
                          Covers{' '}
                          {Math.max(
                            0,
                            deliverables.items.length - decomposition.coverageGaps.length,
                          )}{' '}
                          of {deliverables.items.length} deliverables
                        </p>
                      ) : (
                        <p className="text-muted-foreground text-xs">
                          No deliverables to trace against.
                        </p>
                      )}
                      {decomposition.estimateTotal > 0 ? (
                        <p className="text-muted-foreground text-xs">
                          Estimated total: {decomposition.estimateTotal} pts
                        </p>
                      ) : null}
                      {decomposition.coverageGaps.length > 0 ? (
                        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
                          <p className="font-medium text-amber-700 dark:text-amber-400">
                            Not covered by any proposal
                          </p>
                          <ul className="mt-1 list-disc pl-4">
                            {decomposition.coverageGaps.map((g) => (
                              <li key={g.index}>{g.deliverable}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <ul className="space-y-2">
                        {decomposition.proposals.map((p, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={decomposition.selected.has(i)}
                              aria-label={`Include ${p.title} (#${i + 1})`}
                              onChange={(e) => decomposition.toggle(i, e.target.checked)}
                            />
                            <div className="text-sm">
                              <p className="font-medium">
                                {p.title}{' '}
                                <span className="text-muted-foreground">
                                  ({TICKET_TYPE_LABELS[p.type]})
                                </span>
                              </p>
                              <p className="text-muted-foreground">{p.description}</p>
                              <p className="text-muted-foreground/80 text-xs italic">
                                {p.rationale}
                              </p>
                              {p.estimate_reason ? (
                                <p className="text-muted-foreground/80 text-xs">
                                  {p.estimate_reason}
                                </p>
                              ) : null}
                              <div className="mt-1 flex flex-wrap gap-1">
                                {p.estimate != null ? (
                                  <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">
                                    {p.estimate} pts
                                  </span>
                                ) : null}
                                {creepIndices.has(i) ? (
                                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                                    Not tied to a deliverable
                                  </span>
                                ) : (
                                  p.covers
                                    .filter((idx) => deliverables.items[idx] !== undefined)
                                    .map((idx) => (
                                      <span
                                        key={idx}
                                        className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]"
                                      >
                                        {deliverables.items[idx]}
                                      </span>
                                    ))
                                )}
                              </div>
                            </div>
                          </li>
                        ))}
                      </ul>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={decomposition.accepting || decomposition.selected.size === 0}
                          onClick={() => void decomposition.acceptSelected()}
                        >
                          {decomposition.accepting
                            ? 'Adding…'
                            : `Add ${decomposition.selected.size} to backlog`}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={decomposition.accepting}
                          onClick={decomposition.reset}
                        >
                          Discard
                        </Button>
                      </div>
                    </div>
                  )}
                  {decomposition.aiError ? (
                    <p role="alert" className="text-destructive text-sm">
                      {decomposition.aiError}
                    </p>
                  ) : null}
                </div>
              </>
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
