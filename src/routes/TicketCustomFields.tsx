import { useState } from 'react'

import type {
  CustomFieldType,
  ProjectField,
  ProjectFieldOption,
  Ticket,
  TicketFieldValue,
} from '@/lib/domain'
import { firstUnready, useTaggedRead, type ReadPhase, type TaggedRead } from '@/lib/project-reads'
import { optionsForField } from '@/lib/project-field-options'
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

/**
 * What a control needs, whatever its type.
 *
 * `options`/`optionsReady` are consumed by `select` alone — the other four entries destructure
 * neither, which costs nothing: TypeScript does not require every property of a parameter's
 * type to be named in the destructuring pattern.
 */
type ControlProps = {
  name: string
  value: string
  onCommit: (raw: string) => void
  /** This field's own options (already filtered from the project's full list), in
   *  `(position, slug)` order. */
  options: readonly ProjectFieldOption[]
  /** Whether `options` is trustworthy — `optionsPhase === 'loaded'`. `false` covers BOTH
   *  `'loading'` and `'failed'` deliberately: an empty list from a failed read and an empty
   *  list from a field with genuinely no options are the same value arriving for opposite
   *  reasons, and only this flag tells them apart. */
  optionsReady: boolean
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
 * **`select` is a real `<select>` (SPRIN-92), populated from the project's `project_field_options`
 * rows for this field.** It carries a blank `—` choice FIRST, always — every custom field is
 * optional in this epic, so the control needs a way to express "no value" the same way an
 * emptied `EditableText` does. Picking it commits `''`, which `parseFieldValue`'s `textDraft`
 * already treats as CLEAR for every string-valued type (`select` included) — see `commit` below,
 * which needs no `select`-specific branch for that reason. The value committed for a real choice
 * is the option's `slug`, never its `label`: `tfv_option_fk` is keyed on the slug, which is what
 * makes renaming a label rewrite no ticket rows.
 *
 * **Disabled whenever `optionsReady` is false**, i.e. whenever `optionsPhase` is not `'loaded'`.
 * An empty options list from a still-loading or failed read and an empty list from a field that
 * genuinely has no options are the same value arriving for opposite reasons — an enabled, empty
 * select would quietly tell the user this field has nothing to choose, which is the S4.6 shape
 * again. A field with no options AND a loaded read renders the blank choice alone, enabled: that
 * is the honest "nothing to pick, but you could clear it" state.
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
  select: ({ name, value, onCommit, options, optionsReady }: ControlProps) => (
    <select
      aria-label={name}
      className={selectClass}
      value={value}
      disabled={!optionsReady}
      onChange={(e) => onCommit(e.target.value)}
    >
      <option value="">—</option>
      {options.map((o) => (
        <option key={o.slug} value={o.slug}>
          {o.label}
        </option>
      ))}
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
  options,
  optionsReady,
  onWritten,
}: {
  ticket: Ticket
  field: ProjectField
  value: TicketFieldValue | undefined
  /** This field's own slice of the project's options — already filtered by `optionsForField`
   *  in `TicketCustomFieldsBody`, so every OTHER control ignores it for free. */
  options: readonly ProjectFieldOption[]
  optionsReady: boolean
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
        options={options}
        optionsReady={optionsReady}
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
  options,
  optionsPhase,
  onRetryFields,
  onRetryValues,
}: {
  ticket: Ticket
  fields: ProjectField[]
  fieldsPhase: ReadPhase
  values: TaggedRead<TicketFieldValue>
  /** The project's FULL options list — across every `select` field it has. Sliced per field
   *  with `optionsForField` in the map below, so each row gets only its own. */
  options: ProjectFieldOption[]
  optionsPhase: ReadPhase
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
          options={optionsForField(options, field.id)}
          optionsReady={optionsPhase === 'loaded'}
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
  options,
  optionsPhase,
  onRetryFields = () => {},
}: {
  ticket: Ticket
  fields?: ProjectField[]
  fieldsPhase?: ReadPhase
  /** REQUIRED (fix round 1), not defaulted to `[]` — unlike `fields` above. A reviewer probe
   *  rendered this component with `optionsPhase="loaded"` and NO `options` prop at all: it
   *  typechecked clean against the old `options = []` default and rendered an ENABLED select
   *  offering only the blank choice, telling the user a `select` field has no options when in
   *  truth none were ever passed in — the exact silent-wrong-answer shape `optionsPhase` itself
   *  was made required to close, and this was the twin hole left open. A dropped `options` wire
   *  is now a COMPILE error at every call site instead. See `optionsPhase`'s own docblock
   *  immediately below for why a required prop with no default costs nothing here: measured,
   *  not assumed. */
  options: ProjectFieldOption[]
  /** Whether `options` is trustworthy (SPRIN-92 task 10, fix round 2). **REQUIRED, not
   *  defaulted — unlike every other read-phase prop in this chain.** Fix round 1 gave it a
   *  `'loading'` default to fail closed, on the reasoning that a required prop would force
   *  `TicketDetailSidebar` (9/10 cyclomatic) and `TicketDetailDialog` (10/10) to stop being
   *  optional-and-undefaulted at this seam, which neither could afford. That reasoning was
   *  never actually measured and turned out to be WRONG: removing the default here dropped
   *  this component from 7 to 6 (a default parameter COSTS a cyclomatic point in this
   *  project's eslint config, so removing one lowers the count), and threading `optionsPhase`
   *  as required through `TicketDetailSidebar` and `TicketDetailDialog` left both UNCHANGED
   *  at 9/10 and 10/10 — only their type annotations lost a `?`, which is not a branch.
   *
   *  The real reason a default existed at all was never the complexity ceiling — it was that
   *  this exact defect class (a prop that can be dropped or crossed with the whole suite
   *  green) had already recurred, and fixing it with tests alone meant trusting every future
   *  editor of three files to keep re-deriving the same discipline. A required prop makes an
   *  unplugged or crossed wire a COMPILE error instead of a passing test suite hiding a
   *  runtime silent-wrong-answer — strictly stronger than any test, and free once measured. */
  optionsPhase: ReadPhase
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
      options={options}
      optionsPhase={optionsPhase}
      onRetryFields={onRetryFields}
      onRetryValues={() => setNonce((n) => n + 1)}
    />
  )
}
