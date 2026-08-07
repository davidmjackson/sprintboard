import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  VALUE_COLUMN,
  applyValueWrite,
  clearTicketFieldValue,
  fieldValueText,
  insertTicketFieldValues,
  listTicketFieldValues,
  parseFieldNumber,
  parseFieldValue,
  parseFieldValues,
  setTicketFieldValue,
  ticketFieldValueRows,
  valueRow,
} from './ticket-field-values'
import {
  CUSTOM_FIELD_TYPES,
  type CustomFieldType,
  type ProjectField,
  type TicketFieldValue,
} from './domain'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// The three chains this module issues:
//
//   listTicketFieldValues:  from().select().eq()
//   setTicketFieldValue:    from().upsert()
//   clearTicketFieldValue:  from().delete().eq().eq()
//
// Each chain gets its own link functions, for the reason `project-fields.test.ts` records:
// two chains that diverge after the same method name cannot share one mock without a test
// losing the ability to say which call it saw.
//
// TWO `.eq()` links on the delete, each with its own mock, so a test can say WHICH key it
// filtered on. Sharing one would make `(ticket_id, field_id)` and `(ticket_id, ticket_id)`
// indistinguishable — and the second key is what stops a clear wiping every value on the
// ticket, which is the whole failure worth catching here.
const eqRead = vi.fn()
const select = vi.fn(() => ({ eq: eqRead }))
const upsert = vi.fn()
const eqField = vi.fn()
const eqTicket = vi.fn(() => ({ eq: eqField }))
const del = vi.fn(() => ({ eq: eqTicket }))
const insert = vi.fn()

function mockRows(data: unknown[] | null, error: { message: string } | null = null) {
  eqRead.mockResolvedValue({ data, error })
}

function mockUpsert(error: { code?: string; message?: string } | null = null) {
  upsert.mockResolvedValue({ error })
}

function mockDelete(error: { code?: string; message?: string } | null = null) {
  eqField.mockResolvedValue({ error })
}

// Field ids are DELIBERATELY unlike the slugs, and unlike the type names. A fixture whose id
// is derived from its slug (or whose every field is `text`) makes two distinct production
// reads indistinguishable — the confound SPRIN-87 spent a story breaking, and the one §9 of
// this story's spec calls out by name.
const ROWS = [
  {
    ticket_id: 't1',
    project_id: 'p1',
    field_id: 'f-9a3',
    field_type: 'text',
    value_text: 'ACME-1',
    value_number: null,
    value_date: null,
    value_option: null,
  },
  {
    ticket_id: 't1',
    project_id: 'p1',
    field_id: 'f-2c7',
    field_type: 'number',
    value_text: null,
    value_number: 4.5,
    value_date: null,
    value_option: null,
  },
]

/** One stored value row, defaulting to all-null so each test names only the column it means. */
function value(overrides: Partial<TicketFieldValue> = {}): TicketFieldValue {
  return {
    ticket_id: 't1',
    project_id: 'p1',
    field_id: 'f-9a3',
    field_type: 'text',
    value_text: null,
    value_number: null,
    value_date: null,
    value_option: null,
    ...overrides,
  } as TicketFieldValue
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(supabase.from).mockReturnValue({
    select,
    upsert,
    delete: del,
    insert,
  } as unknown as ReturnType<typeof supabase.from>)
  mockRows(ROWS)
  mockUpsert(null)
  mockDelete(null)
})

/**
 * Field ids UNLIKE their slugs, and UNLIKE the type names, same reasoning as `ROWS` above.
 * Mirrors `TicketCustomFields.test.tsx:50`'s `field()` helper.
 */
function field(overrides: Partial<ProjectField> = {}): ProjectField {
  return {
    id: 'f-9a3',
    project_id: 'p1',
    slug: 'cust_ref',
    name: 'Customer ref',
    type: 'text',
    created_at: '2026-08-01T00:00:00+00:00',
    ...overrides,
  } as ProjectField
}

