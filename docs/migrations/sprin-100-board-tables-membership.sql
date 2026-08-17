-- SPRIN-100 -- Board tables governed by membership, not ownership
-- Epic SPRIN-75 (teams, roles and permissions). Story 3 of 8.
--
-- ASCII ONLY. clip.exe transcodes by console codepage, and a smart quote that
-- survives the clipboard will not survive the SQL editor. No em dashes, no
-- curly quotes, no non-breaking spaces anywhere in this file.
--
-- Rewrites the three "for all" policies that govern day-to-day board work --
-- counters_owner, sprints_owner and tickets_owner -- from ownership to
-- membership, with NO role predicate. Both 'admin' and 'member' do board work.
-- That is David's settled design for the whole epic: two roles, both read AND
-- write, because a read-only viewer would make read broader than write on these
-- tables and re-arm the SPRIN-64 trap described in section 3 below.
--
-- Depends on SPRIN-98, which created project_members and the app_auth
-- predicates. This migration adds no table and no function of its own; it
-- changes three policies and the security context of one existing trigger
-- function.
--
--
-- 1. WHY EVERY POLICY HERE CARRIES "to authenticated", WHICH THE OLD ONES DID NOT
--
-- This is the single most important line in the file, and omitting it breaks
-- production rather than merely loosening it.
--
-- Measured on the live catalogue 2026-08-17:
--
--   sprints, tickets, project_counters   relacl includes anon=arwdDxtm
--   all three existing policies          polroles = {public}  (no TO clause)
--   anon USAGE on schema app_auth        false
--   anon EXECUTE on is_project_member    false
--
-- Policy expressions are evaluated as the CALLING role. So a policy that calls
-- an app_auth function, on a table anon holds a grant for, raises
--
--   permission denied for schema app_auth   (SQLSTATE 42501)
--
-- for an anonymous caller -- where the old EXISTS simply matched nothing and
-- anon received a clean empty array.
--
-- This is not a prediction. src/test/project-members.integration.test.ts
-- lines 446-455 derived exactly this from the catalogue when SPRIN-98 landed.
-- SPRIN-98 never felt it because anon holds NO grant at all on project_members,
-- so the privilege layer refuses first. SPRIN-100 is the FIRST story to put an
-- app_auth call in front of a table anon can actually reach.
--
-- What that would have broken, in order of severity:
--
--   a. The cron-job.org keepalive performs an anonymous
--      GET /rest/v1/tickets?select=id&limit=1 and expects 200 with a JSON array.
--      It would start receiving an error object. The Supabase free tier then
--      pauses the project after about 7 days of inactivity, and per CLAUDE.md a
--      paused database blocks EVERY merge -- including the one that would fix it.
--   b. src/test/keepalive.integration.test.ts asserts that exact contract on the
--      required verify check, so CI would go red first. That is the good case.
--
-- With "to authenticated", anon matches no policy at all: RLS filters it to zero
-- rows, the 200-with-empty-array contract is preserved exactly, and anon never
-- reaches app_auth. Anon's observable behaviour is unchanged on all four verbs
-- while its actual reach is strictly narrower than before.
--
-- Two alternatives were considered and rejected:
--
--   - Short-circuit the predicate with
--       (select auth.uid()) is not null and app_auth.is_project_member(...)
--     Rejected: this relies on the planner evaluating AND operands left to
--     right, which Postgres does not guarantee. A security property must not
--     rest on plan shape.
--   - Grant anon USAGE and EXECUTE on app_auth. Rejected: it widens anon's reach
--     into the schema that exists to HOLD the security predicates, purchasing a
--     'false' that matching no policy already returns.
--
--
-- 2. WHY create_project_counter BECOMES SECURITY DEFINER
--
-- The bootstrap problem is documented against SPRIN-101 and the projects table.
-- It bites HERE first, and SPRIN-100's own story description does not mention it.
--
-- Three AFTER INSERT ... FOR EACH ROW triggers exist on projects. Same-timing
-- triggers fire in NAME ORDER, and 'on_project_created' is a prefix of
-- 'on_project_created_admin', so it sorts first:
--
--   on_project_created            create_project_counter    INVOKER   <-- first
--   on_project_created_admin      seed_project_admin        DEFINER
--   on_project_created_statuses   seed_project_statuses     DEFINER
--
-- create_project_counter is SECURITY INVOKER and inserts into project_counters.
-- Under a membership-only counters_owner it therefore runs BEFORE the membership
-- row that would authorise it exists, fails WITH CHECK, and EVERY PROJECT
-- CREATION FAILS.
--
-- Making it SECURITY DEFINER matches its two sibling triggers on the same table,
-- which are already DEFINER for precisely this reason. It inserts new.id and
-- nothing caller-controlled, so its authority is inherited from the projects
-- INSERT policy that just admitted the row. It already pins search_path to the
-- empty string, so it earns no function_search_path_mutable advisor lint.
--
-- Rejected: renaming the trigger to sort after the admin seeding. It keeps the
-- insert under RLS, but makes alphabetical fire order a load-bearing, invisible
-- mechanism that a future rename breaks silently -- and it would falsify
-- sprin-98-project-members.sql's own comment that "nothing depends on that
-- ordering".
--
-- Rejected: widening counters_owner to re-admit the project owner. It
-- contradicts the settled design in which owner_id is an audit column granting
-- nothing.
--
-- NOTE ON THE REVOKE BELOW. create_project_counter is currently EXECUTE-to-PUBLIC
-- (proacl {=X/postgres, postgres=X, anon=X, authenticated=X, service_role=X}),
-- and CREATE OR REPLACE PRESERVES an existing ACL rather than resetting it. A
-- SECURITY DEFINER function must not keep a public EXECUTE grant it does not
-- need. Both DEFINER siblings sit at {postgres=X, service_role=X}; this migration
-- brings create_project_counter to the same shape. It returns trigger, so
-- PostgREST cannot invoke it as an RPC in any case -- this is defence in depth
-- and consistency, not the closing of a live hole.
--
--
-- 3. WHAT MUST NOT CHANGE -- the trap recorded from SPRIN-64
--
-- All three stay SINGLE "for all" policies with the SAME predicate in USING and
-- WITH CHECK. completeSprint's guard (src/lib/sprints.ts, requireSprintStatus) is
-- correct ONLY because sprints_owner is one "for all" policy: the same predicate
-- governs the guard's SELECT and both writes, so "can read this sprint's status"
-- and "can write it" are the same question. If read ever becomes broader than
-- write on this table, that guard silently stops holding AND THE ISOLATION SUITE
-- WOULD NOT FLAG IT. Do not split these into per-verb policies.
--
-- Related, from docs/sprintboard_phase1_schema.sql lines 677-679: assign_ticket_key
-- is deliberately NOT security definer, so its project_counters UPDATE is
-- permitted only by counters_owner. Ticket key atomicity depends on the writer
-- keeping that write. Membership grants it, and the new suite proves it with a
-- positive control: a non-owner member creating a ticket must receive a correctly
-- numbered key.
--
--
-- 4. POLICY NAMES ARE DELIBERATELY UNCHANGED
--
-- They will read "_owner" while meaning membership. Kept because the story's
-- acceptance criteria enumerate all three by name, SPRIN-103 and SPRIN-104 will
-- reference them, and a rename adds churn to a diff whose value is being
-- reviewable line by line. Recorded here so a later reader does not mistake the
-- name for the predicate.


