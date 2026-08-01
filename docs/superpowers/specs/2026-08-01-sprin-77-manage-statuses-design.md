# SPRIN-77 — Manage a project's statuses: add, rename and reorder

**Epic:** SPRIN-72 (Rung 3.1, custom statuses and configurable board columns)
**Depends on:** SPRIN-79 (per-project status rows), SPRIN-76 (board renders from those rows)
**Blocks:** SPRIN-80 (delete a status)
**Date:** 2026-08-01

---

## 1. What this story is

The first story in epic 72 a user can *see*. SPRIN-79 moved the status vocabulary into
`project_statuses`; SPRIN-76 made the board render from those rows. Both left the table
**readable but not writable** — `statuses_owner_read` is the only policy on it, and it is
`for select`. This story opens writes and builds the surface that uses them.

Three operations, and no more: **add**, **rename**, **reorder**. Delete is SPRIN-80 and
stays out, deliberately — it has a data-safety problem of its own (what happens to tickets
sitting on the deleted status) and the RLS design below keeps the door shut until then.

## 2. The prerequisite that is not optional

`src/lib/domain.ts:44-47` states it as a hard precondition, and it is repeated in
`docs/sprintboard_phase1_schema.sql:120-124`:

> SPRIN-77 must move `src/lib/sprints.ts`'s `.neq('status','done')` and
> `src/routes/ProjectShell.tsx`'s `t.status !== 'done'` onto this column — **BOTH of them,
> together** — before it opens write access to `project_statuses`.

The reason is concrete. Both sites hardcode the slug `'done'` as "this ticket is finished".
That is only true while the vocabulary is immutable. The moment a user can add a status,
they can add a *terminal* one — and `completeSprint` would drag its tickets back to the
backlog because their slug is not literally `done`. Equally, a user renaming the seeded
`Done` column does **not** change its slug, so that path stays correct; it is the *added*
terminal status that breaks. `category = 'done'` is the field that already exists to carry
this, seeded correctly on every project, and defaulted to the non-terminal `in_progress`
so a flow that forgets it fails safe.

So: **the `'done'` move ships in this story, in the same commit range as the write policies.**

## 3. Decisions taken with David (2026-08-01)

Four questions were put; all four answered. These are settled, not open.

| # | Decision | Chosen |
|---|---|---|
| 1 | How to open writes | **Narrow: INSERT + UPDATE, no DELETE**, plus column-level `revoke update` |
| 2 | Duplicate-name constraint | **Case-insensitive, trimmed**: `unique (project_id, lower(btrim(name)))` |
| 3 | Reading of "which board column it belongs to" | **`category`**, exposed as a picker on the add form |
| 4 | Leftover PR #73 | Merged before this branch started (now `a29dbb0` on `main`) |

## 4. Database changes (hand-applied — the MCP is read-only on purpose)

Five statements. Each is justified below; none is optional.

### 4.1 The duplicate-name constraint (AC4)

```sql
create unique index project_statuses_project_name_unique
  on project_statuses (project_id, lower(btrim(name)));
```

An **index**, not a table constraint, because the key is an expression and Postgres will
not accept an expression in `unique (...)` on a table. Scoped to `project_id`, so the same
name in a different project is fine — which AC4 requires explicitly.

`lower(btrim(...))` mirrors the existing `project_statuses_name_nonempty` check, which
already `btrim`s. "Done" / "done" / " Done " are one name to a user, so they are one name
here. The client's zod schema rejects the same shape first; the index is the edge that
cannot be bypassed, per CLAUDE.md's both-edges rule.

Its violation surfaces as SQLSTATE **23505**. The write layer maps that one code to a
field-level error rather than the generic failure message, in the same idiom `startSprint`
already uses for the one-active-sprint index.

### 4.2 The write policies

```sql
create policy statuses_owner_insert on project_statuses
  for insert
  with check (exists (select 1 from projects p
                      where p.id = project_statuses.project_id
                        and p.owner_id = auth.uid()));

create policy statuses_owner_update on project_statuses
  for update
  using      (exists (select 1 from projects p
                      where p.id = project_statuses.project_id
                        and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p
                      where p.id = project_statuses.project_id
                        and p.owner_id = auth.uid()));
```

Two policies, not one `for all`. **There is deliberately no DELETE policy.** The existing
comment on `statuses_owner_read` names the exact failure a `for all` policy would reopen:
an owner deleting the `todo` row permanently breaks ticket creation, because
`tickets.status`'s default is the bare literal `'todo'` and nothing resolves it against
`is_initial` yet. SPRIN-80 owns both the delete UI and that default's replacement. Until
then a `DELETE` from a client matches no policy and is denied.

