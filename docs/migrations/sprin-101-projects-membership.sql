-- SPRIN-101 -- The projects table governed by membership, not ownership
-- Epic SPRIN-75 (teams, roles and permissions). Story 4 of 8.
--
-- ASCII ONLY. clip.exe transcodes by console codepage, and a smart quote that
-- survives the clipboard will not survive the SQL editor. No em dashes, no
-- curly quotes, no non-breaking spaces anywhere in this file.
--
-- Replaces projects_owner -- ONE "for all" policy, no TO clause, owner_id =
-- auth.uid() in both clauses -- with four verb-scoped policies. SELECT resolves
-- to membership; UPDATE and DELETE additionally require the 'admin' role,
-- because project configuration is an admin act; INSERT stays owner-scoped,
-- purely to bootstrap.
--
-- Also reverts assign_ticket_key to SECURITY INVOKER, undoing sprin-100b now
-- that its one reason has expired. Section 4 argues that in full.
--
-- Depends on SPRIN-98 (project_members, app_auth predicates) and SPRIN-100
-- (the board tables, and the "to authenticated" rule this file obeys).
--
--
-- ==========================================================================
-- 1. WHY EVERY NEW POLICY CARRIES "to authenticated"
-- ==========================================================================
--
-- Same rule SPRIN-100 established, second table to need it. Measured on the
-- live catalogue 2026-08-20:
--
--   projects relacl
--     {postgres=arwdDxtm/postgres,anon=ardDxtm/postgres,
--      authenticated=ardDxtm/postgres,service_role=arwdDxtm/postgres}
--
--   anon therefore holds INSERT (a), SELECT (r) and DELETE (d) on this table.
--   projects_owner polroles = {-}  i.e. public, anon included.
--   anon USAGE on schema app_auth        false
--   anon EXECUTE on is_project_member    false
--
-- Policy expressions are evaluated as the CALLING role. Three of the four
-- policies below call an app_auth function, so without a TO clause an
-- anonymous SELECT of projects would raise
--
--   permission denied for schema app_auth   (SQLSTATE 42501)
--
-- where today it is filtered to a clean empty array.
--
-- With the clause, anon matches no policy at all: SELECT returns [], INSERT and
-- DELETE are refused by RLS. Observably the same as today.
--
-- NOTE, so nobody "tidies" it later: anon's a/d grants on this table are now
-- pure liability, since no policy will ever admit an anonymous caller. Revoking
-- them belongs to SPRIN-103's schema-wide sweep, scoped from pg_class.relacl
-- across every table at once, NOT to this migration. A piecemeal revoke here is
-- how the previous "narrowing" migrations left privileges nobody intended.
--
--
-- ==========================================================================
-- 2. THE BOOTSTRAP PROBLEM, AND WHY IT IS ALREADY SOLVED
-- ==========================================================================
--
-- If authority came only from membership rows then creating a project would
-- require a membership that does not yet exist, and EVERY project creation
-- would fail at insert time. The INSERT policy therefore keeps
-- owner_id = (select auth.uid()). It is a bootstrap, not an ownership model:
-- owner_id remains an audit column that grants nothing on its own.
--
-- Three facts verified from the catalogue rather than assumed, because
-- SPRIN-100 was bitten by exactly this class of unwritten dependency:
--
--   a. All three triggers on projects are AFTER INSERT and ALL THREE are
--      SECURITY DEFINER:
--        on_project_created           -> create_project_counter   (definer)
--        on_project_created_admin     -> seed_project_admin       (definer)
--        on_project_created_statuses  -> seed_project_statuses    (definer)
--      None of them is exposed to the new policies' authority.
--
--   b. seed_project_admin inserts (new.id, new.owner_id, 'admin') -- it reads
--      NEW.OWNER_ID, NOT auth.uid(). So a service-role fixture insert, which
--      has no auth.uid() at all, still seeds an admin row. Every raw fixture
--      insert across the live suites and the Playwright E2E keeps working.
--      Had it read auth.uid(), those projects would have been created with no
--      admin and become permanently undeletable by this migration's DELETE
--      policy.
--
--   c. No repair is owed. Before applying:
--        select count(*) from public.projects p
--        where not exists (select 1 from public.project_members m
--                          where m.project_id = p.id and m.role = 'admin');
--      returned 0 of 3 projects. Every existing project already has its owner
--      as admin.
--
--
-- ==========================================================================
-- 3. WHAT THIS COSTS: owner_id IMMUTABILITY NOW RESTS ON THE GRANT ALONE
-- ==========================================================================
--
-- Stated plainly rather than glossed, because it is a real narrowing.
--
-- The old for-all policy's WITH CHECK (owner_id = auth.uid()) applied to UPDATE
-- as well as INSERT. projects_admin_update below checks is_project_admin(id)
-- and says NOTHING about owner_id -- deliberately, because an admin who is not
-- the owner must be able to change the cadence.
--
-- So on paper an admin could reassign ownership. They cannot, because the write
-- is refused one layer earlier. Measured 2026-08-20 from pg_attribute.attacl:
--
--   sprint_length_weeks    {authenticated=w/postgres}
--   sprint_start_weekday   {authenticated=w/postgres}
--   ...and no other column has an attacl at all.
--
-- combined with no table-level UPDATE for authenticated (relacl above has no
-- 'w'). owner_id, name, key and project_type carry no UPDATE privilege.
--
-- BEFORE this migration ownership immutability had two independent controls,
-- the grant and the policy's WITH CHECK. AFTER it, one. The survivor is the
-- stronger of the two -- a privilege check precedes RLS and cannot be filtered
-- -- but anyone who later runs `grant update (owner_id)` gets no second
-- refusal. CLAUDE.md's four-part obligation for widening this table therefore
-- binds harder than it did.
--
--
-- ==========================================================================
-- 4. REVERTING assign_ticket_key TO SECURITY INVOKER
-- ==========================================================================
--
-- sprin-100b made this function SECURITY DEFINER for exactly one reason: it
-- does
--
--   select key into v_key from public.projects where id = new.project_id;
--
-- and projects_owner was still owner-scoped, so a member got zero rows, v_key
-- was NULL, and ticket creation died with 23502 on "key". That migration's
-- closing note asks this story to make the revert a DECISION, NOT AN
-- INHERITANCE. This is that decision, taken with David on 2026-08-20: revert.
--
-- The reason has expired. Once projects SELECT resolves to membership, the
-- trigger's read succeeds for a member running as themselves.
--
-- Two things are bought back:
--
--   a. A deliberate tripwire. The original schema comment chose the invoker
--      context so that narrowing counters_owner to read-only would break ticket
--      creation LOUDLY rather than silently. sprin-100b deleted that knowingly
--      and recorded that nothing replaced it.
--
--   b. One fewer SECURITY DEFINER function -- four down to three. A definer
--      function is a standing RLS bypass. This one no longer earns it.
--
-- THE ONE OPEN QUESTION, STATED AS A HYPOTHESIS RATHER THAN A FACT.
--
-- For a STRANGER (authenticated, not a member) the invoker read now returns
-- zero rows, so new.key is NULL. Whether Postgres then reports 42501 (the RLS
-- WITH CHECK on tickets_owner) or 23502 (the NOT NULL constraint on key)
-- depends on which it evaluates first in ExecInsert.
--
-- The expectation is 42501: checking RLS first is the security-sensible order,
-- since a constraint error would otherwise leak information to a caller RLS
-- means to refuse. BUT A MECHANISTIC RATIONALE IS A HYPOTHESIS UNTIL MEASURED,
-- and this file does not rest on it. board-membership.integration.test.ts
-- already asserts 42501 WITH THE ROW-LEVEL-SECURITY MESSAGE for precisely this
-- case, so the existing suite settles it the first time it runs.
--
-- IF IT COMES BACK 23502, THE REVERT IS WRONG. Re-apply sprin-100b's definer
-- version and record the measurement in the design spec. Do not "fix" the test.
--
-- The revoke stays either way. Postgres checks EXECUTE on a trigger function at
-- CREATE TRIGGER time, not on each fire -- measured in SPRIN-100b against
-- seed_project_admin and create_project_counter, both of which sit at
-- {postgres, service_role} and whose triggers fire for ordinary authenticated
-- users. CREATE OR REPLACE preserves the existing ACL, so the revoke below is
-- belt and braces rather than a change.


