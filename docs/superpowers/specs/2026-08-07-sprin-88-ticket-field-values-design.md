# SPRIN-88 — Custom field values on the ticket detail sidebar

**Story 3 of 6**, epic SPRIN-71 (custom fields). Epic design:
`docs/superpowers/specs/2026-08-05-sprin-71-custom-fields-design.md` §3.2, §4.2, §4.5, §5.
**Date:** 2026-08-07. Branch `sprin-88-ticket-field-values`.

This spec records the decisions the epic design left open, and the ONE place where following
it literally does not work. Everything measured here was measured on `86038e2`, not assumed.

---

## 0. What the epic design got right, and the one thing it did not

Checked against the live schema before designing, not after:

| Epic design claims | Live schema, measured 2026-08-07 | Verdict |
|---|---|---|
| `tickets_id_project_unique` exists | `UNIQUE (id, project_id)` | holds |
| `project_fields_id_project_unique` exists | `UNIQUE (id, project_id)` | holds |
| `project_fields_id_type_unique` exists | `UNIQUE (id, type)` | holds |
| Sidebar cyclomatic 9/10, dialog 10/10, shell 10/10 | 9, 10, 10 | holds |

Re-measured with `npx eslint <files> --rule '{"complexity":["error",1]}'`, which prints every
function's real number rather than only the ones over a threshold.

**What does NOT hold is §3.4's grant rule applied to this table** — see §3 below. The epic
design says "revoke the table's UPDATE and re-grant every writable column", and names
`field_type` as the sort of column immutability should be enforced on. Written that way here it
would make the story's own write path impossible. §3 states the conflict, the two ways out, and
which control replaces the grant.

**MIGRATION LETTERS: go by filenames, not by the epic design's letters.** SPRIN-91 shipped a
grants migration the epic design did not anticipate and it took the "B" slot
(`sprin-91-project-fields-insert.sql`). This story's file is
`docs/migrations/sprin-88-ticket-field-values.sql`; it is what the epic design calls "migration
B" and what story 5 will follow as "C".

---

## 1. Decision: values are read PER TICKET, not per project

`ticket_field_values` is read when a ticket's detail dialog opens, scoped to that one ticket.
The rejected alternative was a fifth project-wide read in `ProjectShell` alongside
`fields`/`fieldsPhase`.

- A project-wide read fetches every value of every ticket to render one dialog. The shell
  already carries four reads and the epic design's §4.4 budget was argued for a fourth, not a
  fifth.
- The detail dialog is already keyed `key={selected?.id ?? 'none'}` in `ProjectShell`, so it
  **remounts per ticket**. A per-ticket read therefore has a natural lifecycle with no
  invalidation logic to get wrong, and no risk of the previous ticket's values flashing under
  the new ticket's fields.
- Nothing outside the dialog needs a value. The board card, the backlog row and the settings
  tab all render definitions, never values.

**The read reuses `useTaggedRead`** (`@/lib/project-reads`) rather than growing a second
three-state read. That hook is where S4.6's "a failed read must not look like an empty list"
invariant is enforced, and this surface is the one where re-deriving it would be most tempting
and most damaging — see §4.

**Consequence: one parameter in `project-reads.ts` is renamed.** `useTaggedRead`'s first
parameter is called `activeProjectId`, and this story passes it a **ticket** id. The rename to
`scopeId` is positional-only — no call site changes, no test changes — and it is worth the
churn in a shared module precisely because the alternative is a correct call that reads like a
bug to the next person. The docblock gains one sentence naming the second scope kind. Nothing
about the hook's behaviour changes.

## 2. Decision: the write is an UPSERT, and "no value" deletes the row

Two functions in a new `src/lib/ticket-field-values.ts`:

- `setTicketFieldValue(...)` — `upsert` on the `(ticket_id, field_id)` primary key.
- `clearTicketFieldValue(ticketId, fieldId)` — `delete`.

`AC3` says clearing **deletes the row** rather than storing a null, and the epic design's §3.2
explains why that is structural rather than stylistic: `tfv_one_value_matching_type` insists a
value is present, so a row of nulls is not representable. The client cannot "clear" by writing
null even if it wanted to.

