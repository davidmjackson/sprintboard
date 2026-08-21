-- SPRIN-102 -- add and remove members by email (epic SPRIN-75, teams and roles, story 5).
--
-- ASCII ONLY. clip.exe transcodes by the console codepage, so a non-ASCII character in
-- this file can arrive in the SQL editor as mojibake. Verify the applied state from the
-- CATALOG afterwards, never from the editor reporting "Success".
--
-- ============================================================================
-- WHAT THIS CHANGES, IN ONE SENTENCE
-- ============================================================================
-- project_members stops being writable over PostgREST at all: three SECURITY DEFINER
-- RPCs become the ONLY write path, and they carry the last-admin guard the epic has
-- owed since SPRIN-98 landed.
--
-- ============================================================================
-- WHY THE GUARD IS NOT A TRIGGER -- READ THIS BEFORE "SIMPLIFYING" IT
-- ============================================================================
-- The obvious home for "a project must always have an admin" is a trigger on
-- project_members. Two shapes were considered and BOTH were rejected, for different
-- reasons, and the second rejection is the one that is easy to re-derive wrongly.
--
--   * A ROW trigger counting sibling rows is already ruled out by this repo: it sees a
--     fresh SPI snapshot per row, so during a cascade it counts rows that are on their
--     way out and starts refusing deletes that must succeed. Deleting a project would
--     begin to fail.
--
--   * A STATEMENT trigger with a transition table fixes that much -- a cascade from
--     `projects` can be exempted by asking whether the project still exists, and by
--     AFTER-statement time it does not. It still breaks on a DIFFERENT path. Deleting an
--     auth.users row cascades into BOTH projects and project_members, in an order this
--     schema does not pin. A user who was some project's sole admin, but not its only
--     member, leaves that project existing, still populated, and admin-less -- so the
--     trigger raises and the USER DELETE fails. The E2E suite deletes a signed-up user in
--     teardown on every run, so that is a required check going red, and it could not be
--     measured in advance because the MCP is read-only and cannot create a trigger.
--
-- Making the RPCs the only write path removes the question rather than answering it. A
-- cascade fires no trigger, so no cascade can be refused. The cost is that the three
-- write policies SPRIN-98 wrote become unreachable-by-grant; see section 4.
--
-- Note what this ALSO closes, which SPRIN-98 recorded as open: an admin could reach a
-- re-pointed membership row via DELETE + INSERT, because members_admin_delete's USING and
-- members_admin_insert's WITH CHECK each constrain only the PROJECT and say nothing about
-- user_id. With neither verb granted, that route is gone.
--
-- ============================================================================
-- WHY A ZERO-MEMBER PROJECT BECOMES UNREACHABLE, AND WHY THAT MATTERS
-- ============================================================================
-- The SPRIN-101 deep review left this story a decision: forbid removing the last member,
-- or revisit projects_member_read's bootstrap disjunct
-- (owner_id = auth.uid() and not app_auth.project_has_members(id)), which hands a REMOVED
-- owner their read back if a project is ever emptied.
--
-- The decision is made by the last-admin guard rather than in addition to it. An admin
-- row IS a member row, so "at least one admin" implies "at least one member", and no path
-- through these three functions can empty a project. The disjunct stays exactly as
-- SPRIN-101 wrote it. Anyone adding a fourth write path here inherits that obligation.

begin;

