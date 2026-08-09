# SPRIN-93 — Delete a custom field, showing how many tickets hold a value

Story 6 of 6, epic **SPRIN-71** (custom fields). Epic design:
`docs/superpowers/specs/2026-08-05-sprin-71-custom-fields-design.md`, sections 2.3, 6, 8.

This story closes the epic. It is the delete control, its count-gated confirm, and the one
privilege that has been deliberately withheld since story 1.

---

## 1. What is already true, measured rather than assumed

Every claim below was read out of the live catalogue or the tree on 2026-08-09, not inferred
from the epic design — which has been wrong about this story's neighbours twice (it said
stories 2 and 4 needed no migration; story 2 did).

| Fact | How it was established |
|---|---|
| `authenticated` holds **no DELETE** on `project_fields` | `pg_class.relacl` = `authenticated=rDxtm/postgres` — no `d` |
| Its column grants are exactly `project_id/slug/type = a`, `name = aw` | `pg_attribute.attacl`, four rows |
| `fields_owner_delete` **already exists**, already `(select auth.uid())` | `pg_policies`, four `fields_owner_*` policies |
| Deleting a field already cascades its **values** | `tfv_field_fk` and `tfv_type_fk`, both `on delete cascade` |
| Deleting a field already cascades its **options** | `pfo_field_fk … on delete cascade` |
| A row count for a `field_id` **is** the ticket count | `ticket_field_values_pkey` is `(ticket_id, field_id)` |

**So AC3 needs no schema work at all.** The cascades were built by stories 3 and 5. The only
database change this story makes is a grant, and the policy that governs it is already in place
and already lint-clean — no new `auth_rls_initplan` WARN.

### The Jira issue says "No migration". It is wrong

> "No migration - the cascade is already in place from migration B."

Half right: the cascade is in place. But `sprin-90-project-fields.sql:150` revoked DELETE
table-wide and never granted it back, and `sprin-91-project-fields-insert.sql:66` says so in as
many words — *"DELETE IS DELIBERATELY NOT GRANTED. Story 6 grants it and proves it."* Widening a
privilege with no file recording it is the thing this project's rules exist to prevent, so this
story ships **migration E**.

### A defect found while reading, fixed here

`docs/sprintboard_phase1_schema.sql:1136-1137` shows only:

```sql
revoke insert, update, delete on project_fields from authenticated, anon;
grant  update (name) on project_fields to authenticated;
```

**SPRIN-91's `grant insert (project_id, slug, name, type)` was never added to the doc.** A
rebuild from that file produces a `project_fields` on which `authenticated` cannot insert at
all — every "add a custom field" would be a `42501`. This is the same class as the two missing
grant blocks session 62 found on `ticket_field_values` and `project_field_options`, one table
over, and the block's own comment already claimed *"stories 2 and 6 grant them, visibly"*.

Migration E restates the complete grant state, so the corrected doc block becomes a literal
copy of the migration and the two cannot drift again independently.

---

## 2. Migration E — grants only

`docs/migrations/sprin-93-project-fields-delete.sql`.

**David's decision, 2026-08-09: restate the whole grant state.** The alternative — a bare
`grant delete on project_fields to authenticated;` — is mechanically incapable of cascading
anything away, and was rejected because it leaves the complete privilege set unstated in any
one file, which is exactly how the schema doc above drifted.

```sql
revoke insert, update, delete on project_fields from authenticated, anon;
grant insert (project_id, slug, name, type) on project_fields to authenticated;
grant update (name) on project_fields to authenticated;
grant delete on project_fields to authenticated;
```

Four statements, and the order is load-bearing. A table-level `REVOKE` **cascades to column
grants** — *"the corresponding column privileges (if any) are automatically revoked on each
column of the table, as well"* (PostgreSQL `REVOKE` reference) — so the two restated grants are
not decoration. Writing only `revoke …; grant delete …` is the mistake migration B's header
predicted by name, and it would silently strip both the INSERT grant and `update (name)`.

`select` is **not** in the revoke, deliberately: `authenticated` needs it and `anon` reads zero
rows through `fields_owner_read` anyway.

DELETE is granted **table-wide** because Postgres has no column-level DELETE. That makes
`fields_owner_delete` the only thing standing in front of it — which is why §5's live tests
assert a stranger's delete removes **zero rows** rather than only that the owner's own delete
works. Both sibling tables (`ticket_field_values`, `project_field_options`) already carry a
table-wide DELETE on the same reasoning.

### The risk this shape carries, and what catches it

The restate form's one hazard is transcription: a mistyped column list silently drops a working
privilege. Two things catch it, and neither is new work.

1. **The migration file carries its own catalogue verification queries**, as its siblings do —
   `pg_class.relacl` must show `d` for `authenticated`, and `pg_attribute.attacl` must still show
   the four column rows.
2. **The existing SPRIN-91 tests are the regression detector.** `rls.integration.test.ts` already
   proves an owner can insert a field and rename one. If the restate drops either grant, those go
   red — they are the positive controls for this migration, and they were written before it.

