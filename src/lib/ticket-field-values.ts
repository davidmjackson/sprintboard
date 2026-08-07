import { supabase } from './supabase'
import { isCustomFieldType, type CustomFieldType, type TicketFieldValue } from './domain'
import type { Tables } from './database.types'

/**
 * The columns `listTicketFieldValues` reads, NAMED — not a bare `.select()`.
 *
 * Same rule, same reason, as `FIELD_COLUMNS` in `project-fields.ts`: SPRIN-86 turned a no-arg
 * select plus an unchecked cast into a user-visible defect, because narrowing the select left
 * the whole suite green while the UI rendered nonsense. It is a CLASS of bug that every
 * first-reader of a column inherits, and this module is the first reader of all eight.
 */
const VALUE_COLUMNS =
  'ticket_id, project_id, field_id, field_type, value_text, value_number, value_date, value_option'

/** The four columns a value can live in. */
export type ValueColumn = 'value_text' | 'value_number' | 'value_date' | 'value_option'

/**
 * Which column stores a value of each type — the client-side half of
 * `tfv_one_value_matching_type`.
 *
 * `text` and `paragraph` share `value_text` deliberately: they differ in how they RENDER (an
 * input versus a textarea), never in how they store. The check constraint pairs them the same
 * way, so giving `paragraph` its own column here would pass every unit test in this repo and
 * earn a 23514 against the live database.
 *
 * `satisfies Record<CustomFieldType, ValueColumn>` is what makes a sixth field type a COMPILE
 * error here rather than a value that silently lands nowhere — the same forcing property the
 * `else false` arm of the check constraint has on the database side. Both edges, deliberately.
 */
export const VALUE_COLUMN = {
  text: 'value_text',
  paragraph: 'value_text',
  number: 'value_number',
  date: 'value_date',
  select: 'value_option',
} as const satisfies Record<CustomFieldType, ValueColumn>

/**
 * A field type paired with a value of the right shape for it — the two travel together and
 * cannot be mismatched.
 *
 * `number` fields carry a real `number` because the column is `numeric`; everything else is a
 * string (`date` is an ISO `yyyy-mm-dd`, which is what `<input type="date">` produces and what
 * Postgres `date` parses). Making this a discriminated UNION rather than two separate
 * parameters is what stops `{ fieldType: 'number', value: '3' }` compiling — the same move as
 * `LoadFailure`'s closed `resource` union.
 *
 * **A conditional generic (`value: ValueFor<T>`) was written first and rejected.** It gives the
 * identical guarantee at a *static* call site, but the only production call site is dynamic —
 * the row component holds a `CustomFieldType` read from a definition row, not a literal — so
 * the generic bought nothing there and forced a cast to get past it. A union instead lets
 * `parseFieldValue` construct the pair once, already correctly associated, and TypeScript
 * checks it all the way to the payload with no assertion anywhere in the path.
 */
export type FieldValueWrite =
  | { fieldType: 'text' | 'paragraph' | 'date' | 'select'; value: string }
  | { fieldType: 'number'; value: number }

/** A single-key patch naming the one column a value belongs in. */
type ValuePatch = Partial<Pick<Tables<'ticket_field_values'>, ValueColumn>>

/**
 * Reject a row whose `field_type` is not one this client understands.
 *
 * Identical in shape and reason to `toProjectField`: `TicketFieldValue` narrows the column's
 * `string` to `CustomFieldType`, and a bare cast would make that narrowing a lie the moment
 * the database holds a value the union does not. Throwing surfaces it as a failed read, which
 * the section renders honestly, rather than as a control that renders nothing halfway down the
 * sidebar.
 */
function toTicketFieldValue(row: Tables<'ticket_field_values'>): TicketFieldValue {
  if (!isCustomFieldType(row.field_type)) {
    throw new Error(`Unrecognised custom field type: ${row.field_type}`)
  }
  return { ...row, field_type: row.field_type }
}