Rejected: **update-then-insert-on-miss**. Two round trips on first write, and two tabs that both
miss race into a `23505` that upsert simply does not produce. Rejected: **delete-then-insert**,
which loses the value outright if the insert half fails.

## 3. THE CONFLICT: upsert needs UPDATE on columns the epic design wanted frozen

PostgREST compiles `.upsert(row)` to `INSERT … ON CONFLICT (…) DO UPDATE SET c = excluded.c`
**for every column in the payload**, and Postgres requires UPDATE privilege on every column in a
SET list. The payload has to carry all five identity/type columns —
`ticket_id, project_id, field_id, field_type` plus the one value column — because they are what
an INSERT needs. So `grant update (value_text, value_number, value_date, value_option)` alone,
which is what §3.4 of the epic design implies, makes **every second write to a field fail with
42501**. The first write inserts; the second one updates and is refused.

Two ways out, and the choice is real:

1. **Grant UPDATE on all eight columns**, and let the *constraints* — not the grant — be what
   makes `field_type` immutable.
2. **Abandon upsert** for the update-then-insert path, keeping the narrow grant.

**Chosen: (1).** The grant is not the control here, and pretending otherwise would be the
comment-as-control failure this repo has already recorded:

- **`field_type` cannot be changed to a wrong value regardless of the grant.**
  `tfv_type_fk (field_id, field_type) references project_fields (id, type)` refuses any
  `field_type` that is not the definition's own — SQLSTATE `23503`. The only "change" the grant
  permits is writing the value it already holds.
- **The identity columns cannot leave the tenant.** `tfv_ticket_fk (ticket_id, project_id)` and
  `tfv_field_fk (field_id, project_id)` are composite, so a row cannot be re-pointed at another
  project's ticket or field; and `tfv_owner_update`'s `WITH CHECK` re-tests ownership on the
  post-image, so it cannot be re-pointed at another owner's project either.
- Option (2) would buy a narrower grant at the cost of a two-statement write with a live
  `23505` race, to defend a property two foreign keys already defend. That is a worse trade.

**This is only sound if it is proven rather than asserted**, so the migration ships with three
live tests it would fail without: a mismatched `field_type` earning `23503` on
`tfv_type_fk`; the AC5 cross-project field earning `23503` on `tfv_field_fk`; and AC4's
wrong-column-for-the-type earning `23514` on `tfv_one_value_matching_type`, one case per type.
Each asserts the **constraint name**, not only the SQLSTATE — `message` is the only channel
PostgREST exposes for constraint identity, and three different constraints here can all produce
`23503`.

**DELETE is granted table-wide**, because Postgres has no column-level DELETE and AC3 needs it.
`ticket_field_values` is the first table in this epic to hold a DELETE grant for
`authenticated`; `project_fields` still holds none, and story 6 is where that changes.

## 4. Decision: the phase is consulted before the list, and the failure is per-dialog

`fields` is `[]` while loading and when the read failed (epic design §4.5). The **values** read
adds a second phase over the same surface, and the two combine badly if left implicit: a field
whose value read failed renders an empty control that says, in the only language a control has,
"this ticket has no value for this field". That is S4.6's defect wearing a new face, and here it
is one keystroke from overwriting real data with a value the user was shown by mistake.

So `TicketCustomFields` renders **three** outcomes, in `firstUnready`'s order — failure, then
loading, then the controls:

- `failed` → a `LoadFailure`-style message with its own Retry, scoped to the section. It does
  NOT reuse the shell's `onRetry`: that reloads four project reads to fix one ticket's values.
- `loading` → a muted "Loading…", controls not rendered (and therefore not writable).
- `loaded` → the controls.

The **fields** phase is the shell's and is threaded in; the **values** phase is local. Failure
of either shows the failure. A local `useState` nonce drives the section's own Retry.

`LoadFailure`'s `resource` prop is a deliberately closed union (a documented security control —
an open `string` would let raw PostgREST text render into a `role="alert"`). It gains one member,
`'custom field values'`.

## 5. Decision: the renderer is a `Record<CustomFieldType, …>`, and `select` renders DISABLED