describe('VALUE_COLUMN', () => {
  it('covers every custom field type', () => {
    // Not a restatement of the map — it asserts the map's KEYS are exactly the domain's type
    // list. A sixth type added to `CUSTOM_FIELD_TYPES` without a column here is a compile
    // error via `satisfies`, but a type REMOVED from the domain while its entry lingers is
    // not, and that stale entry would outlive the type it was written for.
    expect(Object.keys(VALUE_COLUMN).sort()).toEqual([...CUSTOM_FIELD_TYPES].sort())
  })

  it('routes text and paragraph to the same column, and the rest to their own', () => {
    // Pinned because the check constraint pairs them: `text` and `paragraph` differ in how
    // they RENDER, not in how they store. Splitting `paragraph` onto its own column would
    // pass every unit test here and earn 23514 against the live database.
    expect(VALUE_COLUMN.text).toBe('value_text')
    expect(VALUE_COLUMN.paragraph).toBe('value_text')
    expect(VALUE_COLUMN.number).toBe('value_number')
    expect(VALUE_COLUMN.date).toBe('value_date')
    expect(VALUE_COLUMN.select).toBe('value_option')
  })
})

describe('listTicketFieldValues', () => {
  it('names the columns it reads rather than selecting everything', async () => {
    await listTicketFieldValues('t1')
    expect(select).toHaveBeenCalledWith(
      'ticket_id, project_id, field_id, field_type, value_text, value_number, value_date, value_option',
    )
  })

  it('scopes the read to one ticket', async () => {
    await listTicketFieldValues('t1')
    expect(eqRead).toHaveBeenCalledWith('ticket_id', 't1')
  })

  it('returns the rows with their type narrowed', async () => {
    const values = await listTicketFieldValues('t1')
    expect(values.map((v) => [v.field_id, v.field_type])).toEqual([
      ['f-9a3', 'text'],
      ['f-2c7', 'number'],
    ])
  })

  it('THROWS rather than resolving to [] when the read fails', async () => {
    // The S4.6 invariant. `[]` is indistinguishable from "this ticket has no values", which
    // is the COMMON case here — every ticket starts with none. A caller handed `[]` on
    // failure would render empty controls, and one keystroke then overwrites real data with
    // a value the user was shown by mistake.
    mockRows(null, { message: 'network down' })
    await expect(listTicketFieldValues('t1')).rejects.toThrow(/could not load/i)
  })

  it('throws on a row whose field_type the client does not understand', async () => {
    // Same guard as `toProjectField`. An unchecked cast would make the narrowing a lie the
    // moment the database holds a sixth type, and the value would render as nothing at all.
    mockRows([{ ...ROWS[0], field_type: 'colour' }])
    await expect(listTicketFieldValues('t1')).rejects.toThrow(/colour/)
  })
})

