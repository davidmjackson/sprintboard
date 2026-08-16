-- SPRIN-105 -- profiles.email and co-member profile reads (epic SPRIN-75, story 2).
--
-- ASCII ONLY. clip.exe transcodes by the console codepage, so a non-ASCII character in
-- this file can arrive in the SQL editor as mojibake. Verify the applied state from the
-- CATALOG afterwards, never from the editor reporting "Success".
--
-- ============================================================================
-- WHAT THIS WIDENS, STATED PLAINLY
-- ============================================================================
-- Joining a project makes your email address visible to everyone else in that project.
-- That is what Jira does and it is the point of the feature, but it is a real disclosure
-- decision rather than an implementation detail. The boundary this establishes is:
-- profile visibility is CO-MEMBERSHIP and nothing wider. Writes do not widen at all.
--
-- "JOINING" OVERSTATES IT -- READ THIS BEFORE TRUSTING THE SENTENCE ABOVE. Nothing in
-- this schema requires the subject's consent to become a co-member. members_admin_insert
-- constrains only project_id, not user_id, and seed_project_admin makes every project
-- creator an admin of their own project on creation -- so ANY authenticated user can
-- create a project and then INSERT an arbitrary user_id into project_members for it, with
-- no action, consent or notification from that user. Once this migration lands, that
-- insert makes the target's display_name and email readable by every other member of that
-- project. The ONLY reason this is not exploitable today is that nothing in the app
-- exposes a uuid oracle -- there is no search-by-uuid, no listing of every auth.users.id,
-- nothing that hands an attacker a stranger's id to insert. SPRIN-102 ("add member by
-- email") is exactly that oracle in reverse: it is what turns "knows a uuid" into "knows
-- an email address", and it is SPRIN-102, not this migration, that owns the decision of
-- whether adding a member should require that member's consent. Do not read the sentence
-- two paragraphs up as a description of an enforced boundary -- it is a description of
-- the intended, cooperative use of the feature, and the schema does not yet compel it.
--
-- ============================================================================
-- STATEMENT ORDER IS LOAD-BEARING -- do not "tidy" it
-- ============================================================================
-- A `language sql` body is fully PARSED AND ANALYSED at CREATE time, because
-- check_function_bodies defaults to on. shares_project_with is `language sql` and reads
-- public.project_members, so it must come after that table exists (it does -- SPRIN-98).
-- handle_new_user is `language plpgsql` and only syntax-checked, so it may be replaced
-- anywhere. The policies come last, after the function they call.

begin;

-- ============================================================================
-- 1. The column
-- ============================================================================
-- NULLABLE, deliberately. A `not null` would put signup itself behind the constraint:
-- any future auth path without an email (phone, an OAuth provider that withholds it)
-- would fail inside handle_new_user and the user would get no profile row at all. The
-- failure mode of the weaker column is a null; the failure mode of the stronger one is
-- a broken signup.
--
-- This is a SEPARATE MIRROR of auth.users.email, not a reuse of display_name.
-- handle_new_user seeds display_name from new.email as a FALLBACK and display_name stays
-- user-editable through the self policy below -- so it is a display string that merely
-- happens to start life looking like an address. It can NEVER be an identity key.
alter table profiles add column email text;

-- UNIQUE because SPRIN-102 grants membership by exact email, and a unique constraint is
-- what makes `.eq('email', x).single()` honest rather than hopeful. Verified safe against
-- live data before writing this: 9 users, 9 with an email, 9 distinct, 9 distinct under
-- lower(), 9 profile rows.
--
-- Postgres treats NULLs as distinct in a unique index, so any number of email-less
-- profiles coexist. That is why "nullable" and "unique" do not fight each other.
alter table profiles add constraint profiles_email_key unique (email);

-- ============================================================================
-- 2. Backfill
-- ============================================================================
update profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is distinct from u.email;

