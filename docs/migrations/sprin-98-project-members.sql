-- SPRIN-98 -- project_members (epic SPRIN-75, teams and roles, story 1).
--
-- ASCII ONLY. clip.exe transcodes by the console codepage, so a non-ASCII character in
-- this file can arrive in the SQL editor as mojibake. Verify the applied state from the
-- CATALOG afterwards, never from the editor reporting "Success".
--
-- ADDITIVE. This migration changes NO existing policy. The app keeps resolving every
-- permission through projects.owner_id until SPRIN-100, SPRIN-101 and SPRIN-99 flip the
-- predicates. That is deliberate: it makes this diff reviewable on its own.
--
-- ============================================================================
-- STATEMENT ORDER IS LOAD-BEARING -- do not "tidy" it
-- ============================================================================
-- The table is created BEFORE the two app_auth functions that read it, and those
-- functions BEFORE the policies that call them. This looks arbitrary. It is not.
--
-- A `language sql` function body is fully PARSED AND ANALYSED at CREATE time, because
-- check_function_bodies defaults to on. A forward reference to a table that does not yet
-- exist fails the whole migration with:
--
--   ERROR: 42P01: relation "public.project_members" does not exist
--
-- A `language plpgsql` body is only SYNTAX-checked at create time, so the same forward
-- reference would have been accepted and failed later, at first call. That asymmetry is
-- why seed_project_admin (plpgsql, at the foot of this file) may reference the table from
-- anywhere, while these two (sql) may not. The first draft of this migration got this
-- wrong and was rejected by the database.
--
-- ============================================================================
-- WHY THERE IS A SEPARATE SCHEMA AND TWO DEFINER FUNCTIONS
-- ============================================================================
-- A policy on project_members cannot ask "is the caller a member of this project?" by
-- selecting from project_members. Postgres raises:
--
--   infinite recursion detected in policy for relation "project_members"
--
-- Asking through `projects` instead only defers the problem. At SPRIN-101 the projects
-- policy starts checking membership, so project_members -> projects -> project_members
-- becomes MUTUAL recursion, and by then the fix is a much more expensive migration.
--
-- The standard answer is a SECURITY DEFINER function: RLS is not applied to the table
-- references inside it, so the cycle is cut. The only real question is where it lives.
-- NOT in `public`: PostgREST publishes every public function as an RPC, a hazard this
-- schema already records at the seed_project_statuses comment. So: a schema that is not
-- in Supabase's exposed-schema list.
--
-- Both functions consult (select auth.uid()) and NOTHING ELSE, so a caller can only ever
-- learn about THEMSELVES. That property is what makes the definer privilege affordable,
-- and it is load-bearing: adding a user_id parameter to either signature would turn a
-- harmless self-query into an oracle about other people. Do not.

begin;

-- ============================================================================
-- 1. app_auth -- helper schema, deliberately NOT exposed to PostgREST
-- ============================================================================
create schema if not exists app_auth;

-- A new schema grants nothing to anyone by default, but say so explicitly rather than
-- relying on it, then hand `authenticated` the minimum: USAGE, so it can resolve the
-- function names its own RLS policies call. Policy expressions are evaluated as the
-- CALLING role, so without this every query on project_members fails.
revoke all on schema app_auth from public;
grant usage on schema app_auth to authenticated;

-- ============================================================================
-- 2. project_members -- BEFORE the functions that read it (see the note above)
-- ============================================================================
create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,

  -- TEXT plus a CHECK, never a Postgres ENUM. Widening a check is one line; altering an
  -- enum type is a painful migration. CLAUDE.md calls converting these the single most
  -- damaging change anyone could make to this schema. ticket.type, sprint.status and
  -- project_type are all text + check for the same reason.
  role       text not null,
  created_at timestamptz not null default now(),

  primary key (project_id, user_id),

  constraint project_members_role_check check (role in ('admin', 'member'))
);

-- The primary key (project_id, user_id) already covers the project_id foreign key: the
-- advisor's rule is that the fk's column list must be a PREFIX of some index's column
-- list, and (project_id) is a prefix of (project_id, user_id). The user_id fk is NOT
-- covered by anything, so without this index the story would add an
-- unindexed_foreign_keys INFO. It also serves the query every later story wants -- "which
-- projects does this user belong to" -- so it is a real index, not lint appeasement.
create index project_members_user_id_idx on project_members (user_id);

