# SPRIN-71 — Custom fields

**Epic:** SPRIN-71 (Rung 3.3)
**Depends on:** SPRIN-72 (per-project statuses) and SPRIN-73 (Kanban) — both complete
**Blocks:** nothing structurally. SPRIN-75 must re-audit everything here against the
membership model, as it must for every Rung 3 epic.
**Date:** 2026-08-05

This is an **epic-level** design covering six stories, not a single story's spec. Each story
is one branch and one small PR. Where a story has a measurement to take before writing code,
this document says so rather than guessing.

---

## 1. What this epic is

A project defines **extra fields on its tickets** beyond the fixed schema. They are set up on
the Settings tab, and they appear on the create-ticket dialog and the ticket detail sidebar.

The architectural rule is fixed by `CLAUDE.md` and is not negotiable:

> Core ticket fields stay real columns. `story_points`, `assignee_id`, `status` etc. are
> first-class and must remain so. Custom fields are **additive** — new tables alongside,
> never a reshaping of `tickets`.

This is what Jira itself does: system fields are columns, only custom ones go in a flexible
store. It is the right end state, not a shortcut to be tidied up later. **A future reader will
be tempted to "unify" this by moving the system fields into the same store. That is the wrong
direction** and would cost query performance, type safety and every existing index.

`tickets` is not touched by any migration in this epic. That is checkable, and story 1's AC
list makes it checkable rather than merely stated.

## 2. The four decisions the epic demanded, and their reasons

### 2.1 Five field types: `text`, `paragraph`, `number`, `date`, `select`

`text` is single-line, `paragraph` is multi-line. They share one storage primitive and differ
only in widget (`<Input>` vs `<Textarea>`) and length cap (255 vs 2000, the latter matching
`description` and `acceptance_criteria` on the existing create dialog). Jira splits these the
same way ("Text Field (single line)" / "(multi-line)").

Checkbox and multi-select are **out of scope**. Multi-select needs a second value shape (an
array, or a row-per-value key change) and buys nothing the single-select does not already
demonstrate.

### 2.2 Values are stored in TYPED COLUMNS, one per primitive

Rejected alternatives, and why:

- **A `jsonb` blob on `tickets`** — forbidden outright. It reshapes `tickets`, which §1
  prohibits in as many words. It also has no real type, so `{"due": "not-a-date"}` is valid
  `jsonb` and "validate at both edges" collapses to zod alone.
- **A single `text` column, cast on read** — still additive, and the simplest table of the
  three, but every number and date becomes a string the database cannot check. `'2026-13-45'`
  stores fine and ordering is lexicographic, so `'10'` sorts before `'9'`.

Typed columns keep the second edge real: a date is a `date`, a number is `numeric`, and the
database refuses the rest.

### 2.3 Deleting a definition CASCADES its values; the TYPE is IMMUTABLE

Deleting a field deletes its values via `on delete cascade`, behind a confirm dialog that
shows how many tickets hold a value — the pattern SPRIN-80 already built for deleting a
status.

Refusing to delete a field that holds values was rejected: there is no in-app way to bulk-clear
values, so such a field would become permanently undeletable. That is the strand-the-user
failure the epic already rejected once, for hard WIP limits.

The **type can never change after creation**. Name and (for a select) options can. Retyping is
therefore unrepresentable rather than merely discouraged, mirroring `project_type`'s
immutability from SPRIN-82.

**§2.2 and §2.3 are ONE decision, not two.** Because a `CHECK` body may not contain a
subquery, the value row carries a copy of its definition's `type` so the "populated column
matches the type" check can be written at all. A denormalised copy is only sound while the
original cannot change — so immutability is what makes typed columns implementable, and a
future story that introduces retyping must revisit the storage design, not just add an
`UPDATE`.

### 2.4 `required` is NOT in this epic

The Jira issue lists `required` among a definition's attributes. It is omitted, and the reason
is structural rather than effort.

