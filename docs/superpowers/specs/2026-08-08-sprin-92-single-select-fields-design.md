# SPRIN-92 — Single-select custom fields

Story 5 of 6 in epic **SPRIN-71** (custom fields). Depends on story 3 (`ticket_field_values`,
SPRIN-88), which is Done. Migration **D** — `docs/migrations/sprin-92-project-field-options.sql`.

Read `docs/superpowers/specs/2026-08-05-sprin-71-custom-fields-design.md` §3.3 first. **This
spec deliberately departs from it in one place** (§1.1) and corrects it in another (§1.4). Both
departures are recorded here rather than applied silently, which is this epic's own convention:
SPRIN-88's migration departed from §3.4 the same way and said why.

## The acceptance criteria

1. A `select` field's options are editable on Settings, in `position` order.
2. A ticket can hold one of its options and **only** one of its options — a value outside the
   list is rejected by the database (live test on `tfv_option_fk`).
3. Renaming an option's **label** changes no value row — proven by reading the value back.
4. **Deleting an option clears it from every ticket holding it, behind a confirm showing how
   many.** Refusing the delete instead would make any option that was ever used permanently
   undeletable.
5. The other four types are unaffected.

## 1. Schema — migration D

### 1.1 The table carries `project_id`, departing from epic §3.3

The epic defines `project_field_options` as `(field_id, slug, label, position)` with **no
`project_id`**. That serves the foreign key it exists for, but it cannot be *read* by this app.

`ProjectShell` reads through `useTaggedRead(activeProjectId, reloadNonce, fn)`, so **every list
function is `(projectId) => Promise<T[]>`**. Without `project_id` the options read would need
either a PostgREST embedded inner join (`project_fields!inner(project_id)`) or a second query fed
by the already-loaded fields list — and the epic's own §4.4 says "no new plumbing beyond a fourth
read". A denormalised tenancy column is the cheaper of the two, and it is not a new idea in this
schema: `ticket_field_values` already carries `project_id` for exactly this reason, which the
handover records as "a **tenancy** column, not a selectivity one".

```sql
create table project_field_options (
  project_id uuid not null,
  field_id   uuid not null,
  slug       text not null,
  label      text not null,
  position   int  not null,

  primary key (field_id, slug),
  constraint pfo_field_fk foreign key (field_id, project_id)
    references project_fields (id, project_id) on delete cascade,
  constraint pfo_label_nonempty check (btrim(label) <> '' and length(label) <= 40),
  constraint pfo_position_positive check (position > 0)
);

alter table ticket_field_values add constraint tfv_option_fk
  foreign key (field_id, value_option)
  references project_field_options (field_id, slug)
  on delete cascade;
```

**`project_id` is constrained, not merely present.** The composite fk
`(field_id, project_id) → project_fields (id, project_id)` makes it impossible for an option's
`project_id` to disagree with its field's. A denormalised column with no constraint is precisely
the drift this project keeps catching; this one cannot drift.

**No new unique constraint is required, and the column order is not free.**
`project_fields_id_project_unique unique (id, project_id)` **already exists** — SPRIN-90 added it
for `tfv_field_fk`, with a comment warning not to drop it as unused. `pfo_field_fk` therefore
references `(id, project_id)` in **that** order, matching `tfv_field_fk` exactly. Writing
`(project_id, id)` instead would demand a second unique constraint covering the same two columns
in the other order, for nothing. (An earlier draft of this spec did exactly that; it was caught
by reading the migration rather than the design doc.)

**There is deliberately no direct `references projects(id)` on `project_id`.** It would be
redundant — `project_fields.project_id` already references `projects`, and the cascade reaches
here transitively — and it would add a fourth unindexed-foreign-key advisor INFO for no control.
`ticket_field_values` declares `project_id uuid not null` with composite fks and no direct
projects reference for the same reason; this table matches it.

**`value_option` already exists** on `ticket_field_values` (SPRIN-88), and its
`tfv_one_value_per_type` check already requires `value_option is not null` for `'select'` and null
for the other four types. Migration D adds no column to that table — only `tfv_option_fk`.

### 1.2 What is unchanged from epic §3.3, and must stay unchanged