/**
 * One ticket's custom field values.
 *
 * **Read PER TICKET, not per project.** The detail dialog is keyed `key={selected?.id ??
 * 'none'}` in `ProjectShell`, so it remounts per ticket and this read has a natural lifecycle
 * with no invalidation logic to get wrong. A project-wide read would fetch every value of
 * every ticket to render one dialog, and would be a fifth read on a shell whose budget was
 * argued for a fourth.
 *
 * No `project_id` filter is needed or wanted: the primary key is `(ticket_id, field_id)`, so
 * `ticket_id` alone already identifies at most one row per field, and `tfv_owner_read` scopes
 * the select to the owner. This differs from `listProjectFields`, which DOES need its filter —
 * there the owner has many projects and RLS narrows to the tenant rather than to the project.
 *
 * THROWS rather than resolving to `[]` on error, mirroring `listProjectFields`. That matters
 * more here than anywhere else in this epic: having no values is the overwhelmingly common
 * case — every ticket starts with none — so `[]` on failure would be indistinguishable from
 * the normal state, and the controls it renders are writable. One keystroke would then
 * overwrite a real stored value with a blank the user was shown by mistake.
 */
export async function listTicketFieldValues(ticketId: string): Promise<TicketFieldValue[]> {
  const { data, error } = await supabase
    .from('ticket_field_values')
    .select(VALUE_COLUMNS)
    .eq('ticket_id', ticketId)

  if (error) throw new Error(`Could not load custom field values: ${error.message}`)
  return (data ?? []).map(toTicketFieldValue)
}

/**
 * The stored value as the string a control renders — the READ counterpart to `valuePatch`.
 *
 * It reads the column named by the ROW's own `field_type`, not by the definition's. The two
 * are equal by `tfv_type_fk`, so this is not a behavioural choice so much as a statement of
 * which one is authoritative for a row that already exists: the row carries its own type
 * precisely so a value can be interpreted without joining to the definition.
 *
 * `String()` rather than a template or a cast, and `null` mapped to `''` rather than to
 * `'null'`: `value_number` arrives as a real `number`, and 0 is a legitimate stored value that
 * must render as `'0'` and not as empty. A `value || ''` here would erase it.
 */
export function fieldValueText(value: TicketFieldValue | undefined): string {
  if (!value) return ''
  const stored = value[VALUE_COLUMN[value.field_type]]
  return stored === null ? '' : String(stored)
}

/**
 * The local list after one write — no refetch.
 *
 * A refetch here would be a second request whose response could land out of order with the
 * write's, and `useTaggedRead`'s `patch` exists for exactly this. The reducer derives from the
 * RULE rather than from the previous state, so it is idempotent: applying the same write twice
 * (a retry after a failure the user could not see the outcome of) yields the same list.
 *
 * Row ORDER is not preserved — a replaced value moves to the end. That is deliberate and safe:
 * the section renders by iterating `fields` and looking each value up by `field_id`, so this
 * list is a lookup table rather than a sequence. Anything that starts rendering it in order
 * owes a sort.
 */
export function applyValueWrite(
  values: TicketFieldValue[],
  keys: { ticketId: string; projectId: string; fieldId: string },
  write: FieldValueWrite | null,
): TicketFieldValue[] {
  const without = values.filter((v) => v.field_id !== keys.fieldId)
  if (write === null) return without
  return [
    ...without,
    {
      ticket_id: keys.ticketId,
      project_id: keys.projectId,
      field_id: keys.fieldId,
      field_type: write.fieldType,
      value_text: null,
      value_number: null,
      value_date: null,
      value_option: null,
      ...valuePatch(write),
    },
  ]
}

/**
 * Writes return a tagged result rather than throwing, matching `project-fields.ts`: a refusal
 * the user can act on is an expected outcome, not an exception.
 *
 * TWO tags. `'stale'` is the foreign-key violation — the definition this value points at is
 * gone, or the ticket is, because another tab deleted it. Nothing about retrying the same
 * write fixes that, so reloading is the only remedy, which is what `'stale'` means everywhere
 * else in this codebase.
 */
export type ValueWriteResult = { ok: true } | { ok: false; error: ValueWriteError }

type ValueWriteError = 'stale' | 'unknown'

/** Postgres `foreign_key_violation`. */
const FOREIGN_KEY_VIOLATION = '23503'

function writeError(error: { code?: string } | null): ValueWriteError {
  return error?.code === FOREIGN_KEY_VIOLATION ? 'stale' : 'unknown'
}

