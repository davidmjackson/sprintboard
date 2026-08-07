# SPRIN-89 — Set custom field values when creating a ticket

Story 4 of 6 in epic **SPRIN-71**. Epic design:
`docs/superpowers/specs/2026-08-05-sprin-71-custom-fields-design.md` (§6, story 4).

**No migration.** Verified rather than assumed: `docs/migrations/sprin-88-ticket-field-values.sql`
already grants `insert` on all eight columns of `ticket_field_values` to `authenticated`
(line 278), so the write this story performs needs no new privilege. The four ACs that touch the
database are satisfied by constraints and grants that are already live.

---

## 1. What exists, and what this story adds

SPRIN-88 built the whole value layer and this story is mostly assembly:

| Already built (SPRIN-88) | Reused here |
|---|---|
| `parseFieldValue(type, raw)` → write \| clear \| message | yes, unchanged |
| `VALUE_COLUMN`, `FieldValueWrite` | yes, unchanged |
| `setTicketFieldValue` (upsert, one row) | **no** — see §4 |
| `applyValueWrite` (local list reducer) | its row builder is extracted and shared |
| `TicketCustomFields` (sidebar controls) | **no** — see §5 |

New: a control block on the create dialog, a bulk insert, and the partial-failure state AC4
specifies.

## 2. The measured lint budget

`CreateTicketDialog.onSubmit` measures **8 of 10** cyclomatic —

```
npx eslint src/routes/CreateTicketDialog.tsx --rule '{"complexity":["error",1]}'
  58:3  Async function 'onSubmit' has a complexity of 8.
```

