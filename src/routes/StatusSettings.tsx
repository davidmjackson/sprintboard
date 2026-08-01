import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ArrowDown, ArrowUp } from 'lucide-react'

import type { ProjectStatus } from '@/lib/domain'
import { STATUS_CATEGORIES, STATUS_CATEGORY_LABELS } from '@/lib/domain'
import {
  createProjectStatus,
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
  onUpdated,
  onMoveUp,
  onMoveDown,
  reordering,
}: {
  status: ProjectStatus
  onUpdated: (status: ProjectStatus) => void
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
 * **Deleting a status is not here.** It is SPRIN-80, and the database has no DELETE policy for
 * this table — an attempt would match zero rows and return no error, so a delete control would
 * appear to work and silently do nothing.
 */
export function StatusSettings({
  projectId,
  statuses,
  onCreated,
  onUpdated,
  onReordered,
}: {
  projectId: string
  statuses: readonly ProjectStatus[]
  onCreated: (status: ProjectStatus) => void
  onUpdated: (status: ProjectStatus) => void
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
              onUpdated={onUpdated}
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
