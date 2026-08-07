# SPRIN-89 — Custom field values on the create-ticket dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The create-ticket dialog renders a control per custom field after the fixed fields, and
writes the values with the ticket — reporting truthfully when the values write fails.

**Architecture:** Draft values live in the existing react-hook-form as a `custom` record keyed by
field id. On submit: parse every value first (nothing written if any is bad), then create the
ticket, then write all values in **one bulk insert**. A values failure leaves the ticket in place,
fires `onCreated`, names the unsaved fields, and disables the submit so a retry cannot create a
second ticket.

**Tech Stack:** React 19, TypeScript strict, react-hook-form 7, zod 4, Tailwind, shadcn/ui,
Vitest, Supabase/PostgREST.

**Spec:** `docs/superpowers/specs/2026-08-07-sprin-89-create-ticket-field-values-design.md`. Read
it before starting — it records why each decision was taken and what was rejected.

---

## Global Constraints

Every task's requirements implicitly include this section.

**The gate.** `npm run verify` = `lint && format:check && build && test`. Your own loop is
`npm run lint`, `npm run typecheck`, `npm run test:unit`. Before committing, run
`npx prettier --write` on the files you touched — `verify` runs `format:check` and unformatted
code turns CI red.

**`npx tsc --noEmit -p tsconfig.json` CHECKS ZERO FILES AND EXITS 0.** The root config is
`"files": []` plus project references. Use **`npm run typecheck`** (`tsc -b --noEmit`). This has
already cost a session of worthless "types clean" claims.

**The live integration suites CANNOT run in this environment and that is expected.** This machine's
`VITE_SUPABASE_URL` is the placeholder `example.supabase.co`, so all seven `*.integration.test.ts`
files fail on `ENOTFOUND`. **Seven red integration files is the normal state here and is not your
diff.** Use `npm run test:unit`, which excludes them. CI holds the real secrets and is the
authority. `npm run keepalive` names the host it tried, which classifies it in one command.

**Lint thresholds T1–T5, enforced as errors:** 30-line functions, cyclomatic 10, cognitive 15,
**4 parameters**, 400-line files. **Never add an inline eslint disable** — a genuine misfit is an
ADR, and there are none in this story. Measure a function's real complexity with:

```
npx eslint <file> --rule '{"complexity":["error",1]}'
```

(The linter reports complexity only on violation, so a number is invisible until it breaks.)

**A call through a computed member is FORBIDDEN anywhere under `src/`** by
`src/test/project-type-immutability.test.ts` check 1. `CONTROLS[field.type](props)` turns the gate
red. **Bind to a local first**, then call: `const render = CONTROLS[field.type]; render(props)`.
`parseFieldValue` in `src/lib/ticket-field-values.ts:365` carries the full explanation — read it.

**Status/type/label vocabulary lives in `src/lib/domain.ts` and nowhere else.** Never inline a
field-type literal in a component.

**Test shapes this project has been burned by — all four are recorded defects, not style:**

1. `toHaveTextContent('some copy')` is a **substring** match, so any additive reword survives it.
   Assert exact strings or anchored regexes.
2. `getByText` matches inside an `aria-hidden` subtree, so it cannot prove a control is reachable.
   Pair a text assertion with a role or label query.
3. `queryByRole` **excludes** `aria-hidden` subtrees, so an absence test reports "absent" for an
   element still in the DOM and keyboard-reachable. Pair an absence assertion with a raw DOM query.
4. `toHaveClass` is a **subset** check — `sr-only hidden` passes `toHaveClass('sr-only')`.

**Never assert an exact accessible name composed from several children.** Under jsdom the parts
fuse (no stylesheet, no flex blockification) and the string is not what any browser produces.
Substring name queries and `getByLabelText` are fine.

**Commit messages:** imperative summary, and end every one with:

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015JzX3kCwXUbBUaWmHefFxk
```

Use `git commit -F <file>` or `git commit -m` — **never a heredoc** for the message (a global guard
hook rejects it).

**Do not edit `src/routes/CreateTicketDialog.test.tsx`'s seven existing tests.** They are AC5's
evidence: a project with no custom fields shows an unchanged dialog, proven by an unedited suite.
You may ADD tests to that file. If an existing one goes red, that is a real regression — report it,
do not adjust the test.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/ticket-field-values.ts` | + `valueRow`, `insertTicketFieldValues`, `parseFieldValues`, `ticketFieldValueRows` | 1 |
| `src/lib/ticket-field-values.test.ts` | unit tests for the above | 1 |
| `src/test/rls.integration.test.ts` | + live multi-type batch insert | 2 |
| `src/routes/CreateTicketCustomFields.tsx` | the control map, the phase decision, prop defaults | 3 |
| `src/routes/CreateTicketCustomFields.test.tsx` | AC1, AC3(empty), phase behaviour | 3 |
| `src/routes/form-primitives.tsx` | `SubmitButton` gains `disabled` | 4 |
| `src/routes/CreateDialog.tsx` | gains `submitDisabled?: boolean` | 4 |
| `src/routes/CreateDialog.test.tsx` | + the new prop's behaviour | 4 |
| `src/routes/CreateTicketDialog.tsx` | schema, `ticketInput`, submit sequence, AC4 latch | 5 |
| `src/routes/CreateTicketDialog.test.tsx` | AC2, AC3, AC4 (ADD only) | 5 |
| `src/routes/ProjectShellHeader.tsx` | forwards `fields`/`fieldsPhase` | 6 |
| `src/routes/ProjectShell.tsx` | passes them from the shell's existing read | 6 |
| `src/routes/ProjectShell.test.tsx` | the "real wiring" test | 6 |

---

## Task 1: The write layer in `ticket-field-values.ts`

**Files:**
- Modify: `src/lib/ticket-field-values.ts`
- Test: `src/lib/ticket-field-values.test.ts`

**Interfaces:**
- Consumes: existing `FieldValueWrite`, `valuePatch`, `writeError`, `ValueWriteResult`,
  `parseFieldValue` — all already in this file.