`statuses_owner_read` **stays `for select`** and must not be folded into these. Three
separate policies is the point: it is what makes "no DELETE" expressible at all.

**Do not add `force row level security`.** Unchanged from SPRIN-79's warning, and now more
load-bearing, not less: `seed_project_statuses()` is `security definer` and runs as the
table owner, exempt from RLS only while FORCE is off. With FORCE on, every project
creation fails at insert time for every user.

### 4.3 Column-level revoke — slug immutability

```sql
revoke update (id, project_id, slug, is_initial)
  on project_statuses from authenticated, anon;
```

This is the guard that makes the UPDATE policy safe to grant. `tickets_status_fk`
references `project_statuses (project_id, slug)`, and CLAUDE.md's rule is that the fk is
keyed on the slug "precisely so no ticket row is ever rewritten when the vocabulary
changes". A rename must therefore touch `name` and nothing else.

Without this, an owner could `PATCH {slug: ...}` on a status. The fk is `on update no
action`, so a status *with* tickets would be protected by the database — but an *unused*
status's slug would change freely, and the next ticket created on the old slug would fail
a foreign-key check with no explanation. Postgres column privileges close it at the right
layer: the request is rejected before any policy is consulted.

`is_initial` is in the list for the same reason — `project_statuses_one_initial_per_project`
prevents *two* initial statuses but not *zero*, and zero is a state SPRIN-80 must handle,
not one this story should let a user reach.

### 4.4 The reorder function

```sql
create or replace function reorder_project_statuses(p_project_id uuid, p_slugs text[])
returns setof public.project_statuses
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  update public.project_statuses s
     set position = o.ord
    from unnest(p_slugs) with ordinality as o(slug, ord)
   where s.project_id = p_project_id
     and s.slug = o.slug
  returning s.*;
end;
$$;

revoke execute on function public.reorder_project_statuses(uuid, text[]) from public, anon;
grant  execute on function public.reorder_project_statuses(uuid, text[]) to authenticated;
```

**Why a function at all**, when every other write in this codebase is a plain PostgREST
call: `project_statuses_project_position_unique` is `deferrable initially deferred`, and
that deferral only helps *within one transaction*. PostgREST wraps each HTTP request in its
own transaction, so N separate `PATCH position=` requests would collide on the very first
swap — moving row 2 to position 1 violates the constraint against the row already there,
and there is no later statement in that transaction for the deferral to defer to. One
statement inside one function is the only shape where the deferral does its job. This is
exactly what the schema comment anticipated when it wrote the constraint that way.

`security invoker`, **not definer** — the caller's own rights apply, so
`statuses_owner_update` still governs every row touched and a cross-tenant `p_project_id`
updates nothing. That is the whole reason a definer function is not needed here: unlike
`seed_project_statuses()`, this one is *not* trying to do something the caller may not do.
`set search_path = ''` and schema-qualified references travel with it anyway, because a
`public` function published as a PostgREST RPC is reachable by any authenticated caller and
should not resolve names through a caller-controlled path.

The `revoke from public, anon` + `grant to authenticated` pair is not the same shape as
`seed_project_statuses()`'s blanket revoke: that one is a **trigger** function, and triggers
need no EXECUTE privilege at all. This one is called directly, so `authenticated` must keep
it.

**Positions stay dense 1..N.** The function assigns `ordinality`, so a caller sending the
full ordered slug list always produces `1..N` with no gaps. A caller sending a partial list
would leave the omitted rows on their old positions and could collide at commit — the write
layer always sends the complete list, and a unit test pins that.

### 4.5 After applying

Run `get_advisors`. Note the known, pre-existing state recorded at SPRIN-79: `auth_rls_initplan`
already fires on **every** policy in this database because each wraps `auth.uid()` unwrapped.
The two policies added here will add two more instances of that same pre-existing lint.
**"Zero lints" is not achievable and is not the bar** — SPRIN-75 fixes all of them together
when it rewrites every policy for the membership model. The bar for this story is: no *new
class* of advisor, and no `rls_disabled_in_public` / `policy_exists_rls_disabled`.

## 5. Application changes

### 5.1 `src/lib/project-statuses.ts` — the write layer

Reads and writes share a module here, matching `sprints.ts` (which holds `listSprints`
alongside `createSprint`/`startSprint`/`completeSprint`). The file is 59 lines today; this
takes it to roughly 190, well inside the 400-line ceiling.

Four additions:

**`slugForName(name: string): string | null`** — derives the machine identity from the
display name. Lowercase, non-alphanumeric runs collapse to `_`, leading/trailing `_`
stripped, truncated to 30 characters. Must satisfy the existing `project_statuses_slug_format`
check `^[a-z][a-z0-9_]{0,29}$`, so a name that derives to something starting with a digit or
to the empty string returns **`null`**, and the caller reports a field error rather than
sending a request the database will reject on a constraint the user cannot see. (Example:
a name of `"42"` or `"!!!"`.) The truncation happens *before* the trailing-`_` strip, so a
30-character cut landing on `_` does not produce an invalid slug.

