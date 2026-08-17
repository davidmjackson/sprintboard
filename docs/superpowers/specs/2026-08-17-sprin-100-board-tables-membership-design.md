# SPRIN-100 — Board tables governed by membership, not ownership

Story 3 of epic SPRIN-75. Design settled 2026-08-17, approved by David before any SQL was
written. Branch `sprin-100-board-tables-membership`, cut from `main` at `52fa6ed`.

## What the story asks for

Rewrite the three `for all` policies that govern day-to-day board work — `sprints_owner`,
`tickets_owner`, `counters_owner` — from ownership to membership, with **no role predicate**:
both `admin` and `member` do board work.

Each currently reads, verbatim from `pg_policies` on 2026-08-17:

```sql
exists (select 1 from projects p
        where p.id = <table>.project_id and p.owner_id = auth.uid())
```

and becomes `app_auth.is_project_member(<table>.project_id)`.

**They stay single `for all` policies.** This is load-bearing, not cosmetic — see §5.

## The two problems the story description does not mention

Both were found in orientation by checking the ACs against the live catalogue rather than
against the prose. Both would have shipped as breakage.

### 1. The naive rewrite breaks the keepalive contract, and therefore every future merge

Measured on the live database, 2026-08-17:

| Fact | Value |
|---|---|
| `sprints`, `tickets`, `project_counters` table ACL | `anon=arwdDxtm` — anon holds full CRUD |
| All three policies' roles | `{public}` — **no `TO` clause**, so anon is covered |
| `anon` USAGE on schema `app_auth` | **false** |
| `anon` EXECUTE on `app_auth.is_project_member(uuid)` | **false** |

Policy expressions are evaluated as the *calling* role. So a policy calling an `app_auth`
function, on a table anon can reach, raises `permission denied for schema app_auth` (42501)
for an anonymous caller — where today the `EXISTS` simply matches nothing and anon gets a
clean empty array.

This is not a prediction. `src/test/project-members.integration.test.ts:446-455` already
derived exactly this from the catalogue and wrote it down: *"Grant anon SELECT and the call
still fails 42501 — because the moment `members_read` is finally evaluated Postgres raises
`permission denied for schema app_auth`."* SPRIN-98 never felt it because `anon` holds **no
grant at all** on `project_members`, so the privilege layer refuses first.

**SPRIN-100 is the first story to put an `app_auth` call in front of a table anon can reach.**

The consequence is disproportionate. The cron-job.org keepalive performs an anonymous
`GET /rest/v1/tickets?select=id&limit=1`, and `src/test/keepalive.integration.test.ts`
asserts `200` plus a JSON array on the **required** `verify` check. The naive rewrite turns
that red; shipped, it stops the keepalive, the free-tier project pauses after ~7 days, and
per `CLAUDE.md` a paused database blocks every merge — including the one that would fix it.

**Decision: add `to authenticated` to all three policies.**

Anon then matches no policy at all. RLS filters it to zero rows, the `200 []` contract is
preserved exactly, and anon never reaches `app_auth`. Anon's observable behaviour is
unchanged on all four verbs — SELECT still `[]`, INSERT still 42501 with
`new row violates row-level security policy`, UPDATE and DELETE still zero rows — while the
role's actual reach is strictly narrower than today.

**Rejected — short-circuit the predicate:** `(select auth.uid()) is not null and
app_auth.is_project_member(project_id)`. Relies on the planner evaluating `AND` operands
left to right, which is not guaranteed. A correctness property must not rest on plan shape.

**Rejected — grant anon USAGE and EXECUTE on `app_auth`:** widens anon's reach into the
schema that exists to hold the security predicates, to buy a `false` it can already get by
matching no policy.

### 2. The bootstrap problem arrives one story early

`HANDOVER.md` and SPRIN-101 both place the bootstrap problem on the `projects` table. It
bites here first, and nothing in SPRIN-100's description says so.

Measured from `pg_trigger`, all three `AFTER INSERT ... FOR EACH ROW` on `projects`:

