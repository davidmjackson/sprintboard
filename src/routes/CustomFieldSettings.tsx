import { CUSTOM_FIELD_TYPE_LABELS, type ProjectField } from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import { LoadFailure } from './LoadFailure'

/**
 * The project's custom field definitions, listed read-only (SPRIN-90, epic SPRIN-71).
 *
 * Story 1 of the epic is the database half plus this read surface — deliberately no add,
 * rename or delete, which are stories 2 and 6. The migration grants UPDATE on `name` alone
 * and no INSERT or DELETE at all, so there is nothing here that could write even if a
 * control were added by mistake.
 *
 * **The phase is consulted before the list, and here that is not a formality.** Every other
 * surface in this app treats "empty" as a rare state; for custom fields it is the DEFAULT —
 * every project starts with zero and nothing seeds them. So `[]` from a failed read and `[]`
 * from a project that simply has no custom fields are the same value arriving for opposite
 * reasons, and rendering the empty state over a failure would be a confident claim about a
 * list we do not have. That is S4.6's defect, and this is the surface where it is easiest to
 * ship.
 *
 * Structured as `<dl>` rather than a table: each row is a name and its type, which is a
 * description list, and it keeps the accessible name of each entry to a single text node —
 * relevant because this codebase has already spent a story on names fused by flex layout
 * under jsdom.
 */
export function CustomFieldSettings({
  fields,
  phase,
  onRetry,
}: {
  fields: readonly ProjectField[]
  phase: ReadPhase
  onRetry: () => void
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="custom-fields-heading">
      <div className="flex flex-col gap-1">
        <h2 id="custom-fields-heading" className="text-sm font-semibold">
          Custom fields
        </h2>
        <p className="text-muted-foreground text-xs">
          Extra fields on this project&rsquo;s tickets, beyond the built-in ones.
        </p>
      </div>

      <CustomFieldList fields={fields} phase={phase} onRetry={onRetry} />
    </section>
  )
}

/**
 * The list body, split out so `CustomFieldSettings` stays a plain wrapper and this holds the
 * whole phase decision in one place. Three outcomes, in the order the project's other tabs
 * use: failure first, then loading, then the list (which may legitimately be empty).
 *
 * Failure BEFORE loading, matching `firstUnready`'s rule — an already-known failure must not
 * be masked by a spinner, because nothing retries a `loading` phase on its own.
 */
function CustomFieldList({
  fields,
  phase,
  onRetry,
}: {
  fields: readonly ProjectField[]
  phase: ReadPhase
  onRetry: () => void
}) {
  if (phase === 'failed') return <LoadFailure resource="custom fields" onRetry={onRetry} />
  if (phase !== 'loaded') return <p className="text-muted-foreground text-sm">Loading…</p>

  if (fields.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
        No custom fields yet.
      </p>
    )
  }

  return (
    <dl className="divide-border divide-y rounded-lg border">
      {fields.map((field) => (
        <div key={field.id} className="flex items-baseline justify-between gap-3 p-3">
          <dt className="text-sm font-medium">{field.name}</dt>
          <dd className="text-muted-foreground text-xs">{CUSTOM_FIELD_TYPE_LABELS[field.type]}</dd>
        </div>
      ))}
    </dl>
  )
}