describe('setTicketFieldValue', () => {
  const base = { ticketId: 't1', projectId: 'p1', fieldId: 'f-9a3' } as const

  it('writes a text value to value_text', async () => {
    await setTicketFieldValue({ ...base, fieldType: 'text', value: 'ACME-1' })
    expect(upsert).toHaveBeenCalledWith(
      {
        ticket_id: 't1',
        project_id: 'p1',
        field_id: 'f-9a3',
        field_type: 'text',
        value_text: 'ACME-1',
      },
      expect.anything(),
    )
  })

  it('writes a paragraph value to value_text', async () => {
    await setTicketFieldValue({ ...base, fieldType: 'paragraph', value: 'Two\nlines' })
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      field_type: 'paragraph',
      value_text: 'Two\nlines',
    })
  })

  it('writes a number value to value_number', async () => {
    await setTicketFieldValue({ ...base, fieldType: 'number', value: -2.5 })
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      field_type: 'number',
      value_number: -2.5,
    })
  })

  it('writes a date value to value_date', async () => {
    await setTicketFieldValue({ ...base, fieldType: 'date', value: '2026-08-07' })
    expect(upsert.mock.calls[0]?.[0]).toMatchObject({
      field_type: 'date',
      value_date: '2026-08-07',
    })
  })

  it('sends EXACTLY the five columns the insert needs, and no others', async () => {
    // Asserted as an exact key list, not `objectContaining`. Every key in the payload becomes
    // a `SET c = excluded.c` in the compiled `ON CONFLICT DO UPDATE`, and Postgres requires
    // UPDATE privilege on each one — so an extra key is a 42501 on the SECOND write to a
    // field and never the first. `objectContaining` would pass with the extra key present.
    await setTicketFieldValue({ ...base, fieldType: 'text', value: 'ACME-1' })
    expect(Object.keys(upsert.mock.calls[0]?.[0] as object).sort()).toEqual([
      'field_id',
      'field_type',
      'project_id',
      'ticket_id',
      'value_text',
    ])
  })

  it('does NOT send the value columns the type does not call for', async () => {
    // A payload spelling out `value_number: null` alongside `value_text` would satisfy the
    // check constraint and still be wrong: it widens the SET list by three columns for no
    // reason. The row cannot hold a stale value in another column anyway — a field's type is
    // immutable, so the populated column never changes over the row's life.
    await setTicketFieldValue({ ...base, fieldType: 'number', value: 3 })
    const payload = upsert.mock.calls[0]?.[0] as object
    expect(payload).not.toHaveProperty('value_text')
    expect(payload).not.toHaveProperty('value_date')
    expect(payload).not.toHaveProperty('value_option')
  })

  it('upserts on the primary key and UPDATES on conflict rather than ignoring', async () => {
    // `ignoreDuplicates: true` would make every write after the first a silent no-op — the
    // value would appear to save, survive no reload, and raise nothing. Pinned exactly.
    await setTicketFieldValue({ ...base, fieldType: 'text', value: 'ACME-1' })
    expect(upsert).toHaveBeenCalledWith(expect.anything(), {
      onConflict: 'ticket_id,field_id',
      ignoreDuplicates: false,
    })
  })

  it('reports success', async () => {
    const result = await setTicketFieldValue({ ...base, fieldType: 'text', value: 'x' })
    expect(result).toEqual({ ok: true })
  })

  it('reports a foreign-key violation as stale', async () => {
    mockUpsert({ code: '23503', message: 'violates foreign key constraint "tfv_field_fk"' })
    const result = await setTicketFieldValue({ ...base, fieldType: 'text', value: 'x' })
    expect(result).toEqual({ ok: false, error: 'stale' })
  })

  it('reports anything else as unknown', async () => {
    mockUpsert({ code: '42501', message: 'permission denied' })
    const result = await setTicketFieldValue({ ...base, fieldType: 'text', value: 'x' })
    expect(result).toEqual({ ok: false, error: 'unknown' })
  })
})

describe('clearTicketFieldValue', () => {
  it('deletes the row for exactly one ticket AND one field', async () => {
    await clearTicketFieldValue('t1', 'f-9a3')
    expect(eqTicket).toHaveBeenCalledWith('ticket_id', 't1')
    expect(eqField).toHaveBeenCalledWith('field_id', 'f-9a3')
  })

  it('issues a delete, never an update writing nulls', async () => {
    // AC3 is structural, not stylistic: `tfv_one_value_matching_type` insists a value is
    // present, so a row of nulls is not representable. An update clearing the column would
    // earn 23514 against the live database while every mocked test stayed green.
    await clearTicketFieldValue('t1', 'f-9a3')
    expect(del).toHaveBeenCalled()
  })

  it('reports success', async () => {
    await expect(clearTicketFieldValue('t1', 'f-9a3')).resolves.toEqual({ ok: true })
  })

  it('reports a failed delete', async () => {
    mockDelete({ code: '42501', message: 'permission denied' })
    await expect(clearTicketFieldValue('t1', 'f-9a3')).resolves.toEqual({
      ok: false,
      error: 'unknown',
    })
  })
})