- **`tfv_option_fk` is on `(field_id, value_option)` → `(field_id, slug)`.** Slug-keyed, not
  keyed on a surrogate id, which is what makes **AC3 true by construction**: renaming a label
  rewrites no value row because no value row references the label. Same reasoning that keyed
  `tickets_status_fk` on `(project_id, slug)` in SPRIN-79.
- **`value_option` is its own column**, never a reuse of `value_text`. Sharing one column would
  make `tfv_option_fk` fire on every `text` and `paragraph` value and reject all of them. Under
  MATCH SIMPLE a null `value_option` skips the check — exactly what the other four types produce.
- **`on delete cascade` on `tfv_option_fk` is AC4.** `no action` — the default — would refuse the
  delete with `23503` and strand an option that could never be removed once used.

### 1.3 Grants

Table-wide revoke first, then re-grant. Per
[[column-revoke-cannot-hole-a-table-grant]], `revoke update (col)` against a table-wide grant is a
**silent no-op**, while a table-level revoke **cascades** to column grants — so the re-grant must
restate every column. A new table is also *born* with full CRUD for `anon` **and**
`authenticated`; "we never granted it" is not true and never was.

```sql
revoke insert, update, delete on project_field_options from authenticated, anon;
grant insert (project_id, field_id, slug, label, position) on project_field_options to authenticated;
grant update (label) on project_field_options to authenticated;
grant delete on project_field_options to authenticated;
```

**`update (label)` alone is what makes AC3 a database property rather than a convention.** A
patch touching `slug` earns `42501` before any policy is consulted, so no value row can be
orphaned by a rename. DELETE *is* granted here, unlike migration A, because AC4 needs it in this
story — and a live test proves it, so the grant is not widened without evidence.

`position` is insertable but **not updatable**: there is no reorder surface (epic §3.3), so a
writable `position` would be machinery with no caller.

### 1.4 Ordering — a correction to the epic

The epic says options are read in `position` order. **`position` alone is not a total order.**
Nothing makes it unique, and the client derives it as `max(position) + 1` from a list nothing
refetches, so two options can tie and PostgREST would return them in an arbitrary, unstable
order. Reads are therefore ordered **`(position, slug)`** — `slug` is unique per field and breaks
every tie. This is the identical defect `listProjectFields` already guards with
`(created_at, slug)`, and it is invisible until it reorders a user's list between reads.

### 1.5 RLS

Four owner-scoped policies mirroring `tfv_owner_*`, all written `(select auth.uid())` and never
bare `auth.uid()`. The baseline is **8 existing `auth_rls_initplan` warnings** (measured
2026-08-08, recorded in `CLAUDE.md`); this story must not add a ninth. `statuses_owner_delete`,
`project_fields` and `ticket_field_values` are the three working precedents in this very schema.

The policy reads **`project_id` and nothing else**, exactly as `tfv_owner_*` does. `field_id` and
`slug` are fk-governed — including across tenants, per
[[rls-with-check-precedes-fk-validation]]. That note matters for SPRIN-75 and is repeated in §7.

### 1.6 What to expect from `get_advisors`

The baseline as of 2026-08-08 is **1 security WARN and 14 performance lints**, recorded in
`CLAUDE.md`. The rule is **add no new lints**, not "reach zero" — that wording was corrected the
same day precisely so a migration story does not read a pre-existing lint as its own regression.

Two new foreign keys arrive with this migration, so measure rather than predict:

- **`pfo_field_fk` on `(field_id, project_id)`** — the primary key index is `(field_id, slug)`,
  which leads with `field_id`. SPRIN-88's migration records that the linter matches on the
  **leading column** rather than the full set, so this is expected to go unflagged.
- **`tfv_option_fk` on `(field_id, value_option)`** — `ticket_field_values` already carries three
  accepted INFOs, and this may well add a fourth.

Run `get_advisors` after applying, compare against the 14, and **record the delta in the
migration file** with either an index or an explicit acceptance. Do not silently absorb it, and do
not re-open the closed `(field_id)` index question — David settled that: keep the index, add
nothing, accept the INFOs.

## 2. Client contract

### 2.1 `src/lib/project-field-options.ts` (new)

Mirrors `project-fields.ts`, which is the closest sibling and already carries the reasoning.

- **`OPTION_COLUMNS` is named explicitly**, never a bare `.select()`. That is the class SPRIN-86
  turned into a user-visible defect (`· limit undefined` on every Kanban column), and a test
  asserts the exact string reaches PostgREST so a silent narrowing goes red.