begin;

-- ---------------------------------------------------------------------------
-- The four policies
-- ---------------------------------------------------------------------------

drop policy if exists projects_owner on public.projects;

-- SELECT: every project the caller is a member of, and no other. No role
-- predicate -- both admins and members read the project they work on.
create policy projects_member_read on public.projects
  for select
  to authenticated
  using (app_auth.is_project_member(id));

-- INSERT: bootstrap only. See section 2. The wrapped (select auth.uid()) form
-- is deliberate and not a style choice: it keeps the uid read out of the
-- per-row path and is what stops this policy re-adding an auth_rls_initplan
-- WARN that the other three clear.
create policy projects_bootstrap_insert on public.projects
  for insert
  to authenticated
  with check (owner_id = (select auth.uid()));

-- UPDATE: admin only. The predicate is repeated in WITH CHECK rather than left
-- to default, so a row cannot be updated INTO a project the caller does not
-- administer. Both clauses read the same because id is not updatable (no
-- column grant), but writing only USING would make that grant load-bearing in
-- a second, undocumented place.
create policy projects_admin_update on public.projects
  for update
  to authenticated
  using (app_auth.is_project_admin(id))
  with check (app_auth.is_project_admin(id));

-- DELETE: admin only, and this half is NOT optional. Deleting a project
-- cascades through every referencing fk -- counters, sprints, tickets,
-- statuses, fields, options, values, memberships -- and RLS IS NOT ENFORCED ON
-- THE CASCADED CHILD ROWS. Under a membership-only DELETE a plain member would
-- destroy the entire board. Restricting it to admins is what keeps the blast
-- radius matched to the authority.
create policy projects_admin_delete on public.projects
  for delete
  to authenticated
  using (app_auth.is_project_admin(id));