Per epic design §4.2, and per the Jira issue's own CRITICAL note: a map entry costs no
cyclomatic point, an `if`/`else` chain costs one per branch, and neither the sidebar (9/10) nor
the dialog (10/10) can pay. The map is `Record<CustomFieldType, …>`, so a sixth type is a
**compile error** rather than a field that silently renders nothing.

Four types get real editors, reusing what the sidebar already uses so a custom field looks like
a built-in one:

| Type | Control | Notes |
|---|---|---|
| `text` | `EditableText` | click-to-edit, the sidebar's own motif |
| `paragraph` | `EditableText multiline` | `<Textarea>`, as `description` uses |
| `number` | `EditableText numeric` | parsed by `parseFieldNumber`, see §6 |
| `date` | `<input type="date">` | native picker; `''` is the cleared state |
| `select` | **disabled `<select>`** | story 5 |

**`select` renders a control rather than nothing, and that is the AC.** AC1 says *each* of the
project's custom fields renders a control labelled with its name — and `select` fields are
creatable **today**, because SPRIN-91's add form offers all five types from
`CUSTOM_FIELD_TYPES`. Rendering nothing for one would be a field a user created and then could
not find. It is disabled because `project_field_options` does not exist until story 5, so there
is no legal value to offer: until `tfv_option_fk` lands, `value_option` would accept any string
at all, and shipping a free-text editor onto a column story 5 is about to constrain would strand
values that the option fk then refuses. Disabled is the honest state, not a placeholder.

## 6. Decision: number parsing is its own function, not `parseStoryPoints`

`parseStoryPoints` is whole-numbers-and-non-negative — the estimation rule, not an arithmetic
one. A custom `number` field is a `numeric` column and should take `-2.5` as readily as `3`. So
`parseFieldNumber` lives beside the write layer, rejects anything `Number()` cannot turn into a
finite number, and reports through the field's own error region. Reusing `parseStoryPoints`
would silently impose story-point semantics on every custom number in every project.

## 7. Decision: errors are PER FIELD, not per ticket

`TicketDetailSidebar` already has `setError(ticketId, message)`, which paints one banner for the
whole dialog. With several custom fields on screen that banner cannot say *which* one was
refused — the identical argument `StatusRow` and `CustomFieldRow` both record for owning their
own `role="alert"`. Each rendered field owns its error state and its own alert region.

## 8. Schema — `docs/migrations/sprin-88-ticket-field-values.sql`

The table is the epic design's §3.2 verbatim (typed columns, carried `field_type`, composite
fks, `tfv_one_value_matching_type` with its `else false`), plus the three things §3.2 did not
write out:

**RLS** — four owner-scoped policies through `projects`, all four written
`(select auth.uid())` and never the bare call. Baseline measured today:
**8 `auth_rls_initplan` warnings** outstanding on the older tables (`profiles`, `projects`,
`project_counters`, `sprints`, `tickets`, and three on `project_statuses`). This story adds
**zero**. They are SPRIN-75's to fix when every policy is rewritten to a membership check; do
not "make it consistent" with them.

**No `force row level security`** — same trap `project_fields` and `project_statuses` both
record: it reads as hardening and would break the SECURITY DEFINER paths.