| Trigger | Function | Security |
|---|---|---|
| `on_project_created` | `create_project_counter` | **INVOKER** |
| `on_project_created_admin` | `seed_project_admin` | DEFINER |
| `on_project_created_statuses` | `seed_project_statuses` | DEFINER |

Same-timing triggers fire in **name order**, and `on_project_created` is a prefix of
`on_project_created_admin`, so the counter insert runs **first** — before the membership row
exists. `create_project_counter` is SECURITY INVOKER and does
`insert into public.project_counters (project_id) values (new.id)`, which under a
membership-only `counters_owner` fails `WITH CHECK`. **Every project creation would fail.**

**Decision: `create_project_counter` becomes SECURITY DEFINER.**

Its two sibling triggers on the same table are already DEFINER for precisely this reason, so
this is consistency with an established pattern rather than a new privilege shape. It inserts
`new.id` and nothing caller-controlled, so its authority is inherited from the `projects`
INSERT policy that just admitted the row. It already carries `set search_path = ''`, so it
adds no `function_search_path_mutable` advisor lint.

**Rejected — rename the trigger so it sorts after the admin seeding:** keeps the insert under
RLS, but makes alphabetical fire order a load-bearing, invisible mechanism that any future
rename breaks silently. `sprin-98-project-members.sql` explicitly says *"Nothing depends on
that ordering"* — this option would make that comment false.

**Rejected — widen `counters_owner` to re-admit the project owner:** contradicts David's
settled design that `owner_id` is an audit column granting nothing, and re-introduces into a
policy the very ownership this epic exists to remove.

## The policies, as they will read

```sql
create policy counters_owner on project_counters
  for all
  to authenticated
  using      (app_auth.is_project_member(project_counters.project_id))
  with check (app_auth.is_project_member(project_counters.project_id));
```

and the same shape for `sprints_owner` and `tickets_owner` on their own `project_id`.

## Decisions taken without asking, each open to veto

- **The policy names do not change.** They will say `_owner` while meaning membership, which
  is a genuine wart in a file this project keeps honest. Kept anyway: the AC enumerates all
  three by name as the objects to modify, SPRIN-103 and SPRIN-104 will reference them, and a
  rename adds churn to a diff whose whole value is being easy to review line by line. The
  schema doc states the discrepancy in a comment rather than leaving a reader to infer it.
- **A new suite file**, `src/test/board-membership.integration.test.ts`, rather than extending
  `rls.integration.test.ts`. The membership fixtures need users that no sibling file can
  touch, which is exactly the remedy SPRIN-105 arrived at after its unscoped assertions went
  red. Throwaway users follow the `profiles.integration.test.ts:104-116` pattern.
- **Only `member` rows are added by the new fixtures, never a second `admin`.**
  `project-members.integration.test.ts:209` asserts a whole-database invariant that every
  project has *exactly one* admin, and it runs in parallel against the same database. A second
  admin anywhere turns a sibling file red.
- **`verify-gate.test.mjs`'s `LIVE_SUITES` gains two entries, not one.** The array lists eight
  files; there are nine. `profiles.integration.test.ts` was added by SPRIN-105 and never
  registered, so the control that exists to make an unregistered live suite impossible is
  itself blind to one today. Registering the missing sibling alongside the new suite takes it
  to ten. Disclosed to David rather than folded in silently.

## What must NOT change — the trap this story must not spring

`src/lib/sprints.ts:219-238` carries a docblock addressed to this exact migration.
`completeSprint`'s guard, `requireSprintStatus`, is safe **only** because `sprints_owner` is a
single `for all` policy: the same predicate governs the guard's `SELECT` and both writes, so
*"can read this sprint's status"* and *"can write it"* are the same question. If read ever
becomes broader than write on this table, the guard silently stops holding **and the isolation
suite would not flag it**.

This design keeps read and write co-extensive — one policy, one predicate, both clauses. That
is why David rejected a read-only `viewer` role for the whole epic. The docblock is updated to
record that SPRIN-100 preserved the property rather than left to imply the question is open.

