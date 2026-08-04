import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import type { ProjectStatus } from '@/lib/domain'
import { STATUS_CATEGORIES, STATUS_CATEGORY_LABELS } from '@/lib/domain'
import { createProjectStatus, reorderProjectStatuses } from '@/lib/project-statuses'
import { AddStatusSchema, DUPLICATE_NAME, type AddStatusValues } from '@/lib/status-schemas'
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
import { FormRootError, selectClass, SubmitButton } from './form-primitives'
import { StatusRow } from './StatusRow'

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
              count={counts.get(status.slug)}
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
