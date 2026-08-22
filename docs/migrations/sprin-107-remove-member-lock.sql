-- SPRIN-107 -- remove_project_member could strand a project with ZERO admins.
-- Bug under epic SPRIN-75 (teams and roles), follow-up to SPRIN-102.
--
-- ASCII ONLY. clip.exe transcodes by the console codepage, so a non-ASCII character in
-- this file can arrive in the SQL editor as mojibake. Verify the applied state from the
-- CATALOG afterwards, never from the editor reporting "Success".
--
-- ============================================================================
-- WHAT THIS CHANGES, IN ONE SENTENCE
-- ============================================================================
-- remove_project_member stops deciding whether to delete a row based on a role it read
-- earlier and never re-checked: the DELETE now re-asserts that role, and re-evaluates the
-- whole guard if it moved underneath.
--
-- ============================================================================
-- THE DEFECT, AND THE FACT THAT IT WAS NOT THEORETICAL
-- ============================================================================
-- SPRIN-102's migration claims, in section 3: "an admin row IS a member row, so 'at least
-- one admin' implies 'at least one member', and no path through these three functions can
-- empty a project." That sentence was false for exactly one path.
--
-- The deployed body read the target's role UNLOCKED, and took its `for update` lock only
-- INSIDE `if v_current = 'admin'`. Removing a plain member therefore took no lock at all,
-- and the DELETE that followed carried no `role` predicate:
--
--     select m.role into v_current ...      -- unlocked read
--     if v_current = 'admin' then           -- lock taken only in this branch
--       perform 1 ... where m.role = 'admin' for update;
--       ... if v_admin_rows <= 1 then return 'last_admin'; end if;
--     end if;
--     delete ... where project_id = $1 and user_id = $2;   -- no role predicate
--
-- Under READ COMMITTED every statement in a plpgsql body takes a fresh snapshot, so
-- v_current can be stale by the time the DELETE runs, and the DELETE never looked at role.
--
-- THE INTERLEAVING. Project P, admin X, plain member A:
--   1. T2 calls remove_project_member(P, A). v_current reads 'member'. The guard branch is
--      skipped, so NO row lock is ever taken.
--   2. T1 performs an ordinary hand-over: set_project_member_role(P, A, 'admin') commits,
--      then remove_project_member(P, X) commits -- that call DOES lock, counts two admins,
--      and deletes X. Admins are now {A}.
--   3. T2 resumes and executes its DELETE. A's row is unlocked, the WHERE ignores role, and
--      A -- now the sole admin -- is deleted.
--
-- P then has ZERO admins, reached entirely through the three RPCs. That state is
-- unrecoverable: SPRIN-101 routed projects_admin_update AND projects_admin_delete through
-- app_auth.is_project_admin, and all three membership RPCs check it too, so an adminless
-- project can no longer be reconfigured, administered, or even DELETED by any authenticated
-- user, and its whole cascade subtree goes with it.
--
-- THIS WAS REPRODUCED, NOT REASONED ABOUT. The SPRIN-102 review lens rated the finding LOW
-- *because it could not reproduce the race*, and the review capped verification by severity,
-- so a correct finding about an unrecoverable state fell below the cap and was never
-- adversarially checked. It was trying to WIN a race. You do not have to win a race you can
-- stop: src/test/member-management-concurrency.integration.test.ts pins the interleaving open
-- with an UNCOMMITTED promotion, so T2 blocks on the row lock at exactly the failing
-- instruction, every run. Against the deployed function that test reports the project's admin
-- list as [] where it must be [A]. Read src/test/pg-sessions.ts for why it needs two raw
-- Postgres sessions and cannot be written against PostgREST.
--
-- ============================================================================
-- WHY THIS FIX AND NOT THE OTHER TWO -- READ BEFORE "TIGHTENING" IT
-- ============================================================================
-- Three candidates were considered. David chose this one on 2026-08-22.
--
--   * REJECTED, and insufficient on its own: take the existing `for update` unconditionally,
--     before the branch. A FOR UPDATE over `role = 'admin'` does not lock the target row
--     while that row is still a 'member', which is precisely this case. It would leave the
--     hole open while looking like a fix.
--
--   * REJECTED, though correct: lock the TARGET row on the initial read, by adding
--     `for update` to the first SELECT. This does close the hole, but it acquires the
--     target-row lock BEFORE the admin-rows lock, while set_project_member_role acquires
--     them in the opposite order -- a lock-order inversion, and therefore a deadlock, in
--     exchange for fixing a race. Making it safe needs a deterministic acquisition order
--     across both functions, whose deadlock-freedom argument then rests on LockRows sitting
--     above Sort in the plan. That is planner behaviour, not a documented contract, and it
--     is a weaker guarantee than the one below.
--
--   * CHOSEN: re-assert the role in the DELETE, and re-evaluate if it moved. This takes NO
--     new lock, so it raises no lock-ordering question at all, and it fails safe by
--     construction: if the role changed underneath, the DELETE matches zero rows and cannot
--     remove anybody. It is the smallest change with the strongest argument.
--
-- WHY A LOOP RATHER THAN A NEW RETURN TAG. A bare `and m.role = v_current` leaves the
-- caller with zero rows deleted and nothing honest to say: 'not_a_member' would be a lie,
-- and a new 'conflict' tag would have to widen RemoveMemberResult in domain.ts and be
-- handled in MemberSettings.tsx -- which today routes every non-'last_admin' tag to the
-- "not a member" message, so a new tag would ship a falsehood unless the client changed
-- too. Re-running the guard instead gives the RIGHT answer rather than a new kind of
-- shrug: after a concurrent promotion the second pass sees 'admin', takes the lock, counts,
-- and returns 'last_admin' if the target is now the only one. The external contract is
-- unchanged, so no client code moves.
--
-- WHY THE LOOP CONVERGES. Each pass either returns, or observes that the row changed since
-- the pass began. The two zero-row outcomes are covered: if the row was DELETED underneath,
-- the next pass reads null and returns 'not_a_member'; if it was PROMOTED underneath, the
-- next pass reads 'admin' and takes the lock, after which the role cannot move again while
-- this transaction holds it. Three passes is therefore generous, not a guess.
--
-- WHY THE AUTHORISATION CHECK STAYS OUTSIDE THE LOOP. It is deliberate and it is
-- load-bearing. In the very interleaving above, T1 removes the CALLER's own admin row and
-- commits while T2 is parked; re-checking is_project_admin on the second pass would then
-- fail for a caller who was a legitimate admin when the call began, turning a correct
-- 'last_admin' into a confusing 42501. Authorisation is established once, at entry, as it
-- was before this change.
--
-- ============================================================================
-- WHAT THIS DELIBERATELY DOES NOT TOUCH
-- ============================================================================
-- set_project_member_role is UNCHANGED. It has the same unlocked-read shape, and it is
-- safe -- but for a reason worth writing down rather than re-deriving: a stale 'member'
-- read there can only lead to a promotion or an 'unchanged' return, and a stale 'admin'
-- read is corrected because FOR UPDATE re-evaluates under EvalPlanQual once the blocking
-- transaction commits. That safety is narrow. Anyone editing that function should assume it
-- is one edit away from this same defect; the second test in the concurrency suite pins the
-- demote-vs-demote path so a regression there goes red rather than silent.