**A required field's violation is an absent row.** No `CHECK` can see it — a constraint fires
on a row that exists, and the whole failure mode here is that no row exists. The only database
enforcement available is a trigger on `tickets` that counts sibling rows in
`ticket_field_values`: exactly the shape that broke the cascade in SPRIN-80, where a fresh SPI
snapshot hides rows the same statement is removing.

That leaves zod alone, and `CLAUDE.md` lists "validate at both edges" as non-negotiable. A
client-only "required" is a promise the database will not keep.

**If it is ever built**, the honest framing is the WIP-limit one: *soft* — the create dialog
asks for it, nothing refuses — recorded as a deliberate gap rather than an oversight.

### 2.5 Field order is CREATION ORDER, and there is no `position` column

Fields sort by `(created_at, slug)`, a total order. A `position` column with no reorder UI is
`created_at` with extra machinery — and reorder is not free: for statuses it needed an RPC
(`reorder_project_statuses`), a deferrable unique index, and a live test pinning
`security invoker`. If field reordering is wanted it is its own story, and it adds the column
then.

## 3. Schema

Three migrations, one per story that needs one. **Hand-applied** — the Supabase MCP is
`read_only=true` on purpose. Produce the SQL, hand David one copy-paste command, run
`get_advisors` afterwards and keep it from growing. Files go in `docs/migrations/` as
`sprin-71-*.sql`.

Per [[ship-the-migration-with-its-tests]], each migration is applied as part of its own story,
never early to "unblock" later work.

**Never an ENUM.** `type` is `text` + a `check`, like `ticket.type`, `sprint.status` and
`project_type` before it. Widening a check is one line; altering an enum type is a painful
migration.

### 3.1 Migration A (story 1) — `project_fields`

```sql
create table project_fields (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- Stable machine identity. Users rename `name`, never `slug` — the same division
  -- project_statuses.slug and projects.key already use.
  slug       text not null,

  -- The field's label, as shown on the form and the sidebar.
  name       text not null,

  -- NEVER an enum. Widening this check is one line.
  type       text not null
               check (type in ('text','paragraph','number','date','select')),

  created_at timestamptz not null default now(),

  constraint project_fields_slug_format
    check (slug ~ '^[a-z][a-z0-9_]{0,29}$'),
  constraint project_fields_name_nonempty
    check (btrim(name) <> '' and length(name) <= 40),

  constraint project_fields_project_slug_unique unique (project_id, slug),

  -- Redundant on its own (id is the PK). These exist so ticket_field_values can point at a
  -- definition with COMPOSITE fks and prove same-project membership and type agreement —
  -- exactly why tickets_id_project_unique and project_statuses_id_project_unique exist.
  constraint project_fields_id_project_unique unique (id, project_id),
  constraint project_fields_id_type_unique    unique (id, type)
);
```

### 3.2 Migration B (story 3) — `ticket_field_values`

