# SPRIN-85 — Set a WIP limit per board column (Kanban only)

Story 5 of 6 in epic **SPRIN-73** (Kanban project type). Depends on SPRIN-81 (the
`kanban` project type) and SPRIN-84 (the `StatusSettings` / `StatusRow` split, which
exists to make room for this story). Feeds SPRIN-86, which renders the limit on the
board.

Epic design: `docs/superpowers/specs/2026-08-03-sprin-73-kanban-project-type-design.md`
(§2.2, §3.2, §3.3, §4.1, §4.2). This spec does not restate it; it records what was
**measured**, what was **decided here**, and where this story deviates.

---

## 1. What ships

A per-status numeric **WIP limit**, editable on the Settings tab of a **Kanban** project
only. Empty means no limit. Nothing on the board changes — rendering the limit is
SPRIN-86.

The limit is **soft**. Nothing in this story, and nothing in SPRIN-86, refuses a ticket
entering an at-limit column. §2.2 of the epic design records why, and AC3 of SPRIN-86
exists so that "improving" it into a block goes red.

---

## 2. What was measured, not recalled

Read live on 2026-08-05 before any code was written.

### 2.1 The ACLs — SPRIN-77's end state is intact

`pg_class.relacl` for `project_statuses`:

| role | acl | UPDATE? |
|---|---|---|
| `authenticated` | `ardDxtm` | **no `w`** |
| `anon` | `arDxtm` | no `w`, no `d` |
| `service_role` | `arwdDxtm` | yes |

`pg_attribute.attacl` — the only three columns carrying one:

```
name      {authenticated=w/postgres}
category  {authenticated=w/postgres}
position  {authenticated=w/postgres}
```

Exactly the mirror of `ProjectStatusUpdate`. The story's premise holds.

**`information_schema` returned ZERO ROWS for the same question**, from both
`role_table_grants` and `column_privileges`. That is not evidence of no grants — those
views filter to grants the *current* role is party to, and the Supabase read-only MCP
user is party to none of them. A future audit must read `pg_class.relacl` and
`pg_attribute.attacl` directly or it will conclude the table has no privileges at all.

### 2.2 The RLS policies need no change

`pg_policy` shows four verb-split policies (`statuses_owner_read/insert/update/delete`),
all owner-scoped via a correlated subquery to `projects`, and **none of them names a
column**. `statuses_owner_update` therefore covers `wip_limit` with no edit.

### 2.3 A table REVOKE cascades to column grants — settled from the docs

PostgreSQL's `REVOKE` reference, verbatim:

> "When revoking privileges on a table, the corresponding column privileges (if any) are
> automatically revoked on each column of the table, as well. On the other hand, if a
> role has been granted privileges on a table, then revoking the same privileges from
> individual columns will have no effect."

Both halves bite this table, in opposite directions. The **second** half is the trap
SPRIN-77 documented ([[column-revoke-cannot-hole-a-table-grant]]). The **first** half is
the one this story has to survive, and it makes the shape of the grant load-bearing —
see §3.2.

### 2.4 Line and complexity budget

Counted lines (`skipBlankLines`, `skipComments` — the repo's T5 semantics), against 400:

| file | counted | headroom |
|---|---|---|
| `src/lib/domain.ts` | 138 | 262 |
| `src/lib/project-statuses.ts` | 178 | 222 |
| `src/lib/status-schemas.ts` | 18 | 382 |
| `src/routes/StatusRow.tsx` | 227 | 173 |
| `src/routes/StatusSettings.tsx` | 177 | 223 |
| `src/routes/SettingsTab.tsx` | 55 | 345 |

No file is near the limit. SPRIN-84 bought that headroom for this story and it is there.
The new control still gets **its own file** — see §4.1 — for a reason that is not budget.

---

## 3. The migration

`docs/migrations/sprin-85-wip-limit.sql`. Hand-applied by David; the Supabase MCP is
`read_only=true` on purpose.

### 3.1 The column

```sql
alter table project_statuses add column wip_limit int;

alter table project_statuses
  add constraint project_statuses_wip_limit_positive
    check (wip_limit is null or wip_limit > 0);
```

Nullable, no default, no backfill: every existing row of every project — Scrum and
Kanban alike — gets `null`, which is exactly "no limit".

**Deviations from the epic design's SQL, both deliberate:**

- **The check is a NAMED table constraint**, not the design's inline column check (which
  Postgres would auto-name `project_statuses_wip_limit_check`). `project-statuses.ts`
  parses *constraint names* out of Postgres error messages to choose a user-facing
  remedy, so a constraint name on this table is client-visible API, not an implementation
  detail. `_positive` matches its sibling `project_statuses_position_positive`.
