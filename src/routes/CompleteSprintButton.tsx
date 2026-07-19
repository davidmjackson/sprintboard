import { useState } from 'react'

import { completeSprint } from '@/lib/sprints'
import type { Sprint, Ticket } from '@/lib/domain'
import { Button } from '@/components/ui/button'

/**
 * Completes one active sprint. Owns the async call, its pending state, and the error message
 * for a single row so `SprintsTab` stays a pure view. Completing has no user-correctable
 * failure (unlike Start's `already_active`), so there is a single generic message.
 *
 * On success it hands up BOTH the completed sprint and the tickets that returned to the
 * backlog, so the shell can patch the sprint row and the ticket list in one update.
 */
export function CompleteSprintButton({
  sprint,
  onCompleted,
}: {
  sprint: Sprint
  onCompleted: (sprint: Sprint, returnedTickets: Ticket[]) => void
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
    setError('Something went wrong. Please try again.')
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
