-- =============================================================================
-- SPRIN-97  Change the sprint cadence
--           (Rung 3 epic SPRIN-74, story 2 — "Migration B" in the epic design)
--
-- ONE STATEMENT: grant COLUMN-LEVEL UPDATE on the two cadence columns to
-- `authenticated`. It is the first UPDATE privilege `projects` has carried since
-- SPRIN-82 revoked the table-wide one, and it is deliberately the smallest
-- privilege that makes the Settings cadence form work.
--
-- Named for the STORY that applies it, not the epic. The epic design guessed
-- `sprin-74-…`; story 1 shipped as `docs/migrations/sprin-94-project-cadence.sql`
-- and that is the convention this directory actually follows.
--
-- MEASURED LIVE BEFORE WRITING THIS FILE, not recalled. Read 2026-08-09 from
-- `pg_class.relacl` and `pg_attribute.attacl`:
--
--   projects  relacl:
--     postgres=arwdDxtm/postgres
--     anon=ardDxtm/postgres              <- no w
--     authenticated=ardDxtm/postgres     <- no w: SPRIN-82's revoke still held
--     service_role=arwdDxtm/postgres
--
--   projects  attacl:  NONE. No column on this table carries an ACL. So the
--                      statement below is not widening an existing column grant
--                      — it creates the first one this table has ever had.
--
-- READ THOSE TWO CATALOGUES, NEVER information_schema. Both
-- `information_schema.column_privileges` and `role_table_grants` filter to
-- grants the QUERYING role is party to, and the read-only MCP user is party to
-- none — so they return ZERO ROWS whatever the ACL actually holds, and an empty
-- result there reads exactly like "this table has no privileges at all". That
-- inference has now been drawn wrongly three times on this project (SPRIN-85's
-- banner has the first, SPRIN-94's the second, and this story's design the
-- third). If you are about to conclude something about a grant from a query
-- that returned nothing, check which catalogue you read first.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS GRANTS, AND THE MUCH LARGER SET IT DELIBERATELY DOES NOT
-- ---------------------------------------------------------------------------
-- Resulting state, in full:
--
--   relacl  UNCHANGED — postgres=arwdDxtm, anon=ardDxtm,
--           authenticated=ardDxtm, service_role=arwdDxtm.
--           `authenticated` still has NO table-level `w`.
--
--   attacl  gains an entry on `sprint_length_weeks` and `sprint_start_weekday`
--           only, each carrying `authenticated=w/postgres` beside the owner
--           entry Postgres materialises the moment a column ACL becomes
--           non-null. Every other column of `projects` keeps a NULL attacl.
--
-- THAT ABSENT TABLE-LEVEL `w` IS THE WHOLE POINT. `name`, `key` and
-- `project_type` stay unwritable in the DATABASE rather than only in our code —
-- so SPRIN-82's control survives this story intact, and an owner still cannot
-- flip their own Scrum project to Kanban and strand every sprint behind a UI
-- that no longer renders them. Column-level UPDATE is the only shape of grant
-- that adds one writable field without handing back the other four.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE DOES NOT RESTATE THE WHOLE ACL — departing from SPRIN-93
-- ---------------------------------------------------------------------------
-- SPRIN-93's migration E set a precedent that is right for its table and wrong
-- for this one: revoke the verbs table-wide, then re-grant EVERY permitted
-- column, so one file states the whole intended end state. That form exists
-- because a table-level REVOKE **cascades** to column privileges — "the
-- corresponding column privileges (if any) are automatically revoked on each
-- column of the table, as well" (PostgreSQL REVOKE reference) — which makes
-- revoke-then-grant-only-the-new-column a silent privilege loss.
--
-- Here the cascade argues the opposite way. To restate this ACL at all, this
-- file would have to run a table-level `revoke update on projects from
-- authenticated, anon` first, and that revoke would cascade across privileges
-- SPRIN-97 has no business touching — including `anon`'s `ardDxtm`, which no
-- story has asked to be re-derived and which this one has no measurement
-- obligation for. The restate form buys clarity on a table that has many
-- column grants to keep aligned; `projects` has exactly zero, so it would buy
-- nothing and risk everything. A bare additive `grant` touches one attacl entry
-- per column and cannot cascade at all.
--
-- THE CONSEQUENCE FOR THE NEXT STORY, because it inverts the usual advice on
-- this schema: a later story that needs a THIRD writable column must ADD it to
-- the grant below (`grant update (sprint_length_weeks, sprint_start_weekday,
-- <new>) on projects to authenticated`, or a second bare grant naming only the
-- new column). It must NOT write `revoke update on projects …; grant update
-- (<new>) …` — that reads like the project_statuses and project_fields blocks
-- and would silently strip the two cadence columns, breaking this story's form
-- with a 42501 nothing else goes red for.
--
-- ---------------------------------------------------------------------------
-- THIS BANNER IS DOCUMENTATION, AND DOCUMENTATION IS ENFORCED BY NOTHING
-- ---------------------------------------------------------------------------
-- Nothing in CI reads this file, and nothing in CI can read `relacl` or
-- `attacl` either — PostgREST has no pg_catalog access, so no test in the repo
-- can observe a privilege directly. Every sentence above is a claim a future
-- edit could falsify in silence.
--
-- The real enforcement is BEHAVIOURAL, and it is three live assertions that
-- fail independently of each other:
--
--   (a) The owner CAN update both cadence columns and read the new values back
--       — `src/test/projects.integration.test.ts`. This is the only observation
--       anywhere, local or CI, that this migration was applied at all.
--   (b) The same owner still gets 42501 on `project_type`
--       — `src/test/projects.integration.test.ts`, the pre-existing
--       "refuses the owner's own project_type UPDATE" test, left UNMODIFIED by
--       SPRIN-97 on purpose. It is the proof the grant did not widen to the
--       table: a column grant leaves `project_type` ungranted, so this test
--       going green-to-red is what a mistyped table-wide grant looks like.
--   (c) A cross-tenant cadence update matches ZERO ROWS
--       — `src/test/rls.integration.test.ts`, "B cannot UPDATE any of it". The
--       line SPRIN-82 deleted, restored by this story on a GRANTED column
--       (`sprint_length_weeks`, not the `name` three recorded instructions
--       wrongly prescribed). Only a granted column lets UPDATE reach the policy;
--       RLS then FILTERS on USING rather than raising, so a row count is once
--       again the honest assertion. On `name` the same line would earn a 42501
--       and `data === null`, and repairing it by asserting the error would make
--       it pass off the GRANT — after which deleting `projects_owner` would no
--       longer redden it.
--
-- (a) and (b) together are the load-bearing pair: one column set writable, the
-- rest not. Neither alone says anything useful.
--
-- ---------------------------------------------------------------------------
-- VERIFY BY HAND. Paste this into the SQL editor after running the file; it
-- reads the two catalogues above and nothing else.
-- ---------------------------------------------------------------------------
--   select 'table' as level,
--          '-'     as column_name,
--          array_to_string(c.relacl, E'\n') as acl
--   from pg_class c
--   where c.oid = 'public.projects'::regclass
--   union all
--   select 'column', a.attname, array_to_string(a.attacl, E'\n')
--   from pg_attribute a
--   where a.attrelid = 'public.projects'::regclass
--     and a.attnum > 0
--     and not a.attisdropped
--     and a.attacl is not null
--   order by 1, 2;
--
-- EXPECT: one `table` row whose ACL still shows `authenticated=ardDxtm` and
-- `anon=ardDxtm` — no `w` on either — and exactly TWO `column` rows,
-- `sprint_length_weeks` and `sprint_start_weekday`, each containing
-- `authenticated=w/postgres`. A third column row, or a `w` on the table row,
-- means the grant was mistyped and more is writable than this story intended.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- One explicit transaction. If any statement errors, NOTHING lands.
--
-- RE-RUN: safe, and a no-op. GRANT of a privilege already held succeeds
-- silently and rewrites no row. The post-state block re-verifies either way.
-- =============================================================================