- **`wip_limit is null or wip_limit > 0` is kept in full** even though `wip_limit > 0`
  alone behaves identically (a CHECK evaluating to NULL passes). The redundancy is
  documentation: "null means no limit" is the most important fact about this column, and
  a reader auditing the short form has to recall three-valued logic to work out whether
  NULL is permitted.

### 3.2 The grant rewrite — the part with teeth

```sql
revoke update on project_statuses from authenticated, anon;
grant  update (name, category, position, wip_limit)
  on project_statuses to authenticated;
```

**The grant MUST list all four columns, and that is correctness rather than caution.**
By §2.3 the revoke drops the three existing column grants. So

```sql
revoke update on project_statuses from authenticated, anon;
grant  update (wip_limit) on project_statuses to authenticated;   -- WRONG
```

would leave `authenticated` able to update `wip_limit` **and nothing else**. Every
rename, recategorise and reorder in the app would start returning `42501`, and nothing in
the diff would look like the cause.

**Why revoke-then-regrant at all, when `grant update (wip_limit)` alone would work
today?** It would — there is no table-wide grant for it to be swallowed by. Two reasons
it is not what ships:

1. It encodes a dependency on the current ACL that nothing checks. The revoke-then-regrant
   form states the *complete* intended end state — these four columns and no others — so
   it is correct regardless of the prior state.
2. It is the shape SPRIN-77 established here, and the epic design prescribes it. Diverging
   would be a second idiom for one operation on one table.

**One transaction, and here that is load-bearing** in a way it was not for SPRIN-82's
single revoke. A revoke that committed without its grant is a live outage of three write
paths. `begin`/`commit` is what makes the dance safe to run by hand.

### 3.3 Post-state verification, with a real positive control

The migration ends with a `do $$` block asserting three things that fail independently:
no table-wide UPDATE for either client role; `authenticated`'s column UPDATE set is
**exactly** the four columns (set equality both ways — `@>` alone passes on a superset,
the precise failure being guarded against); and `slug`/`is_initial` specifically are not
among them.

**The block was run against the live pre-migration database and it FAILED**, with:

```
P0001: SPRIN-85: authenticated holds column UPDATE on {category, name, position}
       but should hold exactly {name, category, position, wip_limit}
```

That is a positive control, not a null one — it proves the block parses, executes, reads
the real catalog, and is *capable of failing*. Per
[[mutation-matrices-must-be-cumulative]], a verification block that has only ever been
seen to pass has established nothing.

Its two honest limits are stated in the file and repeated here so nobody assumes
otherwise: it reads back its own work inside its own transaction, and **CI cannot see any
of it** — PostgREST has no access to `pg_catalog`, so no test in the repo can read
`relacl` or `attacl`. Live *behaviour* is the only thing CI can pin.

### 3.4 The accepted gap

A CHECK body may not contain a subquery, so it cannot reach `projects.project_type`: the
database will store a `wip_limit` on a **Scrum** project's status row. It is inert, and
because SPRIN-82 made `project_type` immutable *in the database* (no UPDATE privilege on
`projects` at all), it can never stop being inert.

Recorded, not deferred. **If a project-type conversion story is ever built it inherits the
obligation** to decide what happens to those values — alongside the three obligations
already recorded for a project-rename story.

### 3.5 Order of operations

The migration is applied **before** any code is written. `database.types.ts` is
**regenerated**, never hand-edited — `wip_limit` must appear there before
`ProjectStatusUpdate` can name it.

---

## 4. The client

### 4.1 New file: `src/routes/StatusWipLimit.tsx`

