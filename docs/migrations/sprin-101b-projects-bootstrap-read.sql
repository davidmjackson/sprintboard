-- SPRIN-101b -- the bootstrap problem applies to the READ-BACK, not only the INSERT
-- Epic SPRIN-75, story 4. Follow-up to sprin-101-projects-membership.sql, which was
-- already applied when this defect surfaced.
--
-- ASCII ONLY, same reason as every migration in this directory.
--
--
-- ==========================================================================
-- WHAT WENT WRONG, AND HOW IT WAS FOUND
-- ==========================================================================
--
-- sprin-101 replaced projects_owner with four verb-split policies. Immediately
-- afterwards EIGHT live suites went red and every project INSERT failed:
--
--   42501  new row violates row-level security policy for table "projects"
--
-- Including `createProject`, so project creation was broken app-wide.
--
-- THE INSERT POLICY IS INNOCENT, WHICH IS THE OBVIOUS SUSPECT AND THE WRONG ONE.
-- Discriminated by a throwaway probe rather than argued, because the two
-- hypotheses predict opposite results for one observable:
--
--   insert(...).select('id')   ->  42501
--   insert(...)  [no RETURNING] ->  error null, row landed
--
-- A bare INSERT succeeds. So `owner_id = (select auth.uid())` evaluates TRUE and
-- projects_bootstrap_insert admits the row. What fails is the RETURNING clause:
-- for INSERT ... RETURNING, Postgres applies the SELECT policies to the row being
-- returned, and reports a failure with the WITH CHECK wording above rather than
-- filtering it away.
--
-- projects_member_read asks app_auth.is_project_member(id). The membership row
-- that would make that true is created by seed_project_admin, an AFTER INSERT
-- trigger, and AFTER ROW triggers fire at end of statement -- after the RETURNING
-- projection has already been checked. So the row is, for one instant, owned by
-- the caller and readable by nobody.
--
-- THE GENERAL LESSON, which sprin-100b's lesson did not cover: a table whose
-- SELECT policy depends on a row created by its OWN AFTER INSERT trigger cannot
-- be read back in the same statement. sprin-100b recorded that a SECURITY INVOKER
-- trigger depends on every table it READS. This is the mirror: an RLS policy can
-- depend on a row that does not exist yet, and INSERT ... RETURNING is where that
-- gap becomes visible. `projects` is the only table in this schema with that
-- shape, because it is the only one that seeds its own membership.
--
--
-- ==========================================================================
-- THE FIX, AND WHY IT IS CONDITIONAL RATHER THAN A PLAIN OWNER CLAUSE
-- ==========================================================================
--
-- SELECT gains a second disjunct that is true ONLY in that instant:
--
--   owner_id = (select auth.uid())  and  not app_auth.project_has_members(id)
--
-- A project acquires its admin row in the same transaction, so from the end of
-- that statement onward the second half is false forever and membership is once
-- again the only thing granting read. owner_id therefore remains what David's
-- design says it is -- an audit column granting nothing in any state that
-- outlives a single statement.
--
-- REJECTED: the plain disjunct `or owner_id = (select auth.uid())`. One line,
-- no new function, and it reads as the obvious fix. It permanently re-arms
-- ownership as a read grant: a project's creator would keep read access after
-- being removed from it, so SPRIN-102's removal would leak for exactly one person
-- per project, forever. That is a settled design point, not a preference.
--
-- REJECTED: making project_members.project_id DEFERRABLE INITIALLY DEFERRED and
-- seeding in a BEFORE INSERT trigger. Genuinely the purist fix -- membership
-- would exist before the row lands and owner_id would never appear in a read path
-- at all. Rejected for blast radius: it alters a foreign key and moves its
-- violations from statement time to COMMIT time, changing the error shape for a
-- sibling suite this story does not otherwise touch.
--
-- REJECTED: dropping .select() from every project insert. No schema change, but
-- it touches createProject, ~8 fixture sites and the E2E, and stays fragile
-- forever -- re-adding .select() would silently break creation again.
--
--
-- ==========================================================================
-- WHY THE NOT-EXISTS MUST GO THROUGH A DEFINER, AND CANNOT BE INLINE
-- ==========================================================================
--
-- THIS IS THE SHARP EDGE OF THE CHOSEN FIX. Writing the second half inline as
--
--   not exists (select 1 from public.project_members m where m.project_id = id)
--
-- would be evaluated as the CALLING role and therefore subject to
-- project_members' own RLS, which shows a caller only the membership rows of
-- projects they belong to. For any project the caller is NOT a member of, that
-- subquery sees zero rows and the "has no members" test is TRUE.
--
-- The policy would then reduce to `is_project_member(id) or owner_id = uid` --
-- silently becoming the plain-disjunct variant that was just rejected, with no
-- syntax error and no failing test to say so. app_auth.project_has_members is
-- SECURITY DEFINER so that it sees every membership row regardless of the
-- caller, which is the only way the condition means what it says.
--
-- It takes a PROJECT id and no user parameter, so SPRIN-98's standing warning --
-- that an app_auth function taking another user's id would turn a harmless
-- self-query into an oracle -- does not apply. It answers "does this project have
-- any members at all", which leaks nothing about WHO they are, and is reachable
-- only for a row the caller already owns.
--
-- RESIDUAL, recorded rather than hidden: if a project is ever left with ZERO
-- members, its owner regains read access. That state is exactly what SPRIN-102 is
-- required to prevent and repair (a sole admin deleting their own membership row
-- strands the project). Read access for the owner is a recovery path there, not a
-- leak -- but if SPRIN-102 ever makes zero-member projects a supported state,
-- this disjunct must be revisited.


