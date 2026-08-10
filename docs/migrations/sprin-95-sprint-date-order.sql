-- =============================================================================
-- SPRIN-95  Reject a sprint that ends before it starts
--           (Rung 3 epic SPRIN-74, story 4 -- "Migration C" in the epic design)
--
-- ONE NAMED CHECK CONSTRAINT. Nothing else moves: no column, no grant, no index,
-- no RLS change. `src/lib/sprint-schemas.ts` already refuses `endDate < startDate`
-- in the client; this file pays the asymmetry that file's own docblock admitted,
-- so the rule finally holds at BOTH edges (CLAUDE.md, "validate at both edges").
--
-- MEASURED LIVE 2026-08-10 BEFORE WRITING THIS FILE, not recalled:
--
--   sprints.start_date / sprints.end_date  ->  timestamp with time zone
--   sprints                                ->  1 row, 0 dated rows, 0 violations
--   existing check constraints on sprints  ->  sprints_status_check (only)
--   pg_cast timestamptz -> date            ->  provolatile = 's'  (STABLE)
--
-- WHY A PLAIN COMPARISON AND NOT `::date`. The columns are timestamptz, so the
-- check compares INSTANTS while the client's refine compares 'YYYY-MM-DD'
-- CALENDAR DAYS. Those are not the same comparison in general -- but they are the
-- same for every value this application can produce, because `toUtcMidnight` in
-- src/lib/sprint-dates.ts pins both columns to T00:00:00.000Z on write and
-- `createSprint` is the only writer of either column in src/ (no edit-sprint path
-- exists; startSprint and completeSprint touch `status` alone). With both operands
-- at UTC midnight, instant order and calendar-day order coincide, so `>=` here
-- matches `>=` in the client exactly and a same-day sprint is legal at both edges.
--
-- A `::date` VARIANT IS NOT MERELY WORSE, IT IS IMPOSSIBLE. The timestamptz->date
-- cast is STABLE (measured above), and Postgres refuses a non-IMMUTABLE expression
-- in a CHECK, so `check (end_date::date >= start_date::date)` cannot be created at
-- all. It is STABLE precisely because it reads the session TimeZone -- which is also
-- why it would have been the wrong semantics even if it were allowed.
--
-- NO NULL GUARD, DELIBERATELY. `end_date >= start_date` evaluates to NULL when
-- either side is null, and a CHECK PASSES on NULL. A sprint with no dates, or with
-- only one, stays legal -- matching CreateSprintSchema, where every field is
-- optional. `or end_date is null or start_date is null` would change no outcome and
-- read as though it did. AC3's live test pins this in both directions.
--
-- NAMED, NOT LEFT TO POSTGRES. Constraint names are client-visible API in this
-- codebase (src/lib/project-statuses.ts and its siblings parse them out of error
-- messages), and AC1's live test asserts THIS name rather than a bare 23514 --
-- necessarily so: `sprints_status_check` also lives on this table, so a bare
-- SQLSTATE would pass on a violation that test is not about. A generated name would
-- make the assertion a guess. Same reasoning as SPRIN-94's two range checks.
--
-- NO `NOT VALID` / `VALIDATE` TWO-STEP. Re-measured 2026-08-10: 1 row, both dates
-- null, 0 violations. `alter table ... add constraint` validates the existing rows
-- itself and there is nothing to backfill. Splitting it would buy a lock-duration
-- saving on a one-row table.
--
-- NO GRANT CHANGE, NO INDEX, NO RLS CHANGE, and that absence is deliberate rather
-- than an oversight. The constraint moves no privilege. `sprints_owner` is a single
-- `for all` policy whose expressions name no columns, so it needs no edit. Nothing
-- filters or joins on the ordering, so no index. Following SPRIN-94, which states
-- the same absence for the same reason.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- If any statement errors, NOTHING lands.
--
-- RE-RUN: NOT idempotent -- `add constraint` errors if the name already exists, and
-- the transaction then rolls the whole thing back. That is the safe failure.
-- `if not exists` was deliberately NOT used: it would let a re-run silently skip the
-- add and then verify a schema nobody applied.
-- =============================================================================

begin;

-- 1. The constraint. `>=`, not `>`: a one-day sprint (start = end) is legal, and
--    AC2's live test is the guard on that.
alter table sprints
  add constraint sprints_end_not_before_start check (end_date >= start_date);

comment on constraint sprints_end_not_before_start on sprints is
  'A sprint may not end before it starts. Mirrors the zod refine in '
  'src/lib/sprint-schemas.ts, which is what keeps a user from ever seeing this '
  'error. NULL on either side passes: a half-dated sprint stays legal.';

-- 2. Post-state check. Fails the transaction unless the end state is exactly the
--    intended one.
--
--    Its honest limit, restated rather than assumed (SPRIN-82, SPRIN-85 and
--    SPRIN-94's files make the same disclosure): it runs INSIDE the transaction
--    that just did the work, so it reads back its OWN writes. It is not independent
--    verification -- what it catches is somebody editing the `alter` above and not
--    this block. The independent verification is the three live tests added to
--    src/test/sprints.integration.test.ts, which run against the applied schema.
--
--    Four assertions, because they fail independently and for different reasons:
--      i)   the constraint exists on public.sprints
--      ii)  it is a CHECK (contype = 'c') and not some other constraint reusing
--           the name
--      iii) it is convalidated -- i.e. the existing rows were checked, not merely
--           the future ones (this is what a stray NOT VALID would cost)
--      iv)  its definition is EXACTLY the intended expression, so an edit to the
--           statement above that changes the semantics is caught rather than
--           rubber-stamped by (i)-(iii)
do $$
declare
  con      pg_constraint%rowtype;
  actual   text;
  -- Postgres re-renders the expression; a single binary comparison comes back
  -- double-parenthesised. Confirmed against the sibling checks already in this
  -- database, e.g. pfo_position_positive -> CHECK (("position" > 0)).
  expected text := 'CHECK ((end_date >= start_date))';
begin
  -- (i) Present on the right table.
  select * into con
  from pg_constraint
  where conrelid = 'public.sprints'::regclass
    and conname = 'sprints_end_not_before_start';

  if not found then
    raise exception 'SPRIN-95: constraint sprints_end_not_before_start is missing from public.sprints';
  end if;

  -- (ii) A check constraint, not something else wearing the name.
  if con.contype <> 'c' then
    raise exception 'SPRIN-95: sprints_end_not_before_start has contype %, expected c', con.contype;
  end if;

  -- (iii) Validated against the rows that already existed.
  if not con.convalidated then
    raise exception 'SPRIN-95: sprints_end_not_before_start is NOT VALID; existing rows were never checked';
  end if;

  -- (iv) Exactly the intended expression.
  actual := pg_get_constraintdef(con.oid);
  if actual is distinct from expected then
    raise exception 'SPRIN-95: unexpected constraint definition: % (expected %)', actual, expected;
  end if;

  raise notice 'SPRIN-95: ok: sprints_end_not_before_start added and validated, no privilege moved';
end $$;

commit;