---

## 3. Data layer — `src/lib/project-fields.ts`

Two functions, both mirroring `project-field-options.ts`'s equivalents, which are this project's
working precedent for count-before-commit.

```ts
export async function deleteProjectField(id: string): Promise<FieldWriteResult<void>>
export async function countTicketsHoldingField(fieldId: string): Promise<number>
```

**`deleteProjectField` counts its own affected rows** — `.select('id')` then `length !== 1` →
`'stale'` — rather than leaning on `.single()`'s incidental zero-row error. RLS **filters** a
delete rather than raising on it, so a cross-tenant or already-deleted row comes back as a
successful zero-row delete unless something counts. This is the third time this project has had
to state it (`deleteProjectStatus`, `deleteProjectFieldOption`) and the second time a review
found the `.single()` form and asked for it.

**`countTicketsHoldingField` THROWS**, on a query error and on a `null` count alike. It does not
resolve to zero. **Zero is the value that UNLOCKS the destructive action**, so a failed count
reported as zero would offer a delete whose blast radius the user was told was nil — AC4,
verbatim, and the rule `ticketCountsByStatus` and `countTicketsHoldingOption` already follow.

No `distinct` and no join: the primary key is `(ticket_id, field_id)`, so one row per ticket per
field, and `count: 'exact'` with `head: true` over `.eq('field_id', …)` **is** the ticket count.

---

## 4. UI

### Placement — a new file, and the reason is measured

`CustomFieldSettings.tsx` counts **331 lines against the 400 budget** (`max-lines`, with
`skipBlankLines`/`skipComments`, measured with `npx eslint --rule`). The option-delete precedent
(`OptionDeleteDialog` + `OptionDeleteControl`) is roughly **95 counted lines**. Putting the field
equivalent in that file would redden the gate.

So the delete UI is a new file, **`src/routes/CustomFieldDelete.tsx`**, exporting one component,
`CustomFieldDeleteControl`. That mirrors `CustomFieldOptions.tsx`, which is its own file for the
same reason, and leaves `CustomFieldSettings.tsx` at roughly 335.

This is a placement decision made on a measurement, not a preference. It is recorded because a
later reader will otherwise wonder why the field's delete lives apart from the field's row while
the status delete lives inside `StatusRow.tsx` — the answer is 69 lines of headroom.

### Shape — `OptionDeleteDialog`'s, deliberately

```
CustomFieldDeleteControl        the Remove button + confirm-open state
  └── FieldDeleteDialog         the AlertDialog, the lazy count, the refusal
```

Four properties carried over from the option precedent, each of which was paid for there:

- **The count is read lazily, on the `open` transition — never on render.** A project with many
  fields must not fire one count query per field per paint. Only the field whose confirm was
  actually opened is counted.
- **`FieldCountState` is three-valued** — `'counting' | { count: number } | 'failed'` — not
  `number | null`. `null` would make "the read failed" and "zero tickets hold it" the same value.
- **`known` is the only thing that unlocks the destructive button.** An unknown count must never
  be able to impersonate zero.
- **The count resets to `'counting'` on the way OUT.** The component stays mounted while closed,
  so without the reset a stale count from the last open flashes as already-known on the next one,
  ahead of the fresh fetch.

### Copy

| Surface | Text |
|---|---|
| Trigger | `Remove`, `aria-label={`Remove ${field.name}`}` |
| Title | `Remove {field.name}?` |
| Description, count known | `N ticket(s) will lose this value. This can't be undone.` |
| Description, count unknown | `This can't be undone.` |
| Failed count | `Could not check how many tickets hold this field. Try again.` (`role="alert"`) |
| Refusal, `'stale'` | `This field no longer exists — refresh the page to see the current list.` |
| Refusal, `'unknown'` | `GENERIC_CREATE_ERROR` |

`'stale'` gets its own sentence rather than the generic retry copy because it is **reachable and
its remedy is different**: a zero-row delete means another tab already removed this field, and
retrying reproduces it forever. Telling that user to "try again" is telling them to repeat an
action that fails identically every time.

The description deliberately says nothing about the field's **options** also being deleted. AC2
asks for the number of tickets that hold a value, and that is the number a user is deciding on;
a second clause about option rows would describe bookkeeping the user never sees.

---

## 5. Wiring, and the defect class it belongs to

`onFieldDeleted` runs the length of the shell:

```
ProjectShell → Outlet context → SettingsTab → CustomFieldSettings
             → CustomFieldBody → CustomFieldList → CustomFieldRow → CustomFieldDeleteControl
```

**That is a seven-hop prop chain, and this exact class produced five of SPRIN-92's six findings**
— a wire that could be dropped, crossed or defaulted with the entire suite green. Two mitigations,
both mandatory:

1. **The prop is REQUIRED at every component in the chain — no default value anywhere.** An
   unplugged wire is then a `TS2741` compile error rather than a silent no-op. Session 61 also
   measured that removing a default *lowers* cyclomatic complexity, so this costs nothing.