— which matches the figure on the Jira issue. (Recorded because the equivalent figure on
SPRIN-86's issue was stale by four points, and re-measuring is now the rule.)

Two points is not enough. AC4 needs two new branches in `onSubmit` (a parse failure and a write
failure), which lands it at exactly 10 of 10 — passing, but leaving the file in the state
`docs/HANDOVER.md` already flags as a hazard on `TicketDetailDialog` and `ProjectShell`: one added
branch reddens the gate for whoever comes next.

**So the fixed-field mapping is extracted first**, into a pure `ticketInput(parsed)` local to
`CreateTicketDialog.tsx`. It carries five of the eight points (`description?.trim() || undefined`
is two, `acceptanceCriteria?.trim() || undefined` is two, the `storyPoints` ternary is one),
taking `onSubmit` to 3 before the new work and to **6 after** it — two new branches plus the `??`
that §3 spends to decouple the parse from `defaultValues`.

That extraction is pure motion, and it is protected by a test that already exists and is not being
edited: `CreateTicketDialog.test.tsx`'s "creates a ticket with parsed fields" asserts
`toHaveBeenCalledWith` against the complete seven-key object. If the mapping changes, that test
goes red. This is the "refactor under an unedited test file" discipline — the unedited suite is
the evidence.

## 3. Where the draft values live: **react-hook-form**, as a record

`CreateTicketSchema` gains `custom: z.record(z.string(), z.string()).optional()`, with
`defaultValues.custom = {}`. Each control registers as `custom.<field.id>`.

**Two arguments, and `.optional()`, both measured rather than recalled.** This project is on
**zod 4**, where `z.record` takes a key schema and a value schema. And `onSubmit` calls
`CreateTicketSchema.parse(values)`, which **throws** — verified by running it — when `custom` is
absent. A required `custom` would therefore make the whole submit path depend on
`defaultValues.custom = {}` continuing to exist, and the failure mode of deleting that line is a
rejected promise and a dialog that silently does nothing. `.optional()` plus `parsed.custom ?? {}`
removes the coupling for one cyclomatic point, which the §2 budget can afford. The default is still
supplied, because the inputs need it to stay controlled — but nothing now *depends* on it.

**Keyed by `id`, not `slug`.** `field_id` is what the value row's foreign key stores; the slug is
a second identifier that would have to be mapped back. Field ids are uuids, which contain no `.`,
so they are safe as react-hook-form path segments.

**Why the form and not a local `useState`.** The alternative — a `useState` record cleared through
`CreateDialog`'s `onClosed` hook — was rejected because the reset becomes something a maintainer
has to *remember*. `CreateDialog` already calls `form.reset()` on every open-state transition, so
a value living in the form is cleared on close, on reopen and after a successful create, correctly
and for free. A value living beside the form is cleared only while that one `onClosed` line
survives, and its failure mode is silent: reopening the dialog would show the previous draft's
custom values sitting under blank fixed fields. Form state also gets `FormMessage` error rendering
and the submit-disabled-while-submitting behaviour for nothing.

**Controls read `field.value ?? ''`.** `form.reset()` restores `custom` to `{}`, at which point a
registered path has no value and a bare `value={field.value}` would flip the input from controlled
to uncontrolled mid-life. Seeding `defaultValues.custom` from the field list instead was rejected:
`useForm`'s defaults are captured once, so a field added on the Settings tab in another tab of the
same session would not appear in them.

**Stale keys are ignored, not cleaned.** If a field is deleted while the dialog is open, its entry
stays in the record. Nothing reads it: §4's parse iterates the *definitions list*, never the
record's keys, so a value can only be written for a field that currently exists.

## 4. The write: **one bulk `.insert()`**, not N upserts

```ts
insertTicketFieldValues(rows: TicketFieldValueRow[]): Promise<ValueWriteResult>
```

in `src/lib/ticket-field-values.ts`.

**A deviation from the Jira issue, recorded.** The issue says the helper belongs "in a helper in
`project-fields.ts`". It goes in `ticket-field-values.ts` instead: `project-fields.ts` owns field
*definitions*, and every piece of value machinery this helper sits beside — `setTicketFieldValue`,
`parseFieldValue`, `VALUE_COLUMN` — is in `ticket-field-values.ts`. Read as a module-naming slip
rather than a design instruction.

**`insert`, not `upsert`.** `createTicket` has just returned a brand-new ticket id, so no value row
for it can exist and `ON CONFLICT DO UPDATE` is unreachable. A plain INSERT also needs only the
INSERT privilege, where an upsert compiles a SET list and demands UPDATE on every payload column —
narrower privilege for an identical result. `setTicketFieldValue`'s upsert stays exactly as it is;
it is the right shape for the sidebar, where a row genuinely may already exist.

**One statement, not one per field.** N sequential writes would cost N round trips and would make
a *partial* values result representable — some fields saved, some not, with nothing in the codebase
that cleans up or retries. A single statement is all-or-nothing, so the only outcomes are "every
value saved" and "no value saved", and AC4's message is truthful in both.

**Every row must carry all eight keys, and that is a trap with a test.** PostgREST rejects a bulk
insert whose objects have differing keys (`PGRST102`, "All object keys must match"), and rows for
different field types naturally differ — a `text` row wants `value_text`, a `date` row wants
`value_date`. So each row spells out all four value columns, three of them `null`. That is exactly
the shape `applyValueWrite` already constructs, so its row literal is extracted as

```ts
valueRow(keys: { ticketId, projectId, fieldId }, write: FieldValueWrite): TicketFieldValueRow
```

and shared by both. One unit test asserts every row in the payload carries all eight keys, and one
**live** test inserts a multi-row, multi-type batch — because a mocked client cannot see PGRST102,
and this property is invisible until it meets the real PostgREST.

**Zero rows means no request at all.** `insertTicketFieldValues([])` returns `{ ok: true }` without
touching the network. That is AC3 stated as code rather than as a comment, and it keeps the common
case — a project with custom fields where the user filled none — at one round trip.

## 5. The controls: a second map, deliberately

`src/routes/CreateTicketCustomFields.tsx`, rendered as the last child inside `CreateDialog` (AC1).

It does **not** reuse the sidebar's `CONTROLS` map. That one is built on `EditableText`, a
click-to-edit motif that commits each change immediately — correct for a detail sidebar editing a
row that exists, wrong for a create form where every other field is a plain always-editable input
and nothing is written until Create is pressed. So this map renders `Input`, `Textarea`,
`<input type="date">` and a disabled `<select>`, each wrapped in the
`FormField`/`FormItem`/`FormLabel`/`FormControl`/`FormMessage` chrome the dialog's six fixed fields
already use — a custom field looks like a built-in one, which is the same goal the sidebar map has
and the reason the two differ.

It is a second place a sixth field type must be handled, so it carries the same forcing device:
`satisfies Record<CustomFieldType, …>` makes a sixth type a **compile** error rather than a control
that silently renders nothing.

`select` renders **disabled**, matching the sidebar and for the same reason — `project_field_options`
does not exist until story 5, so a free-text editor would strand values that `tfv_option_fk` will
later refuse. A disabled control cannot produce a value, so `select` fields contribute nothing to
the write.

**This component owns the phase decision and the prop defaults.** `fields = []` and
`fieldsPhase = 'loaded'` default *here*, not at `CreateTicketDialog` — a destructuring default costs
a cyclomatic point and the dialog cannot pay one. It also means a standalone
`<CreateTicketDialog projectId="p1" />` renders exactly as it does today, which is what keeps
`CreateTicketDialog.test.tsx`'s seven existing tests passing **unedited** — the evidence for AC5.

Ordering mirrors `TicketCustomFieldsBody`:

| `fieldsPhase` | `fields` | Renders |
|---|---|---|
| `loaded` | `[]` | nothing (AC5) |
| `failed` | — | a non-blocking notice, and no controls |
| `loading` | — | `Loading…` |
| `loaded` | non-empty | one control per field |

**Consulting the phase is mandatory, not decorative.** `fields` is `[]` both when the project has
none and when the read failed — the exact ambiguity `ProjectShellContext`'s own docblock warns
about. Ignoring it would render a failed read as "this project has no custom fields", which is the
S4.6 defect this codebase has already removed twice.

**A failed fields read does not block ticket creation.** Custom fields are optional metadata; a
read failure must not cost the user the ability to file a ticket. The notice says so and points at
the remedy SPRIN-88 already shipped: set them on the ticket afterwards. This is deliberately weaker
than `ProjectShellHeader`'s gate on `ticketsPhase`, which hides the create trigger outright —
there, a failed *tickets* read means a created ticket would be invisible, and invisible creates
produce duplicates. Nothing is invisible here.

## 6. Wiring

`ProjectShell` → `ProjectShellHeader` → `CreateTicketDialog` → `CreateTicketCustomFields`.

`ProjectShell` sits at exactly 10 of 10 cyclomatic and `ProjectShellHeader` forwards two more
props. Both cost **zero** points: passing a prop is not a branch. This is the same measured
argument SPRIN-88 used to hand `fields`/`fieldsPhase` to `TicketDetailDialog` from the same file.

No `onRetryFields` is threaded. The sidebar takes one because its notice offers a Retry; here the
notice offers none, because the dialog is modal furniture over a shell whose Board and Backlog
already carry the Retry for this read, and a Retry that reloads four project reads from inside a
create form is the wrong place to put it.

## 7. AC4 — the partial-failure state

The order of operations is **parse everything, then write the ticket, then write the values**:

```
parseFieldValues(fields, parsed.custom)   →  per-field messages, and NOTHING is written
createTicket(ticketInput(parsed))         →  root error, and no values are attempted
insertTicketFieldValues(rows)             →  the ticket stands; report the unsaved fields
```

Parsing first is what stops a mistyped number ("Numbers only") from creating a ticket and *then*
failing — the only outcome under which the user loses nothing is the one where the refusal happens
before any write.

On a values failure the dialog:

1. **fires `onCreated`** — the ticket is real and must appear on the board; withholding it would be
   the invisible-create defect;
2. **does not close**;
3. shows a root-level message naming the ticket and every field that did not save:
   `Created MP-12, but couldn't save: Severity, Due date. Set them on the ticket.`
   (`createTicket` does a bare `.select()`, so the returned row carries `key`.)

### The latch, and why it is not scope creep

That state is novel: a dialog holding a form whose submit has **already succeeded**. Pressing
Create again creates a *second* ticket. Everywhere else in this dialog an error means nothing was
written and retrying is exactly right, so the semantics invert here and the existing affordance
becomes actively harmful — the user retries, gets duplicate tickets, and still has no values.

`CreateDialog` therefore gains one optional prop, `submitDisabled?: boolean`, forwarded to
`SubmitButton` as `disabled={isSubmitting || submitDisabled}`. It defaults to `false`, so the other
two Create dialogs are unchanged. The remaining action is closing the dialog, which is the correct
one: the ticket exists and its values are set on the sidebar.

This is four lines of shared code and it is not stated by AC4. It is recorded here as a deliberate
widening rather than smuggled in, because "duplicate tickets from a create the user could not see
the result of" is a class `ProjectShellHeader`'s own docblock already argues about at length — the
codebase has decided this class matters.

## 8. Tests

Acceptance tests are written from the ACs before implementation.

| AC | Test | Where |
|---|---|---|
| 1 | one control per field, labelled by `name`, **positioned after** Acceptance criteria | `CreateTicketCustomFields.test.tsx` |
| 2 | filling values calls `createTicket`, then inserts rows carrying the right column per type | `CreateTicketDialog.test.tsx` |
| 3 | an empty field contributes no row; **all** empty issues no request at all | both |
| 4 | write fails → `onCreated` fired, dialog open, message names the fields, submit disabled | `CreateTicketDialog.test.tsx` |
| 5 | the seven existing tests pass **with the file unedited** | `CreateTicketDialog.test.tsx` |

Plus, not derived from an AC:

- **every row in the payload carries all eight keys** (unit) — the PGRST102 property of §4;
- **a multi-row, multi-type batch inserts against the real database** (live) — the same property
  where it is actually enforced. A mocked client cannot see it.
- `parseFieldValues` directly: a bad number blocks the whole submit; a stale record key is ignored.

Two shapes to avoid, both recorded in memory from this project:

- `toHaveTextContent` with a bare string is a **substring** match, so an additive reword survives
  it. Assert exact strings or anchored regexes.
- `getByText` matches inside an `aria-hidden` subtree, so it cannot prove a control is reachable.
  Pair a text assertion with a role query.

## 9. Decisions recorded, with what was rejected

| Decision | Rejected alternative | Why |
|---|---|---|
| Values in RHF `custom` record | local `useState` + `onClosed` | reset becomes correct-by-construction, not remembered |
| One bulk `insert` | N `setTicketFieldValue` upserts | one round trip; no partial state to represent |
| `insert` | `upsert` | no conflict is possible on a new ticket; narrower privilege |
| Helper in `ticket-field-values.ts` | `project-fields.ts` (as the issue says) | that module owns definitions, this one owns values |
| A second control map | reusing the sidebar's `CONTROLS` | click-to-edit is wrong for a create form |
| Extract `ticketInput` | let `onSubmit` sit at 10/10 | 10/10 passes but hands the next story a red gate |
| `submitDisabled` latch | accept the duplicate-create | retrying an error is right everywhere else here |
| Notice on a failed fields read | block the create; or ignore the phase | ignoring it renders a failed read as "no fields" |
