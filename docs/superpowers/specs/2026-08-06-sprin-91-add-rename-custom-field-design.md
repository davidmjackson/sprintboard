# SPRIN-91 — Add and rename a custom field

**Story:** SPRIN-91 (epic SPRIN-71, story 2 of 6)
**Epic design:** `docs/superpowers/specs/2026-08-05-sprin-71-custom-fields-design.md` §6 story 2
**Depends on:** SPRIN-90 (migration A, `project_fields`, the read-only list) — merged, applied live
**Date:** 2026-08-06

---

## 1. What this story is, and the two debts it inherits

Settings gains an **add form** (name + type) and **inline rename**, mirroring `StatusSettings`.
That is the feature. It also settles two things SPRIN-90 deliberately left open, both recorded
in that story's own migration and test comments:

- **a `grant insert`**, which story 1 revoked along with UPDATE and DELETE; and
- **the AC5 insert-policy proof story 1 could not make.** With nobody holding INSERT, a
  cross-tenant insert died on the missing GRANT before `fields_owner_insert` was consulted —
  and a revoked grant and an RLS `WITH CHECK` violation both raise `42501`. There was no
  positive control able to separate them, so the test would have passed with the policy
  deleted outright. Granting INSERT is what makes that refusal attributable, so the proof is
  this story's by construction rather than by scheduling.

The epic's Jira issue says "No migration." **That is wrong and this spec overrides it** — a
grant change is a migration, and pretending otherwise would mean widening a privilege with no
file recording it.

### Out of scope, decided by David 2026-08-06

- **`anon`'s SELECT stays.** It was queried this session and left deliberately: `anon` reads
  zero rows because `auth.uid()` is NULL, and the real inconsistency is schema-wide (`tickets`
  still carries full `arwdDxtm` for `anon`; every table grants TRUNCATE to both roles). That
  wants **one deliberate sweep with SPRIN-75**, not a piecemeal revoke on whichever table a
  story happens to touch.
- **`required` is not in this epic.** Its violation is an absent row, so no CHECK can see it,
  and the only database enforcement is the sibling-counting trigger SPRIN-80 rejected.
- **No `position` column.** Order stays `(created_at, slug)`; reordering is its own story.

## 2. The measured starting state

Read live from the catalog on 2026-08-06, not assumed:

```
table  project_fields  anon=rDxtm/postgres, authenticated=rDxtm/postgres
column name            authenticated=w/postgres
policy fields_owner_{read,insert,update,delete}   roles = {public}   (all four)
```

`r`=SELECT, `w`=UPDATE, `a`=INSERT, `d`=DELETE, `D`=TRUNCATE. So `authenticated` holds SELECT
and TRUNCATE at table level, UPDATE on `name` alone, and **no INSERT**. All four policies exist
already — story 1 shipped them as the table's security design rather than one story's feature.

**This story adds no policy.** It adds a grant, and then proves the policy that was already
there. Worth stating plainly, because "new RLS policy" and "first exercise of an existing
policy" carry different review weight.

## 3. Migration B — the grant

### 3.1 The shape is revoke-and-restate, and that is not stylistic

`grant insert (…)` alone would work today. The migration still writes the **complete intended
end state** — a table-wide revoke followed by a restatement of *every* column grant, including
`update (name)`, which this story does not otherwise touch.

The reason is the rule recorded in `column-revoke-cannot-hole-a-table-grant` and in migration
A's own comment: **a table-level REVOKE cascades to column grants.** So the dangerous edit is
not this migration, it is the *next* one — a story 6 author writing
`revoke insert, update, delete …; grant delete …` would silently drop `update (name)` and
`insert (…)` with nothing saying so. A migration that always states the full set is idempotent,
survives being re-run, and makes the cascade harmless by construction. The cost is four lines.

`revoke update` is deliberately included in that revoke even though `update (name)` is
immediately re-granted: leaving it out would make the block a partial reset, which is the exact
half-measure that invites the next author to write their own partial reset.

### 3.2 INSERT is granted on FOUR columns, not on the table

```sql
grant insert (project_id, slug, name, type) on project_fields to authenticated;
```

Not `grant insert on project_fields`. The two omissions are the point:

- **`created_at` is the sort key.** §2.5 of the epic design makes `(created_at, slug)` the
  field order, with no `position` column standing behind it. A writable `created_at` is a
  writable sort order, and the ordering rule stops being a database property and becomes a
  convention the client happens to follow. Withholding the column costs nothing — the default
  is `now()` — and makes the rule structural.
- **`id` is `gen_random_uuid()`.** A client that cannot supply one cannot collide with one, and
  nothing in the app has any reason to choose a row's primary key.

`.insert(…).select()` still works: the RETURNING clause needs SELECT, which is granted
table-wide. Column-level INSERT is sufficient on its own — table-level INSERT is not required
when every assigned column is granted. **That is the one claim in this section not measured
from the catalog**, so the live test in §5 exercises a real insert through the app role rather
than through `adminClient()`, and a wrong reading of the privilege model goes red in CI rather
than shipping.

