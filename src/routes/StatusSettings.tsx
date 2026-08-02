import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowDown, ArrowUp } from 'lucide-react'

import type { ProjectStatus } from '@/lib/domain'
import { STATUS_CATEGORIES, STATUS_CATEGORY_LABELS } from '@/lib/domain'
import {
  createProjectStatus,
  deleteBlockReason,
  deleteProjectStatus,
  removeStatus,
  renameProjectStatus,
  reorderProjectStatuses,
} from '@/lib/project-statuses'
import { AddStatusSchema, RenameStatusSchema, type AddStatusValues } from '@/lib/status-schemas'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
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
import { FormRootError, selectClass, SubmitButton } from './form-primitives'

/**
 * What a `'duplicate'` write result means in words. One constant for both the add form and a
 * row's rename, because they are the same conflict — `project_statuses_project_name_unique` is
 * case-insensitive and per project — and two copies of this sentence would drift.
 */
const DUPLICATE_NAME = 'A status with that name already exists in this project.'

/**
 * What a `'stale'` write result means in words, and why it is not the generic retry copy.
 *
 * A position collision happens when this tab's list of statuses is older than the database's —
 * another tab (or another window) added a status, so `max(position)+1` computed here is a
 * position that is already taken. Retrying the same submit reproduces it exactly, forever;
 * reloading is the only thing that fixes it, so that is what the sentence has to say. Reported
 * at FORM level rather than on the name field: the name was never the problem, and a message
 * under an input invites the user to edit the one thing that cannot help.
 */
