# SPRIN-80 — Delete a status without stranding the tickets on it

Epic SPRIN-72 (Rung 3.1, custom statuses), slice 4 — the last one. Depends on SPRIN-77,
which opened INSERT and UPDATE on `project_statuses` and deliberately left DELETE closed.

## Why this is its own story

Add, rename and reorder cannot lose data. This one can. Deleting a status that tickets sit on
must not orphan them, drop them off the board, or surface a raw foreign-key error — and deleting
the wrong status can break ticket creation for a project permanently.

## Decisions taken at design time

The Jira issue left three things open. All three are settled here.

### 1. A status holding tickets cannot be deleted (not "reassign and delete")

The alternative — make the user pick a destination and move the tickets as part of the delete —
is what Jira does, and the deferred fk would have made it genuinely atomic in one RPC. It was
rejected as more machinery than this slice needs. The refusal is more annoying and entirely
defensible: the user moves the tickets themselves, then deletes the empty status.

### 2. Deleting the initial status auto-promotes the next one

`is_initial` marks where new tickets land. It is enforced by
`project_statuses_one_initial_per_project`, a **partial unique index**, which means *at most*
one — there is no floor. An initial status holding no tickets is deletable under decision 1, and
deleting it would leave the project with nowhere for new tickets to start.

So deleting the initial status promotes the **lowest-position remaining** status to initial, in
the same transaction. No new UI, and the invariant holds by construction.

Rejected: refusing the delete (with no control to nominate a different initial status, `To Do`
would become permanently undeletable in every project); and adding a "starting status" control
(a second write path, another column grant, another set of tests — YAGNI until asked for).

**The promotion must happen in an `AFTER DELETE` trigger, not `BEFORE`.**
`project_statuses_one_initial_per_project` is a partial index, and a partial index cannot be a
constraint, so it cannot be `DEFERRABLE`. In a `BEFORE DELETE` trigger the outgoing row still
exists with `is_initial = true`, so setting another row's `is_initial` collides immediately.
After the delete, there is nothing to collide with.

### 3. Ticket counts are fetched eagerly for every status

One count per status when the settings tab loads, shown inline on each row, with Delete disabled
and the reason visible before the user clicks anything. The database is the real control, so a
stale count is a display bug and never a data one.

## The `is_initial` half is not optional

`createTicket` never sends `status` (`src/lib/tickets.ts:9`); it relies on the column default,
which is still the bare literal `'todo'`. That default is safe today only because the `todo` row
**cannot be removed** — there is no DELETE policy, and `slug` is not in the column-level UPDATE
grant. This story removes the first of those protections.

A brand-new project has zero tickets, so its `todo` status is empty and therefore deletable even
under decision 1's strict rule. Ticket creation would then fail forever on `tickets_status_fk`.

**Adding a DELETE policy without replacing that default is a data-loss bug**, which is why the
schema comment at `sprintboard_phase1_schema.sql:263` names SPRIN-80 as owning both halves
together. Neither ships alone.

## Enforcement: one control per rule

| Rule | Enforced by | Notes |
|---|---|---|
| A status holding tickets cannot be deleted | **the existing `tickets_status_fk`** | Already true. `on delete no action` raises `23503`. No new code. |
| A project's last status cannot be deleted | new `BEFORE DELETE` trigger | Nothing else can express `count(*) > 1`. |
| Deleting the initial status promotes the next | new `AFTER DELETE` trigger | Must be AFTER; see decision 2. |
| A new ticket resolves its status from `is_initial` | new `BEFORE INSERT` trigger on `tickets`, and `default 'todo'` dropped | Fires before the NOT NULL check, so an insert omitting `status` is filled rather than rejected. |
| Only the project's owner may delete | new `statuses_owner_delete` policy | RLS **filters** a DELETE rather than raising — see below. |

**Deliberately no "does this status hold tickets" check inside the trigger**, even though it would
produce a friendlier error than a raw `23503`. The fk already enforces it. Two guards on one bad
write mean removing either still goes red, and the suite stops being able to tell you which one
works. One rule, one control, one test that fails for one reason.

This also satisfies the issue's closing NOTE — a guard that says "the database enforces this"
needs a test proving it, verified against `pg_constraint`. The fk *is* the guard, so that test is
an assertion about `tickets_status_fk`'s real shape rather than a comment.