### 3.3 What stays revoked

DELETE. Story 6 grants it and proves it, exactly as story 1 said. `slug` and `type` stay
unwritable — that immutability is what makes story 3's denormalised `field_type` copy sound,
and it is asserted live already.

## 4. The client

### 4.1 A `duplicate` tag would be a lie — there is no name-uniqueness constraint

This is the one place where copying `StatusSettings` wholesale would be wrong, and it is easy
to miss because the two surfaces look identical.

`project_statuses` carries `project_statuses_project_name_unique`. **`project_fields` carries no
name constraint at all** — only `project_fields_project_slug_unique`. And that is deliberate:
**AC2 requires that adding two fields with the same name succeeds**, producing two distinct
slugs. So:

- There is **no `'duplicate'` write tag** and no `DUPLICATE_NAME` equivalent. Importing
  `status-schemas`'s sentence here would put a message on screen describing a constraint this
  table does not have, for a write that in fact succeeded.
- A `23505` on `project_fields_project_slug_unique` is therefore **`'stale'`**, not
  `'duplicate'`: it means the client's list of existing fields was older than the database's,
  so the collision-free slug it derived was not collision-free. Retrying the same submit
  reproduces it forever; reloading is the only remedy, which is what the message says. Same
  reasoning as `StatusSettings`'s `STALE_LIST`, reached from a different constraint.

The tag set is therefore `'stale' | 'unknown'` — two, where statuses have five.

### 4.2 `field-schemas.ts`, not an addition to `status-schemas.ts`

A new module. `status-schemas.ts` is named for statuses and imports `STATUS_CATEGORIES`; a
field's rules differ in the way that matters (no uniqueness sentence, a type instead of a
category). Sharing the file would put two different `DUPLICATE_NAME`-shaped decisions one
scroll apart.

What it holds:

- `name` — trimmed, min 1, max 40. Mirrors `project_fields_name_nonempty`
  (`btrim(name) <> '' and length(name) <= 40`) so a name this schema accepts is one the
  database accepts. **That parity is AC4**, and it is asserted at both edges.
- `addName` — `name` plus a refine that `slugForName(value) !== null`, for the same reason
  `AddStatusSchema` has one: a name with no derivable slug otherwise reaches the write and
  returns the not-user-correctable `unknown` tag, so the form shows generic retry copy for
  something the user could trivially fix. **Not applied to rename** — a rename never re-derives
  the slug, so refusing such a name would be a constraint the database does not have.
- `type` — `z.enum(CUSTOM_FIELD_TYPES)`, read from the shared constant so a sixth type cannot
  become addable here without the database's check agreeing.

`slugForName` and `uniqueSlugForName` are **imported from `project-statuses.ts`, not copied.**
Their rule is `^[a-z][a-z0-9_]{0,29}$`, and `project_fields_slug_format` is character-for-character
the same regex — migration A says so in as many words. Two derivations of one rule drift; one
cannot. (If a later story gives the two tables different slug rules, that is the moment to split
the helper, and it will be a visible edit rather than a silent divergence.)

### 4.3 `project-fields.ts` gains two writes

`createProjectField({ projectId, name, type, existing })` and `renameProjectField(id, name)`,
mirroring `createProjectStatus` / `renameProjectStatus` down to the object parameter (T4 caps
parameters at 4) and the trim-inside-the-write (the schema binds the form, not the function, so
a direct caller sending `'  Notes  '` must not store leading space).

`renameProjectField` sends `{ name } satisfies ProjectFieldUpdate` — **the `satisfies` is the
security property, not tidiness.** `authenticated` holds UPDATE on `name` alone, so a patch
touching `slug` is refused by Postgres before any policy is consulted; the generated row type
offers every column, so `.update({ slug })` would compile and fail only at runtime against the
live database, which a mocked unit test never reaches.

`ProjectFieldUpdate` and its `Exact<keyof …, 'name'>` assertion go in `domain.ts` — story 1's
docblock explicitly reserved both for this story, on the grounds that adding them with no
writer would be an unpinned claim about a privilege nothing exercises.

### 4.4 The list becomes `<ul>`/`<li>`, reversing story 1's `<dl>`

Story 1 chose a `<dl>` because each row was a name and its type — a description list, and one
whose accessible name stayed a single text node. Once the name is an `EditableText` button and
the row carries its own error region, a row is no longer a term/definition pair; it is an item
with controls, which is what `StatusSettings` renders as an `<li>`. Reversing an earlier
decision because its premise changed is the correct move, not churn — recording it here so the
diff does not read as an unexplained rewrite.

### 4.5 Shell wiring

`ProjectShell` gains `onFieldCreated` (append) and `onFieldUpdated` (replace by id), published
on `ProjectShellContext` beside the status reducers, and `SettingsTab` threads them through.

**Measured on `831d9bb`, not assumed:** `ProjectShell` is at cyclomatic **10 / 10** and cannot
take a branch. Both reducers are `const` arrow declarations, and ESLint's `complexity` rule
counts per function — the file already holds seven nested arrows at complexity ≥ 2 while
`ProjectShell` itself reads 10. So two more branch-free arrows cost **zero**. `SettingsTab` is
3 / 10 and `CustomFieldList` 4 / 10; there is ample budget in both.

