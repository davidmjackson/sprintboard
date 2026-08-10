# SPRIN-95 — Reject a sprint that ends before it starts, in the database

**Story 4 of 4 in epic SPRIN-74 (configurable sprint cadence). Independent of stories 1–3.**
Migration **C** in the epic design,
`docs/superpowers/specs/2026-08-09-sprin-74-sprint-cadence-design.md`, which this document
narrows to the decisions the story actually had to make.

Approved by David 2026-08-10 before any file was written — the schema change is one of
autopilot's four stop-and-ask cases.

---

## What the story is

`src/lib/sprint-schemas.ts` validates `endDate >= startDate` with a zod `refine`, and its own
docblock admits the asymmetry:

> Date ordering is checked here and **not** in the database. That is a known asymmetry against
> CLAUDE.md's "validate at both edges", taken deliberately […] Recorded in the design doc as a
> trade, not an oversight.

This story pays that debt. After it, the rule holds at both edges, and **that docblock becomes
false and must be corrected in the same commit** — a stale statement of fact in a file every
sprint story reads is the decay class `CLAUDE.md` warns about.

## Acceptance criteria and where each is proven

| AC | Claim | Proven by |
|---|---|---|
| AC1 | The database rejects `end_date < start_date` | New live test: `23514` **and** the constraint name |
| AC2 | Equal start and end are accepted | New live test, re-read through the same client |
| AC3 | Either date null is accepted | New live tests, both directions |
| AC4 | The client `refine` still rejects first, so no user sees the DB error | **Already covered** — see below |

**AC4 needs no new test, and finding that out was the point of checking.**
`src/routes/CreateSprintDialog.test.tsx:117` — *"shows the field error and does not submit when
the end date precedes the start"* — already asserts the message renders **and**
`expect(createSprint).not.toHaveBeenCalled()`. That is AC4 exactly: the request is never issued,
so the constraint is unreachable through the UI. `src/lib/sprint-schemas.test.ts:38` covers the
`refine` itself, on the `endDate` path.

Writing a second test for a claim already pinned would have added a file and proven nothing new.
What the story owes instead is **evidence that the existing test is not vacuous**: it is
mutation-checked (delete the `refine`, watch it red) rather than trusted. See *Verification*.

## The migration

`docs/migrations/sprin-95-sprint-date-order.sql`:

```sql
alter table sprints
  add constraint sprints_end_not_before_start check (end_date >= start_date);
```

### Why this exact form, and why there is no alternative

**`start_date` and `end_date` are `timestamptz`, not `date`.** The epic design did not say so,
and it matters: the check compares *instants*, while the client's `refine` compares
`'YYYY-MM-DD'` strings, i.e. *calendar days*. Those are not the same comparison in general.

They are the same comparison for **every value this application can produce**, because
`toUtcMidnight` in `src/lib/sprint-dates.ts` pins both columns to `T00:00:00.000Z` on write and
`createSprint` is the only writer of either column in `src/` (verified by grep — no edit-sprint
path exists; `startSprint` and `completeSprint` touch `status` alone). With both operands at UTC
midnight, instant order and calendar-day order coincide, so `>=` at the database matches `>=` at
the client exactly and a same-day sprint is legal at both edges.

**A `::date` variant is not merely worse, it is impossible.** Measured on the live database:

```
pg_cast timestamptz -> date  =>  provolatile = 's'   (STABLE, not IMMUTABLE)
```

Postgres refuses a non-IMMUTABLE expression in a `CHECK`, so
`check (end_date::date >= start_date::date)` cannot be created at all. The cast is STABLE
precisely because it depends on the session `TimeZone` — which is also why it would have been
the wrong semantics even if it were allowed. The plain comparison is the only form available,
and it is the correct one.

**No null guard.** `end_date >= start_date` is `null` when either side is null, and a `CHECK`
passes on `null`. A sprint with no dates, or only a start, stays legal — matching
`CreateSprintSchema`, where every field is optional. Adding `or end_date is null or start_date
is null` would be noise that changes no outcome.

