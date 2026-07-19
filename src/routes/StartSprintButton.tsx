import { useState } from 'react'

import { startSprint } from '@/lib/sprints'
import type { Sprint } from '@/lib/domain'
import { Button } from '@/components/ui/button'

/**
 * Starts one sprint. Owns the async call, its pending state, and the error message for a
 * single row so `SprintsTab` stays a pure view. The `already_active` case (the partial
 * unique index rejecting a second active sprint) is user-correctable, so it gets a clear,
 * specific message; anything else is the generic retry copy, matching `CreateSprintDialog`.
 *
 * `setPending(false)` runs BEFORE `onStarted`: a successful start flips the sprint out of
 * `future`, so `SprintsTab` stops rendering this button and it unmounts — no state is set
 * on it afterwards.
 */
export function StartSprintButton({
  sprint,
  onStarted,
}: {
  sprint: Sprint
  onStarted: (sprint: Sprint) => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleStart() {
    setPending(true)
    setError(null)
    const result = await startSprint(sprint.id)
    setPending(false)
    if (result.ok) {
      onStarted(result.sprint)
      return
    }
    setError(
      result.error === 'already_active'
        ? 'This project already has an active sprint. Complete it before starting another.'
        : 'Something went wrong. Please try again.',
    )
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button size="sm" variant="outline" onClick={handleStart} disabled={pending}>
        {pending ? 'Starting…' : 'Start'}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive max-w-[16rem] text-right text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}