begin;

-- ---------------------------------------------------------------------------
-- project_counters
-- ---------------------------------------------------------------------------
drop policy counters_owner on project_counters;

create policy counters_owner on project_counters
  for all
  to authenticated
  using      (app_auth.is_project_member(project_counters.project_id))
  with check (app_auth.is_project_member(project_counters.project_id));

-- ---------------------------------------------------------------------------
-- sprints
-- ---------------------------------------------------------------------------
drop policy sprints_owner on sprints;

create policy sprints_owner on sprints
  for all
  to authenticated
  using      (app_auth.is_project_member(sprints.project_id))
  with check (app_auth.is_project_member(sprints.project_id));

-- ---------------------------------------------------------------------------
-- tickets
-- ---------------------------------------------------------------------------
drop policy tickets_owner on tickets;

create policy tickets_owner on tickets
  for all
  to authenticated
  using      (app_auth.is_project_member(tickets.project_id))
  with check (app_auth.is_project_member(tickets.project_id));

-- ---------------------------------------------------------------------------
-- create_project_counter -- see section 2
-- ---------------------------------------------------------------------------
create or replace function create_project_counter()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_counters (project_id) values (new.id);
  return new;
end;
$$;

revoke execute on function public.create_project_counter() from public, anon, authenticated;

commit;


-- ===========================================================================
-- AFTER APPLYING -- verify from the CATALOGUE, not from the editor's "Success"
-- ===========================================================================
--
-- a. The three policies: each exactly one row, cmd = ALL, roles = {authenticated},
--    and BOTH expressions calling app_auth.is_project_member.
--
--   select tablename, policyname, cmd, roles::text,
--          pg_get_expr(pol.polqual, pol.polrelid)      as using_expr,
--          pg_get_expr(pol.polwithcheck, pol.polrelid) as check_expr
--   from pg_policies pp
--   join pg_policy pol on pol.polname = pp.policyname
--   join pg_class c on c.oid = pol.polrelid and c.relname = pp.tablename
--   where pp.schemaname = 'public'
--     and pp.tablename in ('sprints','tickets','project_counters')
--   order by pp.tablename;
--
--   EXPECT roles = {authenticated} on all three. If any says {public}, the TO
--   clause was lost and the keepalive is about to break -- see section 1.
--
-- b. The trigger function is now definer, still search_path-pinned, and no longer
--    EXECUTE-to-PUBLIC:
--
--   select proname, prosecdef, proacl::text, proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'create_project_counter';
--
--   EXPECT prosecdef = true, proconfig = {"search_path=\"\""},
--          proacl = {postgres=X/postgres,service_role=X/postgres}
--   -- the same shape as seed_project_admin and seed_project_statuses.
--
-- c. Advisors. Baseline immediately before this migration was 1 security WARN
--    (leaked password protection) and 15 performance lints: 8
--    unindexed_foreign_keys INFOs and 7 auth_rls_initplan WARNs across five
--    tables. counters_owner, sprints_owner and tickets_owner are three of those
--    seven and should clear, because a STABLE definer predicate takes the
--    auth.uid() read out of the per-row path.
--
--    EXPECT 12 performance lints and 4 auth_rls_initplan WARNs across three
--    tables: projects (projects_owner) and project_statuses (three policies).
--    ADD NO NEW LINTS. Re-derive with get_advisors and update CLAUDE.md's
--    baseline paragraph with the measured figures, not these predicted ones.
--
-- d. The keepalive contract, which is the thing section 1 exists to protect.
--    Run it directly rather than trusting the reasoning:
--
--      npm run keepalive
--
--    EXPECT 200 and []. A 42501 mentioning app_auth means a TO clause is missing.