begin;

-- ============================================================================
-- remove_project_member
-- ============================================================================
-- Identical signature, so this is a REPLACE and not a CREATE: the existing EXECUTE grants
-- are preserved, and the revoke-by-hand warning at the head of sprin-98-project-members.sql
-- does not apply. Verified from pg_proc.proacl in the checks below rather than assumed.
create or replace function public.remove_project_member(
  p_project_id uuid,
  p_user_id    uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current    text;
  v_admin_rows int;
  v_attempts   int := 0;
begin
  -- AUTHORISATION FIRST, and outside the loop. See the header for why re-checking it per
  -- pass would break the legitimate hand-over case.
  if not app_auth.is_project_admin(p_project_id) then
    raise exception 'Only a project admin may remove members'
      using errcode = '42501';
  end if;

  loop
    v_attempts := v_attempts + 1;

    select m.role into v_current
    from public.project_members m
    where m.project_id = p_project_id
      and m.user_id = p_user_id;

    if v_current is null then
      return 'not_a_member';
    end if;

    if v_current = 'admin' then
      perform 1
      from public.project_members m
      where m.project_id = p_project_id
        and m.role = 'admin'
      for update;

      select count(*) into v_admin_rows
      from public.project_members m
      where m.project_id = p_project_id
        and m.role = 'admin';

      if v_admin_rows <= 1 then
        return 'last_admin';
      end if;
    end if;

    -- THE FIX IS THE THIRD PREDICATE. Without `m.role = v_current` this DELETE removes the
    -- row whatever its role has become since the read above, which is the whole defect.
    -- With it, a row promoted underneath matches nothing and nobody is removed.
    delete from public.project_members m
    where m.project_id = p_project_id
      and m.user_id = p_user_id
      and m.role = v_current;

    if found then
      return 'removed';
    end if;

    -- Zero rows means the row moved between the read and the DELETE. Re-evaluate rather
    -- than guess: the next pass reads the current state and answers from it.
    if v_attempts >= 3 then
      raise exception 'Could not remove member: the role changed repeatedly during removal'
        using errcode = '40001';
    end if;
  end loop;
end;
$$;

commit;

-- ============================================================================
-- VERIFICATION -- run these AFTER applying, and read the catalog, not the editor
-- ============================================================================
--
-- 1. The DELETE carries the role predicate, and the loop is bounded. This is a source
--    check, so treat it as necessary and not sufficient -- the live suite is what proves
--    the behaviour. Expect one row, `true`, `true`.
--
-- select pg_get_functiondef(p.oid) like '%and m.role = v_current%' as delete_reasserts_role,
--        pg_get_functiondef(p.oid) like '%v_attempts >= 3%'        as retry_is_bounded
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname = 'remove_project_member';
--
-- 2. The EXECUTE grants survived the replace. Expect the SAME proacl as the other two
--    RPCs -- authenticated holds EXECUTE, anon does not. A create-instead-of-replace would
--    show up here as a function born EXECUTE-to-PUBLIC.
--
-- select p.proname, p.prosecdef, p.proacl
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('add_project_member_by_email', 'set_project_member_role',
--                      'remove_project_member')
--  order by p.proname;
--
-- 3. The live proof. Both tests must pass; the first one FAILS against the pre-migration
--    function with the project's admin list reading [] instead of [<user>]:
--
--    npx vitest run src/test/member-management-concurrency.integration.test.ts
--
-- ============================================================================
-- ADVISORS -- EXPECT NO CHANGE, AND THE REASON IS NOT "IT IS ONLY A FUNCTION BODY"
-- ============================================================================
-- Expected after applying: 4 security WARNs and 8 performance INFOs, exactly as SPRIN-102
-- left them, with auth_rls_initplan still ZERO.
--
-- The reason is worth stating precisely, because SPRIN-102's own prediction failed by
-- reasoning about what a migration CREATES rather than about the shape it produces. Lint
-- 0029 (authenticated_security_definer_function_executable) is REACHABILITY-GATED: it fires
-- on a public-schema, authenticated-executable SECURITY DEFINER function. This migration
-- REPLACES such a function with another of the same shape, adds no new one, and changes no
-- grant -- so the count of qualifying functions is unchanged at three, and the WARN count
-- is unchanged at three plus the pre-existing, unrelated leaked-password-protection WARN.
-- A FOURTH public RPC would add a FIFTH WARN by construction. This is not that.