**Grants** — the whole intended state restated in one block (a table-level REVOKE **cascades**
to column grants, so a partial reset is what invites the next author's partial reset), then
INSERT and UPDATE on all eight columns and DELETE on the table, per §3.

**One index: `(field_id)` — and it was WRONG. Corrected below; this is the record of it.**

The original reasoning was measured and still wrong, because it was measured from the wrong
catalog. It ran: the advisor flags three unindexed fks, all on `tickets`, and does *not* flag
`tickets_status_fk (project_id, status)` despite its only covering index appearing to be
`(project_id, number)` — therefore the advisor matches on the **leading column**. That came from
querying `pg_constraint` alone. `pg_indexes` was never read, and it holds
`tickets_project_status_idx ON tickets (project_id, status)`, an exact cover. The unflagged fk
was never evidence of a leading-column rule; it was evidence of an index nobody looked for.

**The real rule, re-derived and checked on five cases: the fk's column list must be a PREFIX of
some index's column list.** `tickets_epic_fk (parent_epic_id, project_id)` is flagged despite
`tickets_epic_idx (parent_epic_id)` existing — the same shape as the index this story wrote,
which settles it.

Applying the migration therefore added **four INFO lints**: `unindexed_foreign_keys` on all
three of `tfv_ticket_fk`, `tfv_field_fk` and `tfv_type_fk`, plus `unused_index` on
`ticket_field_values_field_id_idx`.

**There is no zero-lint answer**, and that is the actual finding: a brand-new table has either
unindexed foreign keys or unused indexes. `project_fields` reached zero only because
`project_fields_project_slug_unique (project_id, slug)` happens to both cover its one fk and be
used by `listProjectFields`. `ticket_field_values` gets no such luck — its only query is
`where ticket_id = $1`, which the PK already serves, so any index added here is for fk coverage
alone and is unused until story 6.

Three options, **open for David** at the point this spec was written:

1. **Cover all three** — `(ticket_id, project_id)`, `(field_id, project_id)`,
   `(field_id, field_type)`. Returns `unindexed_foreign_keys` to its 3-on-`tickets` baseline and
   trades it for three `unused_index` INFOs, which self-clear on first scan. Defensible on
   merit rather than as linter appeasement: this is the epic's highest-cardinality table,
   growing as tickets × fields, and all three fks cascade.
2. **One index, accept two INFOs** — widen `(field_id)` to `(field_id, project_id)`, a strict
   improvement at zero cost that kills one lint and still serves story 6's count-by-`field_id`.
   Record the other two as accepted with the measured reason. No dead indexes; permanently 2
   INFOs above baseline.
3. **No secondary index at all** — drop it; story 6 adds one alongside the query that first uses
   it. Three INFOs above baseline.

**Baseline for comparison, measured 2026-08-07 before this migration:** 3 unindexed-fk INFOs
(all on `tickets`) + 8 `auth_rls_initplan` WARNs on the older tables, and 1 unrelated
`auth_leaked_password_protection` WARN on the security side. Not zero, and not zero since before
SPRIN-79 — so "keep `get_advisors` at zero lints" is read in this repo as "add none", and this
story has not yet met even that.

## 9. Testing — the shapes most likely to ship this green and broken

Live assertions go in the **existing** `rls.integration.test.ts` and `tickets.integration.test.ts`
so the CI tripwire gap stays at **seven files**. Re-derive with
`npx vitest list --filesOnly | wc -l`, never a grep.

- **Fixture-shaped absence (AC6).** "A project with no custom fields renders the sidebar exactly
  as it does today" passes trivially against a fixture with no fields — including if
  `TicketCustomFields` threw and rendered nothing at all. **The AC6 test carries a positive
  control in the same test**: the same sidebar, same render, with one field, asserting the
  control IS there. Absence without a positive control is shape 4 of the green-for-the-
  wrong-reason list and is exactly the vacuous test SPRIN-86's review found.
- **`queryByRole` excludes `aria-hidden` subtrees**, so an absence assertion reports "absent" for
  a control still in the DOM and keyboard-reachable. Pair it with a raw DOM query.
- **A confound between `field_id` and `slug`.** Every fixture here must make them *different* —
  a fixture whose slug is the lowercased name makes two distinct production reads
  indistinguishable, which is precisely what SPRIN-87 spent a story breaking.
- **The value column and the type must not be confounded either.** A fixture where every field
  is `text` cannot tell "writes to the column the type calls for" from "always writes
  `value_text`". The unit tests cover all four writable types.
- **AC4 is five cases, one per type**, including `select` — and `select`'s case is the one that
  proves `else false` is unreachable rather than untested.

## 10. Review depth

Epic design §7 says one reviewer per story, and that stories 1/3/5 adding new RLS policies is
"the closest this epic comes" to a security-boundary diff without being one.

**This story is the strongest case of the three and gets more than one pass**, because it is the
first write to a newly-isolated table AND because §3 above deliberately declines to use a grant
as a control, resting instead on two foreign keys and a policy's `WITH CHECK`. That reasoning is
either right or it is a tenancy hole, and it is not the sort of thing to settle by reading. So:
one mutation-briefed whole-branch reviewer in its own worktree, one security review aimed
specifically at §3's argument, and a re-review of whatever fix wave they produce — the pattern
that found the sharpest defect of the last run. Not a fleet: SPRIN-75 is where that comes out.
