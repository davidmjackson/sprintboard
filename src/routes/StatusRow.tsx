import { useState } from 'react'
import { ArrowDown, ArrowUp } from 'lucide-react'

import type { ProjectStatus } from '@/lib/domain'
import { STATUS_CATEGORY_LABELS } from '@/lib/domain'
import {
  deleteBlockReason,
  deleteProjectStatus,
  removeStatus,
  renameProjectStatus,
} from '@/lib/project-statuses'
import { DUPLICATE_NAME, RenameStatusSchema } from '@/lib/status-schemas'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { GENERIC_CREATE_ERROR } from './CreateDialog'
import { EditableText } from './EditableText'
import { StatusWipLimitField } from './StatusWipLimit'

/** The `error` tag `deleteProjectStatus` can resolve with, read off its own return type rather
 *  than re-declared here — `StatusWriteError` is a private alias in `project-statuses.ts`, and
 *  duplicating its literal union would drift the moment a tag is added there. */
type DeleteStatusError = Extract<
  Awaited<ReturnType<typeof deleteProjectStatus>>,
  { ok: false }
>['error']

/**
 * What each `deleteProjectStatus` refusal means in words. A `Record` over the derived union,
 * not a chain of `if`s, so adding a tag there is a compile error here until this is updated.
 *
 * `duplicate` is unreachable in practice — a delete carries no name to collide on, so nothing
 * in `deleteError` can produce it — but the map stays total rather than partial-with-a-fallback,
 * because a partial map is exactly the shape that lets a real, reachable tag go unhandled
 * without the compiler noticing.
 */
const DELETE_FAILURE_COPY: Record<DeleteStatusError, string> = {
  has_tickets:
    'This status still holds tickets. Move them to another status first, then try again.',
  last: 'A project must keep at least one status.',
  stale: 'This status no longer exists — refresh the page to see the current list.',
  duplicate: GENERIC_CREATE_ERROR,
  unknown: GENERIC_CREATE_ERROR,
}

/**
 * One status, with its name editable in place and the two reorder controls.
 *
 * The rename call lives HERE rather than in the parent so a failed rename can say so on the
 * row that failed: with several rows on screen, a page-level banner would not say which name
 * was refused. Reorder is the opposite case and is owned by the parent — it is one write about
 * the whole list, and every row's controls have to be disabled while it is in flight.
 *
 * `onMoveUp`/`onMoveDown` are `undefined` at the ends of the list rather than disabled: a
 * control for a move that does not exist is not a temporarily unavailable control.
 */