describe('parseFieldNumber', () => {
  it('accepts a whole number', () => {
    expect(parseFieldNumber('3')).toEqual({ ok: true, value: 3 })
  })

  it('accepts a NEGATIVE decimal, which parseStoryPoints rejects', () => {
    // The whole reason this function exists. `parseStoryPoints` encodes the ESTIMATION rule
    // (whole, non-negative); a custom `number` field is a `numeric` column and carries no
    // such meaning. Reusing it would impose story-point semantics on every custom number in
    // every project — a temperature, a variance, a balance.
    expect(parseFieldNumber('-2.5')).toEqual({ ok: true, value: -2.5 })
    expect(parseStoryPointsWouldReject('-2.5')).toBe(true)
  })

  it('treats an empty or whitespace-only value as CLEAR, not as zero', () => {
    // `Number('')` is 0, so a bare `Number()` here would silently store a real zero for a
    // field the user just emptied — and 0 is a legitimate value, so nothing downstream could
    // tell the two apart afterwards.
    expect(parseFieldNumber('')).toEqual({ ok: true, value: null })
    expect(parseFieldNumber('   ')).toEqual({ ok: true, value: null })
  })

  it('accepts zero as a real value rather than as absence', () => {
    expect(parseFieldNumber('0')).toEqual({ ok: true, value: 0 })
  })

  it('rejects text', () => {
    expect(parseFieldNumber('abc')).toEqual({ ok: false })
  })

  it('rejects non-finite input', () => {
    // `Number('Infinity')` is a number and passes a `Number.isNaN` check. Postgres `numeric`
    // has no infinity in the range this column accepts, so it would fail at the database.
    expect(parseFieldNumber('Infinity')).toEqual({ ok: false })
    expect(parseFieldNumber('-Infinity')).toEqual({ ok: false })
    expect(parseFieldNumber('NaN')).toEqual({ ok: false })
  })
})

describe('parseFieldValue', () => {
  it('covers every custom field type', () => {
    // The map behind it is `satisfies Record<CustomFieldType, …>`, so a MISSING type is a
    // compile error. This catches the other direction at runtime: a type present in the domain
    // whose parser was never wired would return undefined and throw on call.
    //
    // Each type gets an input VALID FOR IT rather than one shared string — `number` refuses
    // 'x', so a shared input would make this assert "every type parses 'x' as text", which is
    // both false and a weaker claim than the one wanted here.
    const VALID_RAW: Record<CustomFieldType, string> = {
      text: 'ACME-1',
      paragraph: 'Two lines',
      number: '4.5',
      date: '2026-08-07',
      select: 'red',
    }
    for (const type of CUSTOM_FIELD_TYPES) {
      const draft = parseFieldValue(type, VALID_RAW[type])
      expect(draft.ok && draft.write?.fieldType).toBe(type)
    }
  })

  it('pairs the value with its own type so the write cannot be mismatched', () => {
    expect(parseFieldValue('number', '4.5')).toEqual({
      ok: true,
      write: { fieldType: 'number', value: 4.5 },
    })
    expect(parseFieldValue('date', '2026-08-07')).toEqual({
      ok: true,
      write: { fieldType: 'date', value: '2026-08-07' },
    })
  })

  it('produces a real number for number fields, not the digits as a string', () => {
    // The distinction the whole `FieldValueWrite` union exists for. A string here reaches
    // `value_number` and earns 22P02 from Postgres — a failed write where a field-level
    // message was wanted.
    const draft = parseFieldValue('number', '4.5')
    expect(draft.ok && draft.write?.value).toBe(4.5)
    expect(typeof (draft.ok && draft.write?.value)).toBe('number')
  })

  it('reads an emptied control as CLEAR for every type', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      expect(parseFieldValue(type, '   ')).toEqual({ ok: true, write: null })
    }
  })

  it('trims a stored string so a space-padded value is not a distinct one', () => {
    expect(parseFieldValue('text', '  ACME-1  ')).toEqual({
      ok: true,
      write: { fieldType: 'text', value: 'ACME-1' },
    })
  })

  it('refuses a non-numeric number with a message the row can render', () => {
    expect(parseFieldValue('number', 'abc')).toEqual({ ok: false, message: 'Numbers only' })
  })
})

