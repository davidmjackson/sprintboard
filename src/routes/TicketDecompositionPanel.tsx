import { TICKET_TYPE_LABELS } from '@/lib/domain'
import type { Decomposition } from '@/lib/ticket-decomposition'
import { FieldLabel } from './EditableText'
import { Button } from '@/components/ui/button'

/** The Rung 2 AI decomposition panel (epic only): the "Decompose with AI" trigger, the
 *  proposal list with its traceability signals (coverage summary, gap callout, scope-creep
 *  flag, `delivers` chips), and the accept/discard actions. Rendered by `TicketEpicSection`
 *  beneath the deliverables editor. */
export function TicketDecompositionPanel({
  decomposition,
  items,
}: {
  decomposition: Decomposition
  items: string[]
}) {
  // Proposal indices flagged as not tied to any deliverable (R2.1 scope-creep signal).
  const creepIndices = new Set(decomposition.scopeCreep.map((c) => c.proposal_index))

  return (
    <div className="space-y-2 border-t pt-4">
      <FieldLabel>AI decomposition</FieldLabel>
      {decomposition.proposals === null ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={decomposition.decomposing}
          onClick={() => void decomposition.runDecompose()}
        >
          {decomposition.decomposing ? 'Thinking…' : 'Decompose with AI'}
        </Button>
      ) : (
        <div className="space-y-2">
          {items.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              Covers {Math.max(0, items.length - decomposition.coverageGaps.length)} of{' '}
              {items.length} deliverables
            </p>
          ) : (
            <p className="text-muted-foreground text-xs">No deliverables to trace against.</p>
          )}
          {decomposition.estimateTotal > 0 ? (
            <p className="text-muted-foreground text-xs">
              Estimated total: {decomposition.estimateTotal} pts
            </p>
          ) : null}
          {decomposition.coverageGaps.length > 0 ? (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs">
              <p className="font-medium text-amber-700 dark:text-amber-400">
                Not covered by any proposal
              </p>
              <ul className="mt-1 list-disc pl-4">
                {decomposition.coverageGaps.map((g) => (
                  <li key={g.index}>{g.deliverable}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <ul className="space-y-2">
            {decomposition.proposals.map((p, i) => (
              <li key={i} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={decomposition.selected.has(i)}
                  aria-label={`Include ${p.title} (#${i + 1})`}
                  onChange={(e) => decomposition.toggle(i, e.target.checked)}
                />
                <div className="text-sm">
                  <p className="font-medium">
                    {p.title}{' '}
                    <span className="text-muted-foreground">({TICKET_TYPE_LABELS[p.type]})</span>
                  </p>
                  <p className="text-muted-foreground">{p.description}</p>
                  <p className="text-muted-foreground/80 text-xs italic">{p.rationale}</p>
                  {p.estimate_reason ? (
                    <p className="text-muted-foreground/80 text-xs">{p.estimate_reason}</p>
                  ) : null}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {p.estimate != null ? (
                      <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-medium">
                        {p.estimate} pts
                      </span>
                    ) : null}
                    {creepIndices.has(i) ? (
                      <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                        Not tied to a deliverable
                      </span>
                    ) : (
                      p.covers
                        .filter((idx) => items[idx] !== undefined)
                        .map((idx) => (
                          <span
                            key={idx}
                            className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px]"
                          >
                            {items[idx]}
                          </span>
                        ))
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={decomposition.accepting || decomposition.selected.size === 0}
              onClick={() => void decomposition.acceptSelected()}
            >
              {decomposition.accepting
                ? 'Adding…'
                : `Add ${decomposition.selected.size} to backlog`}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={decomposition.accepting}
              onClick={decomposition.reset}
            >
              Discard
            </Button>
          </div>
        </div>
      )}
      {decomposition.aiError ? (
        <p role="alert" className="text-destructive text-sm">
          {decomposition.aiError}
        </p>
      ) : null}
    </div>
  )
}
