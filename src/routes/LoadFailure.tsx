import { Button } from '@/components/ui/button'

/**
 * Which project read failed. A CLOSED union, and deliberately so — see the docblock on
 * `LoadFailure` below for why widening it to `string` would dissolve a security control.
 * Named and exported so callers (and `firstUnready`'s `R`) can refer to the same list
 * rather than restating it.
 */
export type LoadFailureResource = 'tickets' | 'sprints' | 'statuses'

/** The failure copy, keyed by resource. Lives here rather than in `domain.ts`: that module is
 *  the single home for status/type/column display names, which Rung 3 makes dynamic — this is
 *  failure copy owned by the component that renders it, and putting it there would dilute the
 *  rule. Kept above the docblock below so that block anchors to `LoadFailure`, which it
 *  describes. */
const FAILURE_COPY: Record<LoadFailureResource, string> = {
  tickets: 'Could not load tickets.',
  sprints: 'Could not load sprints.',
  statuses: 'Could not load statuses.',
}

/**
 * Shared "could not load this — try again" block. Extracted from the dashed-border failure
 * box `SprintsTab` had before Backlog and Board grew the same failed-read case: three copies
 * is how the third one drifts (different copy, a Retry that silently does nothing, etc).
 * `role="alert"` stays on the message, not the wrapper, so a screen reader announces exactly
 * the sentence a sighted user reads and nothing else in the block gets read out.
 *
 * It takes a `resource`, NOT a message string, and owns the copy itself. Do not "make it
 * flexible" by widening this back to `message: string` — the closed union is a security
 * control, and a deliberate one. `listTickets`/`listSprints`/`listProjectStatuses` reject with
 * `Could not load tickets: ${error.message}` — a raw PostgREST string that can name columns,
 * policies or schema internals. With an open string channel, `<LoadFailure message={err.message} />`
 * would render that verbatim into `role="alert"` and COMPILE CLEAN; the only thing standing
 * between us and that today is that all three call sites happen to pass literals. A closed
 * discriminant makes the wrong call untypeable rather than merely discouraged — the same move
 * as `SprintCreateInsert = Omit<SprintInsert, 'status'>` and
 * `TicketInsert = Omit<TablesInsert<'tickets'>, 'key' | 'number'>` elsewhere in this codebase.
 * Adding a resource means adding a case to `FAILURE_COPY`, which is exactly the review moment
 * we want — `'statuses'` was added that way in SPRIN-76.
 *
 * `BoardTab` now reaches this component through `firstUnready`, which is generic in `R` for
 * this reason: `R` infers `LoadFailureResource` from the board's own literal array and flows
 * in unwidened. Typing that helper's `resource` to `string` would compile clean on its own and
 * silently reopen the channel — so it is `BoardTab`'s call site, not the helper, that makes
 * this control real.
 */
export function LoadFailure({
  resource,
  onRetry,
}: {
  resource: LoadFailureResource
  onRetry: () => void
}) {
  return (
    <div className="border-destructive/50 flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed">
      <p role="alert" className="text-destructive text-sm">
        {FAILURE_COPY[resource]}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  )
}