/**
 * `fieldValueText` and `applyValueWrite` had NO direct tests until a review found it — both
 * rested entirely on one component test that starts from an empty value list, so the REPLACE
 * path, the `field_type` stamp, the identity columns and the documented idempotence were all
 * unexercised. Four mutations survived in that state; each has a test below now.
 *
 * ONE CORRECTION, recorded because the discipline cuts both ways: a fifth reported survivor —
 * `fieldValueText` always reading `value_text` — was NOT one. A re-review restored the
 * pre-fix test file, re-planted it, and watched it kill three tests that already existed. The
 * original reviewer had run a narrow subset. So read a survivor list as a hypothesis too, not
 * only a kill list: the count was ten, not eleven. These direct tests remain worth having —
 * they name the property rather than catching it incidentally — but they did not close a hole
 * that was open.
 */
describe('fieldValueText', () => {
  it("reads the column the ROW's own field_type names, for every type", () => {
    // The mutation that survived: `return value.value_text` regardless of type. A fixture set
    // where only `text` carried a value could not tell that apart from correct behaviour.
    expect(fieldValueText(value({ field_type: 'text', value_text: 'ACME-1' }))).toBe('ACME-1')
    expect(fieldValueText(value({ field_type: 'paragraph', value_text: 'Two\nlines' }))).toBe(
      'Two\nlines',
    )
    expect(fieldValueText(value({ field_type: 'number', value_number: -2.5 }))).toBe('-2.5')
    expect(fieldValueText(value({ field_type: 'date', value_date: '2026-08-07' }))).toBe(
      '2026-08-07',
    )
    expect(fieldValueText(value({ field_type: 'select', value_option: 'red' }))).toBe('red')
  })

  it('renders a stored ZERO as "0", not as empty', () => {
    // The defect the function's own docblock names — "a `value || ''` here would erase it" —
    // and which no fixture exercised, so the prose was doing a test's job. `0` is a legitimate
    // value for a number field and is indistinguishable from "no value" once erased.
    expect(fieldValueText(value({ field_type: 'number', value_number: 0 }))).toBe('0')
  })

  it('renders an empty stored string as empty without claiming absence', () => {
    expect(fieldValueText(value({ field_type: 'text', value_text: '' }))).toBe('')
  })

  it('renders no value at all as empty', () => {
    expect(fieldValueText(undefined)).toBe('')
  })

  it('renders a null column as empty rather than as "null"', () => {
    expect(fieldValueText(value({ field_type: 'text', value_text: null }))).toBe('')
  })
})