-- ============================================================================
-- 3. The co-membership predicate
-- ============================================================================
-- READ THIS BEFORE COPYING THE PATTERN. SPRIN-98's migration says of is_project_member
-- and is_project_admin:
--
--   "Both functions consult (select auth.uid()) and NOTHING ELSE, so a caller can only
--    ever learn about THEMSELVES. That property is what makes the definer privilege
--    affordable, and it is load-bearing: adding a user_id parameter to either signature
--    would turn a harmless self-query into an oracle about other people. Do not."
--
-- That warning STANDS and this migration does not touch either signature. What it adds is
-- a THIRD function that does take another user's id, and the parameter is affordable here
-- for a different, weaker, and precisely stateable reason:
--
--   * ONE SIDE OF THE JOIN IS PINNED TO (select auth.uid()). It answers "do I share a
--     project with X". It cannot be made to answer "do X and Y share a project", which is
--     the oracle the warning is about.
--   * ITS ANSWER IS EXACTLY CO-EXTENSIVE WITH THE POLICY THAT CALLS IT. Anything it
--     reveals about X, a select on X's profile row already reveals. No new channel.
--   * IT IS NOT INDEPENDENTLY REACHABLE. app_auth is absent from the exposed-schema list,
--     so PostgREST publishes no RPC for it.
--
-- If a future story wants a predicate WITHOUT those three properties, it is a different
-- decision and needs its own argument. Do not read this function as a precedent for
-- "parameters are fine now".
--
-- STABLE, not VOLATILE, because the result cannot change within a statement -- that
-- volatility marking is correct and stays. Do NOT read it as "the uid read happens once
-- per statement", and do NOT read the two siblings (is_project_member, is_project_admin)
-- as a counter-example either: NONE of the three predicates is hoisted. Every real call
-- site -- shares_project_with(profiles.id) here, and is_project_member(project_members
-- .project_id) / is_project_admin(project_members.project_id) in the SPRIN-98 policies --
-- passes a per-row column reference (a Var) from the very table the policy filters, not a
-- literal. There is no constant-argument call site anywhere in this schema, so Postgres
-- invokes every one of them once per candidate row. Measured with pg_get_userbyid as a
-- stand-in probe: a Var-argument call showed 693 invocations against a multi-row table, a
-- constant-argument call showed 1 -- confirming what a Var argument costs, not showing
-- that any predicate here avoids it.
--
-- What STABLE actually buys: the function is not treated as volatile, so the planner may
-- reuse a result within a scan where the argument repeats, and -- the part that matters
-- for cost -- it lets the (select auth.uid()) inside the body run as an InitPlan evaluated
-- once PER INVOCATION of the function, rather than once per row of the join inside that
-- invocation's own body. It does not buy whole-statement hoisting here, because the
-- argument is never constant.
--
-- The policies below still need no (select auth.uid()) wrapper around THESE calls, and
-- the reason is the SAME one for all three predicates, not a planning story: the
-- auth_rls_initplan advisor matches the literal text `auth.<fn>()` inside a policy
-- expression, and none of these three policy bodies contain that text at all -- each
-- policy calls a function, and auth.uid() appears only inside that function's own
-- already-wrapped body, never in the policy expression the advisor actually scans.
--
-- search_path pinned empty, every reference schema-qualified, matching the two siblings.
create or replace function app_auth.shares_project_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;

-- *** A NEW FUNCTION IN app_auth IS BORN EXECUTE-TO-PUBLIC. *** There are no default
-- privileges on this schema -- SPRIN-98 tried to add them, the editor reported "Success"
-- every time, and pg_default_acl still held zero rows for app_auth afterwards. So the
-- hand-revoke below is the only thing standing between this function and every signed-in
-- user. anon is deliberately absent: it holds USAGE on neither the schema nor, after
-- section 6, anything on profiles.
revoke execute on function app_auth.shares_project_with(uuid) from public;
grant execute on function app_auth.shares_project_with(uuid) to authenticated;

-- ============================================================================
-- 4. handle_new_user -- now mirrors the email as well
-- ============================================================================
-- THREE PROPERTIES MUST SURVIVE THIS EDIT, all load-bearing:
--   1. security definer -- the insert happens before the user can authenticate, so RLS
--      must not apply.
--   2. set search_path = '' with every reference schema-qualified -- a definer function
--      otherwise inherits the CALLER's search_path, and a role able to create objects in
--      a schema searched first could shadow public.profiles.
--   3. the explicit revoke below.
--
-- display_name keeps its coalesce(..., new.email) fallback UNCHANGED. The two columns
-- diverge from the same source on purpose: one is editable, one is not.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email), new.email);
  return new;
end;
$$;

