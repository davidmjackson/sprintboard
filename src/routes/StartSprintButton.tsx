import { useState } from 'react'

import { startSprint } from '@/lib/sprints'
import type { Sprint } from '@/lib/domain'
import { Button } from '@/components/ui/button'

const START_ERRORS: Record<'already_active' | 'stale' | 'unknown', string> = {
  already_active: 'This project already has an active sprint. Complete it before starting another.',
  stale: 'This sprint is no longer waiting to start. Refresh to see its current state.',
  unknown: 'Something went wrong. Please try again.',
}

/**
 * Starts one sprint. Owns the async call, its pending state, and the error message for a
 * single row so `SprintsTab` stays a pure view. Two of the three failure tags are
 * user-correctable and get their own specific message: `already_active` (the partial unique
 * index rejecting a second active sprint) and `stale` (the view is out of date). `unknown` is
 * the only one that falls back to the generic retry copy, matching `CreateSprintDialog`.
 *
 * `setPending(false)` runs BEFORE `onStarted`: a successful start flips the sprint out of
 * `future`, so `SprintsTab` stops rendering this button and it unmounts — no state is set
 * on it afterwards.
 *
 * A `stale` result surfaces its message only — it does NOT trigger the shell's refetch. That
 * was tried (threading an `onRetry` prop down and calling it on `stale`) and reverted: the
 * refetch bumps the shell's read nonce, `useTaggedRead` drops the in-flight result, and
 * `SprintsTab` renders `sprints.length === 0` on the very next commit — unmounting this button,
 * and the alert with it, before the user can read it. The message and an auto-refetch are
 * mutually exclusive without a notice that outlives the row, and that notice is a UI feature
 * with its own AC, not a fix to bolt on here. Until it exists, a stale row is stale until the
 * user manually refreshes — cosmetic, never corrupting, and the message says so.
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
    setError(START_ERRORS[result.error])
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