## Schema changes

All in one hand-applied migration, `docs/migrations/sprin-80-status-deletes.sql`, in a single
explicit transaction with an in-transaction smoke test in SPRIN-77's style. If any assertion
fails, nothing lands.

1. **`statuses_owner_delete`** — `for delete`, owner check on the parent project. Written with
   `(select auth.uid())` rather than a bare `auth.uid()` so it does **not** add a ninth
   `auth_rls_initplan` advisor lint. The existing eight are pre-existing and stay for SPRIN-75 to
   fix together; this story must not grow that list. This is a deliberate deviation from the
   surrounding policies' style and the migration says so inline, so it is not "tidied" back.

   `project_statuses` then carries **four** policies split by verb — read, insert, update, delete.
   Never collapse them into `for all`; the split is the security model, and a live test goes red.

2. **`project_statuses_delete_guard()`** — `BEFORE DELETE`, raises `SB001` when the project has
   only one status left.

3. **`project_statuses_promote_initial()`** — `AFTER DELETE`, and only when the deleted row was
   `is_initial`: promotes the surviving status with the lowest `position`.

4. **`resolve_initial_ticket_status()`** — `BEFORE INSERT` on `tickets`. When `status` is null,
   fills it from the project's `is_initial` row; raises `SB002` if there is none.

   `SECURITY DEFINER` with `set search_path = ''`, matching `seed_project_statuses()`. Under
   `SECURITY INVOKER` this read would depend on `statuses_owner_read` being broad enough for
   whoever is inserting — true today, and exactly the kind of app-layer guard leaning on a
   policy's breadth that CLAUDE.md warns will silently stop holding under SPRIN-75's membership
   model. `DEFINER` removes the coupling. Trigger functions need no `EXECUTE`, so it is revoked
   from `public`, `anon` and `authenticated`.

5. **`alter table tickets alter column status drop default`**, and
   `docs/sprintboard_phase1_schema.sql` updated to match — including replacing the comment block
   at lines 251-264 that describes the old default and names this story.

### Custom SQLSTATEs

`SB001` (last status) and `SB002` (no initial status) are raised with explicit `errcode`s rather
than the `P0001` default, so the client keys off a code that cannot be reworded. This module's
existing `23505` **message** parse exists only because Postgres offered no other channel; here we
control the raise, so we do not repeat it.

## Client changes

### `src/lib/project-statuses.ts`

- **`ticketCountsByStatus(projectId, statuses)`** → `Promise<Map<string, number>>`. One
  `head: true, count: 'exact'` query per status, issued in parallel. Exact, bounded, and no
  dependency on PostgREST's `select=status,count()` aggregate, which requires
  `db-aggregates-enabled` and could not be verified from here. A settings tab has a handful of
  statuses; this is cheap.

- **`deleteProjectStatus(id)`** → the existing `StatusWriteResult` shape with two new tags:

  | Outcome | Signal | Tag |
  |---|---|---|
  | Holds tickets | `23503` | `has_tickets` |
  | Last remaining status | `SB001` | `last` |
  | Not ours, or already gone | `error: null` and **zero rows** | `stale` |
  | Anything else | — | `unknown` |

  **The row count is load-bearing.** RLS *filters* a DELETE rather than raising on it, so a
  cross-tenant or stale id returns exactly `error: null, data: []` — a delete that removed
  nothing, indistinguishable from one that worked unless the count is checked. This is the same
  trap `reorderProjectStatuses` already guards against, and the reason the call uses
  `.delete().eq('id', id).select()`.

- **`initialSlug(statuses)`** → the single exported derivation of "where new tickets start",
  mirroring `doneSlugs()`. The confirm dialog's copy reads from it rather than re-deriving.

### Reflecting the promotion locally, not by refetching

An `AFTER DELETE` promotion changes a **different** row's `is_initial`, which no delete response
can carry back. Left alone, the client's `is_initial` goes stale and the *next* confirm dialog
names the wrong status.

An earlier draft of this spec resolved that by refetching. That was wrong on two counts, both
load-bearing:

- **`ProjectShell` states that every reducer is a LOCAL mutation, never a refetch** — an
  unguarded refetch resolving after a project switch clobbers the new project's list.