**Slug collision.** `project_statuses_project_slug_unique` is a real constraint and two
distinct names can derive to one slug ("To Do" and "To-Do" both give `to_do`). The name
index in §4.1 does **not** catch this — those are different names. The write layer appends
`_2`, `_3`, … until the slug is free among the project's loaded rows, and the database's
own unique constraint remains the backstop for the race. Deriving rather than exposing the
slug is deliberate: the user renames `name`, never `slug`, which is the same division
`projects.key` already uses.

**`doneSlugs(statuses: readonly ProjectStatus[]): Set<string>`** — the single derivation of
"which of this project's statuses are terminal", `category === 'done'`. **One exported
helper, used by all three consumers** (the DB filter, the shell's optimistic reducer, and
the tests), because the correctness argument in `completeSprint`'s docblock rests on the
database's rule and the client's local patch being *the same rule*. Two independent
derivations could drift; one cannot.

**`createProjectStatus` / `renameProjectStatus` / `reorderProjectStatuses`** — tagged-result
returns in this codebase's established shape (`{ ok: true, ... } | { ok: false, error: tag }`),
not thrown errors, matching `startSprint`/`completeSprint`. `23505` maps to a `'duplicate'`
tag; everything else collapses to `'unknown'`.

`createProjectStatus` computes `position` as `max(position) + 1` from the loaded rows —
appending, so an add never disturbs existing column order. It passes `is_initial: false`
explicitly rather than relying on the column default, because the default is the thing
SPRIN-80 changes.

### 5.2 `src/lib/status-schemas.ts` (new) — zod

`AddStatusSchema`: `name` trimmed, 1–40 characters (matching `project_statuses_name_nonempty`'s
`length(name) <= 40`), `category` a `z.enum` over `STATUS_CATEGORIES` from `domain.ts`.
`RenameStatusSchema`: the `name` rule alone.

Both edges, as everywhere else: zod rejects the shape, the constraints reject the truth
(uniqueness is not knowable client-side without a race).

### 5.3 The `'done'` move

**`sprints.ts`** — `completeSprint(id: string, doneSlugs: ReadonlySet<string>)`. The filter
becomes:

```ts
// slugs are constrained to ^[a-z][a-z0-9_]{0,29}$ by project_statuses_slug_format, so
// there is no comma, paren or quote to escape in this list — the check constraint is
// what makes the raw join safe.
query = doneSlugs.size > 0 ? query.not('status', 'in', `(${[...doneSlugs].join(',')})`) : query
```

The **empty set is a real case now** and must not be an error: a project whose statuses
include no `done`-category row has nothing terminal, so *every* ticket is incomplete and
every one returns to the backlog. Emitting `in ()` would be malformed, so the filter is
omitted entirely — which produces exactly that semantics.

Why the caller supplies the set rather than `completeSprint` fetching it: the shell's
optimistic reducer needs the identical set, and it already holds the loaded rows.
Threading one value from one source makes "the DB's rule and the local patch agree"
structurally true. Having the function fetch its own copy would create two reads that can
disagree — the precise failure the existing docblock's idempotency argument depends on not
happening. Cost: `CompleteSprintButton` gains one prop and `SprintsTab` derives it once.

**`ProjectShell.tsx`** — `onSprintCompleted`'s ternary becomes
`!done.has(t.status)` where `const done = doneSlugs(statuses)`. Same helper, same rule.

Both sites move together. Neither is useful alone: the DB filter without the reducer paints
a ticket back into the backlog the database kept, and the reducer without the filter does
the reverse.

### 5.4 The settings surface

A **fourth tab**, `/projects/:projectId/settings` → `SettingsTab.tsx`, alongside board /
backlog / sprints, with a `NavLink` in `ProjectShellHeader.tsx`. Chosen over a dialog
because the shell already provides `statuses` and `statusesPhase` through
`ProjectShellContext` — a tab reads them for free and inherits the tab-scoped
`ErrorBoundary`, the retry affordance, and the phase-before-empty discipline every other
tab follows. A dialog would need all of that threading built again.

`StatusSettings.tsx` holds the list, extracted so `SettingsTab.tsx` stays a thin
context-reading shell in the shape `SprintsTab` already has. Each row: the name (inline
edit, following `EditableText`), the category, and **Move up / Move down buttons — not drag**.
Drag is excluded on evidence, not taste: CLAUDE.md records that jsdom has no `dataTransfer`,
so every Vitest test of a drag asserts wiring and never the gesture, and the only real
coverage would be Playwright, which is explicitly **not the gate**. Buttons are testable in
the gate, and keyboard-operable without an ARIA drag-and-drop pattern.