begin;

-- 1. The whole change.
grant update (sprint_length_weeks, sprint_start_weekday) on projects to authenticated;

-- 2. Post-state check. Fails the transaction unless the end state is exactly
--    the intended one.
--
--    Its two honest limits, restated rather than assumed (SPRIN-82, SPRIN-85
--    and SPRIN-94's files make the same disclosure):
--      a) It runs INSIDE the transaction that just did the work, so it reads
--         back its own writes. What it catches is someone EDITING the grant
--         above and not this block — a third column, the wrong role, `anon`.
--      b) CI cannot see any of this. What pins live BEHAVIOUR is (a), (b) and
--         (c) under "ENFORCED BY NOTHING" above.
--
--    Three assertions, because they fail independently:
--      i)   `authenticated` holds column UPDATE on EXACTLY the two cadence
--           columns — not one, not three
--      ii)  neither client role holds table-wide UPDATE — SPRIN-82's end state,
--           and the thing that keeps name/key/project_type immutable
--      iii) `anon` and PUBLIC hold NO column privilege of any kind here
do $$
declare
  granted_cols  text;
  tbl_offenders text;
  col_offenders text;
begin
  -- (i) Exactly the two cadence columns, for authenticated.
  select string_agg(a.attname, ', ' order by a.attname)
    into granted_cols
  from pg_attribute a
  cross join lateral aclexplode(a.attacl) as p
  where a.attrelid = 'public.projects'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and p.privilege_type = 'UPDATE'
    and p.grantee::regrole::text = 'authenticated';

  if granted_cols is distinct from 'sprint_length_weeks, sprint_start_weekday' then
    raise exception
      'SPRIN-97: authenticated holds column UPDATE on [%] — expected exactly the two cadence columns',
      coalesce(granted_cols, 'NONE');
  end if;

  -- (ii) Still no table-wide UPDATE. A column grant must not become one.
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
      'SPRIN-97: table-wide UPDATE on projects is granted to: % — SPRIN-82 revoked it and this story must not restore it',
      tbl_offenders;
  end if;

  -- (iii) No column privilege for anon or PUBLIC. `0::regrole` renders as `-`,
  --       which is how a PUBLIC grantee shows up in an exploded ACL.
  select string_agg(format('%s->%s=%s', a.attname, p.grantee::regrole::text, p.privilege_type),
                    ', ' order by a.attname)
    into col_offenders
  from pg_attribute a
  cross join lateral aclexplode(a.attacl) as p
  where a.attrelid = 'public.projects'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and p.grantee::regrole::text in ('anon', '-');

  if col_offenders is not null then
    raise exception 'SPRIN-97: unexpected anon/PUBLIC column privileges on projects: %', col_offenders;
  end if;

  raise notice
    'SPRIN-97: ok — authenticated may UPDATE (sprint_length_weeks, sprint_start_weekday) and nothing else on projects';
end $$;

commit;