-- create or replace PRESERVES the existing ACL, so this is belt-and-braces rather than
-- strictly required. State it anyway: the cost of being wrong about that is a SECURITY
-- DEFINER function callable by anyone.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ============================================================================
-- 5. Policies -- one `for all` becomes four, split by verb
-- ============================================================================
-- The split PRESERVES CURRENT WRITE BEHAVIOUR VERB FOR VERB. `for all` covers all four
-- verbs, so writing them out separately narrows nothing. In particular self-DELETE stays
-- permitted: it is a pre-existing footgun (delete your profile row and handle_new_user
-- will not rebuild it, because it fires on auth.users INSERT alone), but narrowing it
-- would be a scope change smuggled in under a widening story. Left as found.
--
-- No TO clause, matching every other policy in this schema. The consequence, recorded
-- because it has caused a misdiagnosis before: a policy without TO covers anon as well,
-- so a 42501 on an anonymous request has two possible authors. Section 6 settles it on
-- this table -- anon holds nothing, so it is refused at the privilege layer before any
-- policy runs.
--
-- (select auth.uid()), not bare auth.uid(): profiles_self is currently one of the eight
-- auth_rls_initplan WARNs, and rewriting it in the wrapped form clears that one for free
-- since the policy is being rewritten anyway. The sweep across the remaining tables still
-- belongs to SPRIN-75, not here.
drop policy profiles_self on profiles;

create policy profiles_read on profiles
  for select
  using (id = (select auth.uid()) or app_auth.shares_project_with(profiles.id));

create policy profiles_self_insert on profiles
  for insert
  with check (id = (select auth.uid()));

create policy profiles_self_update on profiles
  for update
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy profiles_self_delete on profiles
  for delete
  using (id = (select auth.uid()));

-- ============================================================================
-- 6. GRANTS
-- ============================================================================
-- Measured from the catalog before this migration: profiles.relacl was
--   {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--    authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
-- -- anon held FULL CRUD. The table was BORN that way; nobody granted it deliberately.
-- That is survivable while the table holds a display name. It is not what we want
-- standing alone in front of a column of email addresses.
--
-- This changes nothing observable: anon already saw zero rows, because id = auth.uid() is
-- id = null for an anonymous caller, which is null, which filters everything. What
-- changes is the FAILURE SHAPE, and a test must pick the right one -- a privilege refusal
-- is 42501 with data === null, whereas an RLS filter is error: null, data: [].
--
-- Table-wide, not column-level: `revoke ... (col)` against a table-wide grant is a SILENT
-- NO-OP, while a table-level revoke cascades. Same reasoning as SPRIN-98.
revoke all on profiles from anon;

-- ============================================================================
-- 7. Post-state tripwire
-- ============================================================================
-- STATED LIMITATION: this reads back its own work inside this same transaction, so it
-- proves the backfill statement RAN -- not that the property holds against anything else.
-- It is a tripwire on a silently-empty backfill, not a test. The live suite is the test.
do $$
declare
  unmirrored int;
begin
  select count(*) into unmirrored
  from public.profiles p
  join auth.users u on u.id = p.id
  where u.email is not null
    and p.email is distinct from u.email;

  if unmirrored > 0 then
    raise exception 'Backfill incomplete: % profile(s) do not mirror auth.users.email', unmirrored;
  end if;
end;
$$;

commit;

-- ============================================================================
-- AFTER APPLYING -- verify from the CATALOG, not from "Success"
-- ============================================================================
-- Expected end state:
--   * profiles has 4 columns; email is nullable with a unique constraint
--     profiles_email_key
--   * 4 policies on profiles: profiles_read (SELECT), profiles_self_insert (INSERT),
--     profiles_self_update (UPDATE), profiles_self_delete (DELETE); profiles_self GONE
--   * profiles relacl: anon ABSENT; authenticated=arwdDxtm; no column-level acls
--   * app_auth.shares_project_with: prosecdef = true, provolatile = 's',
--     search_path = '', proacl {postgres, authenticated} -- PUBLIC revoked
--   * handle_new_user: prosecdef = true, search_path = '',
--     proacl {postgres, service_role}
--   * zero profiles whose email does not mirror auth.users
--
-- ADVISORS. Baseline before this story, measured 2026-08-16: 16 performance, 1 security.
-- Predicted after: 15 performance (the profiles_self auth_rls_initplan WARN clears),
-- 1 security (unchanged).
--
-- EXPECT A TRANSIENT 16th: an unused_index INFO on profiles_email_key. unused_index is a
-- statement about TRAFFIC, not about schema -- a brand-new index earns one until
-- something scans it. SPRIN-98 recorded exactly this and watched it clear within the hour
-- once its own suite ran. MEASURE AGAIN LATER. Do not write a first reading into
-- CLAUDE.md as a standing decision; that is the mistake SPRIN-98 made two paragraphs
-- below its own warning about it.
