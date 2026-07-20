import { useEffect, useRef, useState } from 'react'
import { Ban, CircleCheck, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react'

import {
  BLOCK_REASON_MAX,
  blockTicket,
  createTicket,
  deleteTicket,
  parseBlockReason,
  unblockTicket,
  updateTicket,
} from '@/lib/tickets'
import { decomposeEpic, type DecomposeProposal } from '@/lib/ai'
import { parseLabels } from '@/lib/labels'
import { parseDeliverables } from '@/lib/deliverables'
import {
  SPRINT_STATUS_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  TICKET_STATUS_LABELS,
  type Sprint,
  type Ticket,
  type TicketType,
  type TicketUpdate,
} from '@/lib/domain'
import type { SprintsPhase } from './ProjectShell'
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
import { cn } from '@/lib/utils'

const selectClass =
  'border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:ring-3 md:text-sm'

/** Small uppercase eyebrow label, shared by every sidebar field. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-muted-foreground/80 text-[11px] font-semibold tracking-wide uppercase">
      {children}
    </span>
  )
}

/** Click-to-edit text/number field. View mode is a button; edit mode is an input or
 *  textarea. Enter (single-line) or blur commits a changed value; Esc cancels.
 *  The view-mode button reveals a pencil cue on hover/focus — the one motif repeated
 *  across every editable field in the dialog, so the whole modal reads as "click
 *  anything to edit it" without a single instructional sentence. */
function EditableText({
  value,
  ariaLabel,
  multiline,
  numeric,
  placeholder,
  heading,
  onCommit,
  onEditingChange,
}: {
  value: string
  ariaLabel: string
  multiline?: boolean
  numeric?: boolean
  placeholder?: string
  heading?: boolean
  onCommit: (next: string) => void
  /** Reports edit-mode transitions up to the dialog, so it can tell Radix's Escape
   *  handler "a field is mid-edit — cancel the field, don't close the dialog." */
  onEditingChange?: (editing: boolean) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)

  // The view-mode "Edit …" button, so focus can be handed back to it when a field
  // exits edit mode — otherwise the input unmounts and Radix's FocusScope drops focus
  // to the dialog root, throwing keyboard/SR users to the top of the tab order.
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Set by commit()/cancel() to request a refocus once the view-mode button is back in
  // the DOM; a ref (not state) so setting it never itself triggers a render.
  const refocusTriggerRef = useRef(false)
  useEffect(() => {
    if (!editing && refocusTriggerRef.current) {
      refocusTriggerRef.current = false
      triggerRef.current?.focus()
    }
  }, [editing])

  function start() {
    setDraft(value)
    setEditing(true)
    onEditingChange?.(true)
  }
  function commit(refocus: boolean) {
    setEditing(false)
    onEditingChange?.(false)
    // Refocus-to-trigger is a KEYBOARD affordance (Enter commits). A blur means focus is
    // already moving on intentionally (Tab, or a click onto another field's edit button),
    // so yanking it back would steal it — force the user to Tab twice / re-click.
    if (refocus) refocusTriggerRef.current = true
    if (draft !== value) onCommit(draft)
  }
  function cancel() {
    setEditing(false)
    onEditingChange?.(false)
    refocusTriggerRef.current = true
    setDraft(value)
  }

  if (!editing) {
    return (
      <button
        type="button"
        ref={triggerRef}
        aria-label={`Edit ${ariaLabel}`}
        onClick={start}
        className={cn(
          'group hover:bg-muted/60 focus-visible:bg-muted/60 -mx-2 flex w-[calc(100%+1rem)] items-start justify-between gap-2 rounded-md px-2 py-1 text-left outline-none',
          heading ? 'text-xl font-semibold' : 'text-sm',
        )}
      >
        <span className={cn(!value && 'text-muted-foreground font-normal')}>
          {value || placeholder || 'Empty'}
        </span>
        <Pencil
          aria-hidden="true"
          className="text-muted-foreground mt-1 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
        />
      </button>
    )
  }

  const commonProps = {
    autoFocus: true,
    'aria-label': ariaLabel,
    value: draft,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => commit(false),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault()
        commit(true)
      }
    },
  }

  return multiline ? (
    <Textarea rows={3} className="text-sm" {...commonProps} />
  ) : (
    <Input
      type={numeric ? 'number' : 'text'}
      min={numeric ? 0 : undefined}
      placeholder={placeholder}
      className={cn(heading && 'h-auto py-1 text-xl font-semibold md:text-xl')}
      {...commonProps}
    />
  )
}