```sql
create table ticket_field_values (
  ticket_id    uuid not null,
  project_id   uuid not null,
  field_id     uuid not null,

  -- A copy of project_fields.type, carried because a CHECK body may not contain a subquery
  -- and the check below has to reach the definition's type. Sound ONLY because §2.3 makes
  -- the type immutable; tfv_type_fk keeps the copy honest.
  field_type   text not null,

  value_text   text,
  value_number numeric,
  value_date   date,
  value_option text,

  primary key (ticket_id, field_id),

  -- Cross-tenant integrity, the pattern tickets_sprint_fk already uses: carrying project_id
  -- into the fk makes "a ticket in project A holding project B's field" unrepresentable
  -- rather than merely discouraged.
  constraint tfv_ticket_fk foreign key (ticket_id, project_id)
    references tickets (id, project_id) on delete cascade,
  constraint tfv_field_fk foreign key (field_id, project_id)
    references project_fields (id, project_id) on delete cascade,

  -- Keeps the denormalised field_type equal to the definition's. ON UPDATE NO ACTION, never
  -- CASCADE: cascading a type change would silently re-type existing values, which §2.3
  -- forbids.
  --
  -- ON DELETE CASCADE matches tfv_field_fk deliberately, rather than relying on that fk's
  -- cascade to clear the rows first. Two fks to the same table with different delete actions
  -- resolve in RI trigger name order — i.e. luck, the same trap the schema's own comment on
  -- tickets_status_fk records. Making both cascade removes the ordering question entirely.
  constraint tfv_type_fk foreign key (field_id, field_type)
    references project_fields (id, type)
    on update no action on delete cascade,

  -- Exactly one value column populated, and it is the one the type calls for.
  constraint tfv_one_value_matching_type check (
    case field_type
      when 'text'      then value_text   is not null and value_number is null
                            and value_date is null and value_option is null
      when 'paragraph' then value_text   is not null and value_number is null
                            and value_date is null and value_option is null
      when 'number'    then value_number is not null and value_text is null
                            and value_date is null and value_option is null
      when 'date'      then value_date   is not null and value_text is null
                            and value_number is null and value_option is null
      when 'select'    then value_option is not null and value_text is null
                            and value_number is null and value_date is null
      else false
    end
  )
);
```

The `else false` is deliberate: a type this check does not know about stores nothing, rather
than storing anything. A sixth field type must therefore edit this constraint — which is the
intended failure, not an obstacle.

**"No value" is the ABSENCE of a row**, not a row full of nulls. Clearing a field deletes its
row. This is why the check can insist a value is present.

### 3.3 Migration C (story 5) — `project_field_options`

```sql
create table project_field_options (
  field_id uuid not null references project_fields(id) on delete cascade,
  slug     text not null,
  label    text not null,
  position int  not null,

  primary key (field_id, slug),
  constraint pfo_label_nonempty check (btrim(label) <> '' and length(label) <= 40),
  constraint pfo_position_positive check (position > 0)
);

alter table ticket_field_values add constraint tfv_option_fk
  foreign key (field_id, value_option)
  references project_field_options (field_id, slug)
  on delete cascade;
```

`on delete cascade` is the same call as §2.3: deleting an option clears the value rows holding
it, behind a confirm that says how many there are. `no action` — the default — would instead
refuse the delete with `23503` and strand an option that could never be removed once used,
which is the failure §2.3 rejected.

Two non-obvious choices:

- **`value_option` is its own column, not a reuse of `value_text`.** Sharing one column would
  make `tfv_option_fk` fire on every `text` and `paragraph` value too and reject all of them.
  Under MATCH SIMPLE, a null `value_option` skips the check — which is exactly what the other
  four types produce.
- **Keyed on `slug`, not a surrogate id**, so **renaming an option rewrites no value rows**.
  This is the same reasoning that keyed `tickets_status_fk` on `(project_id, slug)` in
  SPRIN-79.

Options *do* carry `position` — unlike fields (§2.5) — because a select's option order is
visible in the control itself and is set in the same small editor that creates them. There is
no separate reorder surface to build.

### 3.4 RLS and grants

Every table gets owner-scoped policies mirroring `statuses_owner_*`. **No table without a
policy.**

Two specifics, both learned the hard way:

- **Write `(select auth.uid())`, never bare `auth.uid()`.** The handover records **8 existing
  `auth_rls_initplan` advisor warnings** where a policy re-evaluates `auth.uid()` per row.
  This epic adds three tables' worth of policies and must not add a ninth warning.
  `statuses_owner_delete` is the working precedent in this very schema.
- **Grants: revoke the table's UPDATE and re-grant every writable column, in one
  transaction.** Per [[column-revoke-cannot-hole-a-table-grant]], `revoke update (col)`
  against a table-wide grant is a **silent no-op**, while a table-level revoke **cascades** to
  column grants — so the re-grant must restate every column, not just the new one.

`slug` and `type` on `project_fields` must be unwritable. A live test asserting `42501` on
each is what makes §2.3's immutability a **database** property rather than a convention.