/**
 * Put `value` in the one column its type calls for.
 *
 * The assertion is confined to this three-line function on purpose. A computed key of union
 * type widens to an index signature in TypeScript, so the object literal cannot be checked
 * against `ValuePatch` structurally — but the pairing it would check is already guaranteed at
 * both edges that matter: `setTicketFieldValue`'s generic makes a wrong `(fieldType, value)`
 * pair untypeable at every call site, and `tfv_one_value_matching_type` refuses it in the
 * database. Widening the assertion's scope — casting the whole payload, say — would give up
 * the first of those.
 */
function valuePatch(write: FieldValueWrite): ValuePatch {
  return { [VALUE_COLUMN[write.fieldType]]: write.value } as ValuePatch
}

/**
 * Set one custom field's value on one ticket (AC2), inserting or replacing as needed.
 *
 * **An UPSERT, and the alternatives were rejected on merit.** Update-then-insert-on-miss costs
 * two round trips on every first write and lets two tabs that both miss race into a `23505`
 * that upsert simply does not produce; delete-then-insert loses the value outright if the
 * insert half fails.
 *
 * **The payload carries five columns, and every one of them is required.** PostgREST compiles
 * `.upsert(row)` to `INSERT … ON CONFLICT (…) DO UPDATE SET c = excluded.c` for EVERY column
 * in the payload, and Postgres requires UPDATE privilege on each column in a SET list. The
 * four identity/type columns are what the INSERT half needs, so they cannot be dropped — which
 * is exactly why the migration grants UPDATE on all eight columns rather than on the value
 * columns alone. A narrow grant would let the FIRST write to a field succeed and every later
 * one fail with 42501.
 *
 * The grant is therefore not the control, and the constraints are: `tfv_type_fk` refuses a
 * `field_type` that is not the definition's own, the composite fks carry `project_id` so a row
 * cannot be re-pointed at another project's ticket or field, and `tfv_owner_update`'s
 * `WITH CHECK` re-tests ownership on the post-image. Live tests assert each by CONSTRAINT NAME
 * — three constraints here can all produce 23503, so the SQLSTATE alone would not say which.
 *
 * `ignoreDuplicates: false` is stated rather than left to the default because the default is
 * the whole behaviour: flipped to `true`, every write after the first becomes a silent no-op —
 * the value appears to save, raises nothing, and survives no reload.
 */
export async function setTicketFieldValue(
  input: { ticketId: string; projectId: string; fieldId: string } & FieldValueWrite,
): Promise<ValueWriteResult> {
  const { error } = await supabase.from('ticket_field_values').upsert(
    {
      ticket_id: input.ticketId,
      project_id: input.projectId,
      field_id: input.fieldId,
      field_type: input.fieldType,
      ...valuePatch(input),
    },
    { onConflict: 'ticket_id,field_id', ignoreDuplicates: false },
  )

  if (error) return { ok: false, error: writeError(error) }
  return { ok: true }
}

/**
 * Clear one custom field's value (AC3) — a DELETE, never an update writing nulls.
 *
 * That is structural rather than stylistic. `tfv_one_value_matching_type` insists a value is
 * present, so a row of nulls is not representable and the client could not "clear" by writing
 * null even if it wanted to. Absence of the row IS the absence of a value.
 *
 * BOTH keys are filtered. `ticket_id` alone would delete every custom value on the ticket, and
 * because DELETE is granted table-wide (Postgres has no column-level DELETE) nothing else
 * stands between that mistake and the data.
 *
 * Deleting zero rows is reported as success, deliberately: clearing an already-empty field is
 * a no-op the user cannot distinguish from a success, and re-clearing after a failed attempt
 * must not start reporting errors. Note this also means RLS filtering a cross-tenant delete to
 * zero rows returns `ok` — which is correct here (nothing happened, and nothing should have)
 * but is the reason the isolation suite asserts row COUNTS rather than trusting this result.
 */
export async function clearTicketFieldValue(
  ticketId: string,
  fieldId: string,
): Promise<ValueWriteResult> {
  const { error } = await supabase
    .from('ticket_field_values')
    .delete()
    .eq('ticket_id', ticketId)
    .eq('field_id', fieldId)

  if (error) return { ok: false, error: writeError(error) }
  return { ok: true }
}

