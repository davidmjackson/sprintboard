-- =============================================================================
-- SPRIN-85  Set a WIP limit per board column (Kanban only)
--           (Rung 3 epic SPRIN-73, slice 5 — "Migration B" in the epic design)
--
-- TWO CHANGES, AND ONLY THE SECOND ONE HAS TEETH:
--
--   1. Add a nullable `wip_limit` column to `project_statuses`, with a check
--      that it is positive when present. Purely additive.
--   2. REWRITE the UPDATE grants on `project_statuses` so `wip_limit` becomes
--      writable by `authenticated` — WITHOUT `slug` or `is_initial` becoming
--      writable along the way. This is the part a mistake is expensive in.
--
-- ONE EXPLICIT TRANSACTION, AND THAT IS LOAD-BEARING HERE IN A WAY IT WAS NOT
-- IN SPRIN-82. This file REVOKEs a privilege and then GRANTs a narrower one
-- back. If the revoke committed and the grant did not, every project owner
-- would silently lose the ability to rename, recategorise or reorder a status
-- — the app would start returning 42501 on paths that worked a second earlier,
-- and no code change would explain it. Atomicity is the thing that makes the
-- revoke-then-regrant dance safe to run by hand.
--
-- MEASURED LIVE BEFORE WRITING THIS FILE, not recalled. `pg_class.relacl` and
-- `pg_attribute.attacl`, read 2026-08-05:
--
--   project_statuses  relacl:
--     postgres=arwdDxtm/postgres
--     anon=arDxtm/postgres              <- no w. SPRIN-80 also took d.
--     authenticated=ardDxtm/postgres    <- no w: SPRIN-77's revoke held
--     service_role=arwdDxtm/postgres
--
--   project_statuses  attacl (the only three columns carrying one):
--     name      {authenticated=w/postgres}
--     category  {authenticated=w/postgres}
--     position  {authenticated=w/postgres}
--
-- So SPRIN-77's end state is intact and is EXACTLY the mirror of
-- `ProjectStatusUpdate` in src/lib/domain.ts. That is the state this file
-- widens by one column, and the state its post-state block re-asserts.
--
-- NOTE ON READING THAT MEASUREMENT: `information_schema.role_table_grants` and
-- `information_schema.column_privileges` both returned ZERO ROWS for this
-- table. That is not evidence of no grants — those views filter to grants the
-- CURRENT role is party to, and the Supabase read-only MCP user is party to
-- none of them. Read `pg_class.relacl` / `pg_attribute.attacl` directly, or you
-- will conclude the table has no privileges at all.
--
-- WHY THE REVOKE-THEN-REGRANT DANCE, RESTATED SO IT IS NOT "TIDIED UP".
-- The obvious form of this change is:
--
--     grant update (wip_limit) on project_statuses to authenticated;
--
-- and on TODAY's measured state that single line, ON ITS OWN AND WITH NO
-- REVOKE, would in fact be correct: there is no table-wide UPDATE grant for it
-- to be swallowed by, so it would simply add a fourth column grant beside the
-- three that exist. It is still not what this file does, for two reasons:
--
--   a) It encodes a dependency on the current ACL that nothing checks. The
--      revoke-then-regrant form states the COMPLETE intended end state — these
--      four columns and no others — so it is correct no matter what the ACL
--      was beforehand. A migration that is only correct given a prior state is
--      a migration that stops being correct silently.
--   b) The mirror-image mistake is the one this codebase has already recorded:
--      `revoke update (slug) on project_statuses from authenticated` reads
--      correctly and is a SILENT NO-OP against a table-wide grant. See the long
--      comment above the grants in docs/sprintboard_phase1_schema.sql. The
--      remedy there and the shape here are the same shape.
--
-- THE GRANT MUST LIST ALL FOUR COLUMNS. THIS IS NOT BELT-AND-BRACES — IT IS THE
-- WHOLE CORRECTNESS OF THE FILE, and the mistake it prevents is silent.
--
-- A table-level REVOKE CASCADES to column privileges. Verbatim, from the
-- PostgreSQL REVOKE reference (checked against the docs, not recalled —
-- https://www.postgresql.org/docs/current/sql-revoke.html):
--
--     "When revoking privileges on a table, the corresponding column privileges
--      (if any) are automatically revoked on each column of the table, as well.
--      On the other hand, if a role has been granted privileges on a table,
--      then revoking the same privileges from individual columns will have no
--      effect."
--
-- Both halves of that sentence bite this table, in opposite directions. The
-- SECOND half is the trap SPRIN-77 already documented (a column REVOKE cannot
-- hole a table grant). The FIRST half is the one THIS file has to survive:
-- statement 3's `revoke update on project_statuses from authenticated` DROPS
-- the existing (name, category, position) column grants measured above. So
--
--     revoke update on project_statuses from authenticated, anon;
--     grant  update (wip_limit) on project_statuses to authenticated;   -- WRONG
--
-- would leave `authenticated` able to UPDATE wip_limit AND NOTHING ELSE. Every
-- rename, every recategorise and every reorder in the app would begin failing
-- with 42501, and nothing in the diff would look like the cause. The grant
-- therefore restates the complete intended end state, and the post-state block
-- below proves that state rather than trusting this paragraph.
--
-- WHAT MUST REMAIN UNWRITABLE, AND WHY — unchanged from SPRIN-77, restated
-- because this file is the one that could break it:
--
--   * `slug` is the fk target of tickets_status_fk. The fk is keyed on the slug
--     precisely so no ticket row is rewritten when the vocabulary changes; a
--     movable slug undoes that.
--   * `is_initial` — project_statuses_one_initial_per_project prevents TWO
--     initial statuses but not ZERO, and since SPRIN-80 ticket creation
--     RESOLVES against that column. Zero initial statuses is not untidy, it is
--     a project that cannot create a ticket.
--
-- AC5 of this story is a LIVE test that both are still refused after this
-- migration. It exists because a grant rewrite is exactly where they would be
-- lost, and because CI cannot read pg_catalog to check the ACL directly — the
-- only observable proof is a 42501 on the wire.
--
-- WHY THE CHECK CONSTRAINT IS NAMED. The epic design writes the check inline on
-- the ADD COLUMN, which would have Postgres generate
-- `project_statuses_wip_limit_check`. It is declared as a named table
-- constraint instead, `project_statuses_wip_limit_positive`, for the same
-- reason every other constraint on this table is named: src/lib/project-statuses.ts
-- parses CONSTRAINT NAMES out of Postgres error messages to decide which remedy
-- to show a user, so a constraint name here is a piece of client-visible API and
-- not an implementation detail. The `_positive` suffix matches its sibling
-- `project_statuses_position_positive`.
--
-- WHY `wip_limit is null or wip_limit > 0` AND NOT JUST `wip_limit > 0`. The
-- short form would behave identically — a CHECK evaluating to NULL passes, so
-- `null > 0` is accepted. The redundancy is deliberate documentation: "null
-- means no limit" is the single most important fact about this column, and a
-- reader auditing `check (wip_limit > 0)` has to recall three-valued logic to
-- work out whether NULL is permitted. Saying it costs nothing and is read many
-- more times than it is written.
--
-- NON-INTEGER AND ZERO/NEGATIVE ARE REFUSED BY TWO DIFFERENT MECHANISMS, which
-- matters when reading AC4's live test. A fractional value (1.5) is refused by
-- the COLUMN TYPE with 22P02 `invalid input syntax for type integer` — the
-- check constraint never sees it. Zero and negatives parse fine and are refused
-- by the CHECK with 23514. Two SQLSTATEs, one AC; a test asserting a single code
-- for both would be asserting something false.
--
-- THE GAP THIS STORY ACCEPTS, RECORDED SO IT IS NOT REDISCOVERED AS A BUG.
-- `wip_limit` lives on `project_statuses`, and SCRUM projects have rows in that
-- table too. A CHECK body may not contain a subquery, so it cannot reach across
-- to `projects.project_type`: the database will happily store a `wip_limit` on a
-- Scrum project's status row. It is INERT — nothing reads it for a Scrum project
-- — and because SPRIN-82 made `project_type` immutable IN THE DATABASE (there is
-- no UPDATE privilege on `projects` at all), such a row can never become a
-- Kanban row later. The absent constraint therefore costs nothing today.
--
-- That is a real dependency between two decisions, not a coincidence. IF A
-- PROJECT-TYPE CONVERSION STORY IS EVER BUILT, it must decide what happens to
-- `wip_limit` values sitting on a project converting to Scrum — or those inert
-- values silently become live. It inherits that obligation alongside the three
-- already recorded for a project-rename story in
-- docs/sprintboard_phase1_schema.sql.
--
-- NO RLS CHANGE. `statuses_owner_update` is `for update` with owner-scoped USING
-- and WITH CHECK expressions that name no columns, so it covers the new column
-- with no edit. Verified by reading pg_policy, not assumed.
--
-- NO INDEX. Nothing filters or joins on `wip_limit`; it is read only as part of
-- the status row the settings tab and board already select in full.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- If any statement errors, NOTHING lands.
--
-- RE-RUN: NOT idempotent — `add column` and `add constraint` both error if the
-- object already exists, and the transaction then rolls the whole thing back.
-- That is the safe failure: a second run leaves the database exactly as the
-- first run left it. `if not exists` was deliberately NOT used on the column:
-- it would let a re-run silently skip the add and then re-grant against a schema
-- nobody re-verified. An error that says "already there" is more informative.
-- =============================================================================

begin;

-- 1. The column. Nullable with no default: null means NO LIMIT, and every
--    existing row (every status of every project, Scrum and Kanban alike) gets
--    exactly that. No backfill, no row rewrite of a defaulted value.
alter table project_statuses
  add column wip_limit int;

comment on column project_statuses.wip_limit is
  'Soft WIP limit for this board column. NULL means no limit. Read only for '
  'Kanban projects (hasWipLimits in src/lib/domain.ts); a value on a Scrum '
  'project''s row is inert by design — see the migration banner. The limit '
  'WARNS, it never blocks: nothing in the database refuses a ticket entering '
  'an at-limit status, deliberately (SPRIN-86).';

-- 2. Positivity. A limit of 0 is not "no limit", it is a column no work may
--    ever enter — which the UI has no way to express and no user means. NULL is
--    how "no limit" is said.
alter table project_statuses
  add constraint project_statuses_wip_limit_positive
    check (wip_limit is null or wip_limit > 0);

-- 3. The grant rewrite. See the banner: the revoke and the grant are ONE
--    statement of intent, and the transaction is what keeps them one.
revoke update on project_statuses from authenticated, anon;
grant  update (name, category, position, wip_limit)
  on project_statuses to authenticated;

-- 4. Post-state check. Fails the transaction unless the end state is EXACTLY
--    the intended one.
--
--    The two honest limits of a block like this, restated rather than assumed
--    (SPRIN-82's file makes the same disclosure):
--
--      a) It runs INSIDE the transaction that just did the work, so it is
--         reading back its own writes. It cannot catch "the grant did not
--         stick"; what it catches is someone EDITING the statements above and
--         not this block — a column added to the grant list, a role name
--         changed, the revoke dropped.
--      b) CI cannot see any of this. PostgREST has no access to pg_catalog, so
--         no test in the repo can read relacl or attacl. What pins live
--         BEHAVIOUR is AC4 and AC5's assertions in
--         src/test/rls.integration.test.ts, which run against the real database
--         on every PR.
--
--    It asserts three separate things, because they fail independently:
--      i)   no TABLE-wide UPDATE for either client role  (the revoke worked)
--      ii)  authenticated holds column UPDATE on exactly the four intended
--           columns — a SET comparison, so both a missing column and an extra
--           one fail
--      iii) slug and is_initial specifically are not among them. Redundant
--           given (ii), and kept anyway: it is the assertion whose failure
--           message names the actual danger, and AC5 exists for these two
--           columns by name.
do $$
declare
  tbl_offenders  text;
  granted_cols   text[];
  expected_cols  text[] := array['name', 'category', 'position', 'wip_limit'];
  forbidden_cols text[];