The second constraint, from `docs/sprintboard_phase1_schema.sql:677-679`: `assign_ticket_key`
is deliberately **not** SECURITY DEFINER, so its `project_counters` UPDATE is permitted only by
`counters_owner`. Ticket-key atomicity depends on the writer keeping that write. Membership
grants it, and a positive control proves it: a non-owner member creating a ticket must receive a
correctly numbered key.

> **SUPERSEDED during implementation, by `sprin-100b`.** The paragraph above is left as the
> design said it, but it did not survive contact. `assign_ticket_key` also **reads `projects`**,
> which stays owner-scoped until SPRIN-101, so a member's ticket insert failed with a NULL `key`.
> The function is now SECURITY DEFINER, which knowingly gives up the `counters_owner` tripwire
> this paragraph describes. The positive control still exists and still earned its place — it is
> what caught the defect — but what it pins is the membership path end to end, not that policy.

## Expected advisor delta

Baseline re-derived 2026-08-17 with `get_advisors`, before any change: **1 security WARN**
(leaked-password protection) and **15 performance lints** — 8 `unindexed_foreign_keys` INFOs
and **7 `auth_rls_initplan` WARNs** across five tables.

Three of those seven are `counters_owner`, `sprints_owner` and `tickets_owner`. A `STABLE`
definer predicate takes the `auth.uid()` read out of the per-row path, so they should clear —
the same mechanism that kept SPRIN-98's four new policies off the list. Expected after:
**12 performance lints, 4 WARNs across two tables** (`projects` ×1, `project_statuses` ×3 — an
earlier draft of this line said "three tables" while naming two).

Re-derive with `get_advisors` after applying and update `CLAUDE.md`'s baseline. Do not trust
this paragraph; it is a prediction, and `unused_index` has already taught this project that a
reading taken straight after a migration can be transient.

## Test plan

Live, against the real database, in the new suite. Every negative assertion carries a positive
control, and every assertion is scoped to a fixture the suite itself created.

**Fixtures** — three throwaway users created via `admin.auth.admin.createUser`:
`O` (creates the project, so the trigger makes them its one admin), `M` (added as `member` by
the service-role client), `S` (a stranger with no membership).

1. **Positive controls — a non-owner member does board work.** `M` can read, insert, update and
   delete tickets in `O`'s project; can create and read a sprint; and `M`'s inserted ticket
   comes back with a correctly formatted, correctly numbered key — which is the only thing that
   proves the `counters_owner` UPDATE inside `assign_ticket_key` still succeeds for a member.
2. **`M` can read the counter row** for the project, scoped to `project_id`.
3. **Negative — the stranger.** `S` sees zero sprints, tickets and counter rows for the project;
   `S`'s ticket and sprint inserts raise 42501; `S`'s updates and deletes affect zero rows. Each
   paired with a re-read proving the row is intact and visible to `M`.
4. **The anon shape, on all three tables.** An anonymous read returns `error: null, data: []` —
   **not** 42501. This is the assertion that goes red if anyone drops `to authenticated`, and it
   pins the keepalive contract's shape at the policy level rather than only at the cron's URL.
5. **The bootstrap control.** An authenticated user with no prior membership creates a project
   and immediately creates a ticket in it. This fails outright without the
   `create_project_counter` DEFINER change, so it is the test that pins finding 2.
6. **Read ≡ write.** For a member, every row `M` can `select` in the project is a row `M` can
   `update` — asserted by round-tripping an update through the same predicate, so a future
   verb-split that widens read over write goes red here rather than silently disarming
   `completeSprint`'s guard.

## Order of work

`ship the migration WITH its tests`. The suite is written and committed **red**, before the
migration is applied — applying early to make it green removes the signal that the tests are
measuring the policy rather than passing anyway. Mutation review happens **after** the migration
lands and the suite is green: a red suite cannot be reviewed for adequacy, because there is no
positive control to kill.

Migrations are hand-applied. `docs/migrations/sprin-100-board-tables-membership.sql` is produced
here; David runs it in the SQL editor. ASCII only.
