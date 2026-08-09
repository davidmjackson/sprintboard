-- =============================================================================
-- SPRIN-94  See a project's sprint cadence
--           (Rung 3 epic SPRIN-74, story 1 — "Migration A" in the epic design)
--
-- PURELY ADDITIVE. Two not-null columns with defaults, and two named range
-- checks. NO GRANT CHANGES AT ALL — and that absence is deliberate, not an
-- oversight. `authenticated` already holds table-level INSERT and SELECT on
-- `projects`, and a table-level grant covers columns added later, so the new
-- columns are readable and insertable the moment they exist. What they are NOT
-- is updatable: there is no UPDATE privilege on this table for either client
-- role, which is SPRIN-82's end state and stays true after this file runs.
-- Making the cadence editable is SPRIN-97's job and SPRIN-97's migration.
--
-- MEASURED LIVE BEFORE WRITING THIS FILE, not recalled. Read 2026-08-09 from
-- `pg_class.relacl` and `pg_attribute.attacl`:
--
--   projects  relacl:
--     postgres=arwdDxtm/postgres
--     anon=ardDxtm/postgres              <- no w
--     authenticated=ardDxtm/postgres     <- no w: SPRIN-82's revoke held
--     service_role=arwdDxtm/postgres
--
--   projects  attacl:  NONE. No column on this table carries an ACL.
--
-- READ THOSE TWO CATALOGUES, NOT information_schema. Both
-- `information_schema.column_privileges` and `role_table_grants` return ZERO
-- ROWS for this table — they filter to grants the CURRENT role is party to, and
-- the read-only MCP user is party to none. An empty result there is not
-- evidence of an empty ACL, and reading it as such is how a story concludes a
-- table has no privileges at all. (This file's author made exactly that mistake
-- first and corrected it; SPRIN-85's banner records the same trap.)
--
-- WHY int + CHECK AND NEVER AN ENUM. The standing rule on this schema. Widening
-- 1-4 to 1-6 is one line against a check and a painful type migration against an
-- enum. Same reasoning as `ticket.type`, `sprint.status` and `project_type`.
--
-- WHY THE CONSTRAINTS ARE NAMED rather than left to Postgres. Constraint names
-- are client-visible API in this codebase: src/lib/project-statuses.ts and its
-- siblings parse them out of error messages to choose which remedy to show. The
-- live tests for AC5 assert these names, so a generated name would make the
-- assertion a guess.
--
-- WHY ISO WEEKDAYS, 1 = MONDAY .. 7 = SUNDAY. It matches Postgres `isodow`, so
-- any future SQL that has to reason about the cadence agrees with the client for
-- free, with no off-by-one translation layer to get wrong.
--
-- WHY not null WITH DEFAULTS rather than nullable. Every project has a cadence,
-- including the Kanban projects that never read one. A nullable column would buy
-- nothing and cost a null branch at every read site, including SPRIN-96's date
-- pre-fill. Existing rows are backfilled by the default.
--
-- A KANBAN PROJECT CARRIES A CADENCE IT NEVER READS, and that is inert by
-- design, exactly as `wip_limit` is inert on a Scrum project's status row
-- (SPRIN-85). A CHECK body may not contain a subquery, so the constraint cannot
-- reach across to `project_type` — and because SPRIN-82 made `project_type`
-- immutable IN THE DATABASE, such a row can never become a Scrum row later. If a
-- project-type conversion story is ever built, it inherits this alongside
-- SPRIN-85's `wip_limit` obligation.
--
-- NO RLS CHANGE. `projects_owner` is a single `for all` policy on
-- `owner_id = auth.uid()` whose expressions name no columns, so it covers the
-- new columns with no edit.
--
-- NO INDEX. Nothing filters or joins on either column; they are read as part of
-- the project row the shell already selects in full.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- If any statement errors, NOTHING lands.
--
-- RE-RUN: NOT idempotent — `add column` and `add constraint` both error if the
-- object already exists, and the transaction then rolls the whole thing back.
-- That is the safe failure. `if not exists` was deliberately NOT used: it would
-- let a re-run silently skip the add and then verify a schema nobody re-applied.
-- =============================================================================

begin;

-- 1. The columns. Defaults backfill every existing row; not null makes the
--    absence of a cadence unrepresentable.
alter table projects
  add column sprint_length_weeks  int not null default 2,
  add column sprint_start_weekday int not null default 1;

comment on column projects.sprint_length_weeks is
  'Sprint length in whole weeks, 1 to 4. Read only for Scrum projects '
  '(hasSprints in src/lib/domain.ts); a value on a Kanban project is inert by '
  'design. Editable from SPRIN-97 onwards, not before.';

comment on column projects.sprint_start_weekday is
  'ISO weekday a sprint starts on: 1 = Monday .. 7 = Sunday, matching Postgres '
  'isodow. Suggests dates in the create-sprint dialog (SPRIN-96); it never '
  'constrains them.';

-- 2. The ranges, named because the live tests assert the names.
alter table projects
  add constraint projects_sprint_length_weeks_range
    check (sprint_length_weeks between 1 and 4);

alter table projects
  add constraint projects_sprint_start_weekday_range
    check (sprint_start_weekday between 1 and 7);

-- 3. Post-state check. Fails the transaction unless the end state is exactly
--    the intended one.
--
--    Its two honest limits, restated rather than assumed (SPRIN-82 and
--    SPRIN-85's files make the same disclosure):
--      a) It runs INSIDE the transaction that just did the work, so it reads
--         back its own writes. What it catches is someone EDITING the
--         statements above and not this block.
--      b) CI cannot see any of this — PostgREST has no pg_catalog access, so no
--         test in the repo can read relacl or attacl. What pins live BEHAVIOUR
--         is AC2 and AC5 in src/test/projects.integration.test.ts.
--
--    Four assertions, because they fail independently:
--      i)   both columns exist, are not null, and carry the intended defaults
--      ii)  both named check constraints exist
--      iii) neither client role holds table-wide UPDATE — this file must not
--           have changed that, and SPRIN-97 is where it legitimately does
--      iv)  neither new column carries ANY column-level ACL — the mirror of
--           (iii) at column granularity, and the thing that would quietly make
--           SPRIN-97's grant a no-op-shaped surprise
do $$
declare
  col_state     text;
  missing_cons  text[];
  tbl_offenders text;
  col_acl       text;
