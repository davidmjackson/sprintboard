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
 * A `stale` result also calls `onRetry` — the shell's `onRetry`, threaded down as a prop —
 * so the row self-corrects instead of dead-ending: without it, the badge would keep reading
 * `active`, the button would keep offering a complete the guard will keep refusing, and the
 * ticket count would keep counting a ticket the database already returned to the backlog. The
 * error message is set FIRST, for the same unmount reason `StartSprintButton` documents: a
 * successful refetch can change this sprint's status and unmount the button, so nothing may
 * be set on it after `onRetry` runs.
 */
export function CompleteSprintButton({
  sprint,
  onCompleted,
  onRetry,
}: {
  sprint: Sprint
  onCompleted: (sprint: Sprint, returnedTickets: Ticket[]) => void
  onRetry: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleComplete() {
    setPending(true)
    setError(null)
    const result = await completeSprint(sprint.id)
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
    if (result.error === 'stale') onRetry()
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