Exports `StatusWipLimitField`, which owns its draft state, its validation, its write and
its own error line.

**Its own file rather than more of `StatusRow.tsx`**, and the reason is not the line
budget (§2.4 shows 173 lines spare). It is that this control is a self-contained
write path — parse, guard, write, tag, report — of the same weight as
`StatusDeleteControl`, and `StatusRow.tsx` already holds three components. A fourth
would make that file the place status editing lives rather than the place a status *row*
is assembled. It also gives the control a test file of its own, which is what SPRIN-84's
split was for.

**Not built on `EditableText`.** Three reasons, each disqualifying on its own:

- `EditableText` commits a **raw string** and offers no place to parse-and-refuse before
  writing; this field must reject `0` and show why, without a request.
- Its numeric mode hardcodes `min={0}`, which contradicts the rule this story is adding.
- Its view mode is a button. A settings field should show its current value and be
  directly editable; click-to-edit is the ticket dialog's motif, not the settings tab's.

There is also a recorded hazard in reusing it: `EditableText`'s own `draft !== value`
guard is **unpinned and unpinnable** from `StatusSettings.test.tsx` because the row's trim
guard shadows it. This field's no-op guard is written explicitly and tested directly
(§6), rather than inherited from a component whose equivalent guard nothing observes.

**Shape.** An always-visible numeric input, `aria-label={`WIP limit for ${status.name}`}`,
placeholder `None`. Commits on **blur** and on **Enter**. Escape reverts the draft.
On an invalid draft it shows a field-level message and sends nothing.

**A no-op commit sends no request.** The parsed value is compared with
`status.wip_limit` before writing — the same discipline as `StatusRow`'s rename, and for
the same reason: a blur is not an intent to write.

### 4.2 `domain.ts`

```ts
export function hasWipLimits(project: Pick<Project, 'project_type'>): boolean {
  return project.project_type === 'kanban'
}
```

A **second predicate**, deliberately not a negated `hasSprints`. "Has sprints" and "has
WIP limits" are two different questions that share an answer only while there are exactly
two project types; a third would separate them. `hasSprints`'s own docblock already
promises this function arrives in SPRIN-85 with its first caller.

It takes the narrowest shape it reads, matching `hasSprints`, so a test can pass
`{ project_type: 'kanban' }` without inventing eight irrelevant columns.

`ProjectStatusUpdate` gains `wip_limit`, and `AssertProjectStatusUpdateColumns` becomes
`Exact<keyof ProjectStatusUpdate, 'name' | 'category' | 'position' | 'wip_limit'>` **in
the same commit**. That assertion is the mechanism that makes forgetting the grant
rewrite a compile error rather than a silent client-side re-widening.

**The AST guard permits all of this**: `src/test/project-type-single-expression.test.ts`
allows `kanban`, the raw comparison and the `.project_type` read in `domain.ts` and
nowhere else. `hasWipLimits` lives there, so no component ever reads the column.

### 4.3 `status-schemas.ts` — the client edge

`WipLimitSchema` takes the input's **string** and produces `number | null`:

| input | result |
|---|---|
| `''`, `'   '` | `null` — AC3, clears the limit |
| `'3'` | `3` |
| `'0'` | rejected — a limit of 0 is not "no limit", it is a column no work may enter |
| `'-1'`, `'1.5'`, `'abc'`, `'1e3'` | rejected |
| `'2147483647'` | accepted (int4 max) |
| `'2147483648'` | rejected |

