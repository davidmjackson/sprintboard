import { useState } from 'react'

import type { CustomFieldType, ProjectField, Ticket, TicketFieldValue } from '@/lib/domain'
import { firstUnready, useTaggedRead, type ReadPhase, type TaggedRead } from '@/lib/project-reads'
import {
  applyValueWrite,
  clearTicketFieldValue,
  fieldValueText,
  listTicketFieldValues,
  parseFieldValue,
  setTicketFieldValue,
  type FieldValueWrite,
} from '@/lib/ticket-field-values'
import { EditableText, FieldLabel } from './EditableText'
import { LoadFailure } from './LoadFailure'
import { selectClass } from './form-primitives'

/** What a control needs, whatever its type. */
type ControlProps = {
  name: string
  value: string
  onCommit: (raw: string) => void
}

/**
 * The renderer, as a MAP KEYED BY TYPE — never an if/else chain.
 *
 * This story's Jira issue marks it CRITICAL and the reason is the lint budget: a map entry
 * costs no cyclomatic point where an `if`/`else` chain costs one per branch, and neither
 * `TicketDetailSidebar` (9 of 10) nor `TicketDetailDialog` (10 of 10) could pay. Typed
 * `Record<CustomFieldType, …>`, a sixth field type is a COMPILE error here rather than a field
 * that silently renders nothing.
 *
 * Four types reuse the sidebar's own controls, so a custom field looks like a built-in one —
 * `EditableText` is the click-to-edit motif every other field in the dialog uses.
 *
 * **`select` renders a DISABLED control rather than nothing, and that is AC1.** Select fields
 * are creatable TODAY: SPRIN-91's add form offers all five types from `CUSTOM_FIELD_TYPES`, so
 * rendering nothing for one would be a field a user created and then could not find. It is
 * disabled because `project_field_options` does not exist until story 5 — until `tfv_option_fk`
 * lands, `value_option` would accept any string at all, and a free-text editor would strand
 * values that the option fk then refuses. Disabled is the honest state, not a placeholder.
 *
 * **`number` passes no `min`.** It used to get one for free: `EditableText`'s numeric mode
 * hardcoded `min={0}`, which is the ESTIMATION rule and a property of story points rather than
 * of arithmetic. A custom number field is a plain `numeric` column — a temperature, a variance,
 * a balance — so this story moved that bound to the story-points call site that owns it.
 */
const CONTROLS = {
  text: ({ name, value, onCommit }: ControlProps) => (
    <EditableText value={value} ariaLabel={name} placeholder="—" onCommit={onCommit} />
  ),
  paragraph: ({ name, value, onCommit }: ControlProps) => (
    <EditableText value={value} ariaLabel={name} multiline placeholder="—" onCommit={onCommit} />
  ),
  number: ({ name, value, onCommit }: ControlProps) => (
    <EditableText value={value} ariaLabel={name} numeric placeholder="—" onCommit={onCommit} />
  ),
  date: ({ name, value, onCommit }: ControlProps) => (
    <input
      type="date"
      aria-label={name}
      className={selectClass}
      value={value}
      onChange={(e) => onCommit(e.target.value)}
    />
  ),
  select: ({ name, value }: ControlProps) => (
    <select aria-label={name} className={selectClass} value={value} disabled>
      <option value={value}>{value || '—'}</option>
    </select>
  ),
} as const satisfies Record<CustomFieldType, (props: ControlProps) => React.ReactElement>

/**
 * What each write failure tells the user. `'stale'` is the foreign-key violation — the
 * definition this value points at is gone, so retrying the same write reproduces it forever
 * and reloading is the only remedy, which is what `'stale'` means everywhere in this codebase.
 */
const WRITE_MESSAGE = {
  stale: 'That field changed elsewhere — reload to see it.',
  unknown: 'Could not save that. Try again.',
} as const