**Optimistic updates** follow the local-mutation reducer convention (AC5, and
`local-mutation-reducers-derive-from-rule`): the shell gains `onStatusCreated`,
`onStatusUpdated` and `onStatusesReordered` on the context, each a `statusRead.patch`
deriving from the operation's own predicate so a fail-then-retry is idempotent.
`onStatusesReordered` replaces by slug from the rows the RPC returns — the database's own
post-update rows, not a guess, matching `onSprintCompleted`'s use of `returnedTickets`.

**AC1 — "appears as a board column without a reload"** falls out of this: `BoardTab` already
renders `statuses` from the same context, so a patched list re-renders the columns. No new
mechanism; that is what SPRIN-76 bought.

### 5.5 Accessible-name discipline

Per SPRIN-67 (recorded at length in CLAUDE.md): **no exact accessible-name assertion on any
element whose name is composed from several children whose `display` comes from Tailwind.**
Status rows are exactly that shape. Assert DOM text scoped with `within(row)`, and pair it
with a **substring** role-name query (`{ name: /move .* up/i }`) so `aria-hidden` is still
honoured. Exact names are fine on the buttons, whose names come from a single text node or
an `aria-label`.

## 6. Testing

| Area | File | What it pins |
|---|---|---|
| Slug derivation | `project-statuses.test.ts` | truncation, invalid-start → `null`, `_2` collision suffix |
| `doneSlugs` | `project-statuses.test.ts` | category filter; empty set when nothing is terminal |
| Write layer | `project-statuses.test.ts` | 23505 → `'duplicate'`; reorder sends the **complete** ordered list |
| zod | `status-schemas.test.ts` | 40-char boundary, empty-after-trim, category enum |
| `completeSprint` | `sprints.test.ts` | filter present with slugs; **filter absent when the set is empty** |
| Shell reducers | `ProjectShell.test.tsx` | idempotent re-apply; a renamed terminal status still counts as done |
| UI | `StatusSettings.test.tsx` | add/rename/reorder wiring, duplicate-name field error, pending + failure states |
| **RLS** | `rls.integration.test.ts` (**extended, not new**) | owner can insert/update; **stranger cannot**; **nobody can DELETE**; **slug UPDATE is denied** |

The RLS coverage goes into the **existing** integration suite. Adding a new
`*.integration.test.ts` file would move the tripwire GAP from 7 to 8, and AC6 requires it
stay 7.

Two of those RLS cases are the ones that actually matter, and both are negative controls
paired with a positive one (per `rls-tests-pass-for-the-wrong-reason` — RLS *filters*, it
does not raise, so a zero-row result must be distinguished from a zero-row table):

- **DELETE is denied for the owner's own row.** This is the assertion that keeps SPRIN-80's
  door shut. If someone later "simplifies" the three policies into one `for all`, this test
  is what goes red.
- **Updating `slug` is denied** by the column revoke, while updating `name` on the same row
  succeeds. The paired success is what proves the failure is the revoke and not a broken
  fixture.

## 7. Out of scope

- **Deleting a status** — SPRIN-80, and the RLS design above actively prevents it.
- **Replacing `tickets.status`'s `default 'todo'` with `is_initial` resolution** — SPRIN-80,
  same story that makes zero-initial reachable.
- **A scrolling board for >4 columns.** `BoardTab`'s `lg:grid-cols-4` is a fixed class under
  a now-dynamic column count; five statuses render five columns that wrap. Cosmetic, visible,
  and worth its own decision — recorded here, not fixed here, because doing it properly is a
  layout story and doing it carelessly is a regression on the four-column case.
- **Kanban / custom fields / cadence / membership** — later epics, untouched.

## 8. Risks

1. **The migration is hand-applied.** Five statements, one copy-paste, then `get_advisors`.
   Per `validate-sql-before-handing-it-over`, every top-level literal is `SELECT`-checked
   before the SQL is handed over.
2. **Widening a deliberately-narrow policy is the security event of this story.** It is why
   the RLS integration suite is extended rather than merely kept green — owner-vs-stranger
   was already covered; *this table, these verbs* was not.
3. **`completeSprint`'s guard breadth.** Its docblock records that its safety rests on
   `sprints_owner` being a single `for all` policy. This story does not change that policy,
   but it does establish the precedent of splitting a table's policies by verb — and
   SPRIN-75 must re-audit `completeSprint` when read and write stop being co-extensive.
   Noted so the precedent is not mistaken for permission.