- **`listProjectFieldOptions(projectId)` THROWS** rather than resolving to `[]`. `[]` is the
  common legitimate state — most fields are not `select` and most select fields start empty — so
  a silent empty would be indistinguishable from a failed read. Ordered `(position, slug)` per
  §1.4.
- **`createProjectFieldOption({ projectId, fieldId, label, existing })`** — one object parameter,
  T4 caps at 4. Derives the slug with the existing `uniqueSlugForName` against the field's own
  slugs, and `position = max(existing.position) + 1`. Tagged `'stale' | 'unknown'`, where
  `'stale'` is a `23505` naming the primary key. The constraint match is an **allow-list**, so a
  constraint added by a later story collapses to generic retry copy rather than a confident
  remedy that will not work.
- **`renameProjectFieldOption(fieldId, slug, label)`** — sends `{ label }` with
  `satisfies ProjectFieldOptionUpdate`. The generated row type offers every column, so
  `.update({ slug })` would otherwise **compile** and fail only at runtime against the live
  database, somewhere a mocked unit test never goes.
- **`deleteProjectFieldOption(fieldId, slug)`** — checks the affected row count **explicitly**,
  like `deleteProjectStatus` and `reorderProjectStatuses`, rather than leaning on `.single()`'s
  incidental zero-row error. The handover already flags `renameProjectStatus` as the odd one out
  for doing the latter; there is no reason to create a fourth instance.
- **`countTicketsHoldingOption(fieldId, slug)`** — `{ head: true, count: 'exact' }` against
  `ticket_field_values`.

### 2.2 `domain.ts` and `field-schemas.ts`

`domain.ts` gains the `ProjectFieldOption` **shape** and no new vocabulary constants — options are
user data, not a vocabulary, so this is the "contract for the shape" role the epic describes,
not the "source of the values" role.

`field-schemas.ts` gains `AddOptionSchema` and `RenameOptionSchema`: label trimmed, non-empty,
`≤ 40` — matching `pfo_label_nonempty` **exactly**, so the form's message and the constraint
cannot disagree about what is legal.

### 2.3 The fourth read

`ProjectShell` adds `useTaggedRead(activeProjectId, reloadNonce, listProjectFieldOptions)` and
threads `options` / `optionsPhase` beside `fields` / `fieldsPhase`. No other plumbing, per epic
§4.4.

## 3. Components

- **`src/routes/CustomFieldOptions.tsx` (new)** — the options list, the add form, and the remove
  confirm. Its own file rather than growth in `CustomFieldSettings.tsx`: one clear purpose, and it
  keeps the settings file inside budget (measured 2026-08-08: **170** counted lines of 400 —
  `max-lines` skips blanks and comments, so the raw 369 is not the number that matters).
- **`CustomFieldRow`** renders it beneath the field name when `field.type === 'select'`, and
  nothing otherwise. Options are inline under select rows — not behind a disclosure, and not in a
  dialog. A dialog would be the only settings write in this app behind one, and would reintroduce
  the `CreateDialog` generation-guard race SPRIN-89 paid a real defect to fix.
- **`CONTROLS.select`** in `TicketCustomFields.tsx` becomes a real `<select>`: a blank `—` choice
  **always first**, then the field's options in order. `ControlProps` gains `options`; the other
  four entries ignore it. The map stays a `Record<CustomFieldType, …>`, never an if/else chain —
  a map entry costs no cyclomatic point and neither `TicketDetailSidebar` (9/10) nor
  `TicketDetailDialog` (10/10) can pay one.
- **`CREATE_CONTROLS.select`** in `CreateTicketCustomFields.tsx` gets the same treatment. It
  renders disabled today for the same story-3 reason and must stop.

### 3.1 The blank choice, and clearing

`required` is out of this epic (§2.4), so every custom field is optional and the select needs a
way to express "no value". The blank `—` is that way, and selecting it routes to
`clearTicketFieldValue` — **not** a write of `''`, which would store an empty string that
`tfv_option_fk` would then refuse. A field with **no options yet** renders that single `—` choice
and nothing else.

### 3.2 The most important behaviour in this story

**When `optionsPhase` is not `loaded`, the select renders DISABLED** — story 3's honest
placeholder — rather than as an enabled control offering only `—`.