2. **An explicit hop test at each level**, because requiredness catches a *missing* wire and not a
   *crossed* one. `onFieldDeleted` and `onFieldUpdated` have different signatures
   (`(id: string)` vs `(field: ProjectField)`), so the compiler does catch that particular swap —
   but `onFieldDeleted` and a future same-signature sibling would not be caught, and
   [[a-deletion-mutation-cannot-find-a-crossed-wire]] is on the record here.

### The shell reducer patches TWO lists

```ts
const onFieldDeleted = (id: string) => {
  fieldRead.patch(project.id, (fs) => fs.filter((f) => f.id !== id))
  optionRead.patch(project.id, (os) => os.filter((o) => o.field_id !== id))
}
```

The second patch is not tidiness. `pfo_field_fk` cascades, so the database has **already** removed
those option rows; leaving them in the shared list would make the client's copy disagree with the
database. `options` is read by `CreateTicketCustomFields` and `TicketDetailSidebar` as well as the
settings tab, so the staleness is not confined to the surface that caused it. This mirrors
`onSprintCompleted`, the existing precedent for one event patching two of the shell's lists.

`ProjectShell` is at **cyclomatic 10 of 10** — measured again for this story, not recalled. The
reducer is a `const` arrow with two statements and no branches, so it costs the component zero
points, the same way `onFieldCreated` and the three option reducers do. **This must be re-measured
after the edit, not assumed from the precedent.**

---

## 6. Tests

Written from the ACs before implementation. Live assertions go in the **existing**
`rls.integration.test.ts` so the CI tripwire gap stays at **seven files**.

### The tripwire that must go red first

`rls.integration.test.ts:1778` — *"an authenticated owner still holds no DELETE on their own
fields"* — asserts `42501` on the owner's own delete. **This is story 6's tripwire and migration E
is what fires it.** It is replaced, not deleted: deleting it is the tidy-looking mistake, since
half the test's body no longer matches its name.

### Live (`rls.integration.test.ts`)

| Assertion | Why it is not vacuous |
|---|---|
| Owner A deletes their own field | row count 1 — the positive control for every row below |
| Stranger B's delete removes **ZERO rows** | RLS **filters**; `error === null` would pass with the policy deleted |
| `anon`'s delete → `42501` **and** `/permission denied/` | the code alone cannot say whether the grant or the policy refused |
| Deleting a field removes its `ticket_field_values` rows | AC3, through the **app role**, not `adminClient` |
| Deleting a field removes its `project_field_options` rows | AC3's other half — the cascade story 5 built |
| A's INSERT and rename still work | the migration's own regression detector (§2) |

### Unit

- `project-fields.test.ts` — the exact filters reaching PostgREST; zero rows → `'stale'`; an
  error → `'unknown'`; `countTicketsHoldingField` throws on error **and** on a `null` count.
- `CustomFieldDelete.test.tsx` — the count is on screen before the button unlocks; the button is
  disabled while `'counting'` and while `'failed'`; a failed count shows its alert; a zero count
  is deletable (AC5); the count resets between opens.
- `CustomFieldSettings.test.tsx` — the row renders the control, and the callback reaches it.
- `ProjectShell.test.tsx` — the reducer removes the field **and** that field's options, and
  leaves another field's options alone.
- `SettingsTab.test.tsx` — the context's `onFieldDeleted` is the one that arrives.

### The failure modes most likely to ship this green and broken

- **Fixture-shaped absence.** "The delete control is absent" passes on a project with no fields
  even if the whole section failed to render. Every absence assertion carries a positive control
  in the same test.
- **`queryByRole` excludes `aria-hidden` subtrees**, so an absence test reports "absent" for a
  control still in the DOM and keyboard-reachable. Pair it with a raw DOM query.
- **A count of `0` and a failed count must not be assertable by the same query.** The whole of
  AC4 is that these are different states; a test that reads only the button's `disabled` cannot
  tell them apart, so the alert text is asserted too.

---

## 7. Review depth

**One reviewer, briefed to mutate rather than read** — the epic design's own call for all six
stories, and the project's review-depth rule.

The honest caveat: this story widens a **privilege**, which is closer to the security boundary
than the epic's other five. It is not an RLS *rewrite* — `fields_owner_delete` was written by
story 1, is unchanged here, and is already lint-clean — and the widening is covered the way
SPRIN-85 covered its GRANT: by making the refusal a **live test with a positive control on the
same row**. A security pass runs at the end of the build regardless, per autopilot.

## 8. What this hands to SPRIN-75

Recorded on the Jira issue and repeated here because it is the trap this epic keeps re-finding:

**The delete guard reads a count to decide whether to offer a destructive action, so it leans on
a policy's breadth.** Under a membership model where **read is broader than write**, a
non-writing member would be shown a truthful count and an enabled Remove button for a field they
cannot delete — and **the isolation suite would not flag it**, because the suite tests the
policy, not the guard. This is the SPRIN-64 trap in a new place. Re-audit the guard, not only the
policies.