begin
  -- (i) Table-wide UPDATE must be held by neither client role.
  select string_agg(p.grantee::regrole::text, ', ' order by p.grantee::regrole::text)
    into tbl_offenders
  from pg_class rel
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  cross join lateral aclexplode(rel.relacl) as p
  where nsp.nspname = 'public'
    and rel.relname = 'project_statuses'
    and p.privilege_type = 'UPDATE'
    and p.grantee::regrole::text in ('authenticated', 'anon');

  if tbl_offenders is not null then
    raise exception
      'SPRIN-85: table-wide UPDATE on project_statuses is still granted to: %',
      tbl_offenders;
  end if;

  -- (ii) Column UPDATE for `authenticated` must be exactly the four columns.
  select coalesce(array_agg(att.attname::text order by att.attname), array[]::text[])
    into granted_cols
  from pg_attribute att
  cross join lateral aclexplode(att.attacl) as p
  where att.attrelid = 'public.project_statuses'::regclass
    and att.attnum > 0
    and not att.attisdropped
    and p.privilege_type = 'UPDATE'
    and p.grantee::regrole::text = 'authenticated';

  -- Set equality, spelled both ways round. `@>` alone would pass on a superset,
  -- which is the exact failure this whole file is guarding against.
  if not (granted_cols @> expected_cols and expected_cols @> granted_cols) then
    raise exception
      'SPRIN-85: authenticated holds column UPDATE on {%} but should hold exactly {%}',
      array_to_string(granted_cols, ', '),
      array_to_string(expected_cols, ', ');
  end if;

  -- (iii) The two that must never be writable, named explicitly.
  select array_agg(c order by c)
    into forbidden_cols
  from unnest(array['slug', 'is_initial']) as c
  where c = any (granted_cols);

  if forbidden_cols is not null then
    raise exception
      'SPRIN-85: authenticated can now UPDATE %, which must never be writable',
      array_to_string(forbidden_cols, ', ');
  end if;

  raise notice
    'SPRIN-85: ok — no table-wide UPDATE; authenticated may UPDATE (%)',
    array_to_string(granted_cols, ', ');
end $$;

commit;