begin
  -- (i) Columns, nullability and defaults.
  select string_agg(
           format('%s(notnull=%s,default=%s)', a.attname, a.attnotnull,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), 'NONE')),
           ', ' order by a.attname)
    into col_state
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = 'public.projects'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and a.attname in ('sprint_length_weeks', 'sprint_start_weekday');

  if col_state is distinct from
     'sprint_length_weeks(notnull=t,default=2), sprint_start_weekday(notnull=t,default=1)'
  then
    raise exception 'SPRIN-94: unexpected cadence column state: %', coalesce(col_state, 'NONE');
  end if;

  -- (ii) Both named checks present.
  select array_agg(c order by c)
    into missing_cons
  from unnest(array['projects_sprint_length_weeks_range',
                    'projects_sprint_start_weekday_range']) as c
  where not exists (
    select 1 from pg_constraint
    where conrelid = 'public.projects'::regclass
      and contype = 'c'
      and conname = c
  );

  if missing_cons is not null then
    raise exception 'SPRIN-94: missing check constraint(s): %',
      array_to_string(missing_cons, ', ');
  end if;

  -- (iii) No table-wide UPDATE for either client role. SPRIN-82's end state.
  select string_agg(p.grantee::regrole::text, ', ' order by p.grantee::regrole::text)
    into tbl_offenders
  from pg_class rel
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  cross join lateral aclexplode(rel.relacl) as p
  where nsp.nspname = 'public'
    and rel.relname = 'projects'
    and p.privilege_type = 'UPDATE'
    and p.grantee::regrole::text in ('authenticated', 'anon');

  if tbl_offenders is not null then
    raise exception
      'SPRIN-94: table-wide UPDATE on projects is granted to: % — SPRIN-82 revoked it',
      tbl_offenders;
  end if;

  -- (iv) Neither new column carries a column-level ACL.
  select string_agg(format('%s->%s', a.attname, p.grantee::regrole::text), ', ')
    into col_acl
  from pg_attribute a
  cross join lateral aclexplode(a.attacl) as p
  where a.attrelid = 'public.projects'::regclass
    and a.attname in ('sprint_length_weeks', 'sprint_start_weekday')
    and p.grantee::regrole::text in ('authenticated', 'anon');

  if col_acl is not null then
    raise exception 'SPRIN-94: unexpected column privileges on the cadence columns: %', col_acl;
  end if;

  raise notice 'SPRIN-94: ok — cadence columns added, no privilege moved';
end $$;

commit;