/**
 * One custom field's label, control and error region.
 *
 * **The error is owned HERE, per field, not by the dialog.** `TicketDetailSidebar` already has
 * `setError(ticketId, message)`, which paints one banner for the whole modal — with several
 * custom fields on screen that banner cannot say WHICH one was refused. `StatusRow` and
 * `CustomFieldRow` (settings) both record the identical argument for owning their own
 * `role="alert"`.
 */
function TicketCustomFieldRow({
  ticket,
  field,
  value,
  onWritten,
}: {
  ticket: Ticket
  field: ProjectField
  value: TicketFieldValue | undefined
  onWritten: (fieldId: string, write: FieldValueWrite | null) => void
}) {
  const [error, setError] = useState<string | null>(null)

  // Bound to a capitalised local and rendered as JSX rather than invoked as
  // `CONTROLS[field.type]({…})`. A call through a computed member is forbidden anywhere under
  // `src/` by `project-type-immutability.test.ts` check 1 — see the matching note in
  // `parseFieldValue`. As an element there is no call expression at all, which is also the
  // idiomatic React spelling. `field.type` never changes for a given field, so this cannot
  // remount the control underneath the user.
  const Control = CONTROLS[field.type]

  async function commit(raw: string) {
    const draft = parseFieldValue(field.type, raw)
    if (!draft.ok) {
      setError(draft.message)
      return
    }
    const result =
      draft.write === null
        ? await clearTicketFieldValue(ticket.id, field.id)
        : await setTicketFieldValue({
            ticketId: ticket.id,
            // From the TICKET, never from the field definition. `tfv_ticket_fk` and
            // `tfv_field_fk` are both composite on `project_id`, so a row whose project
            // disagreed with either would be rejected — taking it from the ticket is what
            // makes the row's tenancy the ticket's tenancy.
            projectId: ticket.project_id,
            fieldId: field.id,
            ...draft.write,
          })

    if (!result.ok) {
      setError(WRITE_MESSAGE[result.error])
      return
    }
    setError(null)
    onWritten(field.id, draft.write)
  }

  return (
    <label className="flex flex-col gap-1">
      <FieldLabel>{field.name}</FieldLabel>
      <Control
        name={field.name}
        value={fieldValueText(value)}
        onCommit={(raw) => void commit(raw)}
      />
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </label>
  )
}

/**
 * Failure, then loading, then the controls — in `firstUnready`'s order.
 *
 * Split from the component below purely for the lint budget: the hook call, the three
 * destructuring defaults and this decision together exceed T2, and the defaults have to live
 * with the hook.
 *
 * **THE RETRY GOES TO WHICHEVER READ FAILED.** The values read is local and a nonce bump
 * refetches it; the DEFINITIONS read belongs to the shell and no local state can touch it, so
 * a Retry wired to the nonce would render, be clicked, and do nothing — the "Retry that
 * silently does nothing" `LoadFailure`'s own docblock warns about. Note this is the one place
 * reusing the shell's `onRetry` is right: it reloads four project reads, which is wasteful to
 * fix one ticket's values but is exactly the read that failed here.
 *
 * The empty case is checked BEFORE the phases, and that ordering is AC6. A project with no
 * custom fields must render the sidebar exactly as it does today — so once the definitions are
 * known to be empty, this section renders nothing at all rather than a "Loading…" line for
 * values it will never need.
 */