## 4. The client-side contract

### 4.1 `domain.ts` owns the vocabulary, as always

Mirroring `TICKET_TYPES` and `PROJECT_TYPES` exactly:

- `CUSTOM_FIELD_TYPES = ['text','paragraph','number','date','select'] as const`
- `CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]`
- `CUSTOM_FIELD_TYPE_LABELS` for the picker
- `isCustomFieldType` guard
- `AssertCustomFieldTypesExhaustive = Expect<Exact<…>>`

**Do not inline the type names in a component, a form or a badge map.** This is the rule
SPRIN-72 cashed in: because it held, statuses becoming dynamic changed one module instead of
fifteen.

### 4.2 The renderer is a MAP KEYED BY TYPE, never an `if`/`else` chain

This is the load-bearing choice for the lint budget (§5). A map entry costs no cyclomatic
point; a branch costs one, and the sidebar has exactly one left. It also makes adding a sixth
type a data change in two places (the map and the CHECK) rather than a hunt.

### 4.3 Every `.select()` names its columns explicitly

The handover records a live follow-up: `listProjectStatuses` uses a no-arg `.select()` and
casts the rows unchecked, so narrowing it shipped the literal `· limit undefined` to every
Kanban column **on a green gate** — measured twice in SPRIN-86's review. It is a **class**, not
one column: every future first-reader of a column inherits it.

New readers in this epic do not join that class. `project-fields.ts` names its columns, and a
fixture missing one goes red.

### 4.4 No new plumbing beyond a fourth read

**Measured on `63cd60c`, not assumed:** `ProjectShell` sits at cyclomatic **10/10**, but
`useTaggedRead` is a hook call, not a branch, and the local reducers are separate arrow
functions with their own budgets. A fourth read —

```ts
const fieldRead = useTaggedRead(activeProjectId, reloadNonce, listProjectFields)
```

— and its destructure cost **zero** cyclomatic points. `fields` and `fieldsPhase` join
`ProjectShellContext` beside `statuses`/`statusesPhase`, sharing `reloadNonce` so one Retry
still covers everything.

**No `StatusSettings`-style split story is needed before this epic can start.** That was a real
possibility and it was measured away.

### 4.5 The read phase is consulted before the list

`fields` is `[]` while loading **and** when the read failed. Treating `[]` as "this project has
no custom fields" renders a confident claim over a list we do not have — S4.6's defect, a
distinct state wearing another state's face. Every surface here follows the phase-before-empty
discipline the other tabs already follow.

## 5. The lint budget, measured

Measured on `63cd60c` with `npx eslint <file> --rule '{"complexity":["error",1]}'`, which
prints every function's real number. **Re-measure rather than trust this table** — SPRIN-86 was
designed around a stale figure that turned out to be three points off.

| Site | Cyclomatic | Headroom |
|---|---|---|
| `TicketDetailDialog` | **10 / 10** | none |
| `ProjectShell` | **10 / 10** | none |
| `TicketDetailSidebar` | 9 / 10 | one point |
| `CreateTicketDialog.onSubmit` | 8 / 10 | two points |
| `SettingsTab` | 3 / 10 | ample |
| `StatusSettings` | 3 / 10 | ample |

File length is **not** a constraint anywhere in this epic (limit 400, counted with
`skipBlankLines` and `skipComments`): sidebar 166, `TicketDetailDialog` 124,
`CreateTicketDialog` 163, `StatusSettings` 180, `StatusRow` 231, `SettingsTab` 57,
`project-statuses.ts` 192.

> Measuring `max-lines` needs the config's own options passed through —
> `--rule '{"max-lines":["error",{"max":1,"skipBlankLines":true,"skipComments":true}]}'`.
> A bare `["error",1]` silently reverts to raw line counts and reported `project-statuses.ts`
> as 519 rather than 192.

Consequences that shape the stories:

- **Custom fields render inside their own component** (`TicketCustomFields`), which the sidebar
  renders unconditionally. Passing props costs nothing; a conditional in the sidebar spends its
  last point, and one in `TicketDetailDialog` is not available at all.
- **`TicketDetailDialog` threads `fields`/`fieldsPhase` straight through** to the sidebar. No
  new conditional there, at any point in this epic.
- **Story 4 must measure `onSubmit` before writing.** Two points is not much once custom values
  join the create path; the values write belongs in a helper in `project-fields.ts`, not inline.

## 6. The six stories

Order: **1 → 2 → 3 → 4**; **5** after 3; **6** after 3.

### Story 1 — The `project_fields` table and the field list

Migration A. `domain.ts` vocabulary. `src/lib/project-fields.ts` with `listProjectFields`.
`ProjectShell` gains the fourth read and publishes `fields`/`fieldsPhase`. The Settings tab
renders the project's custom fields read-only, with an empty state. **No writes yet** — this is
the database half, the shape SPRIN-79 used.

**ACs**

1. A project's custom fields are listed on the Settings tab, in `(created_at, slug)` order,
   with a distinct empty state when there are none.
2. The list respects the read phase: a failed read shows the failure, never "no custom fields".
3. The database rejects a `type` outside the five — live integration test.
4. The database refuses an UPDATE to `slug` and to `type` with `42501`, while a permitted
   column still updates on the same row — live test, positive control included.
5. A second user can neither read nor insert another tenant's `project_fields` rows — live
   test asserting the **row count** for the read (RLS filters rather than raises) and the
   error for the write.
6. **`tickets` is unchanged.** The migration touches no existing table.

### Story 2 — Add and rename a custom field

Settings gains an add form (name + type) and inline rename, mirroring `StatusSettings`. Slug is
derived from the name and made collision-free, reusing the `uniqueSlugForName` approach.

**ACs**

1. Adding a field with a name and a type persists it and it appears in the list.
2. The slug is derived from the name and is unique within the project; adding two fields with
   the same name succeeds and produces two distinct slugs.
3. Renaming changes `name` only — the slug is untouched, proven by asserting it directly.
4. Empty, whitespace-only and over-length names are rejected client-side **and** by the
   database.
5. The type control offers exactly the five types, from `CUSTOM_FIELD_TYPES`.

### Story 3 — Values on the ticket detail sidebar

Migration B. A new `TicketCustomFields` component renders one control per definition —
`text`, `paragraph`, `number`, `date` — reading and writing `ticket_field_values`. `select`
renders in story 5.

**ACs**

1. Each of the project's custom fields renders a control in the detail sidebar, labelled with
   its `name`.
2. Setting a value persists it and it survives a reload.
3. Clearing a value **deletes the row** rather than storing a null.
4. The database rejects a value in the wrong column for the type — live test, one case per
   type.
5. A ticket in project A cannot hold project B's field — live test on `tfv_field_fk`.
6. A project with no custom fields renders the sidebar exactly as it does today.

### Story 4 — Custom fields on the create-ticket dialog

The create dialog renders the same controls, and values are written with the ticket.

**ACs**

1. The create dialog renders a control per custom field, after the fixed fields.
2. Creating a ticket with custom values persists both the ticket and its values.
3. Leaving a custom field empty writes no value row.
4. **If the values write fails, the ticket still exists and the dialog says so**, naming the
   fields that did not save and leaving the ticket on the board. The two writes cannot be one
   transaction — the values need the ticket's id, and PostgREST gives the client no
   multi-statement transaction — so the choice is between a truthful partial result and a
   fabricated rollback that would have to delete a ticket the user just watched appear. A
   silent success is the one outcome ruled out.
5. A project with no custom fields shows an unchanged create dialog.

### Story 5 — Single-select fields

Migration C. The Settings editor gains an options list for a `select` field; the renderer gains
a `<select>`.

**ACs**