Append rather than re-sort: the list is ordered `(created_at, slug)` and a newly created field
has the newest `created_at`, so the end is where the database would put it. No client-side sort
is needed and adding one would be a second derivation of the order rule.

## 5. Tests

Written from the ACs before implementation, per the project's workflow.

### 5.1 The live half — `rls.integration.test.ts`

Goes in the **existing** suite, so the CI tripwire gap stays at seven files.

**One existing test must change, and its change is the point.** `'an authenticated owner still
holds no INSERT or DELETE on their own fields'` pins the current no-INSERT state precisely so
this story cannot widen the privilege silently. It goes red on migration B, which is the review
moment story 1 wanted. Its DELETE half stays (story 6 owns that); its INSERT half is replaced by
the proof below. **Deleting the whole test would throw away story 6's tripwire** — narrow it,
do not remove it.

The new assertions:

1. **AC5, the debt.** `b` inserts a `project_fields` row naming **A's** project → refused, and
   the refusal is attributed: `42501` **and** a message matching `/row-level security policy/`,
   **not** `/permission denied/`. The two controls share the SQLSTATE, so the message is the
   only channel that says which one fired — the same discrimination story 1's anon test already
   makes in the other direction.
2. **The positive control, on the same client.** `b` inserts into **B's own** project →
   succeeds. Without it, a migration that failed to grant INSERT at all would leave assertion 1
   green for the wrong reason, which is exactly the hole story 1 declined to ship.
3. **The column grant is real.** An insert supplying `created_at` (or `id`) → `42501` with
   `/permission denied/`, while the same row without it succeeds. This is what makes §3.2 a
   database property rather than a comment; without it the four-column grant is
   indistinguishable from a table-wide one.
4. **AC4's database edge.** Empty and whitespace-only names, and a 41-character name, refused
   with `23514` and a message matching `/project_fields_name_nonempty/`. Asserting the
   constraint name, not just the SQLSTATE — otherwise a typo tripping `project_fields_slug_format`
   passes this test.
5. **AC3's database edge.** A rename leaves `slug` untouched: read the row back through
   `adminClient()` and assert the slug **by value**, not merely that the update succeeded.

### 5.2 The unit half

- `field-schemas.test.ts` — AC4's client edge. Empty, whitespace-only, 41 characters, and a
  name with no derivable slug (`'!!!'`) on the add path only.
- `project-fields.test.ts` — AC2's slug derivation: two fields named `Customer ref` produce
  `customer_ref` and `customer_ref_2`; the `23505` → `'stale'` mapping; `renameProjectField`
  sends `name` and nothing else.
- `CustomFieldSettings.test.tsx` — **a file that does not exist yet.** SPRIN-90's review found a
  docblock citing it, which is precisely what made the missing shell seam read as covered. AC1,
  AC5 (the control offers exactly five options, derived from `CUSTOM_FIELD_TYPES` rather than
  written out), and the rename path.
- `ProjectShell.test.tsx` — the **seam**, extending the `FieldContextProbe` SPRIN-90's review
  added. `onFieldCreated`/`onFieldUpdated` must be pinned at the shell→context boundary, because
  that is the seam the last story's review found entirely unpinned: four type-valid, lint-clean
  mutations survived there, including `fieldsPhase = statusesPhase`.

### 5.3 The ways this ships green and broken

- **`ProjectShell.test.tsx` must mock `@/lib/project-fields`.** SPRIN-90's review measured the
  unit suite issuing ~90 live PostgREST requests per run because it did not — invisible, because
  `useTaggedRead` catches the rejection. Two new exports from that module widen the same hole.
- **A fixture whose slug is the lowercased name is a confound.** AC2 and AC3 both distinguish
  `name` from `slug`; if the fixture makes them equal, a production read of one is
  indistinguishable from a read of the other. SPRIN-87 broke three of these. Fixture names are
  chosen so the derived slug is *not* the obvious lowercasing.
- **Every absence assertion carries a positive control in the same test.** A project with no
  fields renders nothing, so "the control for X is absent" passes even when the whole section
  failed to render.
- **`toHaveClass` is a subset check** and `toHaveTextContent` with a bare string is a substring
  match. Both have passed while the thing under test was broken, in this repo, this month.
- **`queryByRole` excludes `aria-hidden` subtrees** — pair an absence assertion with a raw DOM
  query.

## 6. Review depth

**One reviewer, briefed to mutate rather than read**, plus a security pass on the grant.

The diff widens a privilege, which is why it gets a security review rather than only a peer one;
it adds **no policy** and rewrites none, so it is not the multi-agent case. The epic design says
this explicitly: new-policy stories are covered "by making the policy's refusal a live test with
a positive control on the same row, rather than by a review fleet. SPRIN-75 is where the fan-out
comes out." This story is one step milder than that — it proves a policy that already shipped.