function TicketCustomFieldsBody({
  ticket,
  fields,
  fieldsPhase,
  values,
  onRetryFields,
  onRetryValues,
}: {
  ticket: Ticket
  fields: ProjectField[]
  fieldsPhase: ReadPhase
  values: TaggedRead<TicketFieldValue>
  onRetryFields: () => void
  onRetryValues: () => void
}) {
  const unready = firstUnready([
    { resource: 'custom fields' as const, phase: fieldsPhase },
    { resource: 'custom field values' as const, phase: values.phase },
  ])

  if (fieldsPhase === 'loaded' && fields.length === 0) return null

  if (unready?.phase === 'failed') {
    return (
      <LoadFailure
        resource={unready.resource}
        onRetry={unready.resource === 'custom fields' ? onRetryFields : onRetryValues}
      />
    )
  }

  // Controls are NOT rendered while loading, and that is the point rather than a nicety. An
  // empty control says, in the only language a control has, "this ticket has no value for this
  // field" — and it is writable, so one keystroke overwrites real stored data with a blank the
  // user was shown by mistake. S4.6's defect wearing a new face.
  if (unready) return <p className="text-muted-foreground text-sm">Loading…</p>

  return (
    <>
      {fields.map((field) => (
        <TicketCustomFieldRow
          key={field.id}
          ticket={ticket}
          field={field}
          // Looked up by `field_id`, never by position. The values list is a lookup table and
          // `applyValueWrite` does not preserve its order.
          value={values.items.find((v) => v.field_id === field.id)}
          onWritten={(fieldId, write) =>
            values.patch(ticket.id, (items) =>
              applyValueWrite(
                items,
                { ticketId: ticket.id, projectId: ticket.project_id, fieldId },
                write,
              ),
            )
          }
        />
      ))}
    </>
  )
}

/**
 * The project's custom fields, with this ticket's values, on the detail sidebar (SPRIN-88).
 *
 * **Rendered UNCONDITIONALLY by the sidebar**, which is what keeps this story inside the lint
 * budget: a conditional in `TicketDetailSidebar` (9 of 10 cyclomatic) or `TicketDetailDialog`
 * (10 of 10) was not affordable, so the "should anything show at all?" question is answered
 * here, where there is headroom. That is the same division `TicketSprintField` uses for
 * `hasSprints`.
 *
 * **This component owns the prop DEFAULTS for the same reason.** A destructuring default costs
 * a cyclomatic point, and the dialog has none left — so `fields` and `fieldsPhase` are
 * forwarded through the dialog and the sidebar with no defaults at either stop, and land here.
 *
 * `fieldsPhase` defaults to `'loaded'` rather than to `'loading'`, which is the opposite of
 * `sprintsPhase`'s default and deliberately so. That default exists to describe a dialog
 * rendered WITHOUT field wiring — standalone, or in a test — and the honest answer there is
 * "this ticket has no custom fields", which renders nothing. The reason `sprintsPhase` defaults
 * to `'loading'` is that an enabled picker over an empty list could silently MOVE a ticket;
 * there is no equivalent hazard here, because the empty case renders no control at all. A
 * `'loading'` default would instead leave an unwired dialog showing a "Loading…" line that
 * never resolves.
 *
 * **Values are read PER TICKET.** The dialog is keyed `key={selected?.id ?? 'none'}` in
 * `ProjectShell`, so it remounts per ticket and this read has a natural lifecycle — no
 * invalidation logic, and no risk of the previous ticket's values flashing under the new
 * ticket's fields. The read is skipped entirely when the project has no custom fields, which
 * is the common case: `useTaggedRead` already treats an `undefined` scope as "nothing to
 * fetch", the same way the shell passes `undefined` before a project is chosen.
 */
export function TicketCustomFields({
  ticket,
  fields = [],
  fieldsPhase = 'loaded',
  onRetryFields = () => {},
}: {
  ticket: Ticket
  fields?: ProjectField[]
  fieldsPhase?: ReadPhase
  /** The SHELL's retry. Only reachable when the definitions read failed — see the body. */
  onRetryFields?: () => void
}) {
  const [nonce, setNonce] = useState(0)
  const values = useTaggedRead(
    fields.length > 0 ? ticket.id : undefined,
    nonce,
    listTicketFieldValues,
  )

  return (
    <TicketCustomFieldsBody
      ticket={ticket}
      fields={fields}
      fieldsPhase={fieldsPhase}
      values={values}
      onRetryFields={onRetryFields}
      onRetryValues={() => setNonce((n) => n + 1)}
    />
  )
}