begin;

-- ---------------------------------------------------------------------------
-- The predicate
-- ---------------------------------------------------------------------------
--
-- STABLE, not IMMUTABLE: it reads a table. STABLE is also what keeps the call out
-- of the per-row auth_rls_initplan path, the same property that let sprin-100
-- clear three WARNs for free.
--
-- search_path is pinned to '' and every reference is schema-qualified, which is
-- what makes SECURITY DEFINER affordable here.

create or replace function app_auth.project_has_members(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members m
    where m.project_id = p_project_id
  );
$$;

-- A NEW FUNCTION IN app_auth IS BORN EXECUTE-TO-PUBLIC, and `authenticated` holds
-- permanent USAGE on the schema. SPRIN-98 tried `alter default privileges` for
-- this and it reported success while doing nothing -- pg_default_acl stayed empty.
-- Revoke by hand, in the same migration, exactly as its two siblings do.
revoke execute on function app_auth.project_has_members(uuid) from public;
grant  execute on function app_auth.project_has_members(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- The policy
-- ---------------------------------------------------------------------------
--
-- Still `to authenticated`, for the reason sprin-101 section 1 gives at length:
-- projects grants anon ardDxtm, anon holds no USAGE on app_auth, and a policy
-- with no TO clause covers public. Dropping and recreating a policy is where that
-- clause is easiest to lose.

drop policy if exists projects_member_read on public.projects;

create policy projects_member_read on public.projects
  for select
  to authenticated
  using (
    app_auth.is_project_member(id)
    or (
      owner_id = (select auth.uid())
      and not app_auth.project_has_members(id)
    )
  );

commit;


-- ===========================================================================
-- AFTER APPLYING -- verify from the CATALOGUE, not the editor's "Success"
-- ===========================================================================
--
-- a. The function's security context and ACL. If proacl still shows a PUBLIC
--    entry (`=X/postgres` with no role name), the revoke did not take.
--
--   select proname, prosecdef, provolatile, proacl::text, proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'app_auth' order by proname;
--
--   EXPECT four rows now. project_has_members: prosecdef = true,
--   provolatile = 's', proconfig = {"search_path=\"\""},
--   proacl = {postgres=X/postgres,authenticated=X/postgres} -- the SAME shape as
--   is_project_member and is_project_admin.
--
-- b. The policy still carries its TO clause and now has both disjuncts.
--
--   select polname, polcmd, polroles::regrole[]::text as roles,
--          pg_get_expr(polqual, polrelid) as using_expr
--   from pg_policy where polrelid = 'public.projects'::regclass
--   order by polname;
--
--   EXPECT four rows, all roles = {authenticated}, and projects_member_read's
--   using_expr containing BOTH is_project_member(id) AND project_has_members(id).
--
-- c. Advisors. Baseline immediately before this migration was 1 security WARN
--    and 11 performance lints (8 unindexed_foreign_keys INFOs, 3
--    auth_rls_initplan WARNs on project_statuses alone).
--
--    EXPECT NO CHANGE. The new disjunct wraps auth.uid() in a select and calls a
--    STABLE definer, so it adds no auth_rls_initplan WARN; the function adds no
--    function_search_path_mutable lint because search_path is pinned. ADD NO NEW
--    LINTS, and do not record an unused_index INFO taken straight after applying.
--
-- d. The proof is the suites. Both must be run, and the FIRST is the regression:
--
--      env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY npm run verify
--
--    EXPECT 83 files, 0 skipped. Before this migration the same command gave
--    8 failed files / 11 failed tests / 197 skipped, the 197 being tests cascaded
--    out by fixture beforeAll failures. A run that still reports skips has not
--    fixed the fixtures.
--
-- e. The narrowness of the fix is worth one direct check, because a plain
--    owner-disjunct would pass every test that this conditional one does EXCEPT
--    this: a project that HAS members must not be readable by its owner when the
--    owner is not among them. projects-membership.integration.test.ts gains a
--    test for exactly that -- an owner removed from their own project's
--    membership reads zero rows. Without it, the two variants are
--    indistinguishable to the suite and the rejected design would pass review.