-- ============================================================================
-- 1. add_project_member_by_email
-- ============================================================================
-- The narrow, auditable hole the story exists for. An admin must be able to resolve an
-- address belonging to someone they share NO project with yet, which profiles_read
-- deliberately refuses (SPRIN-105 scoped it to co-members). A definer function is the
-- only way to answer that one question without widening the policy for everyone.
--
-- THE ORDER OF THE FIRST TWO STATEMENTS IS THE SECURITY PROPERTY. The admin check runs
-- before the address is so much as looked at. A definer function bypasses RLS, so the
-- policy layer will NOT do this check for us; and if the lookup ran first, a non-admin
-- would get a working email-enumeration oracle out of a function that then refused them.
-- The refusal must be indistinguishable for a registered and an unregistered address,
-- and it is, because nothing has been read at the point it is raised.
--
-- It remains an enumeration oracle FOR PROJECT ADMINS, by construction -- 'no_such_user'
-- is a statement about the address. That is the bound Jira accepts (Jira itself does the
-- same), and it is why the return value carries a TAG and never a user id, a display
-- name, or a row: an admin learns that an address is registered, and nothing else about
-- whoever holds it, unless the add succeeds and they become co-members.
--
-- MATCHING IS EXACT AGAINST A LOWERCASED INPUT, not lower(p.email) = lower(...), and the
-- difference is a failure MODE rather than a nicety. profiles_email_key is a plain
-- case-sensitive UNIQUE, so two rows differing only by case are possible in principle;
-- GoTrue normalises addresses so there are none today (measured: 0 of 9 profile rows
-- differ from their own lower()). Under a case-insensitive match those two rows would
-- both match and SELECT INTO would take one ARBITRARILY -- silently adding the wrong
-- person. Under an exact match the same situation yields 'no_such_user'. If the
-- guarantee ever breaks, this fails closed instead of adding a stranger to a project.
create or replace function public.add_project_member_by_email(
  p_project_id uuid,
  p_email      text,
  p_role       text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  -- AUTHORISATION FIRST. Nothing above this line reads p_email.
  if not app_auth.is_project_admin(p_project_id) then
    raise exception 'Only a project admin may add members'
      using errcode = '42501';
  end if;

  -- The role vocabulary, checked here as well as by project_members_role_check. The
  -- constraint alone would refuse an unknown role, but as an opaque 23514 naming a
  -- constraint; the story asks for outcomes a user can act on.
  if p_role is null or p_role not in ('admin', 'member') then
    raise exception 'Unrecognised role: %', p_role
      using errcode = '22023';
  end if;

  select p.id into v_user_id
  from public.profiles p
  where p.email = lower(btrim(p_email));

  if v_user_id is null then
    return 'no_such_user';
  end if;

  -- ON CONFLICT DO NOTHING rather than a preceding EXISTS check: the check-then-insert
  -- shape has a race between the two statements, and this has none. FOUND is false when
  -- the conflict fired, which is exactly "already a member". Adding an existing member
  -- deliberately does NOT change their role -- AC5 asks for it to be REPORTED, and a
  -- silent promotion out of the add box is not what an admin typed.
  insert into public.project_members (project_id, user_id, role)
  values (p_project_id, v_user_id, p_role)
  on conflict (project_id, user_id) do nothing;

  if not found then
    return 'already_member';
  end if;

  return 'added';
end;
$$;

-- ============================================================================
-- 2. set_project_member_role
-- ============================================================================
-- THE LOCK IS NOT DECORATION. Without it, two admins demoting each other concurrently
-- both read a count of 2, both pass the guard, and the project ends with zero admins --
-- the precise state this function exists to prevent. `for update` on the project's admin
-- rows serialises those two transactions. The delete path in section 3 takes the SAME
-- lock on the SAME rows, so demote-vs-remove races are covered too, not just
-- demote-vs-demote.
create or replace function public.set_project_member_role(
  p_project_id uuid,
  p_user_id    uuid,
  p_role       text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current    text;
  v_admin_rows int;
begin
  if not app_auth.is_project_admin(p_project_id) then
    raise exception 'Only a project admin may change a member role'
      using errcode = '42501';
  end if;

  if p_role is null or p_role not in ('admin', 'member') then
    raise exception 'Unrecognised role: %', p_role
      using errcode = '22023';
  end if;

  select m.role into v_current
  from public.project_members m
  where m.project_id = p_project_id
    and m.user_id = p_user_id;

  if v_current is null then
    return 'not_a_member';
  end if;

  if v_current = p_role then
    return 'unchanged';
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

  update public.project_members m
  set role = p_role
  where m.project_id = p_project_id
    and m.user_id = p_user_id;

  return 'updated';
end;
$$;

-- ============================================================================
-- 3. remove_project_member
-- ============================================================================
-- Removing YOURSELF is permitted, and is the ordinary way an admin hands over: promote a
-- second admin, then remove your own row. It is refused only when you are the last admin,
-- which is the same rule applied to everyone rather than a special case.
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
begin
  if not app_auth.is_project_admin(p_project_id) then
    raise exception 'Only a project admin may remove members'
      using errcode = '42501';
  end if;

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

  delete from public.project_members m
  where m.project_id = p_project_id
    and m.user_id = p_user_id;

  return 'removed';
end;
$$;

-- ============================================================================
-- 4. EXECUTE PRIVILEGES -- revoking from PUBLIC is NOT enough here
-- ============================================================================
-- These live in `public` because PostgREST only publishes exposed schemas and the client
-- has to call them; they cannot hide in app_auth the way the membership predicates do.
--
-- The `public` schema carries a DEFAULT ACL for functions, measured 2026-08-16 as
-- {postgres=X/postgres, anon=X/postgres, authenticated=X/postgres, service_role=X/postgres}.
-- Those are EXPLICIT grants, not the implicit PUBLIC one, so `revoke ... from public`
-- leaves anon holding execute. anon must be named. This is the pattern handle_new_user,
-- seed_project_statuses and seed_project_admin all carry.
revoke execute on function public.add_project_member_by_email(uuid, text, text) from public, anon;
revoke execute on function public.set_project_member_role(uuid, uuid, text) from public, anon;
revoke execute on function public.remove_project_member(uuid, uuid) from public, anon;

grant execute on function public.add_project_member_by_email(uuid, text, text) to authenticated;
grant execute on function public.set_project_member_role(uuid, uuid, text) to authenticated;
grant execute on function public.remove_project_member(uuid, uuid) to authenticated;

-- ============================================================================
-- 5. THE WRITE GRANTS GO -- the RPCs above are now the only write path
-- ============================================================================
-- Written TABLE-WIDE, because a table-level revoke CASCADES to column grants while
-- `revoke insert (col)` against a table-wide grant is a SILENT NO-OP. Measured before
-- this migration, project_members held relacl authenticated=rdDxtm plus column grants
-- project_id=a, user_id=a, role=aw. All four disappear here.
--
-- TRUNCATE goes with them. It is the uppercase D in that string and it is NOT covered by
-- `revoke delete`; RLS cannot police TRUNCATE at all, so a single statement would empty
-- every membership row in the database. It is not reachable over PostgREST, which has no
-- TRUNCATE verb, so this is defence in depth rather than a live hole -- but leaving it
-- granted on the ONE table this migration exists to make unwritable would be an odd place
-- to stop. The repo-wide TRUNCATE sweep across the other tables is still SPRIN-75's, not
-- this story's; this is one table, named deliberately.
--
-- SELECT deliberately SURVIVES. The members list is read directly under members_read, so
-- the UI needs no RPC to render it, and read stays co-extensive with what a member can
-- already see.
revoke insert, update, delete, truncate on project_members from authenticated;

-- THE THREE WRITE POLICIES STAY, and are now defence in depth rather than the control.
-- The privilege layer refuses these verbs before any policy is consulted, so
-- members_admin_insert, members_admin_update and members_admin_delete can no longer be
-- reached over PostgREST. They are kept for the reason SPRIN-105b kept the four policies
-- it had just put behind a revoke: re-granting a verb later must not silently open a
-- row-level hole at the same moment. Dropping them would also be fail-closed -- RLS with
-- no permissive policy denies -- but it would make a future re-grant a two-file change
-- with one file easy to forget.
--
-- MIND THE CONSEQUENCE FOR TESTS. A refused write here now earns 42501 with a
-- "permission denied for table project_members" message from the PRIVILEGE layer, NOT
-- the "new row violates row-level security policy" message an RLS refusal produces. Two
-- controls, one SQLSTATE: an assertion must match on the MESSAGE to say which refused.
-- Three negative tests in project-members.integration.test.ts would otherwise stay green
-- while proving something they no longer prove.

-- ============================================================================
-- 6. REPAIR -- the guard must fix existing strandings, not only prevent new ones
-- ============================================================================
-- A sole admin has been able to delete their own membership row since SPRIN-98 landed,
-- and SPRIN-101 made the consequence worse: projects_admin_update and
-- projects_admin_delete both resolve to app_auth.is_project_admin, so a zero-admin
-- project can no longer be reconfigured OR removed by any authenticated user, and its
-- whole cascade subtree goes with it. A guard that only blocked new occurrences would
-- leave any existing one permanently stranded.
--
-- ONE statement repairs both shapes a stranded project can take, which is why it is an
-- INSERT with a DO UPDATE rather than the more obvious UPDATE: a project whose owner
-- holds a 'member' row gets that row promoted, and a project where the owner holds no row
-- at all (or holds none because every member was removed) gets one inserted. The owner is
-- the right person to restore because owner_id is not null and survives as the audit
-- record SPRIN-75 kept it for.
--
-- Measured immediately before writing this: 3 projects, 3 member rows, 0 without an
-- admin. So this statement is a provable no-op TODAY and ships anyway -- the state stays
-- reachable right up until the revoke above applies, including by a request in flight
-- while this migration runs.
insert into public.project_members (project_id, user_id, role)
select p.id, p.owner_id, 'admin'
from public.projects p
where not exists (
  select 1 from public.project_members a
  where a.project_id = p.id and a.role = 'admin'
)
on conflict (project_id, user_id) do update set role = 'admin';

-- A post-state check with a stated limitation, copied from SPRIN-98: it reads back its
-- own work inside this same transaction, so it proves the statement above ran -- NOT that
-- the invariant holds against anything else. It is a tripwire on a silently-empty repair,
-- not a test. The live suite is the test.
do $$
declare
  projects_without_admin int;
begin
  select count(*) into projects_without_admin
  from public.projects p
  where not exists (
    select 1 from public.project_members m
    where m.project_id = p.id and m.role = 'admin'
  );

  if projects_without_admin > 0 then
    raise exception 'Repair incomplete: % project(s) have no admin', projects_without_admin;
  end if;
end;
$$;

commit;

-- ============================================================================
-- AFTER APPLYING -- verify from the CATALOG, not from "Success"
-- ============================================================================
--   * project_members relacl: authenticated=rxtm -- a (INSERT), w (UPDATE), d (DELETE)
--     and D (TRUNCATE) all gone. anon still ABSENT. service_role unchanged.
--     THIS LINE READ "rxt only" BEFORE THE MIGRATION WAS APPLIED, AND WAS WRONG. m
--     (MAINTAIN) was in the pre-state (authenticated=rdDxtm) and is not in the revoke
--     list, so it survives by design. Corrected from the measured post-state rather
--     than left to read as a failed check by the next person who runs the checklist.
--   * column attacl on project_members: NOTHING on project_id, user_id or role. The
--     table-level revoke cascades; confirm it rather than assuming it, because a column
--     grant surviving a table revoke is precisely the asymmetry this repo has been bitten
--     by in the other direction.
--   * has_table_privilege('authenticated','public.project_members','INSERT') = false,
--     and the same for UPDATE, DELETE and TRUNCATE. SELECT = true.
--   * All FOUR policies still present and unchanged.
--   * The three new functions: prosecdef = true, proconfig = {search_path=}, and proacl
--     listing postgres, service_role and authenticated but NOT anon and no bare "=X/".
--   * Every project has AT LEAST one admin; measured 3 projects, 3 member rows, and as
--     it happens exactly one admin each. "At least" is the invariant this migration
--     enforces -- "exactly" is a fact about today's data, and promoting a second admin
--     is the feature. Do not turn the measurement back into an assertion.
--
-- ============================================================================
-- ADVISORS -- THIS SECTION PREDICTED "NO NEW LINTS" AND WAS WRONG
-- ============================================================================
-- Measured after applying, 2026-08-21: security went 1 WARN -> 4. Performance is
-- unchanged at 8 INFOs and auth_rls_initplan is still ZERO across the schema, both as
-- predicted. The prediction that failed was the security half, and the original wording
-- is kept above the correction rather than swapped out silently.
--
-- The three new WARNs are one per RPC, all `authenticated_security_definer_function_
-- executable` (lint 0029): "Function public.<name> can be executed by the authenticated
-- role as a SECURITY DEFINER function via /rest/v1/rpc/<name>."
--
-- WHY THE PREDICTION FAILED. It reasoned about the lints this migration could add by
-- what it CREATES -- no table, no index, no policy -- and about search_path, which the
-- advisor does check. It never considered that the SHAPE ITSELF is what 0029 flags. The
-- lint is REACHABILITY-GATED, and these three functions are the first public-schema,
-- authenticated-callable SECURITY DEFINER functions this schema has ever had. Measured:
-- every other SECURITY DEFINER function in `public` (handle_new_user, seed_project_admin,
-- seed_project_statuses, create_project_counter, resolve_initial_ticket_status and the
-- two project_statuses guards) has EXECUTE revoked from authenticated because they are
-- trigger functions; and the four app_auth definers ARE authenticated-executable but sit
-- in an UNEXPOSED schema, so 0029's /rest/v1/rpc/ condition never holds for them. Nothing
-- in this schema had ever tripped it, so nothing warned that it could.
--
-- ACCEPTED, ON DAVID'S EXPLICIT CALL, 2026-08-21. These three WARNs are the design, not a
-- defect, and there is no option that keeps the feature and silences the lint truthfully:
--
--   * SECURITY INVOKER defeats add_project_member_by_email outright. Resolving an address
--     belonging to someone the admin shares NO project with is the entire reason the
--     function exists, and profiles_read deliberately refuses exactly that (SPRIN-105).
--   * Revoking EXECUTE from authenticated leaves the functions uncallable -- no feature.
--   * Moving the bodies to app_auth behind thin SECURITY INVOKER wrappers in `public`
--     WOULD silence the lint, because it is reachability-gated. It was considered and
--     REJECTED as lint-laundering: the security property is completely unchanged, an
--     authenticated caller still reaches definer-privileged code over REST with one extra
--     hop, and it would collide with the standing rule about adding a fifth app_auth
--     function taking a foreign-id parameter. A clean advisor page bought by making the
--     code less honest is not a trade this repo makes.
--
-- What actually carries the safety here is not the lint's absence but the FIRST STATEMENT
-- of each function: app_auth.is_project_admin, checked before anything is read. Section 1
-- explains why that ordering is the security property.
--
-- SO THE BASELINE MOVES, and this is its first standing exception. A future session
-- comparing against the post-SPRIN-99 figure of 1 security / 8 performance will read
-- three expected WARNs as a regression. The figure to compare against from here is
-- 4 security / 8 performance: 1 leaked-password-protection WARN (pre-existing,
-- unrelated) plus these 3, and 8 unindexed_foreign_keys INFOs (4 on ticket_field_values,
-- 3 on tickets, 1 on project_field_options), with auth_rls_initplan at ZERO. CLAUDE.md
-- carries the same correction.