The upper bound is not arbitrary and is not a product decision: it is the column's own
type. Without it a client-accepted value earns a `22003 numeric value out of range` the
user cannot act on. The literal is **not named in the user-facing copy** ("That limit is
too large.") because `2147483647` is noise to a person; it is named in a constant with a
comment saying it is int4's ceiling.

This mirrors the database at both edges, which is what CLAUDE.md asks for: the set the
schema accepts is exactly the set `project_statuses_wip_limit_positive` plus the column
type accepts.

### 4.4 `project-statuses.ts` — the write

```ts
export async function setStatusWipLimit(
  id: string,
  wipLimit: number | null,
): Promise<StatusWriteResult<ProjectStatus>>
```

Sends `{ wip_limit: wipLimit } satisfies ProjectStatusUpdate` and **only** that column,
which keeps the request inside the grant by construction and makes a widened payload a
compile error.

**The zero-row guard is explicit, not incidental.** It `.select()`s and checks the row
count, returning `'stale'` on anything but exactly one row — the deliberate shape
`deleteProjectStatus` and `reorderProjectStatuses` use, because **RLS filters an UPDATE
rather than raising on it**: a row belonging to another tenant, or one another tab
deleted, comes back as `error: null, data: []`.

This is a considered departure from its nearest sibling. `renameProjectStatus` uses
`.single()`, whose zero-row protection is *incidental* — it errors, which becomes
`unknown`, which becomes generic copy. `docs/HANDOVER.md` records that as an open
follow-up. New code meets the standard deliberately rather than inheriting the weaker
mechanism for consistency's sake. **Fixing `renameProjectStatus` is not in this story**;
it stays a follow-up so this diff does not grow a second, unrelated behaviour change.

### 4.5 Threading

`SettingsTab` already holds `project` from `ProjectShellContext`. It calls
`hasWipLimits(project)` and passes the boolean down: `SettingsTab` → `StatusSettings` →
`StatusRow` → render or not.

The prop is named **`hasWipLimits`**, after the domain question, not `showWipLimit`. AC1
is "absent, not merely hidden": a Scrum project does not have a WIP limit it is declining
to show, it has no such concept. The prop name should not invite someone to satisfy it
with `hidden`.

No new plumbing through the shell — §4.3 of the epic design already established that
`project` is in context everywhere it is needed.

---

## 5. Acceptance criteria → where each is proved

| AC | Proof |
|---|---|
| 1. Control appears only on a Kanban project's Settings tab | `StatusSettings.test.tsx` — absent with `hasWipLimits={false}`, present with `true`. A DOM-absence assertion, not a class check |
| 2. A limit persists across a reload | **Live** — `rls.integration.test.ts`: the owner writes `wip_limit`, a fresh read returns it |
| 3. Clearing the field writes null | Unit (`''` → `null`, and the write receives `null`) **and** live (a written limit is cleared and reads back `null`) |
| 4. Zero, negative and non-integer rejected client-side **and** by the database | Unit: `WipLimitSchema` table. **Live**: `0`/`-1` → `23514`, `1.5` → `22P02` |
| 5. The widened grant still refuses `slug` and `is_initial` | **Already covered, deliberately not duplicated** — see §5.1 |

### 5.1 AC5 is covered by tests that already exist, and that is stronger

`rls.integration.test.ts` already holds:

- *"the owner can rename a status but cannot move its slug"* — asserts `42501` on `slug`,
  **paired with a successful rename on the same row**, so the refusal cannot be a broken
  fixture or a missing policy.
- *"the owner cannot change is_initial"* — asserts `42501` on `is_initial`, and clears
  rather than sets it deliberately, so the unique index cannot refuse it in the
  privilege's place.

Both predate this story. They are therefore better evidence than a test written alongside
the migration: they were not authored by someone who already knew what answer they wanted.
Duplicating them would also break this codebase's **one rule, one control** discipline —
two controls over one refusal and the suite can no longer tell you which is holding.

**What this story owes AC5 is that those two stay green after the grant rewrite**, and
that is exactly what CI will report.

### 5.2 One test added beyond the ACs, and why

The grant rewrite restates the whole column list, so a typo silently **drops** a column.
Of the four:

| column | live witness that the grant survived |
|---|---|
| `name` | the rename in the slug test |
| `position` | the `reorder_project_statuses` tests (the RPC is `SECURITY INVOKER`, so it writes as the caller) |
| `wip_limit` | new, this story |
| `category` | **none — it is only ever written on INSERT in the live suite** |

So today, dropping `category` from that grant would ship green. This story adds one live
test — *the owner can recategorise a status* — paired into the existing describe block in
the same positive-control shape as its neighbours.

It is outside the ACs and it is in scope anyway: it closes the last unwitnessed column of
the exact control this story rewrites. [[every-gate-needs-its-own-attack]].

---

## 6. Tests, by file

| file | what |
|---|---|
| `src/lib/domain.test.ts` | `hasWipLimits` — Kanban true, Scrum false |
| `src/lib/status-schemas.test.ts` | the `WipLimitSchema` table in §4.3, each row its own case |
| `src/lib/project-statuses.test.ts` | `setStatusWipLimit`: payload is `wip_limit` alone; one row → ok; **zero rows with `error: null` → `'stale'`**; error → tagged |
| `src/routes/StatusWipLimit.test.tsx` | **new.** Renders the current limit; blur commits; Enter commits; Escape reverts; invalid draft shows a message and **sends nothing**; an unchanged draft **sends nothing**; a failed write shows an error and leaves the value alone |
| `src/routes/StatusSettings.test.tsx` | AC1 — the field is absent when `hasWipLimits` is false |
| `src/test/rls.integration.test.ts` | AC2, AC3, AC4-database, and §5.2's `category` test |

Adding one unit-test file moves `npm test` and `test:unit` **together**, so the tripwire
gap stays at **7**. Re-derive with `npx vitest list --filesOnly`, never recall.

**Every "sends nothing" assertion needs a positive control in the same test file** — a
case where the same mock IS called. A spy asserted `not.toHaveBeenCalled()` passes just as
happily when the component never renders.

---

## 7. Review depth

**Deep multi-agent adversarial pass**, chosen by David on 2026-08-05 when asked.

This is a **widening** of a privilege, which is the opposite direction from SPRIN-82 (a
revocation, which its spec correctly argued was not a security-boundary diff). Widening a
column grant on a table whose `slug` is a foreign-key target and whose `is_initial`
governs whether a project can create a ticket at all is the diff where one missed defect
is expensive.

Per CLAUDE.md: **every mutating reviewer gets its own worktree** (`isolation: "worktree"`),
reviewers are asked to **mutate rather than read**, and the **KILLED findings get read**,
not only the survivors.

The first things to attack:

1. **The grant.** Drop a column from it and see what goes red. If dropping `category`
   still ships green, §5.2's test is not doing its job.
2. **The `Exact<>` key-set assertion.** Widen `ProjectStatusUpdate` and confirm it is a
   compile error, not a warning.
3. **Every "sends nothing" test.** These are the story's most likely vacuous greens.
4. **`setStatusWipLimit`'s zero-row guard.** Return `data: []` with `error: null` and
   confirm `'stale'` — not `ok: true` with `undefined`.
5. **The schema's boundaries**, at the value and one past it: `1`, `0`, int4 max, int4
   max + 1.

---

## 8. Files touched

| file | change |
|---|---|
| `docs/migrations/sprin-85-wip-limit.sql` | **new** |
| `docs/sprintboard_phase1_schema.sql` | the column, the constraint, the four-column grant |
| `src/lib/database.types.ts` | **regenerated**, never hand-edited |
| `src/lib/domain.ts` | `hasWipLimits`; `ProjectStatusUpdate` + its `Exact<>` assertion |
| `src/lib/status-schemas.ts` | `WipLimitSchema` |
| `src/lib/project-statuses.ts` | `setStatusWipLimit` |
| `src/routes/StatusWipLimit.tsx` | **new** |
| `src/routes/StatusRow.tsx` | render the field when `hasWipLimits` |
| `src/routes/StatusSettings.tsx` | thread `hasWipLimits` |
| `src/routes/SettingsTab.tsx` | call `hasWipLimits(project)` |
| tests | §6 |

No change to `BoardTab` — rendering the limit is SPRIN-86.

---

## 9. Out of scope, stated so it is not "found missing"

- **Rendering the limit on the board** — SPRIN-86.
- **Blocking a drag into an at-limit column** — never; §2.2 of the epic design.
- **Fixing `renameProjectStatus`'s incidental zero-row guard** — a recorded follow-up
  (§4.4), left alone so this diff carries one behaviour change and not two.
- **A `wip_limit` on a Scrum row** — accepted gap, §3.4.
- **The `lg:grid-cols-4` fixed board column count** — an older recorded follow-up, still
  unrelated.