export function StatusRow({
  status,
  statuses,
  count,
  hasWipLimits,
  onUpdated,
  onDeleted,
  onMoveUp,
  onMoveDown,
  reordering,
}: {
  status: ProjectStatus
  /** The WHOLE list, not just this row's status — `StatusDeleteControl` needs it to know
   *  whether this is the last status and, if it is the initial one, who gets promoted. */
  statuses: readonly ProjectStatus[]
  /** `undefined` when the caller's count map has no entry for this status — i.e. it does not
   *  know the count, NOT that the count is zero. See `StatusDeleteControl`'s own prop doc. */
  count: number | undefined
  /** Whether this project has WIP limits AT ALL (`hasWipLimits` in domain.ts) — not whether
   *  to show a control. A Scrum project has no such concept, so the field is ABSENT rather
   *  than hidden or disabled, and this prop is named after the question rather than after
   *  the rendering so nobody satisfies it with `hidden`. */
  hasWipLimits: boolean
  onUpdated: (status: ProjectStatus) => void
  onDeleted: (id: string) => void
  onMoveUp?: () => void
  onMoveDown?: () => void
  /** A reorder is in flight somewhere in the list — every row's controls wait for it, because
   *  the write sends the WHOLE order and a second one would race the first. */
  reordering: boolean
}) {
  const [error, setError] = useState<string | null>(null)

  async function rename(next: string) {
    const parsed = RenameStatusSchema.safeParse({ name: next })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? GENERIC_CREATE_ERROR)
      return
    }
    // Cleared BEFORE the no-op check, not after it. Every commit that reaches this function is
    // a fresh attempt, and the previous attempt's message describes none of them — a stale
    // 'that name already exists' survived a no-op commit and went on accusing a name the user
    // had since reverted, about a request that was never sent.
    setError(null)
    // The trim is the schema's, so `'Triage '` on a status called `Triage` is a no-op here as
    // well as in the database. `renameProjectStatus` trims too; this only avoids the request.
    if (parsed.data.name === status.name) return
    const result = await renameProjectStatus(status.id, parsed.data.name)
    if (!result.ok) {
      // No `'stale'` branch, and that is not an omission: a rename sends `name` alone, so it
      // cannot reach `project_statuses_project_position_unique` — the only constraint that
      // produces that tag. If it somehow did, generic retry copy is the honest fallback.
      setError(result.error === 'duplicate' ? DUPLICATE_NAME : GENERIC_CREATE_ERROR)
      return
    }
    onUpdated(result.value)
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <EditableText
          value={status.name}
          ariaLabel={`name of ${status.name}`}
          onCommit={(next) => void rename(next)}
        />
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </div>
      <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
        {STATUS_CATEGORY_LABELS[status.category]}
      </span>
      {hasWipLimits ? <StatusWipLimitField status={status} onUpdated={onUpdated} /> : null}
      <StatusDeleteControl
        status={status}
        statuses={statuses}
        count={count}
        onDeleted={onDeleted}
      />
      <div className="flex shrink-0 gap-1">
        {onMoveUp ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Move ${status.name} up`}
            disabled={reordering}
            onClick={onMoveUp}
          >
            <ArrowUp aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
        {onMoveDown ? (
          <Button
            size="sm"
            variant="outline"
            aria-label={`Move ${status.name} down`}
            disabled={reordering}
            onClick={onMoveDown}
          >
            <ArrowDown aria-hidden="true" className="size-3.5" />
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The destructive confirm for deleting one status — mirrors `TicketDeleteDialog`'s `AlertDialog`
 * shape (`TicketActionDialogs.tsx`): closed while a delete is in flight, Cancel/destructive
 * footer, an inline `role="alert"` for a refusal.
 *
 * Split out of `StatusDeleteControl` so that component, and `StatusRow` above it, both stay
 * under the line/complexity thresholds as this grows.
 */
function StatusDeleteDialog({
  status,
  statuses,
  open,
  onOpenChange,
  onDeleted,
}: {
  status: ProjectStatus
  statuses: readonly ProjectStatus[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: (id: string) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // `removeStatus` is the single source of the promotion rule (mirrors the DB trigger) — this
  // reads its result rather than re-deciding who takes over. Guarded on `status.is_initial`
  // because `removeStatus` returns the survivors' `is_initial` unchanged when the removed
  // status was not the initial one: without the guard the lookup finds the status that is
  // ALREADY initial, and the dialog promises a change of starting status on a delete that
  // does not affect where tickets start.
  const promoted = status.is_initial
    ? removeStatus(statuses, status.id).find((s) => s.is_initial)
    : undefined

  async function submit() {
    setDeleting(true)
    setError(null)
    const result = await deleteProjectStatus(status.id)
    setDeleting(false)
    if (!result.ok) {
      setError(DELETE_FAILURE_COPY[result.error])
      return
    }
    onDeleted(status.id)
  }

  return (
    <AlertDialog
      open={open}
      // The error is cleared on the way OUT, which is what makes the next way IN clean —
      // `StatusRow`'s rename fixed the same class of bug from the other side. This component
      // is NOT unmounted when the dialog closes (only Radix's content is), so without this a
      // cancelled failure is still on screen when the same dialog is reopened, presenting
      // 'This status still holds tickets' as the answer to a request this open never sent.
      // Clearing here rather than on open covers every exit — Cancel, Escape, the overlay —
      // because `open` only ever becomes true through the parent's button, never through here.
      onOpenChange={(next) => {
        if (deleting) return
        setError(null)
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {status.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This can’t be undone.
            {promoted ? ` New tickets will start in ${promoted.name} instead.` : ''}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={deleting}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button variant="destructive" onClick={() => void submit()} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The Delete button plus its always-visible ticket count and, when blocked, the reason —
 * and the confirm dialog above. Split out of `StatusRow` so that function stays under the
 * threshold; this owns the confirm-open state because only one status's dialog is ever open
 * at a time.
 */
function StatusDeleteControl({
  status,
  statuses,
  count,
  onDeleted,
}: {
  status: ProjectStatus
  statuses: readonly ProjectStatus[]
  /** This status's own ticket count, straight from the caller's map with NO `?? 0` — `0` is
   *  the one value that unlocks this control, so a missing entry (the caller never learned the
   *  count) must stay `undefined` all the way to `deleteBlockReason` rather than being
   *  invented here. See that function's docblock for the precedence this feeds. */
  count: number | undefined
  onDeleted: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const reason = deleteBlockReason(count, statuses.length === 1)

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {count === undefined
            ? 'count unavailable'
            : `${count} ${count === 1 ? 'ticket' : 'tickets'}`}
        </span>
        <Button
          size="sm"
          variant="outline"
          aria-label={`Delete ${status.name}`}
          disabled={reason !== null}
          onClick={() => setConfirming(true)}
        >
          Delete
        </Button>
      </div>
      {reason ? <p className="text-muted-foreground text-xs">{reason}</p> : null}
      <StatusDeleteDialog
        status={status}
        statuses={statuses}
        open={confirming}
        onOpenChange={setConfirming}
        onDeleted={onDeleted}
      />
    </div>
  )
}