/**
 * Parse a custom `number` field's input. **Not `parseStoryPoints`**, and the difference is the
 * point: that function encodes the ESTIMATION rule — whole numbers, non-negative, at most
 * three digits — which is a property of story points and not of arithmetic. A custom number
 * field is a plain `numeric` column and must take `-2.5` as readily as `3`, because it might
 * be a temperature, a variance or a balance. Reusing `parseStoryPoints` would silently impose
 * story-point semantics on every custom number in every project.
 *
 * Empty (or whitespace-only) yields `null`, meaning CLEAR — the same convention
 * `parseStoryPoints` uses, so the calling control can treat both fields identically. This is
 * why the parse cannot be a bare `Number()`: `Number('')` is `0`, and 0 is a legitimate value
 * here, so an emptied field would silently store a real zero that nothing downstream could
 * tell from a deliberate one.
 *
 * Non-finite input is rejected rather than passed through. `Number('Infinity')` survives a
 * `Number.isNaN` check and Postgres `numeric` would refuse it, turning a typo into a failed
 * write instead of a field-level message.
 */
export function parseFieldNumber(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return { ok: false }
  return { ok: true, value: parsed }
}

/**
 * What a control's raw string means: a write, a clear, or a refusal to explain.
 *
 * `write: null` is CLEAR rather than a separate tag, so the caller's branch is
 * `draft.write === null` — one question, matching the one decision the row actually makes.
 */
export type FieldValueDraft =
  | { ok: true; write: FieldValueWrite | null }
  | { ok: false; message: string }

/** Every type but `number` stores its trimmed string; empty means clear. */
function textDraft(
  fieldType: 'text' | 'paragraph' | 'date' | 'select',
  raw: string,
): FieldValueDraft {
  const trimmed = raw.trim()
  return trimmed === '' ? { ok: true, write: null } : { ok: true, write: { fieldType, value: trimmed } }
}

function numberDraft(raw: string): FieldValueDraft {
  const parsed = parseFieldNumber(raw)
  if (!parsed.ok) return { ok: false, message: 'Numbers only' }
  return parsed.value === null
    ? { ok: true, write: null }
    : { ok: true, write: { fieldType: 'number', value: parsed.value } }
}

/**
 * A MAP keyed by type, never an if/else chain — the rule this story's Jira issue marks
 * CRITICAL, and it applies here as much as to the renderer: a map entry costs no cyclomatic
 * point, and `satisfies Record<CustomFieldType, …>` makes a sixth type a compile error rather
 * than a field whose input is silently dropped.
 *
 * Each entry names its own type LITERALLY, which is what lets `textDraft` and `numberDraft`
 * build a correctly-paired `FieldValueWrite` with no assertion: inside an entry the type is a
 * literal, so the union member is chosen statically even though the lookup is dynamic.
 */
const DRAFT_PARSERS = {
  text: (raw: string) => textDraft('text', raw),
  paragraph: (raw: string) => textDraft('paragraph', raw),
  date: (raw: string) => textDraft('date', raw),
  select: (raw: string) => textDraft('select', raw),
  number: numberDraft,
} as const satisfies Record<CustomFieldType, (raw: string) => FieldValueDraft>

/**
 * Turn one control's raw string into a write, a clear, or a message.
 *
 * This is where "validate at both edges" is honoured on the client side: it is the only place
 * that decides which column a keystroke lands in and whether it is a value at all. The
 * database's `tfv_one_value_matching_type` is the other edge and neither substitutes for the
 * other — this one produces a message the user can act on, that one is what actually holds
 * when a caller skips this function.
 */
export function parseFieldValue(type: CustomFieldType, raw: string): FieldValueDraft {
  // BOUND TO A LOCAL FIRST, then called — `DRAFT_PARSERS[type](raw)` is a call through a
  // computed member and `project-type-immutability.test.ts` check 1 forbids that shape
  // ANYWHERE under `src/`, because a guard that cannot read a callee's name is blind to every
  // other check it makes: `supabase['from']('projects')['update'](…)` is the write it exists
  // to catch. Binding first makes the callee a plain identifier, which that file's own
  // `isReadableCallee` docblock explains is not a hole — an alias can only be a supabase
  // method if the client escaped as a value (check 3) or a write member was referenced rather
  // than called (check 2), and both are red on their own account. Do not "simplify" this back
  // into one expression; it turns the gate red.
  const parse = DRAFT_PARSERS[type]
  return parse(raw)
}