describe('applyValueWrite', () => {
  const keys = { ticketId: 't1', projectId: 'p1', fieldId: 'f-9a3' }
  const existing = value({ field_id: 'f-9a3', field_type: 'text', value_text: 'OLD' })
  const untouched = value({ field_id: 'f-2c7', field_type: 'number', value_number: 4.5 })

  it('REPLACES an existing value rather than leaving the old one', () => {
    // The survivor that mattered most: a reducer that inserts but silently refuses to replace
    // kept the whole suite green, because the only test of this path began from an empty list.
    // Editing a field that already has a value is the common case, and it would have shown the
    // stale value until reload.
    const next = applyValueWrite([existing, untouched], keys, { fieldType: 'text', value: 'NEW' })
    expect(next).toHaveLength(2)
    expect(fieldValueText(next.find((v) => v.field_id === 'f-9a3'))).toBe('NEW')
  })

  it('leaves every OTHER field alone', () => {
    const next = applyValueWrite([existing, untouched], keys, { fieldType: 'text', value: 'NEW' })
    expect(next.find((v) => v.field_id === 'f-2c7')).toEqual(untouched)
  })

  it("stamps the write's OWN field_type on the patched row", () => {
    // Survivor: `field_type: 'text'` hardcoded. User-visible, because `fieldValueText` reads
    // the column that field_type names — so after saving a number, the control would blank.
    const next = applyValueWrite([], keys, { fieldType: 'number', value: -2.5 })
    expect(next[0]!.field_type).toBe('number')
    expect(next[0]!.value_number).toBe(-2.5)
    expect(fieldValueText(next[0])).toBe('-2.5')
  })

  it('carries the ticket and project it was given', () => {
    // Survivor: both were replaceable with literals and nothing noticed, because the render
    // path reads only `field_id` and the value column. Harmless today; wrong the moment
    // anything else reads the patched row.
    const next = applyValueWrite([], keys, { fieldType: 'text', value: 'x' })
    expect(next[0]).toMatchObject({ ticket_id: 't1', project_id: 'p1', field_id: 'f-9a3' })
  })

  it('populates ONLY the column the type calls for', () => {
    const next = applyValueWrite([], keys, { fieldType: 'date', value: '2026-08-07' })
    expect(next[0]).toMatchObject({
      value_text: null,
      value_number: null,
      value_date: '2026-08-07',
      value_option: null,
    })
  })

  it('REMOVES the row on a clear, leaving the others', () => {
    const next = applyValueWrite([existing, untouched], keys, null)
    expect(next.map((v) => v.field_id)).toEqual(['f-2c7'])
  })

  it('is idempotent — applying the same write twice yields the same list', () => {
    // The docblock claims this ("derives from the RULE rather than from the previous state"),
    // and nothing applied a write twice. It is what makes a retry after an unclear failure safe.
    const write = { fieldType: 'text', value: 'NEW' } as const
    const once = applyValueWrite([existing], keys, write)
    expect(applyValueWrite(once, keys, write)).toEqual(once)
    const cleared = applyValueWrite([existing], keys, null)
    expect(applyValueWrite(cleared, keys, null)).toEqual(cleared)
  })

  it('preserves a stored zero through the round trip', () => {
    const next = applyValueWrite([], keys, { fieldType: 'number', value: 0 })
    expect(fieldValueText(next[0])).toBe('0')
  })
})

/** Documents the divergence asserted above rather than restating `parseStoryPoints`' regex. */
function parseStoryPointsWouldReject(raw: string): boolean {
  return !/^\d{0,3}$/.test(raw.trim())
}

describe('valueRow', () => {
  it('carries all eight columns, with three value columns null', () => {
    const row = valueRow(
      { ticketId: 't1', projectId: 'p1', fieldId: 'f-2c7' },
      { fieldType: 'number', value: -2.5 },
    )
    // Exact key set, not a subset. CORRECTED 2026-08-07: this used to say a row that omits
    // its null columns "breaks the batch" (PGRST102) — CI measured that a differing-key batch
    // is actually ACCEPTED on this stack, so that is false. The property still worth pinning
    // is that `valueRow` itself always emits the full eight-key shape as defence in depth (see
    // its docblock in `src/lib/ticket-field-values.ts`), independent of whether PostgREST
    // would tolerate a narrower one.
    expect(Object.keys(row).sort()).toEqual([
      'field_id',
      'field_type',
      'project_id',
      'ticket_id',
      'value_date',
      'value_number',
      'value_option',
      'value_text',
    ])
    expect(row).toMatchObject({
      ticket_id: 't1',
      project_id: 'p1',
      field_id: 'f-2c7',
      field_type: 'number',
      value_number: -2.5,
      value_text: null,
      value_date: null,
      value_option: null,
    })
  })
})