An empty option list from a *failed read* and an empty list from a field with *no options yet*
are the same value arriving for opposite reasons. An enabled empty select would quietly tell the
user this field has nothing to choose, which is a confident claim about a list we do not have.
That is S4.6's defect and the select is the easiest place in this epic to ship it.

### 3.3 Deleting an option (AC4)

The confirm states how many tickets hold the option before the user commits, mirroring SPRIN-80's
status delete, which is this project's working precedent for count-before-commit.

- The count is read **when the confirm opens**, not eagerly for every option on every render —
  otherwise a project with twenty options fires twenty counts per paint.
- **A failed count must not read as zero.** Zero is the number that unlocks a destructive action,
  so an unknown count **blocks** the delete and says so. This is the rule `useTicketCounts`
  already follows and AC4 of story 6 restates.

## 4. Testing

Written from the ACs before implementation.

| AC | Where | What stops it being vacuous |
|---|---|---|
| 1 | unit — `CustomFieldOptions.test.tsx` | DOM text **and** its container, scoped with `within`. A fixture with **tied `position` values** pins §1.4's `slug` tiebreak, which `position`-only ordering survives |
| 2 | **live** — `rls.integration.test.ts` | `23503` naming `tfv_option_fk`, with a **same-row positive control** — a legal option written successfully first. Without it, a blanket row-level refusal is indistinguishable from the fk working |
| 3 | **live** | Write a value, rename the label, read the value back, assert the stored **slug is unchanged**; plus `42501` on an attempted `slug` patch, which is what makes §1.3 a database property |
| 4 | unit + **live** | Live: the cascade genuinely clears value rows. Unit: a **failed** count blocks the delete rather than rendering zero |
| 5 | unit | The existing `CONTROLS` and `CREATE_CONTROLS` tests stay green with no edits to them |

**All live tests go in `rls.integration.test.ts`**, where every other epic-71 live test already
lives. The tripwire gap between `npm test` and `test:unit` therefore **stays 7** — a new
`*.integration.test.ts` file would move it and would need `CLAUDE.md` updated in the same commit.

### 4.1 What would most likely ship this green and broken

Both are mutation-test targets, not reading targets:

- **The blank `—` routes to a write of `''` instead of `clearTicketFieldValue`.** Every render
  test passes; the failure appears only against the real fk.
- **§3.2's gate does not actually disable.** A test asserting the control *exists* passes either
  way. Assert the `disabled` property under a `failed` phase specifically.

Note also [[querybyrole-hides-aria-hidden-from-absence-tests]]: `queryByRole` excludes
`aria-hidden`, so an absence assertion on an option needs a raw DOM query beside it.

## 5. What this hands to SPRIN-75

- `project_field_options` is born with `TRUNCATE` granted to both roles like every other table
  here, and TRUNCATE bypasses RLS. Not reachable through PostgREST, so it is defence-in-depth —
  but `revoke truncate` is one line and would keep this table out of the sweep. Same note
  SPRIN-88 recorded for `ticket_field_values`.
- The policies read `project_id` alone, so `field_id` and `slug` are fk-governed **including
  across tenants**. Under a membership model where read is broader than write, re-audit before
  narrowing those composite fks to single columns — that narrowing is exactly what the *wrong*
  version of [[rls-with-check-precedes-fk-validation]] would license.
- `deleteProjectFieldOption` filters on `(field_id, slug)` and leans on the policy's USING clause,
  a fresh instance of the SPRIN-64 class. Correct today; a viewer-role delete would not be caught
  here.

## 6. Considered and rejected

- **Options behind a disclosure toggle, or in a per-field dialog.** Both hide the thing the story
  exists to make editable; the dialog additionally reintroduces SPRIN-89's generation-guard race.
- **Reusing `value_text` for the option slug.** Would make `tfv_option_fk` fire on every text and
  paragraph value and reject all of them (epic §3.3).
- **Keying the fk on a surrogate option id.** Would rewrite every value row on a label rename,
  which is the opposite of AC3.
- **A separate "Clear" button beside the select.** A control shape nothing else in this app uses,
  and it makes clearing a two-target interaction.
- **Following epic §3.3's column list exactly.** Rejected in §1.1: it cannot be read by
  `useTaggedRead` without plumbing the epic's own §4.4 forbids.