-- ============================================================================
-- 3. The membership predicates -- AFTER the table, BEFORE the policies
-- ============================================================================
-- STABLE, not VOLATILE: the result cannot change within a statement, so the planner may
-- cache it per row-set instead of re-running it per row. This is also why the policies
-- below do not need the (select auth.uid()) wrapper that auth_rls_initplan asks for --
-- the uid read happens once, inside here.
--
-- search_path is pinned empty and every reference is schema-qualified, following
-- handle_new_user and seed_project_statuses: a definer function otherwise inherits the
-- CALLER's search_path, and a role able to create objects in a schema searched first
-- could shadow the table this reads.
create or replace function app_auth.is_project_member(p_project_id uuid)
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
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function app_auth.is_project_admin(p_project_id uuid)
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
      and m.user_id = (select auth.uid())
      and m.role = 'admin'
  );
$$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default. Revoke, then grant back to the
-- one role that needs it. anon is deliberately absent: it holds no privilege on
-- project_members either, so it never reaches a policy that would call these.
revoke execute on function app_auth.is_project_member(uuid) from public;
revoke execute on function app_auth.is_project_admin(uuid) from public;
grant execute on function app_auth.is_project_member(uuid) to authenticated;
grant execute on function app_auth.is_project_admin(uuid) to authenticated;

-- ============================================================================
-- 4. Policies -- AFTER the functions they call
-- ============================================================================
alter table project_members enable row level security;

-- No TO clause, matching every existing policy in this schema. Note the consequence,
-- recorded because it has caused a misdiagnosis before: a policy without TO covers anon
-- as well, so a 42501 on an anon write here has two possible authors. On this table the
-- grants below settle it -- anon holds nothing, so it is refused at the privilege layer
-- before any policy runs.
create policy members_read on project_members
  for select
  using (app_auth.is_project_member(project_members.project_id));

create policy members_admin_insert on project_members
  for insert
  with check (app_auth.is_project_admin(project_members.project_id));

create policy members_admin_update on project_members
  for update
  using      (app_auth.is_project_admin(project_members.project_id))
  with check (app_auth.is_project_admin(project_members.project_id));

create policy members_admin_delete on project_members
  for delete
  using (app_auth.is_project_admin(project_members.project_id));

-- ============================================================================
-- 5. GRANTS
-- ============================================================================
-- The table is BORN with full CRUD for authenticated AND anon. "We never granted it" is
-- not true and never was. The revoke is written TABLE-WIDE and the permitted columns
-- granted back afterwards, because `revoke update (col)` against a table-wide grant is a
-- SILENT NO-OP, while a table-level revoke CASCADES to column grants.
revoke all on project_members from anon;
revoke insert, update, delete on project_members from authenticated;

grant insert (project_id, user_id, role) on project_members to authenticated;

-- UPDATE on `role` ALONE. State the property PRECISELY, because the first draft of this
-- comment overclaimed and the overclaim is the attractive one:
--
--   TRUE:  a single UPDATE statement cannot touch project_id or user_id. A patch
--          touching either earns 42501 at the privilege layer, before any policy runs.
--   FALSE: "a membership row can never be re-pointed at a different user or project".
--          An admin reaches a byte-identical end state with DELETE + INSERT, and both
--          halves are permitted: members_admin_delete's USING and members_admin_insert's
--          WITH CHECK each constrain only the PROJECT, and say nothing about user_id.
--          The live suite's own admin positive control performs exactly that sequence.
--
-- So this grant is a narrowing, not a prohibition. What it actually buys is that the
-- SET-list route is closed, which keeps a single stray patch from silently moving a row.
-- Same technique as SPRIN-92's `grant update (label)`; the difference is that there, no
-- delete-then-insert equivalent existed. Anyone wanting the strong property needs a
-- constraint or trigger, and it is not in this story.
grant update (role) on project_members to authenticated;

-- Postgres has no column-level DELETE, so this is table-wide and members_admin_delete is
-- the only thing in front of it -- which is why a live test proves it.
grant delete on project_members to authenticated;

-- ============================================================================
-- 6. SEEDING -- every project has an admin from the instant it exists
-- ============================================================================
-- SECURITY DEFINER is FORCED, not stylistic. members_admin_insert requires the caller to
-- already be an admin of the project, and at project-creation time nobody is. An invoker
-- function would deadlock the bootstrap exactly as seed_project_statuses would have
-- against the select-only policy on project_statuses.
--
-- It cannot be abused: it fires only AFTER a projects INSERT that already passed
-- projects_owner's WITH CHECK, and it reads new.owner_id -- which that same policy has
-- just constrained to auth.uid().
create or replace function seed_project_admin()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.project_members (project_id, user_id, role)
  values (new.id, new.owner_id, 'admin')
  on conflict (project_id, user_id) do nothing;
  return new;