1. A `select` field's options are editable on Settings, in `position` order.
2. A ticket can hold one of its options, and only one of its options — a value outside the list
   is rejected by the database (live test on `tfv_option_fk`).
3. Renaming an option's **label** changes no value row — proven by reading the value back.
4. **Deleting an option clears it from every ticket holding it, behind a confirm showing how
   many** — `tfv_option_fk`'s cascade (§3.3), and the same count-before-commit rule as story 6.
   The alternative, refusing the delete, would make any option that was ever used permanently
   undeletable.
5. The other four types are unaffected.

### Story 6 — Delete a custom field, with its value count

The delete control, its confirm dialog showing how many tickets hold a value, and the cascade.
Mirrors SPRIN-80's status delete, which is the working precedent for count-before-commit.

**ACs**

1. Settings offers deleting a custom field, behind a confirm.
2. The confirm shows **how many tickets hold a value** for that field, before the user commits.
3. Confirming deletes the definition and every value for it.
4. The count is not fabricated on a failed read — an unknown count must not read as zero, the
   rule `useTicketCounts` already follows (zero is the value that unlocks a destructive
   action).
5. Deleting a field with no values is equally possible.

## 7. Testing

Every story is written test-first from its ACs.

Live integration assertions go in the **existing** `*.integration.test.ts` suites so the CI
tripwire gap stays at **seven files**. Re-derive the file counts with
`npx vitest list --filesOnly | wc -l`, never a grep pattern — that drops the `.mjs` test files.
At `63cd60c` it is **65 files / 1052 tests**, gap 7 against `test:unit`'s 58. A gap of **zero**
means the live suites silently skipped and the run is a failure however green it looks.

### The risks that would most likely ship this green and broken

- **Fixture-shaped absence.** Most of this epic's UI assertions are "the control for field X is
  present". A project with no fields renders nothing, so an absence assertion against it passes
  even if the whole section failed to render. **Every absence assertion carries a positive
  control in the same test** — this is shape 4 of [[green-for-the-wrong-reason]], and it is
  exactly the vacuous test SPRIN-86's review found in my own work.
- **A confound between `field_id` and `slug`.** SPRIN-87 broke three fixture confounds where two
  different production reads were indistinguishable because the fixture made them equal. Do not
  let a fixture's `slug` be the lowercased `name`, and do not let the field list's order match
  its insertion order by accident.
- **`queryByRole` excludes `aria-hidden` subtrees**, so an absence test reports "absent" for a
  control that is still in the DOM and keyboard-reachable. Pair it with a raw DOM query — see
  [[querybyrole-hides-aria-hidden-from-absence-tests]].
- **`toHaveClass` is a subset check** and `toHaveTextContent` with a bare string is a substring
  match. Both have passed while the thing under test was broken, in this repo, this month.

### Review depth

None of these six is a security-boundary diff on the project's own definition — no
authentication, no RLS **rewrite**, no secret handling, no change to the CI gate workflow. Each
gets **one reviewer** on PR open, briefed to **mutate rather than read**, per the project's
review-depth rule.

The caveat worth stating: stories 1, 3 and 5 each add **new RLS policies**, which is not the
same as rewriting existing ones but is the closest this epic comes. That is covered the way
SPRIN-85 covered its GRANT — by making the policy's refusal a **live test with a positive
control on the same row**, rather than by a review fleet. SPRIN-75 is where the fan-out comes
out.

## 8. What this epic hands to SPRIN-75

Every policy written here resolves to `owner_id = auth.uid()` through `projects`. All three
tables must be rewritten to the membership model, and the isolation suite extended past
owner-vs-stranger to member-vs-non-member and role-vs-role.

One trap inherited from SPRIN-64 applies directly: **an app-layer guard that leans on a
policy's breadth stops holding when read becomes broader than write, and the isolation suite
would not flag it.** Story 6's delete-with-count is such a guard — it reads a count to decide
whether to offer a destructive action. Re-audit it, not only the policies.