/**
 * Jira-style ticket detail modal. Every field edits in place and commits independently.
 * Saves are optimistic against `onUpdated`, persisted with `updateTicket`, and rolled
 * back on failure. `updated_at` comes from the DB trigger via the reconciled row.
 * Assignee is deliberately `{ Unassigned, current user }` — Phase 1 is single-owner, and
 * widening the profiles read would leak every user's email.
 */
/** Copies only `keys` from `source` into a new object, typed exactly like `Pick<T, K>`.
 *  Used to capture/apply a FIELD-SCOPED slice of a ticket for optimistic rollback and
 *  reconcile, instead of ever swapping in a whole (possibly stale) ticket object. */
function pickFields<T, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const key of keys) out[key] = source[key]
  return out
}

/** Same rule as `CreateTicketDialog`'s zod schema (`^\d{0,3}$`, "Whole numbers only") —
 *  the edit path has no `<form>`/zod, so it re-validates the same shape by hand. Empty
 *  means "no estimate" (→ null); a non-negative whole number of up to 3 digits (→
 *  Number); anything else (negative, decimal, non-numeric) is rejected. */
function parseStoryPoints(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d{0,3}$/.test(trimmed)) return { ok: false }
  return { ok: true, value: Number(trimmed) }
}

/** Same rule as `CreateTicketDialog`'s zod schema for `summary`
 *  (`.trim().min(1).max(200)`) — the edit path has no `<form>`/zod, so it re-validates
 *  the same shape by hand. `summary text not null` accepts `''`, so without this a
 *  cleared or whitespace-only summary would persist and produce an untitled row.
 *  Returns the TRIMMED value on success. */