-- ---------------------------------------------------------------------------
-- assign_ticket_key back to SECURITY INVOKER (see section 4)
-- ---------------------------------------------------------------------------
--
-- The body is character-for-character what sprin-100b installed. ONLY the
-- security context changes, and the comment below restores the tripwire's
-- rationale to the catalogue where the next reader will find it.

create or replace function assign_ticket_key()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_key text;
  v_num int;
begin
  -- Atomic increment under row lock. Concurrent inserts serialise here.
  update public.project_counters
     set last_number = last_number + 1
   where project_id = new.project_id
   returning last_number into v_num;

  select key into v_key from public.projects where id = new.project_id;

  new.number := v_num;
  new.key    := v_key || '-' || v_num;
  return new;
end;
$$;

comment on function public.assign_ticket_key() is
  'Assigns PROJECTKEY-N via the project_counters row, under a row lock. '
  'Deliberately SECURITY INVOKER: it runs as the caller, so both the counter '
  'update and the projects read are permitted only by RLS -- counters_owner '
  'and projects_member_read respectively. That is a TRIPWIRE, not the boundary: '
  'narrowing either policy breaks ticket creation loudly instead of silently. '
  'SPRIN-100b made it definer because projects was still owner-scoped and a '
  'member could not read the key; SPRIN-101 restored the invoker context once '
  'projects resolved to membership. A SECURITY INVOKER trigger depends on every '
  'table it READS, not only the ones it writes -- that dependency on projects '
  'was undocumented and cost SPRIN-100 a story to find.';

revoke execute on function public.assign_ticket_key() from public, anon, authenticated;

commit;


-- ===========================================================================
-- AFTER APPLYING -- verify from the CATALOGUE, not the editor's "Success"
-- ===========================================================================
--
-- a. The four policies, their roles and both clauses. This is the assertion
--    that matters most: a missing TO clause is invisible until anon calls.
--
--   select polname, polcmd, polroles::regrole[]::text as roles,
--          pg_get_expr(polqual, polrelid)      as using_expr,
--          pg_get_expr(polwithcheck, polrelid) as check_expr
--   from pg_policy where polrelid = 'public.projects'::regclass
--   order by polname;
--
--   EXPECT exactly four rows, every one with roles = {authenticated}:
--     projects_admin_delete      d  using  is_project_admin(id)    check NULL
--     projects_admin_update      w  using  is_project_admin(id)    check is_project_admin(id)
--     projects_bootstrap_insert  a  using  NULL                    check owner_id = (select auth.uid())
--     projects_member_read       r  using  is_project_member(id)   check NULL
--
--   EXPECT NO row named projects_owner.
--
-- b. The trigger function is back to invoker and still attached.
--
--   select proname, prosecdef, proacl::text, proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'assign_ticket_key';
--
--   EXPECT prosecdef = FALSE, proconfig = {"search_path=\"\""},
--          proacl = {postgres=X/postgres,service_role=X/postgres}
--
--   select tgname, tgenabled from pg_trigger
--   where tgrelid = 'public.tickets'::regclass and tgname = 'on_ticket_insert';
--
--   EXPECT one row, tgenabled = 'O'.
--
-- c. Grants are UNCHANGED by this migration. Confirm nothing drifted:
--
--   select relacl::text from pg_class where oid = 'public.projects'::regclass;
--   EXPECT anon=ardDxtm and authenticated=ardDxtm -- still no 'w' on either.
--
--   select attname, attacl::text from pg_attribute
--   where attrelid = 'public.projects'::regclass and attacl is not null;
--   EXPECT exactly two rows, sprint_length_weeks and sprint_start_weekday,
--          both {authenticated=w/postgres}.
--
-- d. Advisors. Baseline immediately before this migration was 1 security WARN
--    (leaked password protection) and 12 performance lints: 8
--    unindexed_foreign_keys INFOs and 4 auth_rls_initplan WARNs across two
--    tables -- projects (projects_owner) and project_statuses (three).
--
--    EXPECT 11 performance lints and 3 auth_rls_initplan WARNs across ONE
--    table, project_statuses. projects should clear entirely: all four new
--    predicates are either a STABLE definer call or the wrapped
--    (select auth.uid()) form.
--
--    ADD NO NEW LINTS. Re-derive with get_advisors and update CLAUDE.md's
--    baseline paragraph with the MEASURED figures, not these predicted ones.
--    And do not record an unused_index INFO from a reading taken straight
--    after applying -- that advisor is about traffic, not schema.
--
-- e. The keepalive contract. Section 1 exists to protect it; run it rather
--    than trusting the reasoning:
--
--      npm run keepalive
--
--    EXPECT 200 and []. It reads tickets, not projects, so it should be
--    untouched -- but a 42501 mentioning app_auth anywhere means a TO clause
--    is missing somewhere.
--
-- f. The real proof is the suites:
--
--      env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY npm run verify
--
--    projects-membership.integration.test.ts must pass in full, and
--    board-membership.integration.test.ts must stay 16/16 -- its stranger
--    ticket-insert assertion is what settles section 4's open question.
