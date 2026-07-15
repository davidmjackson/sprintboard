import { useEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

import { updateTicket } from '@/lib/tickets'
import { parseLabels } from '@/lib/labels'
import {
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  TICKET_STATUS_LABELS,
  type Ticket,
  type TicketType,
  type TicketUpdate,
} from '@/lib/domain'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  value, ariaLabel, multiline, numeric, placeholder, heading, onCommit, onEditingChange,
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

  function start() {
    setDraft(value)
    setEditing(true)
    onEditingChange?.(true)
  }
  function commit() {
    setEditing(false)
    onEditingChange?.(false)
    if (draft !== value) onCommit(draft)
  }
  function cancel() {
    setEditing(false)
    onEditingChange?.(false)
    setDraft(value)
  }

  if (!editing) {
    return (
      <button
        type="button"
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
    onBlur: commit,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
      if (e.key === 'Enter' && !multiline) {
        e.preventDefault()
        commit()
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

export function TicketDetailDialog({
  ticket,
  currentUser,
  onOpenChange,
  onUpdated,
}: {
  ticket: Ticket | null
  currentUser: { id: string; email: string }
  onOpenChange: (open: boolean) => void
  onUpdated: (ticket: Ticket) => void
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

  if (!ticket) return null

  const error = errorFor?.ticketId === ticket.id ? errorFor.message : null

  async function commit(patch: TicketUpdate) {
    const current = ticketRef.current!
    const keys = Object.keys(patch) as (keyof TicketUpdate)[]
    const revert = pickFields(current, keys) // pre-change values of ONLY the changed keys

    onUpdated({ ...current, ...patch } as Ticket) // optimistic — merge onto the latest ticket
    const result = await updateTicket(current.id, patch)
    if (!result.ok) {
      // Revert only the fields this commit changed, merged onto whatever is latest NOW —
      // preserves any other field a concurrent commit has since applied.
      onUpdated({ ...ticketRef.current!, ...revert } as Ticket)
      setErrorFor({ ticketId: current.id, message: 'Could not save your change. Please try again.' })
    } else {
      // Reconcile only the changed fields (+ the DB-refreshed updated_at) onto the latest
      // ticket — never swap in the whole `result.ticket`, which would clobber a
      // concurrent in-flight optimistic edit to a different field.
      const reconciled = pickFields(result.ticket, keys)
      onUpdated({ ...ticketRef.current!, ...reconciled, updated_at: result.ticket.updated_at } as Ticket)
      setErrorFor(null)
    }
  }

  const assigneeValue = ticket.assignee_id === currentUser.id ? currentUser.id : ''
  const initial = assigneeValue ? currentUser.email[0]!.toUpperCase() : null

  return (
    <Dialog open={ticket !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-0 p-0 sm:max-w-3xl"
        onEscapeKeyDown={(e) => {
          // A field is mid-edit: let its own handler cancel just that field (see
          // EditableText.cancel) and keep the dialog open.
          if (editingCount > 0) e.preventDefault()
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
        </DialogHeader>

        <div className="grid gap-x-8 gap-y-6 px-6 py-5 sm:grid-cols-[1fr_240px]">
          {/* Main column: summary + description */}
          <div className="flex min-w-0 flex-col gap-6">
            <EditableText
              value={ticket.summary}
              ariaLabel="summary"
              heading
              onCommit={(v) => commit({ summary: v })}
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
                onChange={(e) => commit({ type: e.target.value as TicketType })}
              >
                {TICKET_TYPES.map((t) => (
                  <option key={t} value={t}>{TICKET_TYPE_LABELS[t]}</option>
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
                onCommit={(v) => commit({ story_points: v.trim() === '' ? null : Number(v) })}
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
      </DialogContent>
    </Dialog>
  )
}
