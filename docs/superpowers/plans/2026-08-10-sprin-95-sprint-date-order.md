# Plan — SPRIN-95, reject a sprint that ends before it starts

Design: `docs/superpowers/specs/2026-08-10-sprin-95-sprint-date-order-design.md`. Read it first;
it carries the rejected alternatives and David's approval of the schema change.

Branch `sprin-95-sprint-date-order`, off `main` at `e88b8eb`.

## Global constraints — these bind every task

- **The coding standard is the gate.** `npm run lint` enforces T1–T5 as errors over
  `**/*.{ts,tsx,mjs,js}`: 30-line functions, cyclomatic 10, cognitive 15, 4 parameters,
  400-line files. Write to them from the first line. A genuine misfit is an ADR, never an
  inline disable.
- **Verification is `npm run verify`.** Never `tsc --noEmit`, never a chosen subset of test
  files. `npm run test:unit` is a local convenience and excludes every live suite.
- **Never use a Postgres `ENUM`,** and do not convert an existing `text` + `check` to one.
- **Migrations are hand-applied by David.** Produce the SQL file; do not attempt
  `apply_migration` (the Supabase MCP is `read_only=true` on purpose).
- **Live-suite sign-ins are rate-limited.** Do not add a `describe` with its own `beforeAll`
  when an existing one already has the fixtures. Never follow `signIn()` with
  `auth.getUser()` — read the id with `userId(client)`.
- **Do not assert an exact accessible name** for an element whose name is composed from
  several children (not relevant here, but the rule stands repo-wide).

## Task 1 — the three live tests, written to fail

**File:** `src/test/sprints.integration.test.ts`, inside the existing
`describe.skipIf(!hasRlsCredentials)('S6.1 sprint-creation contract', …)` block. Do **not**
create a new `describe` and do **not** add a `beforeAll`; `a`, `userAId` and `projectId` are
already in scope and `afterAll` already cascades the cleanup through the project delete.

Three tests:

1. **AC1 — rejects end before start.** Insert into `sprints` with `project_id: projectId`, a
   name, `start_date` a later UTC-midnight instant than `end_date`. Assert `data` is null,
   `error.code === '23514'`, **and** `error.message` contains
   `'sprints_end_not_before_start'`. The name assertion is required, not decoration:
   `sprints_status_check` also lives on this table, so a bare `23514` would pass on a
   violation this test is not about.
2. **AC2 — equal start and end are accepted.** Insert with both dates the same UTC-midnight
   instant. Assert no error, then **re-read the row with a second query** and assert both
   columns came back equal. Do not assert only on the row the insert echoed back.
3. **AC3 — either date null is accepted.** Two inserts: start set / end null, and end set /
   start null. Assert both succeed. (A sprint with *neither* date is already covered by the
   existing *"accepts a sprint with only a name"* test — do not duplicate it.)

Write dates as `'YYYY-MM-DDT00:00:00.000Z'` strings, matching what `toUtcMidnight` produces,
so the tests exercise the same instants the app writes.

**Expected result when run before the migration is applied:** AC1 **fails** — the insert
succeeds and returns a row. AC2 and AC3 **pass**, and that is not a bug in them: they are
regression guards proving the new constraint does not over-reach, so they are legal both
before and after. AC1 is the only test that discriminates, and seeing it red is the evidence
that the migration is doing the work.

Run them with `npx vitest run src/test/sprints.integration.test.ts` and **report the exact
failure output for AC1**. Do not "fix" it — the red is the deliverable.

## Task 2 — the migration and the schema document

**File:** `docs/migrations/sprin-95-sprint-date-order.sql`. Follow the house style of
`docs/migrations/sprin-94-project-cadence.sql`: a banner comment explaining *why*, the
statement wrapped in `begin; … commit;`, and a post-state `do $$ … $$` block.

The statement is exactly:

```sql
alter table sprints
  add constraint sprints_end_not_before_start check (end_date >= start_date);
```

The banner must record, because each was measured rather than recalled:

- The columns are `timestamptz`, not `date`, and `toUtcMidnight` pins every written value to
  UTC midnight — so instant order and calendar-day order coincide for every value the app can
  produce, and the check matches the client `refine` exactly.
- `pg_cast timestamptz → date` has `provolatile = 's'` (STABLE), so a `::date` variant
  **cannot be created at all**: Postgres refuses non-IMMUTABLE expressions in a `CHECK`.
- No null guard, and why (`check` passes on `null`; AC3).
- **No grant change, no index, no RLS change**, and that this absence is deliberate.
- Measured live 2026-08-10: 1 row, both dates null, 0 violations. Nothing to backfill.
- Not idempotent, deliberately — `add constraint` errors if the name exists, and the
  transaction rolls back. `if not exists` was not used: it would let a re-run silently skip
  the add and then verify a schema nobody applied.

The `do` block asserts, each raising its own exception: the constraint exists on
`public.sprints`; `contype = 'c'`; `convalidated` is true; and `pg_get_constraintdef(oid)`
equals the expected text. State its honest limit in a comment — it runs inside the
transaction that just did the work, so it reads back its own writes; what it catches is
someone editing the `alter` and not the block.

**Also:** add the constraint to the `sprints` table definition in
`docs/sprintboard_phase1_schema.sql`, with a short `-- SPRIN-95:` comment in the style of the
`-- SPRIN-94:` comments already in that file. That document is current and must stay so.

**Do not apply the migration.** David runs it by hand.

## Task 3 — correct the false docblock

**File:** `src/lib/sprint-schemas.ts`. Its docblock currently states:

> Date ordering is checked here and **not** in the database. That is a known asymmetry against
> CLAUDE.md's "validate at both edges" […] Recorded in the design doc as a trade, not an
> oversight.

That becomes false the moment the migration lands. Replace it with the true statement: the
rule now holds at both edges, the database constraint is `sprints_end_not_before_start`, and
this `refine` is what keeps a user from ever seeing the database's error (AC4). Keep the
existing, still-true note that the comparison is a plain string compare on ISO
`YYYY-MM-DD` values so no timezone enters the validation path.

Do **not** add an error branch to `createSprint` for `23514` — the design records why
(unreachable through the UI; the docblock's own reasoning survives).

## Out of scope

- Any change to `createSprint`'s result type or error handling.
- Any new test for AC4 — it is already covered at `src/routes/CreateSprintDialog.test.tsx:117`
  and `src/lib/sprint-schemas.test.ts:38`. The story owes a **mutation check** on those two,
  which I run myself, not another test.
- Any edit-sprint-dates path. None exists, and building one would widen the story.