- Produces, for tasks 3 and 5:
  ```ts
  export function valueRow(
    keys: { ticketId: string; projectId: string; fieldId: string },
    write: FieldValueWrite,
  ): TicketFieldValue

  export type FieldValuesDraft =
    | { ok: true; writes: Array<{ field: ProjectField; write: FieldValueWrite }> }
    | { ok: false; errors: Array<{ fieldId: string; message: string }> }

  export function parseFieldValues(
    fields: ProjectField[],
    raw: Record<string, string | undefined>,
  ): FieldValuesDraft

  export function ticketFieldValueRows(
    ticket: { id: string; project_id: string },
    writes: Array<{ field: ProjectField; write: FieldValueWrite }>,
  ): TicketFieldValue[]

  export function insertTicketFieldValues(rows: TicketFieldValue[]): Promise<ValueWriteResult>
  ```

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/ticket-field-values.test.ts`. The file already mocks supabase as
`vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))` and gives each chain its own
link functions — follow that, adding an `insert` link. Reuse the file's existing `field()`/`value()`
fixture helpers if present; otherwise mirror `TicketCustomFields.test.tsx:50`'s `field()` helper.

```ts
describe('valueRow', () => {
  it('carries all eight columns, with three value columns null', () => {
    const row = valueRow(
      { ticketId: 't1', projectId: 'p1', fieldId: 'f-2c7' },
      { fieldType: 'number', value: -2.5 },
    )
    // Exact key set, not a subset: PostgREST rejects a bulk insert whose objects have
    // differing keys (PGRST102), so a row that omits its null columns breaks the batch.
    expect(Object.keys(row).sort()).toEqual([
      'field_id', 'field_type', 'project_id', 'ticket_id',
      'value_date', 'value_number', 'value_option', 'value_text',
    ])
    expect(row).toMatchObject({
      ticket_id: 't1', project_id: 'p1', field_id: 'f-2c7', field_type: 'number',
      value_number: -2.5, value_text: null, value_date: null, value_option: null,
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
})

describe('insertTicketFieldValues', () => {
  it('issues NO request at all for an empty list', async () => {
    await expect(insertTicketFieldValues([])).resolves.toEqual({ ok: true })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('inserts every row in ONE call', async () => {
    insert.mockResolvedValue({ error: null })
    const rows = [
      valueRow({ ticketId: 't1', projectId: 'p1', fieldId: 'f-1' }, { fieldType: 'text', value: 'a' }),
      valueRow({ ticketId: 't1', projectId: 'p1', fieldId: 'f-2' }, { fieldType: 'number', value: 3 }),
    ]

    await expect(insertTicketFieldValues(rows)).resolves.toEqual({ ok: true })

    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledTimes(1)
    expect(insert).toHaveBeenCalledWith(rows)
  })

  it('tags a foreign-key violation as stale', async () => {
    insert.mockResolvedValue({ error: { code: '23503' } })
    const rows = [
      valueRow({ ticketId: 't1', projectId: 'p1', fieldId: 'f-1' }, { fieldType: 'text', value: 'a' }),
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
    expect(rows[0].project_id).toBe('p1')
  })
})
```

Also add one test proving `applyValueWrite` still behaves after the extraction (it should already
be covered — run the file and confirm its existing `applyValueWrite` tests pass unchanged).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/ticket-field-values.test.ts`
Expected: FAIL — `valueRow`, `parseFieldValues`, `ticketFieldValueRows`,
`insertTicketFieldValues` are not exported.

- [ ] **Step 3: Implement**

In `src/lib/ticket-field-values.ts`. Add `ProjectField` to the existing `./domain` import.

Extract the row literal out of `applyValueWrite` (currently lines 148–161) and have
`applyValueWrite` call it — do not leave two copies:

```ts
/**
 * One value row, with ALL EIGHT columns spelled out — three of them null.
 *
 * The nulls are not padding. PostgREST rejects a bulk insert whose objects have differing keys
 * (`PGRST102`, "All object keys must match"), and rows for different field types naturally
 * differ: a `text` row wants `value_text`, a `date` row wants `value_date`. Omitting the nulls
 * would work for every single-row write and break the moment two types are created together —
 * a failure no mocked client can see, which is why `rls.integration.test.ts` inserts a real
 * multi-type batch.
 *
 * Shared with `applyValueWrite` so the row the client OPTIMISTICALLY renders and the row it
 * SENDS are constructed once. They drifted apart would mean the board showing a value the
 * database never received.
 */
export function valueRow(
  keys: { ticketId: string; projectId: string; fieldId: string },
  write: FieldValueWrite,
): TicketFieldValue {
  return {
    ticket_id: keys.ticketId,
    project_id: keys.projectId,
    field_id: keys.fieldId,
    field_type: write.fieldType,
    value_text: null,
    value_number: null,
    value_date: null,
    value_option: null,
    ...valuePatch(write),
  }
}
```

```ts
/** Every filled field's write, or every bad field's message — never a mix. */
export type FieldValuesDraft =
  | { ok: true; writes: Array<{ field: ProjectField; write: FieldValueWrite }> }
  | { ok: false; errors: Array<{ fieldId: string; message: string }> }

/**
 * Parse a whole form's worth of custom values, BEFORE any ticket exists.
 *
 * Iterates the DEFINITIONS, not the record's keys, so a draft left behind by a field deleted in
 * another tab is ignored rather than written.
 *
 * All-or-nothing: one unparseable value refuses the entire submit. That ordering is the point —
 * the only outcome in which the user loses nothing is the one where the refusal happens before
 * the ticket is created.
 */
export function parseFieldValues(
  fields: ProjectField[],
  raw: Record<string, string | undefined>,
): FieldValuesDraft {
  const writes: Array<{ field: ProjectField; write: FieldValueWrite }> = []
  const errors: Array<{ fieldId: string; message: string }> = []

  for (const field of fields) {
    const draft = parseFieldValue(field.type, raw[field.id] ?? '')
    if (!draft.ok) errors.push({ fieldId: field.id, message: draft.message })
    else if (draft.write !== null) writes.push({ field, write: draft.write })
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, writes }
}

/**
 * The rows for a ticket that now exists. Tenancy comes from the TICKET, never from the field
 * definition — `tfv_ticket_fk` and `tfv_field_fk` are both composite on `project_id`, so taking
 * it from the ticket is what makes the row's tenancy the ticket's tenancy.
 */
export function ticketFieldValueRows(
  ticket: { id: string; project_id: string },
  writes: Array<{ field: ProjectField; write: FieldValueWrite }>,
): TicketFieldValue[] {
  return writes.map(({ field, write }) =>
    valueRow({ ticketId: ticket.id, projectId: ticket.project_id, fieldId: field.id }, write),
  )
}

/**
 * Every custom value for a NEWLY CREATED ticket, in one statement.
 *
 * **An INSERT, not the upsert `setTicketFieldValue` uses.** The ticket id was returned moments
 * ago by `createTicket`, so no row for it can exist and `ON CONFLICT DO UPDATE` is unreachable.
 * An insert also needs only the INSERT privilege, where an upsert compiles a SET list and
 * demands UPDATE on every payload column — narrower privilege, identical result.
 *
 * **One statement, not one per field**, so a PARTIAL values result is not representable. Either
 * every value is stored or none is, which is what lets the dialog's failure message be true.
 *
 * Zero rows issues no request at all — the common case is a project with custom fields where the
 * user filled none, and that must not cost a round trip.
 */
export async function insertTicketFieldValues(
  rows: TicketFieldValue[],
): Promise<ValueWriteResult> {
  if (rows.length === 0) return { ok: true }

  const { error } = await supabase.from('ticket_field_values').insert(rows)

  if (error) return { ok: false, error: writeError(error) }
  return { ok: true }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/ticket-field-values.test.ts`
Expected: PASS, including every pre-existing test in the file.

Then: `npm run lint && npm run typecheck && npm run test:unit`
Expected: clean. Measure and report `parseFieldValues`'s complexity with the `--rule` command
above; it should be well under 10.

- [ ] **Step 5: Commit**

```
git add src/lib/ticket-field-values.ts src/lib/ticket-field-values.test.ts
git commit -F <message-file>
```

---

## Task 2: The live proof that a multi-type batch inserts

**Files:**
- Modify: `src/test/rls.integration.test.ts`

**Interfaces:**
- Consumes: `insertTicketFieldValues` is *not* imported here — this test drives the supabase
  client directly, matching every other test in the file.

**Why this task exists.** Task 1's central claim — that every row must carry all eight keys or
PostgREST refuses the batch — is invisible to a mocked client. A unit test can assert the payload
shape; only the real database can say whether that shape is *required*.

**You cannot run this locally and must not try to "fix" it.** This machine's Supabase URL is a
placeholder, so every integration file fails on `ENOTFOUND`. Write the test, confirm it is
syntactically valid via `npm run lint` and `npm run typecheck`, and let CI execute it.

- [ ] **Step 1: Write the test**

Add inside the existing `describe("a ticket carries values for its project's custom fields
(SPRIN-88)")` block in `src/test/rls.integration.test.ts` — it already seeds `fieldOf` (one field
per type in project A) in its `beforeAll`, and `ticketA` already exists.

**Use a FRESH ticket, not `ticketA`.** Other tests in this block already write values for
`ticketA`, and the primary key is `(ticket_id, field_id)` — reusing it would earn a `23505` that
looks like a bulk-insert failure and is not one.

**Delete before asserting.** A failed assertion aborts the test, so teardown placed after it never
runs and strands rows. This project has stranded ten projects that way.

```ts
// ---- SPRIN-89: several types in ONE statement ----

it('inserts values of different types for a new ticket in a single batch', async () => {
  // The property under test is PGRST102: PostgREST refuses a bulk insert whose objects have
  // differing keys. Rows for `text`, `number` and `date` naturally differ, so this passes only
  // because every row spells out all four value columns. A mocked client cannot see this.
  const created = await a
    .from('tickets')
    .insert({ project_id: projectA, summary: 'SPRIN-89 batch', type: 'story' })
    .select('id')
    .single()
  if (created.error) throw new Error(`Fixture: could not create ticket: ${created.error.message}`)
  const ticketId = created.data.id

  const row = (fieldType: string, patch: Record<string, unknown>) => ({
    ticket_id: ticketId,
    project_id: projectA,
    field_id: fieldOf[fieldType],
    field_type: fieldType,
    value_text: null,
    value_number: null,
    value_date: null,
    value_option: null,
    ...patch,
  })

  const { error } = await a
    .from('ticket_field_values')
    .insert([
      row('text', { value_text: 'ACME-1' }),
      row('number', { value_number: -2.5 }),
      row('date', { value_date: '2026-08-07' }),
    ])

  const readBack = await a
    .from('ticket_field_values')
    .select('field_type, value_text, value_number, value_date')
    .eq('ticket_id', ticketId)

  // Teardown BEFORE the assertions: a failed expect aborts the test, so a delete placed after
  // one never runs. Deleting the ticket cascades the value rows away.
  await a.from('tickets').delete().eq('id', ticketId)

  expect(error).toBeNull()
  expect(readBack.data).toHaveLength(3)
  expect(readBack.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field_type: 'text', value_text: 'ACME-1' }),
      expect.objectContaining({ field_type: 'number', value_number: -2.5 }),
      expect.objectContaining({ field_type: 'date', value_date: '2026-08-07' }),
    ]),
  )
})
```

Check the surrounding block for how `a` reads a numeric column back — `value_number` may arrive as
a string from PostgREST's `numeric`. If the block's existing `number` test compares against a
string, match it and say so in a comment; do not silently loosen the assertion.

- [ ] **Step 2: Verify it is valid without running it**

Run: `npm run lint && npm run typecheck`
Expected: clean. **Do not run `npm test`** and do not report the seven ENOTFOUND integration
failures as a problem — they are this environment, not your diff.

- [ ] **Step 3: Commit**

```
git add src/test/rls.integration.test.ts
git commit -F <message-file>
```

---

## Task 3: `CreateTicketCustomFields`

**Files:**
- Create: `src/routes/CreateTicketCustomFields.tsx`
- Create: `src/routes/CreateTicketCustomFields.test.tsx`

**Interfaces:**
- Consumes: `ProjectField`, `CustomFieldType` from `@/lib/domain`; `ReadPhase` from
  `@/lib/project-reads`; `selectClass` from `./form-primitives`; `Input`, `Textarea`,
  `FormField`, `FormItem`, `FormLabel`, `FormControl`, `FormMessage` from the same paths
  `CreateTicketDialog.tsx` already imports them from.
- Produces, for task 5:
  ```ts
  export function CreateTicketCustomFields(props: {
    control: Control<CreateTicketValues>
    fields?: ProjectField[]
    fieldsPhase?: ReadPhase
  }): React.ReactElement | null
  ```
  `CreateTicketValues` is exported from `./CreateTicketDialog` in task 5. To avoid a circular
  value import, type the `control` prop as `Control<CreateTicketFormShape>` where
  `CreateTicketFormShape` is declared **in this file** as
  `{ custom?: Record<string, string> }` — a structural minimum. If TypeScript rejects that
  against the dialog's full form type, take the type from `./CreateTicketDialog` with
  `import type` (erased at build, so it closes no cycle) and say so in your report.

**Two traps, both already paid for elsewhere in this repo:**

1. **`CONTROLS[field.type](props)` is a call through a computed member and turns
   `npm run lint`'s sibling guard red** (`src/test/project-type-immutability.test.ts` check 1,
   which scans all of `src/`). Bind first: `const render = CONTROLS[field.type]`, then
   `render(props)`.
2. **`FormControl` clones its DIRECT child** to attach `id`, `aria-describedby` and
   `aria-invalid`. If that child is a component wrapper, those props land on a function that
   drops them and `FormLabel`'s `htmlFor` points at nothing. So the map entries are **render
   functions returning a DOM element**, called inside `<FormControl>{render(props)}</FormControl>`
   — not components rendered as `<Control />`. Assert the association with `getByLabelText`.

- [ ] **Step 1: Write the failing tests**

Create `src/routes/CreateTicketCustomFields.test.tsx`. Mirror the `field()` fixture helper at
`src/routes/TicketCustomFields.test.tsx:50`. Render inside a real `useForm` + `Form` provider —
copy the harness shape from `CreateDialog.test.tsx`, or render the whole `CreateTicketDialog` if
that is simpler once task 5 lands (it has not; write a local harness).

```tsx
function Harness({ fields, fieldsPhase }: { fields?: ProjectField[]; fieldsPhase?: ReadPhase }) {
  const form = useForm({ defaultValues: { custom: {} } })
  return (
    <Form {...form}>
      <CreateTicketCustomFields control={form.control} fields={fields} fieldsPhase={fieldsPhase} />
    </Form>
  )
}

it('renders one labelled control per custom field', async () => {
  render(<Harness fields={[TEXT, NUMBER, DATE]} fieldsPhase="loaded" />)

  // getByLabelText, not getByText: it proves the LABEL IS ASSOCIATED with the control, which
  // is what FormControl's cloning provides and what a component wrapper would silently break.
  expect(screen.getByLabelText('Customer ref')).toBeInTheDocument()
  expect(screen.getByLabelText('Priority level')).toBeInTheDocument()
  expect(screen.getByLabelText('Go live')).toBeInTheDocument()
})

it('renders each type as its own control', () => {
  render(<Harness fields={[PARAGRAPH, NUMBER, DATE, SELECT]} fieldsPhase="loaded" />)

  expect(screen.getByLabelText('Delivery notes').tagName).toBe('TEXTAREA')
  expect(screen.getByLabelText('Priority level')).toHaveAttribute('type', 'number')
  expect(screen.getByLabelText('Go live')).toHaveAttribute('type', 'date')
  expect(screen.getByLabelText('Colour')).toBeDisabled()
})

it('does not floor a custom number field at zero', () => {
  // min=0 is the STORY POINTS rule — a property of estimation, not of arithmetic. A custom
  // number field might be a temperature, a variance or a balance. SPRIN-88 moved that bound to
  // the story-points call site that owns it; this is the create-side half of the same rule.
  render(<Harness fields={[NUMBER]} fieldsPhase="loaded" />)
  expect(screen.getByLabelText('Priority level')).not.toHaveAttribute('min')
})

it('renders nothing when the project has no custom fields', () => {
  const { container } = render(<Harness fields={[]} fieldsPhase="loaded" />)
  expect(container).toBeEmptyDOMElement()
})

it('renders nothing when no field wiring is supplied at all', () => {
  // The defaults live HERE, so a standalone <CreateTicketDialog projectId="p1" /> — which is
  // how the seven existing dialog tests render it — is completely unchanged. AC5.
  const { container } = render(<Harness />)
  expect(container).toBeEmptyDOMElement()
})

it('says so when the definitions read failed, and renders no controls', () => {
  render(<Harness fields={[]} fieldsPhase="failed" />)

  expect(screen.getByRole('status')).toHaveTextContent(
    /^Custom fields couldn.t be loaded\. You can set them on the ticket after it.s created\.$/,
  )
  // A raw DOM query, because queryByRole EXCLUDES aria-hidden subtrees and would report
  // "absent" for a control that is still in the DOM and still keyboard-reachable.
  expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0)
})

it('shows a loading line rather than empty controls while the definitions load', () => {
  // An empty control says "this ticket has no value for this field" in the only language a
  // control has. Rendering one before the definitions are known invites the user to fill in a
  // field that may not exist.
  render(<Harness fields={[]} fieldsPhase="loading" />)

  expect(screen.getByText('Loading…')).toBeInTheDocument()
  expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0)
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/routes/CreateTicketCustomFields.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `src/routes/CreateTicketCustomFields.tsx`. Write a docblock on the control map explaining
why it is a map and not an if/else chain (cyclomatic cost, and `satisfies` makes a sixth type a
compile error), and why it does not reuse `TicketCustomFields`'s `CONTROLS` (click-to-edit is
wrong for a create form). The spec's §5 has the reasoning — put it in the code, not a pointer.

```tsx
type CreateControlProps = {
  value: string
  onChange: (value: string) => void
}

const CREATE_CONTROLS = {
  text: (p: CreateControlProps) => (
    <Input value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
  paragraph: (p: CreateControlProps) => (
    <Textarea rows={3} value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
  // No `min`. See the test that pins this.
  number: (p: CreateControlProps) => (
    <Input type="number" inputMode="decimal" value={p.value}
           onChange={(e) => p.onChange(e.target.value)} />
  ),
  date: (p: CreateControlProps) => (
    <Input type="date" value={p.value} onChange={(e) => p.onChange(e.target.value)} />
  ),
  // Disabled until story 5 (SPRIN-92) ships `project_field_options`. A free-text editor would
  // strand values that `tfv_option_fk` will then refuse. Disabled cannot produce a value, so a
  // select field contributes nothing to the write — which is correct, not a gap.
  select: (p: CreateControlProps) => (
    <select className={selectClass} value={p.value} disabled>
      <option value={p.value}>{p.value || '—'}</option>
    </select>
  ),
} as const satisfies Record<CustomFieldType, (p: CreateControlProps) => React.ReactElement>
```

The row — note the local binding before the call, and that `render(...)` returns a DOM element
directly inside `FormControl`:

```tsx
function CreateTicketCustomFieldRow({ control, field }: { control: ...; field: ProjectField }) {
  // Bound to a local, then called. `CREATE_CONTROLS[field.type](props)` is a call through a
  // computed member, which `project-type-immutability.test.ts` check 1 forbids anywhere under
  // `src/` — see `parseFieldValue`'s docblock for why that guard is shaped this way.
  const render = CREATE_CONTROLS[field.type]

  return (
    <FormField
      control={control}
      name={`custom.${field.id}`}
      render={({ field: rhf }) => (
        <FormItem>
          <FormLabel>{field.name}</FormLabel>
          {/* `render(...)` returns a DOM element, so FormControl's clone attaches id and
              aria-* to the actual input. A component wrapper here would swallow them and
              silently break the label association. */}
          <FormControl>{render({ value: rhf.value ?? '', onChange: rhf.onChange })}</FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  )
}
```

`rhf.value ?? ''` is load-bearing: `form.reset()` restores `custom` to `{}`, at which point a
registered path has no value and a bare `value={rhf.value}` flips the input from controlled to
uncontrolled mid-life.

The body — the phase order matches `TicketCustomFieldsBody`, empty checked **before** the phases:

```tsx
export function CreateTicketCustomFields({
  control,
  fields = [],
  fieldsPhase = 'loaded',
}: { ... }) {
  if (fieldsPhase === 'loaded' && fields.length === 0) return null

  if (fieldsPhase === 'failed') {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Custom fields couldn’t be loaded. You can set them on the ticket after it’s created.
      </p>
    )
  }

  if (fieldsPhase === 'loading') {
    return <p className="text-muted-foreground text-sm">Loading…</p>
  }

  return (
    <>
      {fields.map((field) => (
        <CreateTicketCustomFieldRow key={field.id} control={control} field={field} />
      ))}
    </>
  )
}
```

**A failed read must not block creating a ticket** — custom fields are optional metadata. This is
deliberately weaker than `ProjectShellHeader`'s gate on `ticketsPhase`, which hides the create
trigger outright because there a created ticket would be invisible and invisible creates produce
duplicates. Nothing is invisible here. Write that reasoning into the docblock.

Check the apostrophe characters against `npm run lint` — if the repo's copy uses `'` rather than
`’` elsewhere, match the surrounding files and update the test's regex to agree.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/routes/CreateTicketCustomFields.test.tsx`
Expected: PASS.

Then: `npm run lint && npm run typecheck && npm run test:unit`
Expected: clean, and **all seven existing `CreateTicketDialog` tests still pass** (nothing is
wired yet, so they must).

- [ ] **Step 5: Commit**

---

## Task 4: `submitDisabled` on the shared create dialog

**Files:**
- Modify: `src/routes/form-primitives.tsx` (`SubmitButton`)
- Modify: `src/routes/CreateDialog.tsx`
- Test: `src/routes/CreateDialog.test.tsx`

**Interfaces:**
- Produces, for task 5: `CreateDialog` accepts `submitDisabled?: boolean`, default `false`.

**Why.** AC4 leaves the dialog holding a form whose submit has **already succeeded**. Pressing
Create again creates a *second* ticket. Everywhere else in this dialog an error means nothing was
written and retrying is right, so the semantics invert and the existing affordance becomes
harmful. This is the smallest change that closes it.

`CreateProjectDialog` and `CreateSprintDialog` must be **completely unaffected** — the prop
defaults to `false`.

- [ ] **Step 1: Write the failing tests**

Add to `src/routes/CreateDialog.test.tsx`, using its existing `Harness` (extend it with the new
prop, mirroring how it already threads `onClosed`).

```tsx
it('disables the submit button when submitDisabled is set', async () => {
  render(<Harness submitDisabled />)
  await userEvent.click(screen.getByRole('button', { name: 'Open' }))

  expect(await screen.findByRole('button', { name: 'Create' })).toBeDisabled()
})

it('leaves the submit button enabled by default', async () => {
  // The other two Create dialogs pass nothing. If this ever defaults to true they break, and
  // this is the test that says so.
  render(<Harness />)
  await userEvent.click(screen.getByRole('button', { name: 'Open' }))

  expect(await screen.findByRole('button', { name: 'Create' })).toBeEnabled()
})

it('does not submit when submitDisabled is set', async () => {
  // A disabled attribute that the form still honours on Enter would be decoration. This is the
  // property that actually prevents the duplicate create.
  const onSubmit = vi.fn()
  render(<Harness submitDisabled onSubmit={onSubmit} />)
  await userEvent.click(screen.getByRole('button', { name: 'Open' }))
  await userEvent.click(screen.getByRole('button', { name: 'Create' }))

  expect(onSubmit).not.toHaveBeenCalled()
})
```

Match the harness's real trigger and submit labels — read the file rather than trusting `'Open'`
and `'Create'` above, and adjust.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/routes/CreateDialog.test.tsx`
Expected: the first and third FAIL; the second passes already.

- [ ] **Step 3: Implement**

`SubmitButton` gains an optional `disabled`, OR-ed with its own `isSubmitting`:

```tsx
export function SubmitButton({
  label,
  pendingLabel,
  className,
  disabled = false,
}: {
  label: string
  pendingLabel: string
  className?: string
  /** Disables the button for a reason the FORM cannot see — today, a create that already
   *  succeeded and must not be repeated (SPRIN-89 AC4). OR-ed with `isSubmitting`, never
   *  replacing it. */
  disabled?: boolean
}) {
  const { isSubmitting } = useFormState()
  return (
    <Button type="submit" className={className} disabled={isSubmitting || disabled}>
      {isSubmitting ? pendingLabel : label}
    </Button>
  )
}
```

Note the label still keys on `isSubmitting` alone — a latched button reads `Create ticket`, not
`Creating…`, because nothing is in flight.

`CreateDialog` threads it through with a docblock explaining the AC4 state. Four params is the T4
limit and `SubmitButton` now destructures four — that is a destructure, not a parameter list, so
it is fine; confirm with `npm run lint`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/routes/CreateDialog.test.tsx src/routes/CreateProjectDialog.test.tsx src/routes/CreateSprintDialog.test.tsx src/routes/CreateProjectDialog.reopen.test.tsx`
Expected: PASS — the other two dialogs prove the default is inert.

Then `npm run lint && npm run typecheck && npm run test:unit`.

- [ ] **Step 5: Commit**

---

## Task 5: Wire the create dialog

**Files:**
- Modify: `src/routes/CreateTicketDialog.tsx`
- Test: `src/routes/CreateTicketDialog.test.tsx` (**ADD ONLY** — see Global Constraints)

**Interfaces:**
- Consumes: task 1's `parseFieldValues`, `ticketFieldValueRows`, `insertTicketFieldValues`;
  task 3's `CreateTicketCustomFields`; task 4's `submitDisabled`.
- Produces, for task 6: `CreateTicketDialog` accepts `fields?: ProjectField[]` and
  `fieldsPhase?: ReadPhase`, both forwarded straight to `CreateTicketCustomFields` **with no
  defaults here** — the defaults live in that component, because a destructuring default costs a
  cyclomatic point this file cannot pay.

- [ ] **Step 1: Write the failing tests**

ADD to `src/routes/CreateTicketDialog.test.tsx`. Mock the new module alongside the existing
`vi.mock('@/lib/tickets', …)`:

```ts
vi.mock('@/lib/ticket-field-values', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ticket-field-values')>()),
  insertTicketFieldValues: vi.fn(),
}))
```

Keeping the real `parseFieldValues`/`ticketFieldValueRows` is deliberate: mocking them would make
these tests agree with the dialog by construction and stop them seeing a wrong column.

```tsx
it('creates the ticket, then writes its custom values in one insert', async () => {
  mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never })
  mockInsertValues.mockResolvedValue({ ok: true })
  const user = await openDialog({ fields: [TEXT, NUMBER] })

  await user.type(screen.getByLabelText('Summary'), 'Wire the board')
  await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
  await user.type(screen.getByLabelText('Priority level'), '-2.5')
  await user.click(screen.getByRole('button', { name: 'Create ticket' }))

  await waitFor(() => expect(mockInsertValues).toHaveBeenCalledTimes(1))
  // Each value in the column ITS OWN TYPE calls for — a single wrong column here is a 23514
  // against the real database.
  expect(mockInsertValues).toHaveBeenCalledWith([
    { ticket_id: 't1', project_id: 'p1', field_id: TEXT.id, field_type: 'text',
      value_text: 'ACME-1', value_number: null, value_date: null, value_option: null },
    { ticket_id: 't1', project_id: 'p1', field_id: NUMBER.id, field_type: 'number',
      value_number: -2.5, value_text: null, value_date: null, value_option: null },
  ])
})

it('writes no value row for a custom field left empty', async () => {
  mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never })
  mockInsertValues.mockResolvedValue({ ok: true })
  const user = await openDialog({ fields: [TEXT, NUMBER] })

  await user.type(screen.getByLabelText('Summary'), 'Wire the board')
  await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
  await user.click(screen.getByRole('button', { name: 'Create ticket' }))

  await waitFor(() => expect(mockInsertValues).toHaveBeenCalledTimes(1))
  const rows = mockInsertValues.mock.calls[0][0]
  expect(rows).toHaveLength(1)
  expect(rows[0].field_id).toBe(TEXT.id)
})

it('refuses a bad number before creating anything', async () => {
  const user = await openDialog({ fields: [NUMBER] })

  await user.type(screen.getByLabelText('Summary'), 'Wire the board')
  await user.type(screen.getByLabelText('Priority level'), 'twelve')
  await user.click(screen.getByRole('button', { name: 'Create ticket' }))

  expect(await screen.findByText('Numbers only')).toBeInTheDocument()
  // The ORDERING is the point: parse first, so the user loses nothing.
  expect(mockCreate).not.toHaveBeenCalled()
  expect(mockInsertValues).not.toHaveBeenCalled()
})

it('keeps the ticket and names the unsaved fields when the values write fails', async () => {
  mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never })
  mockInsertValues.mockResolvedValue({ ok: false, error: 'unknown' })
  const onCreated = vi.fn()
  const user = await openDialog({ fields: [TEXT, DATE], onCreated })

  await user.type(screen.getByLabelText('Summary'), 'Wire the board')
  await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
  await user.type(screen.getByLabelText('Go live'), '2026-08-07')
  await user.click(screen.getByRole('button', { name: 'Create ticket' }))

  // Exact string, not a substring: toHaveTextContent with a bare string is a SUBSTRING match,
  // so an additive reword would survive it.
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /^Created MP-12, but couldn.t save: Customer ref, Go live\. Set them on the ticket\.$/,
  )
  // The ticket is REAL and must reach the board — withholding it is the invisible-create defect.
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('will not create a second ticket after a values failure', async () => {
  mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never })
  mockInsertValues.mockResolvedValue({ ok: false, error: 'unknown' })
  const user = await openDialog({ fields: [TEXT] })

  await user.type(screen.getByLabelText('Summary'), 'Wire the board')
  await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
  await user.click(screen.getByRole('button', { name: 'Create ticket' }))

  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Create ticket' })).toBeDisabled()

  await user.click(screen.getByRole('button', { name: 'Create ticket' }))
  expect(mockCreate).toHaveBeenCalledTimes(1)
})

it('re-enables the submit when the dialog is closed and reopened', async () => {
  // The latch is per-attempt, not permanent. CreateDialog's onClosed is what clears it, the
  // same seam CreateProjectDialog uses for `keyEdited`.
  mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never })
  mockInsertValues.mockResolvedValue({ ok: false, error: 'unknown' })
  const user = await openDialog({ fields: [TEXT] })

  await user.type(screen.getByLabelText('Summary'), 'Wire the board')
  await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
  await user.click(screen.getByRole('button', { name: 'Create ticket' }))
  await screen.findByRole('alert')

  await user.keyboard('{Escape}')
  await user.click(screen.getByRole('button', { name: 'New ticket' }))

  expect(await screen.findByRole('button', { name: 'Create ticket' })).toBeEnabled()
})

it('issues no values request when the project has custom fields but none are filled', async () => {
  mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never })
  mockInsertValues.mockResolvedValue({ ok: true })
  const user = await openDialog({ fields: [TEXT] })

  await user.type(screen.getByLabelText('Summary'), 'Wire the board')
  await user.click(screen.getByRole('button', { name: 'Create ticket' }))

  await waitFor(() => expect(mockCreate).toHaveBeenCalled())
  // insertTicketFieldValues short-circuits on an empty list, so it is called with [] and issues
  // no request — assert the ARGUMENT, since the call itself is cheap and expected.
  expect(mockInsertValues).toHaveBeenCalledWith([])
})
```

Extend the file's existing `openDialog()` helper to accept optional props rather than writing a
second one — and **keep its zero-argument behaviour identical**, because the seven existing tests
call it bare.

**AC1's ordering test** — the controls come *after* the fixed fields:

```tsx
it('renders the custom fields after the fixed ones', async () => {
  await openDialog({ fields: [TEXT] })

  const labels = screen.getAllByText(/Summary|Acceptance criteria|Customer ref/)
  expect(labels.map((l) => l.textContent)).toEqual([
    'Summary', 'Acceptance criteria', 'Customer ref',
  ])
})
```

Adjust the regex to whatever the real labels are; the property to pin is that `Customer ref`
comes last in **DOM order**.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/routes/CreateTicketDialog.test.tsx`
Expected: the new tests FAIL; **the seven existing ones PASS**.

- [ ] **Step 3: Implement**

Add to the schema and defaults:

```ts
  // `.optional()`, not required, and that is measured rather than stylistic: `.parse()` THROWS
  // when `custom` is absent, so a required field would make the whole submit path depend on
  // `defaultValues.custom = {}` still existing — and deleting that line would surface as a
  // rejected promise and a dialog that silently does nothing, not as a failing test.
  custom: z.record(z.string(), z.string()).optional(),
```

with `custom: {}` in `defaultValues` (the inputs need it to stay controlled).

Extract the fixed-field mapping — this is pure motion and the existing "creates a ticket with
parsed fields" test, which asserts the complete seven-key object, is what proves it:

```ts
/** The form's fixed fields as `createTicket`'s input. Extracted from `onSubmit` so the custom
 *  field branches fit inside T2 — it carried five of that function's eight cyclomatic points. */
function ticketInput(parsed: z.output<typeof CreateTicketSchema>, projectId: string) {
  return {
    projectId,
    summary: parsed.summary,
    type: parsed.type,
    description: parsed.description?.trim() || undefined,
    storyPoints: parsed.storyPoints ? Number(parsed.storyPoints) : undefined,
    labels: parseLabels(parsed.labels),
    acceptanceCriteria: parsed.acceptanceCriteria?.trim() || undefined,
  }
}
```

The copy — a module constant so the failure message is decided in one place:

```ts
/** AC4. Names the ticket so the user can find it, and every field that did not save so they
 *  know exactly what to re-enter. A silent success is the one outcome ruled out. */
function unsavedFieldsMessage(ticketKey: string, fields: ProjectField[]): string {
  return `Created ${ticketKey}, but couldn’t save: ${fields
    .map((f) => f.name)
    .join(', ')}. Set them on the ticket.`
}
```

The submit sequence — **parse, create, then write**:

```ts
  const [created, setCreated] = useState(false)

  async function onSubmit(values, { close, setError }) {
    const parsed = CreateTicketSchema.parse(values)

    // FIRST, before anything is written: a bad value must not cost the user a ticket.
    const drafts = parseFieldValues(fields ?? [], parsed.custom ?? {})
    if (!drafts.ok) {
      for (const e of drafts.errors) setError(`custom.${e.fieldId}`, { message: e.message })
      return
    }

    const result = await createTicket(ticketInput(parsed, projectId))
    if (!result.ok) {
      setError('root', { message: GENERIC_CREATE_ERROR })
      return
    }

    // The ticket is real. It reaches the board whatever the values write does — withholding it
    // would be the invisible-create defect ProjectShellHeader's own gate exists to prevent.
    onCreated?.(result.ticket)

    const written = await insertTicketFieldValues(ticketFieldValueRows(result.ticket, drafts.writes))
    if (!written.ok) {
      // The dialog stays OPEN and its submit LATCHES. Retrying is right everywhere else here,
      // because everywhere else an error means nothing was written — this is the one state
      // where pressing Create again makes a second ticket.
      setError('root', { message: unsavedFieldsMessage(result.ticket.key, drafts.writes.map((w) => w.field)) })
      setCreated(true)
      return
    }

    close()
  }
```

Pass `submitDisabled={created}` and `onClosed={() => setCreated(false)}` to `CreateDialog`, and
render `<CreateTicketCustomFields control={form.control} fields={fields} fieldsPhase={fieldsPhase} />`
as the **last child**, after the Acceptance criteria `FormField`.

`fields ?? []` in `onSubmit` rather than a destructuring default on the prop — a destructuring
default costs a cyclomatic point in the component, where `??` inside `onSubmit` costs it in a
function with headroom.

**Measure `onSubmit` and report the number.** Expected ≈7 of 10. If it exceeds 10, extract the
`for` loop into a module-level `applyFieldErrors(errors, setError)` rather than disabling the rule.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/routes/CreateTicketDialog.test.tsx`
Expected: PASS — new **and** the seven pre-existing, with that file's original tests unedited.

Then `npm run lint && npm run typecheck && npm run test:unit`, and report the measured complexity
of `onSubmit`.

- [ ] **Step 5: Commit**

---

## Task 6: Wire the shell, and prove the wiring is real

**Files:**
- Modify: `src/routes/ProjectShellHeader.tsx`
- Modify: `src/routes/ProjectShell.tsx`
- Test: `src/routes/ProjectShell.test.tsx`

**Interfaces:**
- Consumes: task 5's `fields`/`fieldsPhase` props on `CreateTicketDialog`.

**This task is why SPRIN-88's review cost what it did.** That story shipped a feature that could be
unplugged from the app **in three places with 1094 tests green**; only one hop was caught, and only
by `no-unused-vars`. `ProjectShell.test.tsx` now carries a "real wiring" test for the sidebar's
fields. **Write the create-dialog equivalent, or this task has not been done.**

- [ ] **Step 1: Write the failing test**

Add to `src/routes/ProjectShell.test.tsx`, next to the existing fields wiring test — read that one
first and mirror its setup (it already mocks `@/lib/project-fields`).

```tsx
it('gives the create-ticket dialog the shell’s own custom fields', async () => {
  // The seam this pins is shell → header → dialog. Every hop is a prop pass with no branch, so
  // nothing else in the suite would notice one being dropped: the dialog renders fine without
  // fields, and lint sees a prop that is still "used" one level up.
  mockListFields.mockResolvedValue([field({ name: 'Customer ref' })])
  renderShell()

  await userEvent.click(await screen.findByRole('button', { name: 'New ticket' }))

  expect(await screen.findByLabelText('Customer ref')).toBeInTheDocument()
})
```

Match `renderShell`/`mockListFields`/`field` to whatever that file actually calls them. The
create trigger only renders once `ticketsPhase === 'loaded'`, so the tickets read must resolve.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/routes/ProjectShell.test.tsx`
Expected: FAIL — no `Customer ref` control, because nothing is threaded yet.

**Then break it deliberately to prove the test can fail for the right reason:** with the wiring in
place (after step 3), delete `fields={fields}` from `ProjectShell.tsx`'s `ProjectShellHeader` call
and confirm this test goes red. Restore it. Report that you did this.

- [ ] **Step 3: Implement**

`ProjectShellHeader` gains two props and forwards them. It has no defaults and adds **no branch** —
a prop pass is not a decision:

```tsx
type ProjectShellHeaderProps = {
  project: Project
  ticketsPhase: ReadPhase
  /** Forwarded to the create dialog (SPRIN-89), with NO default here — the defaults live in
   *  `CreateTicketCustomFields`, because a destructuring default costs a cyclomatic point and
   *  neither this component's consumer nor the dialog has one to spend. */
  fields: ProjectField[]
  fieldsPhase: ReadPhase
  onTicketCreated: (ticket: Ticket) => void
}
```

```tsx
<CreateTicketDialog
  projectId={project.id}
  fields={fields}
  fieldsPhase={fieldsPhase}
  onCreated={onTicketCreated}
/>
```

`ProjectShell` passes its existing `fields`/`fieldsPhase` — the same values it already hands
`TicketDetailDialog`. **This costs zero cyclomatic points** and `ProjectShell` is at exactly 10 of
10, so confirm with the `--rule` command that it is still 10 and not 11.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/routes/ProjectShell.test.tsx src/routes/ProjectShellHeader.test.tsx`
(the second only if it exists).
Expected: PASS.

Then `npm run lint && npm run typecheck && npm run test:unit`. Report `ProjectShell`'s measured
complexity.

- [ ] **Step 5: Commit**

---

## Self-review notes

Checked against the spec:

- §2 lint budget → task 5 (`ticketInput` extraction, measured, reported).
- §3 form state → task 5 (schema `.optional()`, `defaultValues`, `?? ''` in task 3).
- §4 bulk insert → tasks 1 and 2 (unit payload shape + live batch).
- §5 controls and phases → task 3 (all four phase rows tested).
- §6 wiring → task 6, with a deliberate break to prove the test fails.
- §7 AC4 and the latch → tasks 4 and 5.
- §8 test table → every row has a task.

Signatures used consistently across tasks: `valueRow`, `parseFieldValues`, `ticketFieldValueRows`,
`insertTicketFieldValues`, `FieldValuesDraft`, `CreateTicketCustomFields`, `submitDisabled`.