- **`ProjectShell` is at cyclomatic 10 of 10.** A promotion ternary inside the reducer adds a
  branch and reddens `npm run lint`.

So the client mirrors the promotion with a **pure exported function**,
`removeStatus(statuses, id)` in `project-statuses.ts`: it drops the row and, when the dropped row
was `is_initial`, marks the lowest-`position` survivor. The shell's new reducer is then
branch-free and adds nothing to its complexity:

```ts
const onStatusDeleted = (id: string) =>
  statusRead.patch(project.id, (ss) => removeStatus(ss, id))
```

That does leave the promotion rule expressed **twice** — once in the trigger, once in
`removeStatus` — which is exactly the drift this codebase warns about with `doneSlugs`. The rule
cannot literally be shared across SQL and TypeScript, so it is closed by test instead: the live
integration test deletes an initial status and asserts **the database** promoted the
lowest-`position` survivor, pinning the same expectation the unit test pins for the TypeScript
side. A trigger rewritten to promote by some other rule goes red.

### UI

`StatusSettings` gains `counts` and `onDeleted`. Each row shows its ticket count. Delete is
disabled, with the reason stated in the UI (AC4), when the status holds tickets or is the last
one. A confirm dialog guards the real thing, and when the initial status is being deleted its copy
names the status that will take over.

**`ProjectShell` is at cyclomatic 10 of 10**, and eslint counts each default parameter as a
branch — the next story touching it must extract first. So the counts fetch and the delete flow
live in **`SettingsTab`**, not as new branches in the shell. The shell gains only an `onDeleted`
prop that swaps in the refetched list, which adds no branch. If `SettingsTab` itself approaches a
threshold, the counts fetch extracts to a hook rather than the budget being widened.

## Tests

Written from the ACs before implementation.

**Unit** — `deleteProjectStatus`'s four-way mapping including the zero-rows case; `initialSlug`;
`ticketCountsByStatus`.

**Component** — count rendered per row; Delete disabled *with its reason* on a non-empty status
and on the last one; confirm dialog copy naming the promoted status; a successful delete calling
`onDeleted`.

**Live integration** — where the ACs actually live:

- AC1: an empty status deletes.
- AC3: after deletion, **assert directly that no ticket references the removed slug**, rather than
  inferring it from the UI looking right.
- AC5: deleting a non-empty status is refused *by the database*, and the ticket count is unchanged
  afterwards — the interrupted-delete path.
- AC4: the last remaining status cannot be deleted.
- Deleting the initial status promotes the next one **and a ticket created afterwards lands on
  it** — one test exercising the promotion trigger and the insert trigger together.
- A ticket created with no `status` resolves through `is_initial`, proving the `'todo'` default is
  really gone.
- `pg_constraint`: `tickets_status_fk` still exists with the expected shape (the issue's NOTE).
- Cross-tenant: B deleting A's status removes **zero rows** and does not raise.

**These land in the existing `rls.integration.test.ts` and `tickets.integration.test.ts`.** AC6
pins the test-file GAP at 7, and an eighth `*.integration.test.ts` file would move it.

## Definition of Done

- `npm run verify` green; test-file GAP still 7, re-derived rather than assumed. **Measured
  2026-08-02: 60 files all / 53 unit / GAP 7.**
- Migration applied by David from one copy-paste command; `get_advisors` afterwards shows **no new
  lint against a measured baseline**. **Measured 2026-08-02: 8 `auth_rls_initplan` WARN**
  (profiles, projects, project_counters, sprints, tickets, and all three `project_statuses`
  policies) **plus 3 `unindexed_foreign_keys` INFO** on `tickets`. Those eleven are pre-existing;
  the `auth_rls_initplan` set is SPRIN-75's to fix together. A ninth WARN means the new DELETE
  policy was written with a bare `auth.uid()` and must be corrected before merge.
- One PR, squash merged. SPRIN-80 → Done on merge, which closes epic SPRIN-72.

## Out of scope

- Reassigning tickets as part of a delete (decision 1).
- A control to nominate which status is the initial one (decision 2).
- Anything touching `lg:grid-cols-4` in `BoardTab`, which is fixed under a now-growable column
  count and needs its own layout story.