describe('parseFieldValues', () => {
  it('returns one write per filled field, and drops the empty ones', () => {
    const text = field({ id: 'f-1', type: 'text' })
    const empty = field({ id: 'f-2', type: 'text' })
    const result = parseFieldValues([text, empty], { 'f-1': 'ACME-1', 'f-2': '   ' })

    expect(result).toEqual({
      ok: true,
      writes: [{ field: text, write: { fieldType: 'text', value: 'ACME-1' } }],
    })
  })

  it('reports every bad value and produces no writes at all', () => {
    const num = field({ id: 'f-2c7', type: 'number' })
    const text = field({ id: 'f-1', type: 'text' })
    const result = parseFieldValues([num, text], { 'f-2c7': 'twelve', 'f-1': 'fine' })

    // NOT a partial result. One bad value refuses the whole submit, so the ticket is never
    // created and the user loses nothing.
    expect(result).toEqual({ ok: false, errors: [{ fieldId: 'f-2c7', message: 'Numbers only' }] })
  })

  it('ignores a record key with no matching field definition', () => {
    // A field deleted in another tab leaves its draft behind. Iterating the DEFINITIONS means
    // a value can only ever be written for a field that currently exists.
    const text = field({ id: 'f-1', type: 'text' })
    const result = parseFieldValues([text], { 'f-1': 'kept', 'f-gone': 'dropped' })

    expect(result).toEqual({
      ok: true,
      writes: [{ field: text, write: { fieldType: 'text', value: 'kept' } }],
    })
  })

  it('treats a missing record entry as empty rather than throwing', () => {
    const text = field({ id: 'f-1', type: 'text' })
    expect(parseFieldValues([text], {})).toEqual({ ok: true, writes: [] })
  })

  /**
   * DEFENCE IN DEPTH, and deliberately UNREACHABLE from production today — do not delete this as
   * dead code. `raw[field.id]` reads the prototype chain as happily as the object's own keys, so
   * a polluted `Object.prototype` would put an attacker-chosen value on a field the user never
   * filled, and — measured by the SPRIN-89 security review — produce a REAL write of it.
   *
   * Three separate things make it unreachable, none of them a property of `parseFieldValues`:
   * `project_fields.id` is a `uuid` column, `z.record` drops a `__proto__` key, and
   * react-hook-form refuses those key names. Any one of them could change in a later story
   * without this file being opened, which is exactly why the guard lives here.
   *
   * The prototype is restored in a `finally` so a failing assertion above cannot leak a polluted
   * `Object.prototype` into every later test in the run.
   */
  it('ignores a value inherited from Object.prototype', () => {
    const polluted = 'f-9a3'
    const proto = Object.prototype as unknown as Record<string, string>
    try {
      proto[polluted] = 'INJECTED'
      const text = field({ id: polluted, type: 'text' })

      // Sanity: a plain index read really would see the planted value, so a green result below
      // means the guard fired rather than that the pollution never took.
      expect(({} as Record<string, string | undefined>)[polluted]).toBe('INJECTED')

      expect(parseFieldValues([text], {})).toEqual({ ok: true, writes: [] })
    } finally {
      delete proto[polluted]
    }
  })
})

describe('insertTicketFieldValues', () => {
  it('issues NO request at all for an empty list', async () => {
    await expect(insertTicketFieldValues([])).resolves.toEqual({ ok: true })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('inserts every row in ONE call', async () => {
    insert.mockResolvedValue({ error: null })
    const rows = [
      valueRow(
        { ticketId: 't1', projectId: 'p1', fieldId: 'f-1' },
        { fieldType: 'text', value: 'a' },
      ),
      valueRow(
        { ticketId: 't1', projectId: 'p1', fieldId: 'f-2' },
        { fieldType: 'number', value: 3 },
      ),
    ]

    await expect(insertTicketFieldValues(rows)).resolves.toEqual({ ok: true })

    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledWith(rows)
  })

  it('tags a foreign-key violation as stale', async () => {
    insert.mockResolvedValue({ error: { code: '23503' } })
    const rows = [
      valueRow(
        { ticketId: 't1', projectId: 'p1', fieldId: 'f-1' },
        { fieldType: 'text', value: 'a' },
      ),
    ]
    await expect(insertTicketFieldValues(rows)).resolves.toEqual({ ok: false, error: 'stale' })
  })
})

describe('ticketFieldValueRows', () => {
  it('takes tenancy from the TICKET, never from the field definition', () => {
    // tfv_ticket_fk and tfv_field_fk are both composite on project_id, so a row whose project
    // disagreed with the ticket's would be refused. The ticket is what makes the row's tenancy.
    const foreign = field({ id: 'f-1', project_id: 'SOME-OTHER-PROJECT', type: 'text' })
    const rows = ticketFieldValueRows({ id: 't1', project_id: 'p1' }, [
      { field: foreign, write: { fieldType: 'text', value: 'a' } },
    ])
    expect(rows[0]?.project_id).toBe('p1')
  })
})
