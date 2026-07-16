import { Button } from '@/components/ui/button'

/**
 * Shared "could not load this — try again" block. Extracted from the dashed-border failure
 * box `SprintsTab` had before Backlog and Board grew the same failed-read case: three copies
 * is how the third one drifts (different copy, a Retry that silently does nothing, etc).
 * `role="alert"` stays on the message, not the wrapper, so a screen reader announces exactly
 * the sentence a sighted user reads and nothing else in the block gets read out.
 */
export function LoadFailure({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="border-destructive/50 flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed">
      <p role="alert" className="text-destructive text-sm">
        {message}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}
