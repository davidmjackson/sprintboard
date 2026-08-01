import { useState } from 'react'

import { completeSprint } from '@/lib/sprints'
import type { Sprint, Ticket } from '@/lib/domain'
import { Button } from '@/components/ui/button'

/**
 * Completes one active sprint. Owns the async call, its pending state, and the error message
 * for a single row so `SprintsTab` stays a pure view. Completing has one user-correctable
 * failure — `stale`, meaning the sprint left `active` under a view this row was rendered
 * from — so it gets its own message telling the user to refresh. Everything else is the
 * generic retry copy.
 *
 * On success it hands up BOTH the completed sprint and the tickets that returned to the
 * backlog, so the shell can patch the sprint row and the ticket list in one update.
 *
 * A `stale` result surfaces its message only — it does NOT trigger the shell's refetch. That
 * was tried (threading an `onRetry` prop down and calling it on `stale`) and reverted: the
 * refetch bumps the shell's read nonce, `useTaggedRead` drops the in-flight result, and
 * `SprintsTab` renders `sprints.length === 0` on the very next commit — unmounting this button,
 * and the alert with it, before the user can read it. The message and an auto-refetch are
 * mutually exclusive without a notice that outlives the row, and that notice is a UI feature
 * with its own AC, not a fix to bolt on here. Until it exists, a stale row (and its ticket
 * count) is stale until the user manually refreshes — cosmetic, never corrupting, and the
 * message says so.
 */
export function CompleteSprintButton({
  sprint,
  terminalSlugs,
  onCompleted,
}: {
  sprint: Sprint
  /** The project's terminal statuses, by slug — `doneSlugs(statuses)`, derived once by
   *  `SprintsTab`. Passed straight through: this button never decides what "complete" means,
   *  and an EMPTY set is a legitimate project state (nothing terminal), not a missing prop. */
  terminalSlugs: ReadonlySet<string>
  onCompleted: (sprint: Sprint, returnedTickets: Ticket[]) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleComplete() {
    setPending(true)
    setError(null)
    const result = await completeSprint(sprint.id, terminalSlugs)
    setPending(false)
    if (result.ok) {
      onCompleted(result.sprint, result.returnedTickets)
      return
    }
    // A two-branch ternary, deliberately, unlike Start's exhaustiveness-checked
    // `START_ERRORS` record: `CompleteSprintResult` only ever has two error tags today. That
    // also means this is NOT compiler-checked the way Start's is — a future third tag on
    // `CompleteSprintResult` would compile silently and fall through to the generic message
    // below rather than raising a TS7053. If a third tag is ever added here, revisit this.
    setError(
      result.error === 'stale'
        ? 'This sprint is no longer active. Refresh to see its current state.'
        : 'Something went wrong. Please try again.',
    )
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={handleComplete} disabled={pending}>
        {pending ? 'Completing…' : 'Complete'}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive max-w-[16rem] text-right text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}
