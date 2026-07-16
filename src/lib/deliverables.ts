/**
 * Narrow an epic's `deliverables` jsonb column to a clean `string[]`.
 *
 * The column is `jsonb not null default '[]'`, so the generated type is `Json` — a value
 * this reads for display and the editor rebuilds on every add/remove/edit. Mirrors
 * `parseLabels`: trims each item and drops blanks. It also defends the untyped jsonb by
 * dropping any non-string element, so a hand-written or legacy row can never inject a
 * number/object into the list the UI renders. A non-array value (the default read as
 * `Json`, null, or junk) yields `[]`. Deliberately a `string[]` and not a structured
 * `{ id, text }` shape: Phase 1 needs only an ordered, editable list (S4.5 AC), and a
 * richer shape is an additive change for the Rung 2 AI decomposition, not a Phase-1 need.
 */
export function parseDeliverables(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}
