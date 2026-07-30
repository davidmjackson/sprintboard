import { formatSprintDate } from '@/lib/sprint-dates'
import type { Sprint } from '@/lib/domain'

/**
 * A sprint's date range, or an honest "No dates set" when it has neither.
 *
 * Both dates are nullable `timestamptz` columns holding calendar days, and
 * `formatSprintDate` slices the ISO string in UTC on purpose — formatting in a local zone
 * west of UTC renders midnight-UTC as the PREVIOUS day. Do not reformat with `Intl` here.
 *
 * Lifted out of `SprintsTab` by SPRIN-65 when the board grew a sprint caption that needs
 * the same three rules. Two copies would have meant two places for a timezone decision
 * that took a whole spec to get right.
 */
export function SprintDates({ sprint }: { sprint: Sprint }) {
  if (!sprint.start_date && !sprint.end_date) {
    return <span className="text-muted-foreground text-xs">No dates set</span>
  }
  const start = sprint.start_date ? formatSprintDate(sprint.start_date) : '—'
  const end = sprint.end_date ? formatSprintDate(sprint.end_date) : '—'
  return (
    <span className="text-muted-foreground font-mono text-xs tabular-nums">
      {start} – {end}
    </span>
  )
}