const STALE_LIST =
  'This list of statuses is out of date — refresh the page and try adding it again.'

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
  has_tickets: 'This status still holds tickets. Move them to another status first, then try again.',
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
function StatusRow({
  status,
  statuses,
  count,
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
  count: number
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
  // reads its result rather than re-deciding who takes over.
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
      onOpenChange={(next) => {
        if (!deleting) onOpenChange(next)
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
  /** This status's own ticket count — `0` when the caller's count map has no entry, which is
   *  what "no tickets yet" looks like on a freshly seeded or freshly created status. */
  count: number
  onDeleted: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const reason = deleteBlockReason(count, statuses.length === 1)

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs">
          {count} {count === 1 ? 'ticket' : 'tickets'}
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

/**
 * Add a status to the project. An inline form rather than a `CreateDialog`: the settings tab
 * has nothing else on it, so a dialog would add a click and a focus trap to reach a two-field
 * form on an otherwise empty page.
 *
 * It deliberately does NOT take `CreateDialog`'s generation-guarded `setError`/`close` (SPRIN-51).
 * That guard exists because a dialog can be closed and reopened while its submit is in flight,
 * resetting a *new* draft with a *stale* continuation. This form is always mounted and has no
 * open state to race, so there is no generation to compare.
 *
 * A `'duplicate'` result goes on the NAME FIELD (AC4), not into `FormRootError`: it is a
 * user-correctable fact about one input, and a banner would make the user work out which.
 * Everything else is not correctable by editing anything, so it takes the shared generic copy.
 */
function AddStatusForm({
  projectId,
  existing,
  onCreated,
}: {
  projectId: string
  existing: readonly ProjectStatus[]
  onCreated: (status: ProjectStatus) => void
}) {
  const form = useForm<AddStatusValues>({
    resolver: zodResolver(AddStatusSchema),
    // From the shared constant, never the literal `'todo'` — CLAUDE.md: a category value is
    // named in `domain.ts` and nowhere else.
    defaultValues: { name: '', category: STATUS_CATEGORIES[0] },
  })

  async function onSubmit(values: AddStatusValues) {
    const parsed = AddStatusSchema.parse(values)
    const result = await createProjectStatus({
      projectId,
      name: parsed.name,
      category: parsed.category,
      // The rows the write derives BOTH a collision-free slug and `max(position)+1` from.
      existing,
    })

    if (!result.ok) {
      if (result.error === 'duplicate') {
        form.setError('name', { message: DUPLICATE_NAME })
        return
      }
      form.setError('root', {
        message: result.error === 'stale' ? STALE_LIST : GENERIC_CREATE_ERROR,
      })
      return
    }

    onCreated(result.value)
    form.reset()
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-wrap items-start gap-3"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem className="min-w-48 flex-1">
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Blocked" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="category"
          render={({ field }) => (
            <FormItem className="w-40">
              <FormLabel>Category</FormLabel>
              <FormControl>
                <select className={selectClass} {...field}>
                  {STATUS_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {STATUS_CATEGORY_LABELS[category]}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <SubmitButton label="Add status" pendingLabel="Adding…" className="mt-6" />
        <div className="w-full">
          <FormRootError />
        </div>
      </form>
    </Form>
  )
}

/**
 * The project's statuses: what its board columns ARE, in the order they appear on the board.
 *
 * The list itself is the shell's — every write hands its result up through `onCreated` /
 * `onUpdated` / `onReordered` so the shell patches the one copy the board, the backlog and the
 * ticket dialog all read (AC1: a new status becomes a column with no reload). This component
 * never keeps a second copy to mutate, which is why a failed write leaves the rendered order
 * exactly as it was without any rollback code.
 *
 * **Reorder is buttons, not drag, and that is a decision rather than an omission.** jsdom has
 * no `dataTransfer`, so a Vitest test of a drag asserts the wiring and never the gesture; the
 * only real coverage would be Playwright, which CLAUDE.md is explicit is NOT the gate here.
 * Buttons are testable in the gate and keyboard-operable without an ARIA drag pattern.
 *
 * **Deleting a status** (SPRIN-80) is owned by `StatusRow`/`StatusDeleteControl`, for the same
 * reason rename is: the refusal reasons (holds tickets, is the last status) are per-row facts,
 * so a row states its own rather than a page-level banner making the user work out which one it
 * meant. `counts` is supplied by the caller rather than fetched here, because AC2 needs the
 * count to gate the button BEFORE any delete is attempted, and this component has no project id
 * to read `tickets` with beyond the one it is already handed for `AddStatusForm`.
 */
export function StatusSettings({
  projectId,
  statuses,
  counts,
  onCreated,
  onUpdated,
  onDeleted,
  onReordered,
}: {
  projectId: string
  statuses: readonly ProjectStatus[]
  /** Ticket counts by status SLUG (matching `ticketCountsByStatus`'s own keying), used to gate
   *  and explain each row's Delete control before any write is attempted. */
  counts: ReadonlyMap<string, number>
  onCreated: (status: ProjectStatus) => void
  onUpdated: (status: ProjectStatus) => void
  onDeleted: (id: string) => void
  onReordered: (statuses: ProjectStatus[]) => void
}) {
  const [reordering, setReordering] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /**
   * Move one status `delta` places and persist the WHOLE resulting order.
   *
   * The complete list is not a nicety: `reorder_project_statuses` assigns positions from the
   * array's ordinality, so a partial list leaves the omitted rows on their old positions and
   * can collide with the new ones on `project_statuses_project_position_unique` at commit.
   */
  async function move(status: ProjectStatus, delta: number) {
    const rest = statuses.filter((s) => s !== status)
    rest.splice(statuses.indexOf(status) + delta, 0, status)
    setReordering(true)
    setError(null)
    const result = await reorderProjectStatuses(
      projectId,
      rest.map((s) => s.slug),
    )
    setReordering(false)
    if (!result.ok) {
      setError(GENERIC_CREATE_ERROR)
      return
    }
    onReordered(result.value)
  }

  return (
    <section className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-sm font-medium">Statuses</h2>
        <p className="text-muted-foreground text-sm">
          These are this project&rsquo;s board columns, left to right.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      {statuses.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {statuses.map((status, index) => (
            <StatusRow
              key={status.id}
              status={status}
              statuses={statuses}
              count={counts.get(status.slug) ?? 0}
              onUpdated={onUpdated}
              onDeleted={onDeleted}
              onMoveUp={index > 0 ? () => void move(status, -1) : undefined}
              onMoveDown={index < statuses.length - 1 ? () => void move(status, 1) : undefined}
              reordering={reordering}
            />
          ))}
        </ul>
      ) : (
        <div className="flex min-h-24 items-center justify-center rounded-lg border border-dashed">
          <p className="text-muted-foreground text-sm">
            This project has no statuses, so its board has no columns.
          </p>
        </div>
      )}

      <AddStatusForm projectId={projectId} existing={statuses} onCreated={onCreated} />
    </section>
  )
}
