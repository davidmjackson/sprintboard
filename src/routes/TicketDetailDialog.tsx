import { useRef, useState } from 'react'
import { Ban, CircleCheck, MoreHorizontal, Trash2, X } from 'lucide-react'

import {
  BLOCK_REASON_MAX,
  blockTicket,
  deleteTicket,
  parseBlockReason,
  parseStoryPoints,
  parseSummary,
  unblockTicket,
} from '@/lib/tickets'
import { useTicketCommit } from '@/lib/ticket-commit'
import { useDecomposition } from '@/lib/ticket-decomposition'
import { useDeliverables } from '@/lib/ticket-deliverables'
import { parseLabels } from '@/lib/labels'
import {
  SPRINT_STATUS_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  TICKET_STATUS_LABELS,
  type Sprint,
  type Ticket,
  type TicketType,
} from '@/lib/domain'
import type { SprintsPhase } from './ProjectShell'
import { EditableText, FieldLabel, selectClass } from './EditableText'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

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

  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // Block flow: the reason dialog's open state, its draft reason, and an in-flight flag.
  // Unblock has no dialog (it needs no input), so it only tracks its own in-flight flag.
  const [blocking, setBlocking] = useState(false)
  const [blockReason, setBlockReason] = useState('')
  const [blockError, setBlockError] = useState<string | null>(null)
  const [blockPending, setBlockPending] = useState(false)
  const [unblockPending, setUnblockPending] = useState(false)

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

  if (!ticket) return null

  // Proposal indices flagged as not tied to any deliverable (R2.1 scope-creep signal).
  const creepIndices = new Set(decomposition.scopeCreep.map((c) => c.proposal_index))

  async function handleDelete() {
    const id = ticket!.id
    setDeleting(true)
    const result = await deleteTicket(id)
    if (!isMounted()) return // dialog was dismissed while the delete was in flight
    if (result.ok) {
      // Parent removes the row → `ticket` becomes null → this dialog unmounts. We don't
      // reset local state (we're on our way out) and never close ourselves directly.
      onDeleted(id)
    } else {
      setDeleting(false)
      setConfirmingDelete(false)
      setError(id, 'Could not delete this ticket. Please try again.')
    }
  }

  function closeBlockDialog() {
    setBlocking(false)
    setBlockReason('')
    setBlockError(null)
  }

  async function handleBlock() {
    const id = ticket!.id
    const parsed = parseBlockReason(blockReason)
    if (!parsed.ok) {
      // The confirm button is disabled while the reason is invalid, so this is a
      // defensive backstop rather than the normal path.
      setBlockError(parsed.message)
      return
    }
    setBlockPending(true)
    const result = await blockTicket(id, parsed.value)
    if (!isMounted()) return // dialog was dismissed while the block was in flight
    setBlockPending(false)
    if (result.ok) {
      applyServerRow(id, result.ticket, ['is_blocked', 'blocked_reason', 'blocked_since'])
      setBlocking(false)
      setBlockReason('')
      setBlockError(null)
    } else {
      setBlockError(
        result.error === 'invalid_reason'
          ? result.message
          : 'Could not block this ticket. Please try again.',
      )
    }
  }

  async function handleUnblock() {
    // Unblock fires from the kebab (which closes on select) and is not optimistic, so
    // without a guard an impatient second click would fire a duplicate request. The
    // banner shows an "Unblocking…" state off this flag until the row reconciles.
    if (unblockPending) return
    const id = ticket!.id
    setUnblockPending(true)
    const result = await unblockTicket(id)
    if (!isMounted()) return // dialog was dismissed while the unblock was in flight
    setUnblockPending(false)
    if (result.ok) {
      applyServerRow(id, result.ticket, ['is_blocked', 'blocked_reason', 'blocked_since'])
      clearError()
    } else {
      setError(id, 'Could not unblock this ticket. Please try again.')
    }
  }

  const assigneeValue = ticket.assignee_id === currentUser.id ? currentUser.id : ''
  const initial = assigneeValue ? (currentUser.email[0]?.toUpperCase() ?? null) : null

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
              {TICKET_STATUS_LABELS[ticket.status]}
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
                <DropdownMenuItem onSelect={() => void handleUnblock()}>
                  <CircleCheck />
                  Unblock
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  onSelect={() => {
                    setBlockReason('')
                    setBlockError(null)
                    setBlocking(true)
                  }}
                >
                  <Ban />
                  Block
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmingDelete(true)}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </DialogHeader>

        <div className="grid gap-x-8 gap-y-6 px-6 py-5 sm:grid-cols-[1fr_240px]">
          {ticket.is_blocked ? (
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
          ) : null}

          {/* Main column: summary + description */}
          <div className="flex min-w-0 flex-col gap-6">
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
              onEditingChange={handleEditingChange}
            />

            <div className="flex flex-col gap-1.5">
              <FieldLabel>Description</FieldLabel>
              <EditableText
                value={ticket.description ?? ''}
                ariaLabel="description"
                multiline
                placeholder="Add a description…"
                onCommit={(v) => commit({ description: v.trim() || null })}
                onEditingChange={handleEditingChange}
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
                onEditingChange={handleEditingChange}
              />
            </div>

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

          {/* Sidebar: a quiet "Details" panel, the Jira right rail */}
          <aside className="bg-muted/30 flex flex-col gap-4 rounded-lg border p-4 sm:self-start">
            <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
              Details
            </h3>

            <label className="flex flex-col gap-1">
              <FieldLabel>Type</FieldLabel>
              <select
                aria-label="type"
                className={selectClass}
                value={ticket.type}
                onChange={(e) => {
                  const next = e.target.value as TicketType
                  // Becoming an epic clears any parent epic in the same write: an epic does
                  // not nest under another epic (Phase 1), and the picker that would let you
                  // clear it is hidden for epics — so leaving it set would strand an
                  // unreachable, invalid reference.
                  commit(next === 'epic' ? { type: next, parent_epic_id: null } : { type: next })
                }}
              >
                {TICKET_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {TICKET_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>

            {/* Non-epic only: reference a parent epic in this project. An epic doesn't nest
                under another epic in Phase 1, so the picker is hidden for epics. The options
                are the project's epics; the composite fk `tickets_epic_fk` keeps the parent
                in the same project, so cross-project references are rejected at the DB. */}
            {ticket.type !== 'epic' ? (
              <label className="flex flex-col gap-1">
                <FieldLabel>Parent epic</FieldLabel>
                <select
                  aria-label="parent epic"
                  className={selectClass}
                  value={ticket.parent_epic_id ?? ''}
                  onChange={(e) => commit({ parent_epic_id: e.target.value || null })}
                >
                  <option value="">No epic</option>
                  {/* If the current parent isn't in the epics list (it was deleted or
                      demoted from epic, and the list is refetch-free), still render its
                      value so the <select> stays controlled and the link isn't silently
                      shown as "No epic" — the user can see it exists and change or clear it. */}
                  {ticket.parent_epic_id && !epics.some((e) => e.id === ticket.parent_epic_id) ? (
                    <option value={ticket.parent_epic_id}>Current parent (unavailable)</option>
                  ) : null}
                  {epics
                    .filter((e) => e.id !== ticket.id)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.key} · {e.summary}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}

            {/* Sprint membership (S6.2). `''` is the backlog: `backlog.ts` defines the backlog
                as `sprint_id is null`, so "Backlog" and "no sprint" are the same fact and the
                UI uses the domain's word for it. Unlike the parent-epic picker this is NOT
                gated on ticket type — an epic can be in a sprint. Sprints are NOT filtered by
                status — barring a complete or active sprint is a rule no AC asks for, and
                S6.3/S6.4 own what starting and completing do. The composite fk
                `tickets_sprint_fk` keeps the sprint in the same project, so a cross-project
                reference is rejected at the database.

                Disabled unless the sprint list actually loaded: `sprints` is `[]` while
                loading AND after a failed read, so an empty list never means "no sprints". An
                enabled picker would then offer only "Backlog", read as "this ticket is in no
                sprint", and one click would quietly unsprint it. */}
            <label className="flex flex-col gap-1">
              <FieldLabel>Sprint</FieldLabel>
              <select
                aria-label="sprint"
                className={selectClass}
                disabled={sprintsPhase !== 'loaded'}
                value={ticket.sprint_id ?? ''}
                onChange={(e) => commit({ sprint_id: e.target.value || null })}
              >
                <option value="">Backlog</option>
                {/* The current sprint isn't in the list (deleted, or the list hasn't loaded):
                    still render its value so the <select> stays controlled and the membership
                    isn't silently shown as "Backlog". Mirrors the parent-epic picker's guard. */}
                {ticket.sprint_id && !sprints.some((s) => s.id === ticket.sprint_id) ? (
                  <option value={ticket.sprint_id}>Current sprint (unavailable)</option>
                ) : null}
                {sprints.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {SPRINT_STATUS_LABELS[s.status]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <FieldLabel>Assignee</FieldLabel>
              <div className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="bg-background text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium"
                >
                  {initial ?? '—'}
                </span>
                <select
                  aria-label="assignee"
                  className={selectClass}
                  value={assigneeValue}
                  onChange={(e) => commit({ assignee_id: e.target.value || null })}
                >
                  <option value="">Unassigned</option>
                  <option value={currentUser.id}>{currentUser.email}</option>
                </select>
              </div>
            </label>

            <label className="flex flex-col gap-1">
              <FieldLabel>Story points</FieldLabel>
              <EditableText
                value={ticket.story_points?.toString() ?? ''}
                ariaLabel="story points"
                numeric
                placeholder="—"
                onCommit={(v) => {
                  const parsed = parseStoryPoints(v)
                  if (!parsed.ok) {
                    setError(ticket.id, 'Whole numbers only')
                    return
                  }
                  commit({ story_points: parsed.value })
                }}
                onEditingChange={handleEditingChange}
              />
            </label>

            <label className="flex flex-col gap-1">
              <FieldLabel>Labels</FieldLabel>
              <EditableText
                value={ticket.labels.join(', ')}
                ariaLabel="labels"
                placeholder="Add labels…"
                onCommit={(v) => commit({ labels: parseLabels(v) })}
                onEditingChange={handleEditingChange}
              />
            </label>

            <p className="text-muted-foreground border-border/70 border-t pt-3 text-[11px]">
              Updated {new Date(ticket.updated_at).toLocaleString()}
            </p>
          </aside>
        </div>

        {error ? (
          <p role="alert" className="text-destructive border-border/70 border-t px-6 py-3 text-sm">
            {error}
          </p>
        ) : null}

        <Dialog
          open={blocking}
          onOpenChange={(open) => {
            // Ignore dismissal while the block is in flight; reset on any close.
            if (blockPending) return
            if (!open) closeBlockDialog()
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Block {ticket.key}?</DialogTitle>
              <DialogDescription>
                Blocking flags the ticket — it stays in its column. A reason is required.
              </DialogDescription>
            </DialogHeader>
            <label className="flex flex-col gap-1.5">
              <FieldLabel>Reason</FieldLabel>
              <Textarea
                aria-label="reason"
                rows={3}
                autoFocus
                maxLength={BLOCK_REASON_MAX}
                value={blockReason}
                placeholder="Why is this blocked?"
                onChange={(e) => {
                  setBlockReason(e.target.value)
                  if (blockError) setBlockError(null)
                }}
              />
            </label>
            {blockError ? (
              <p role="alert" className="text-destructive text-sm">
                {blockError}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={closeBlockDialog} disabled={blockPending}>
                Cancel
              </Button>
              <Button
                onClick={handleBlock}
                disabled={blockPending || !parseBlockReason(blockReason).ok}
              >
                {blockPending ? 'Blocking…' : 'Block'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <AlertDialog
          open={confirmingDelete}
          onOpenChange={(open) => {
            if (!deleting) setConfirmingDelete(open)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {ticket.key}?</AlertDialogTitle>
              <AlertDialogDescription>
                This can’t be undone. The ticket will be removed from the board and backlog.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel asChild>
                <Button variant="outline" disabled={deleting}>
                  Cancel
                </Button>
              </AlertDialogCancel>
              <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