**No `NOT VALID` / `VALIDATE` two-step.** Re-measured live 2026-08-10: `sprints` holds **1 row,
both dates null, 0 violations**. `ALTER TABLE ADD CONSTRAINT` validates the existing rows itself
and there is nothing to backfill. Splitting it would buy a lock-duration saving on a table with
one row.

**Named, not left to Postgres.** Constraint names are client-visible API in this codebase —
`src/lib/project-statuses.ts` and its siblings parse them out of error messages — and AC1's test
asserts this name. A generated name would make that assertion a guess. Same reasoning as
SPRIN-94's two range checks.

**No grant change, no index, no RLS change.** The constraint moves no privilege. `sprints_owner`
is a single `for all` policy whose expressions name no columns, so it needs no edit. Nothing
filters or joins on the ordering, so no index. This absence is deliberate and stated in the
migration header, following SPRIN-94.

### The post-state `DO` block

Included, following SPRIN-94 and SPRIN-97. It asserts the constraint exists on `sprints`, is a
check (`contype = 'c'`), is `convalidated`, and that `pg_get_constraintdef` is exactly the
intended text.

Its honest limit, restated rather than assumed: it runs **inside the transaction that just did
the work**, so it reads back its own writes. What it catches is somebody editing the `alter`
statement and not the block. It is not independent verification — the live tests are.

### The schema document

`docs/sprintboard_phase1_schema.sql` is kept current (SPRIN-94's columns and SPRIN-97's grants
are both in it), so the constraint is added to the `sprints` table definition there in the same
commit. Leaving it out is exactly how the drift this project keeps finding starts.

## Decisions made without asking, and why

**`createSprint` does NOT gain a friendly error branch for `23514`.** Its docblock says a failure
is not user-correctable and so the result is a single `'unknown'`. That reasoning survives this
story: the refine gates every submit, so the constraint is unreachable through the UI, and a
branch for it would be an untestable path plus a cyclomatic point on a function in a file with
no headroom to spare. The docblock's parenthetical — *"no unique constraint is reachable here"* —
is still true as written. What changes is `sprint-schemas.ts`'s claim, and that is corrected.

Contrast `sprints_one_active_per_project`, which **is** surfaced with a clear message: that one
is reachable, because two clients can race to start a sprint. Reachability is the discriminator,
not the mere existence of a constraint.

**The new live tests go in the existing `S6.1 sprint-creation contract` describe** in
`src/test/sprints.integration.test.ts`, not a new block. That describe already signs in user A,
creates a project, and cascades its cleanup through `afterAll`. The file's own header records
that folding blocks together is deliberate — every extra `describe` with its own `beforeAll` is
another sign-in against the live-suite auth rate limit (`CLAUDE.md`, signature 1).

**AC1's test asserts the constraint name, not just `23514`.** `sprints` carries
`sprints_status_check` as well, so a bare SQLSTATE would pass on a violation the test is not
about. Same discipline as `projects.integration.test.ts:400`.

**AC2 and AC3 re-read through a second query rather than trusting the insert's returned row.**
An insert that echoed its input back would satisfy a bare `expect(error).toBeNull()`; the
re-read proves the row is in the table.

## Verification

- `npm run verify` in full, run by me, not a subagent and not a proxy.
- The test-count tripwire: `npm test` must collect exactly **7 more files** than
  `test:unit`, with **0 skipped**. A gap of 0 means the live suites silently skipped and the
  run is a failure however green it looks.
- **Order matters and is not optional.** The three new live tests are written **before** the
  migration is applied, and must be seen to **fail** — AC1 red because nothing rejects the row.
  Applying the migration first would remove the only signal that the tests test anything
  (`CLAUDE.md`: ship the migration with its tests).
- The AC4 mutation check: remove the `refine` from `CreateSprintSchema` and confirm
  `CreateSprintDialog.test.tsx:117` and `sprint-schemas.test.ts:38` both go red, then restore.
  A passing test proves nothing until it has been watched to fail.
- `get_advisors` after applying, compared against the **2026-08-09 baseline of 16 performance /
  1 security** — not against zero. A check constraint should move neither.