end;
$$;

revoke execute on function public.seed_project_admin() from public, anon, authenticated;

-- Fires after on_project_created (the counter) and before on_project_created_statuses,
-- in name order. Nothing depends on that ordering; the name states it rather than
-- stumbling into it, matching the existing comment on on_project_created_statuses.
create trigger on_project_created_admin
  after insert on projects
  for each row execute function seed_project_admin();

-- ============================================================================
-- 7. BACKFILL -- exactly one admin row per project that already exists
-- ============================================================================
insert into public.project_members (project_id, user_id, role)
select p.id, p.owner_id, 'admin'
from public.projects p
on conflict (project_id, user_id) do nothing;

-- A post-state check, with a stated limitation: it reads back its own work inside this
-- same transaction, so it proves the statement above ran -- NOT that the constraint holds
-- against anything else. It is a tripwire on a silently-empty backfill, not a test. The
-- live suite is the test.
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
    raise exception 'Backfill incomplete: % project(s) have no admin', projects_without_admin;
  end if;
end;
$$;

commit;

-- ============================================================================
-- AFTER APPLYING
-- ============================================================================
-- ADVISOR DELTA, measured from the catalogue after this migration was applied
-- (2026-08-16). READ ALL THREE READINGS -- the middle one is the trap:
--
--   security:    1 WARN (leaked-password protection) -- UNCHANGED from baseline.
--   performance: 16 -> 17 immediately after apply, then BACK TO 16 within the hour.
--
-- The transient 17th was an `unused_index` INFO on project_members_user_id_idx: a
-- brand-new index that nothing had scanned yet. Running this story's own live suite
-- scanned it, and the INFO cleared on its own. So the NET delta is ZERO and the
-- prediction below was right after all -- but only in the end state. A story that
-- measured once, immediately after applying, would have recorded a permanent finding
-- about a lint with a half-life, and an earlier version of this comment plus a whole
-- CLAUDE.md paragraph did exactly that. MEASURE AGAIN LATER, especially for
-- `unused_index`, which is a statement about traffic and not about schema.
--
-- Both mechanisms this file named did work:
--
--   * NO new unindexed_foreign_keys. project_members_user_id_idx covers the user_id fk,
--     and the pk covers project_id as a prefix. This is the trap SPRIN-88 and SPRIN-92
--     both fell into, avoided here by applying the rule they re-derived: the fk's column
--     list must be a PREFIX of some index's column list.
--   * NO ninth auth_rls_initplan. The four policies call a STABLE function instead of a
--     bare auth.uid(), so the uid read is not re-evaluated per row.
--
-- VERIFIED FROM THE CATALOG, not from the editor reporting "Success":
--   * 4 policies on project_members; relrowsecurity = true; 2 indexes; 1 trigger
--   * both app_auth functions prosecdef = true, provolatile = 's', search_path = ''
--     with proacl {postgres, authenticated} -- PUBLIC revoked
--   * seed_project_admin proacl {postgres, service_role} -- authenticated revoked too
--   * table relacl authenticated=rdDxtm (no `a`, no `w`); anon ABSENT
--   * column attacl project_id=a, user_id=a, role=aw
--   * 3 projects -> 3 admin rows -> 0 projects without an admin
--
-- AND ONE THING THAT WAS LISTED HERE AS EVIDENCE AND IS NOT EVIDENCE. This checklist
-- used to end with "regenerated database.types.ts lists reorder_project_statuses ALONE
-- under Functions, confirming app_auth is genuinely not exposed to PostgREST". That is a
-- NON-SEQUITUR: the type generator emits the `public` schema regardless of what is
-- exposed, so a non-public schema is absent either way. `graphql_public` IS exposed in
-- this project and is likewise absent from that file. The claim is struck rather than
-- deleted because it is the tempting one and someone will re-derive it.
--
-- The real check is live, in project-members.integration.test.ts: a request carrying
-- `Accept-Profile: app_auth` earns 406 / PGRST106 `Invalid schema`. Measured, and
-- measured to DISCRIMINATE -- an exposed non-public schema (`graphql_public`) answers
-- 404 / PGRST205 instead, so the assertion genuinely flips if app_auth is ever added to
-- the exposed list.