function parseSummary(raw: string): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = raw.trim()
  if (trimmed.length < 1) return { ok: false, message: 'Summary is required' }
  if (trimmed.length > 200)
    return { ok: false, message: 'Keep the summary to 200 characters or fewer' }
  return { ok: true, value: trimmed }
}

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
  // Keyed to the ticket id so switching tickets resets any stale error without a
  // synchronous "reset on prop change" effect (the project's react-hooks lint rule
  // forbids deriving state that way).
  const [errorFor, setErrorFor] = useState<{ ticketId: string; message: string } | null>(null)

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

  // The draft for the "add a deliverable" input (epic only). Cleared on a successful add.
  const [deliverableDraft, setDeliverableDraft] = useState('')
  // True while a deliverables write is in flight — serializes them so two quick add/remove/
  // edits can't race into a lost update (they are whole-array overwrites of one column).
  const [deliverablesPending, setDeliverablesPending] = useState(false)
  // The add-deliverable input, so the dialog's Escape handler can tell "Esc in the add
  // field" (clear the draft, stay open) from "Esc anywhere else" (dismiss the dialog).
  const newDeliverableRef = useRef<HTMLInputElement>(null)

  // AI decomposition (epic only). `proposals === null` is "not decomposed yet" (shows the
  // button); once set, it shows the proposal list until accepted or discarded.
  const [proposals, setProposals] = useState<DecomposeProposal[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [decomposing, setDecomposing] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  // The freshest ticket, readable from inside an in-flight async `commit()` closure.
  // Without this, a rollback/reconcile that fires after a concurrent edit to a
  // DIFFERENT field would merge against the ticket as it was when `commit` was
  // *called*, silently discarding that concurrent edit.
  const ticketRef = useRef<Ticket | null>(ticket)
  // Ref writes must happen outside render (the project's react-hooks/refs rule forbids
  // writing `.current` during render), so this syncs after commit rather than inline.
  useEffect(() => {
    ticketRef.current = ticket
  })

  // A commit()'s async continuation must not touch parent state after THIS instance
  // unmounts. ProjectShell renders us with key={selected?.id ?? 'none'}, so closing then
  // reopening the SAME ticket unmounts this instance and mounts a fresh one that now owns
  // the ticket. A save still in flight when the old instance dies would otherwise resolve
  // against a frozen ticketRef (its sync effect has no cleanup) and clobber the fresh
  // instance's already-saved edits (Ultracode Critical). Set true on (re)mount, false on
  // unmount — the explicit true-on-mount keeps it correct under React StrictMode's
  // mount→unmount→mount.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  if (!ticket) return null

  const error = errorFor?.ticketId === ticket.id ? errorFor.message : null

  // The epic's deliverables, narrowed from the `jsonb` column to a clean string list. The
  // editor always rebuilds the whole array and commits it through `commit`, so a write is
  // always a well-formed `string[]` and never a half-mutated jsonb value.
  const deliverables = parseDeliverables(ticket.deliverables)

  async function commit(patch: TicketUpdate): Promise<boolean> {
    const current = ticketRef.current!
    const keys = Object.keys(patch) as (keyof TicketUpdate)[]
    const revert = pickFields(current, keys) // pre-change values of ONLY the changed keys

    onUpdated({ ...current, ...patch } as Ticket) // optimistic — merge onto the latest ticket
    const result = await updateTicket(current.id, patch)
    // This instance is gone (close→reopen remounted a fresh one that now owns the ticket):
    // its optimistic value was already applied to parent state before the await and carried
    // forward by the fresh instance, so reconciling here would only clobber the live
    // instance's newer edits. Bail (Ultracode Critical — the mountedRef guard).
    if (!mountedRef.current) return false
    // `ticketRef.current` may also have moved on WITHIN this live instance — to a DIFFERENT
    // ticket (the dialog switched tickets while this save was in flight) or to `null`.
    // Merging onto it unguarded would emit a wrong-identity object (or, for null, an id-less
    // `{}`). Fall back to the commit-time `current` — always non-null, always
    // `id === current.id` — whenever the live ref no longer matches this save's ticket.
    const base = ticketRef.current?.id === current.id ? ticketRef.current : current
    if (!result.ok) {
      // Revert only the fields this commit changed, merged onto whatever is latest NOW —
      // preserves any other field a concurrent commit has since applied.
      onUpdated({ ...base, ...revert } as Ticket)
      setErrorFor({
        ticketId: current.id,
        message: 'Could not save your change. Please try again.',
      })
      return false
    } else {
      // Reconcile only the changed fields (+ the DB-refreshed updated_at) onto the latest
      // ticket — never swap in the whole `result.ticket`, which would clobber a
      // concurrent in-flight optimistic edit to a different field.
      // NOTE: two in-flight saves to the SAME field resolving out of order can still
      // reconcile/revert in the wrong order (last-resolved wins, not last-committed) —
      // a known, deliberately deferred limitation.
      const reconciled = pickFields(result.ticket, keys)
      onUpdated({ ...base, ...reconciled, updated_at: result.ticket.updated_at } as Ticket)
      setErrorFor(null)
      return true
    }
  }

  // Deliverables are an epic-only, order-preserving `string[]`. Each mutation rebuilds the
  // WHOLE array and commits it — which makes two concurrent mutations conflicting writes to
  // one column, not the coexisting edits the user intends ("add A", "add B"). Out-of-order
  // resolution would then persist last-write-wins and silently drop an item. So deliverable
  // writes are SERIALIZED: `deliverablesPending` blocks a second mutation until the first
  // reconciles, and Add/remove are disabled meanwhile. Each still rides the shared optimistic
  // commit, so a failed save reverts just `deliverables`.
  async function writeDeliverables(next: string[]): Promise<boolean> {
    if (deliverablesPending) return false
    setDeliverablesPending(true)
    const ok = await commit({ deliverables: next })
    if (!mountedRef.current) return ok
    setDeliverablesPending(false)
    return ok
  }
  async function addDeliverable() {
    const trimmed = deliverableDraft.trim()
    if (!trimmed) return
    const ok = await writeDeliverables([...deliverables, trimmed])
    // Clear the input only once the add persisted — a failed save keeps the typed text so
    // the user can retry without re-entering it.
    if (ok && mountedRef.current) setDeliverableDraft('')
  }
  function removeDeliverable(index: number) {
    void writeDeliverables(deliverables.filter((_, i) => i !== index))
  }
  function editDeliverable(index: number, value: string) {
    // Editing an item to blank removes it — `filter(Boolean)` after the replace, so the
    // list never holds an empty deliverable (the same rule `parseDeliverables` enforces).
    const next = deliverables.map((d, i) => (i === index ? value.trim() : d)).filter(Boolean)
    void writeDeliverables(next)
  }

  async function runDecompose() {
    if (!ticket) return
    setDecomposing(true)
    setAiError(null)
    const result = await decomposeEpic({
      summary: ticket.summary,
      context: ticket.context ?? '',
      deliverables: parseDeliverables(ticket.deliverables),
    })
    setDecomposing(false)
    if (!result.ok) {
      setAiError(
        result.error === 'unauthenticated'
          ? 'Your session expired — sign in again.'
          : 'Could not reach the AI service. Is it running?',
      )
      return
    }
    setProposals(result.proposals)
    setSelected(new Set(result.proposals.map((_, i) => i)))
  }

  async function acceptSelected() {
    if (!ticket || !proposals) return
    setAccepting(true)
    setAiError(null)
    const created: Ticket[] = []
    for (const [i, p] of proposals.entries()) {
      if (!selected.has(i)) continue
      const result = await createTicket({
        projectId: ticket.project_id,
        summary: p.title,
        type: p.type,
        description: p.description,
        parentEpicId: ticket.id,
      })
      if (result.ok) created.push(result.ticket)
    }
    setAccepting(false)
    if (created.length > 0) onTicketsCreated?.(created)
    // Always clear the panel after an attempt: a re-click must never re-create a ticket
    // that already succeeded (duplicate writes). Successful children are already on the
    // board via onTicketsCreated; on partial failure the user re-runs decomposition.
    setProposals(null)
    setSelected(new Set())
    if (created.length < selected.size) {
      setAiError('Some tickets could not be created. Run "Decompose with AI" again to retry the rest.')
    }
  }

  async function handleDelete() {
    const id = ticket!.id
    setDeleting(true)
    const result = await deleteTicket(id)
    if (!mountedRef.current) return // dialog was dismissed while the delete was in flight
    if (result.ok) {
      // Parent removes the row → `ticket` becomes null → this dialog unmounts. We don't
      // reset local state (we're on our way out) and never close ourselves directly.
      onDeleted(id)
    } else {
      setDeleting(false)
      setConfirmingDelete(false)
      setErrorFor({ ticketId: id, message: 'Could not delete this ticket. Please try again.' })
    }
  }

  // Block/unblock are NOT optimistic: the `sync_blocked_fields` trigger stamps/clears
  // `blocked_since` server-side, so we apply the row the DB returns rather than guess it.
  // Reconcile is field-scoped (only the three blocked fields + the refreshed updated_at)
  // onto whatever is latest NOW — the same discipline as `commit()`, so a concurrent
  // in-flight optimistic edit to a different field is never clobbered.
  function applyBlockResult(id: string, next: Ticket) {
    const base = ticketRef.current?.id === id ? ticketRef.current : next
    onUpdated({
      ...base,
      ...pickFields(next, ['is_blocked', 'blocked_reason', 'blocked_since']),
      updated_at: next.updated_at,
    } as Ticket)
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
    if (!mountedRef.current) return // dialog was dismissed while the block was in flight
    setBlockPending(false)
    if (result.ok) {
      applyBlockResult(id, result.ticket)
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
    if (!mountedRef.current) return // dialog was dismissed while the unblock was in flight
    setUnblockPending(false)
    if (result.ok) {
      applyBlockResult(id, result.ticket)
      setErrorFor(null)
    } else {
      setErrorFor({ ticketId: id, message: 'Could not unblock this ticket. Please try again.' })
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
          if (document.activeElement === newDeliverableRef.current && deliverableDraft) {
            e.preventDefault()
            setDeliverableDraft('')
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
                  setErrorFor({ ticketId: ticket.id, message: parsed.message })
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
                  {deliverables.length > 0 ? (
                    <ul className="flex flex-col gap-1">
                      {deliverables.map((d, i) => (
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
                              onCommit={(v) => editDeliverable(i, v)}
                              onEditingChange={handleEditingChange}
                            />
                          </div>
                          <button
                            type="button"
                            aria-label={`Remove deliverable ${i + 1}`}
                            onClick={() => removeDeliverable(i)}
                            disabled={deliverablesPending}
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
                      value={deliverableDraft}
                      placeholder="Add a deliverable…"
                      disabled={deliverablesPending}
                      onChange={(e) => setDeliverableDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void addDeliverable()
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
                      onClick={() => void addDeliverable()}
                      disabled={!deliverableDraft.trim() || deliverablesPending}
                    >
                      Add
                    </Button>
                  </div>
                </div>

                <div className="space-y-2 border-t pt-4">
                  <FieldLabel>AI decomposition</FieldLabel>
                  {proposals === null ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={decomposing}
                      onClick={() => void runDecompose()}
                    >
                      {decomposing ? 'Thinking…' : 'Decompose with AI'}
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <ul className="space-y-2">
                        {proposals.map((p, i) => (
                          <li key={i} className="flex items-start gap-2">
                            <input
                              type="checkbox"
                              className="mt-1"
                              checked={selected.has(i)}
                              aria-label={`Include ${p.title} (#${i + 1})`}
                              onChange={(e) =>
                                setSelected((prev) => {
                                  const next = new Set(prev)
                                  if (e.target.checked) next.add(i)
                                  else next.delete(i)
                                  return next
                                })
                              }
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
                            </div>
                          </li>
                        ))}
                      </ul>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={accepting || selected.size === 0}
                          onClick={() => void acceptSelected()}
                        >
                          {accepting ? 'Adding…' : `Add ${selected.size} to backlog`}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={accepting}
                          onClick={() => {
                            setProposals(null)
                            setSelected(new Set())
                          }}
                        >
                          Discard
                        </Button>
                      </div>
                    </div>
                  )}
                  {aiError ? (
                    <p role="alert" className="text-destructive text-sm">
                      {aiError}
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
                    setErrorFor({ ticketId: ticket.id, message: 'Whole numbers only' })
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
