-- ============================================================
-- Sprintboard  Phase 1 schema
-- Scope: Scrum only, fixed 4 columns, fixed ticket schema,
--        owner-scoped RLS. Postgres / Supabase.
-- Run in the Supabase SQL editor or as a migration.
-- Parked to Rung 3: kanban, editable columns/workflows,
--        custom fields, teams/roles.
-- ============================================================

-- All or nothing. RLS is enabled ~240 lines below the first CREATE TABLE, so a
-- partial apply is the dangerous outcome: tables exist, `anon` is granted on
-- them, and no policy guards them. The SQL editor wraps a multi-statement query
-- in an implicit transaction, but `psql -f` without --single-transaction does
-- not, and each statement would autocommit. Be explicit.
begin;

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";  -- gen_random_uuid()

-- ============================================================
-- profiles  (mirrors auth.users)
-- ============================================================
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now()
);

-- Auto-create a profile row on signup (runs as definer to bypass RLS at signup).
--
-- search_path is pinned empty because a definer function otherwise inherits the
-- CALLER's search_path, and a role able to create objects in a schema searched
-- first could shadow `profiles`. No such role exists here — anon and
-- authenticated hold CREATE on no schema — so this is defence in depth against a
-- future grant, not a live hole. Every reference below is schema-qualified.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email));
  return new;
end;
$$;

-- A SECURITY DEFINER function in `public` that anon can EXECUTE is worth removing
-- on principle. It was never actually reachable: PostgREST excludes functions
-- returning `trigger` from its RPC schema, and Postgres refuses to call a trigger
-- function directly anyway. (Supabase's linter flags it regardless, and is right
-- to — the grant is pointless.) service_role keeps EXECUTE: it bypasses RLS by
-- design and never ships to the browser.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================
-- projects
-- ============================================================
create table projects (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  key          text not null,
  project_type text not null default 'scrum' check (project_type in ('scrum')),
  created_at   timestamptz not null default now(),
  -- key: first char a letter, total length 2 to 4, uppercase alnum
  constraint projects_key_format check (key ~ '^[A-Z][A-Z0-9]{1,3}$'),
  constraint projects_owner_key_unique unique (owner_id, key)
);

-- ============================================================
-- project_counters  (atomic ticket numbering, one row per project)
-- ============================================================
create table project_counters (
  project_id  uuid primary key references projects(id) on delete cascade,
  last_number int not null default 0
);

-- Create the counter row whenever a project is created
create or replace function create_project_counter()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  insert into public.project_counters (project_id) values (new.id);
  return new;
end;
$$;

create trigger on_project_created
  after insert on projects
  for each row execute function create_project_counter();

-- ============================================================
-- project_statuses  (per-project status vocabulary AND board columns)
-- ============================================================
-- One row = one board column, ordered by `position`. There is deliberately no
-- separate board_columns table: the mapping is 1:1 today, a second table would
-- carry no data, and the Rung 3 split is purely additive when it is wanted.
--
-- OWNER-WRITABLE as of SPRIN-77, but NOT the way every other table is. Clients may
-- SELECT, INSERT and UPDATE (three columns only) — and may NOT DELETE at all. See the
-- policy block at the foot of this file; the split by verb IS the security model here,
-- not an accident of how it was written.
--
-- text + check, never an enum.
create table project_statuses (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,

  -- Stable machine identity, and the fk target for tickets.status. Users rename
  -- `name`, never `slug` — the same division projects.key already uses.
  slug        text not null,

  -- The board column heading.
  name        text not null,

  -- Jira's status category, and the eventual home of the "done is terminal" rule
  -- currently inlined in src/lib/sprints.ts and src/routes/ProjectShell.tsx. The
  -- default is deliberately the NON-terminal middle bucket: a flow that forgets to
  -- set it produces a status not treated as Done, so incomplete tickets return to
  -- the backlog. Fail safe, not fail convenient.
  category    text not null default 'in_progress'
                check (category in ('todo','in_progress','done')),

  -- Board order. Dense 1..N per project.
  position    int  not null,

  -- Where new tickets land. NOT derived from position: under a position-derived
  -- default, dragging Done to the front of the board would silently start creating
  -- tickets in Done. Seeded true on `todo`, which is also tickets.status's column
  -- default — the integration suite asserts those two agree.
  is_initial  boolean not null default false,

  created_at  timestamptz not null default now(),

  constraint project_statuses_slug_format
    check (slug ~ '^[a-z][a-z0-9_]{0,29}$'),
  constraint project_statuses_name_nonempty
    check (btrim(name) <> '' and length(name) <= 40),
  constraint project_statuses_position_positive
    check (position > 0),

  -- The fk target for tickets. NON-deferrable, so it remains a legal fk target and
  -- can still arbitrate ON CONFLICT.
  constraint project_statuses_project_slug_unique
    unique (project_id, slug),

  -- DEFERRABLE so a reorder can swap positions inside ONE statement without a
  -- temporary sentinel. NOTE: a DEFERRABLE constraint cannot be used for ON
  -- CONFLICT inference — upserts must target (project_id, slug).
  constraint project_statuses_project_position_unique
    unique (project_id, position) deferrable initially deferred,

  -- Redundant on its own (id is the PK). Exists so a future board_columns table can
  -- point at a status with a COMPOSITE fk and prove same-project membership —
  -- exactly why sprints_id_project_unique and tickets_id_project_unique exist.
  constraint project_statuses_id_project_unique
    unique (id, project_id)
);

-- At most one initial status per project. Same idiom as sprints_one_active_per_project,
-- and the same limitation: it prevents two, not zero.
create unique index project_statuses_one_initial_per_project
  on project_statuses (project_id) where is_initial;

-- Seed the four default statuses whenever a project is created, by EVERY creation
-- path — the app, the raw fixture inserts in the integration suites, the Playwright
-- E2E, and a human pasting SQL. Only a trigger covers all four, and it fires in the
-- parent's transaction, so "a project with no statuses" is not a reachable state.
--
-- SECURITY DEFINER, following handle_new_user and NOT create_project_counter. That
-- is forced by the select-only policy below: an invoker function's INSERT would be
-- denied. It pays for the privilege the same way — an empty pinned search_path,
-- schema-qualified references, and a revoke. It cannot be abused: it only fires
-- after a projects INSERT that already passed projects_owner's WITH CHECK.
--
-- The four values are inlined rather than shared with the backfill via a helper: a
-- `returns table` function in `public` is published by PostgREST as an anon-callable
-- RPC, and the revoke remedy cannot be applied to a helper a trigger calls.
create or replace function seed_project_statuses()
returns trigger language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.project_statuses
    (project_id, slug, name, category, position, is_initial)
  values
    (new.id, 'todo',        'To Do',       'todo',        1, true),
    (new.id, 'in_progress', 'In Progress', 'in_progress', 2, false),
    (new.id, 'in_review',   'In Review',   'in_progress', 3, false),
    (new.id, 'done',        'Done',        'done',        4, false)
  on conflict (project_id, slug) do nothing;
  return new;
end;
$$;

revoke execute on function public.seed_project_statuses() from public, anon, authenticated;

-- Fires after on_project_created (the counter), in name order. Neither depends on
-- the other; the name states the order rather than stumbling into it.
create trigger on_project_created_statuses
  after insert on projects
  for each row execute function seed_project_statuses();

-- ============================================================
-- sprints
-- ============================================================
create table sprints (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references projects(id) on delete cascade,
  name        text not null,
  goal        text,
  status      text not null default 'future' check (status in ('future','active','complete')),
  start_date  timestamptz,
  end_date    timestamptz,
  created_at  timestamptz not null default now(),

  -- Redundant on its own (id is already the PK). Exists so tickets can point at
  -- a sprint with a COMPOSITE fk and prove it belongs to the same project.
  constraint sprints_id_project_unique unique (id, project_id)
);

-- Phase 1 lean rule: at most one active sprint per project
create unique index sprints_one_active_per_project
  on sprints(project_id) where status = 'active';

-- ============================================================
-- tickets
-- ============================================================
create table tickets (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references projects(id) on delete cascade,
  -- Both are owned by the assign_ticket_key BEFORE INSERT trigger, which always
  -- overwrites them. The defaults exist purely so the column is not "required"
  -- in the generated TypeScript Insert type — without them, the type system
  -- demands a key from the client, which is how you end up generating keys
  -- client-side. The trigger still assigns NULL when the counter update matches
  -- no row (a cross-tenant insert), and NOT NULL then aborts the statement.
  -- That abort is a security property. Do not add a default that hides it.
  number         int  not null default 0,       -- the N in PROJECTKEY-N
  key            text not null default '',      -- e.g. SPB-14
  summary        text not null,
  description    text,
  type           text not null default 'story'
                   check (type in ('epic','story','bug','task')),
  -- Validated by tickets_status_fk below, NOT by a check constraint: the status
  -- vocabulary is per-project, and a CHECK body may not contain a subquery.
  --
  -- The default stays a bare literal. SPRIN-77 made the vocabulary MUTABLE, so the
  -- old justification ("safe while the vocabulary is immutable to clients") no longer
  -- holds and has been replaced by a narrower one: what keeps this safe is that the
  -- `todo` row cannot be REMOVED. There is no DELETE policy on project_statuses, and
  -- `slug` is not in the column-level UPDATE grant — so no client can delete the row
  -- this literal names, nor rename its slug out from under it. Adding a DELETE policy
  -- or granting UPDATE(slug) without also fixing this default would break ticket
  -- creation permanently, for every project it happened to.
  --
  -- SPRIN-80 owns both halves together: is_initial resolution here, and deletion there.
  status         text not null default 'todo',
  assignee_id    uuid references auth.users(id) on delete set null,
  story_points   int,
  acceptance_criteria text,
  labels         text[] not null default '{}',
  sprint_id      uuid,   -- null = backlog.        Composite fk below.
  parent_epic_id uuid,   -- story/bug/task -> epic. Composite fk below.

  -- Epic-only fields: free-text context plus an ordered deliverables list. Originally
  -- added to feed the Rung 2 AI decomposition feature, which was removed in the
  -- 2026-07-29 pivot; the columns are kept as epic documentation in their own right.
  context        text,
  deliverables   jsonb not null default '[]',

  -- Blocked as a synced flag, not a board column.
  is_blocked     boolean not null default false,
  blocked_reason text,
  blocked_since  timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint tickets_project_number_unique unique (project_id, number),

  -- Lets an epic be referenced by a composite fk (see tickets_epic_fk).
  constraint tickets_id_project_unique unique (id, project_id),

  -- Cross-project integrity. A plain fk to sprints(id) would happily let an owner
  -- of two projects park a ticket in the OTHER project's sprint; carrying
  -- project_id into the fk makes that unrepresentable rather than merely
  -- discouraged. sprint_id/parent_epic_id stay nullable: under MATCH SIMPLE a
  -- null in any fk column skips the check, so backlog and epic-less tickets pass.
  --
  -- The column list on `set null` is required, not stylistic: an unqualified
  -- `on delete set null` nulls EVERY fk column, and project_id is not null, so
  -- deleting a sprint would abort. Needs Postgres 15 or newer.
  constraint tickets_sprint_fk foreign key (sprint_id, project_id)
    references sprints (id, project_id) on delete set null (sprint_id),
  constraint tickets_epic_fk foreign key (parent_epic_id, project_id)
    references tickets (id, project_id) on delete set null (parent_epic_id),

  -- The status vocabulary is per-project, so this replaces what used to be a global
  -- check constraint on the column. COMPOSITE, carrying project_id, for the same reason
  -- the two fks above are: it makes "a ticket in project A holding project B's
  -- status" unrepresentable. Both columns are NOT NULL, so MATCH SIMPLE always
  -- checks — there is no null escape hatch here, unlike sprint_id/parent_epic_id.
  --
  -- ON UPDATE NO ACTION, never CASCADE: the referencing column list includes
  -- project_id, so cascading a change to project_statuses.project_id would
  -- propagate into tickets.project_id and silently move tickets between projects.
  --
  -- DEFERRABLE INITIALLY DEFERRED is load-bearing, not tidiness. `delete from
  -- projects` fires one cascade per referencing fk, and each cascade's own
  -- immediate checks fire at the end of its own inner statement — so a
  -- non-deferrable NO ACTION is only safe if the tickets cascade happens to run
  -- first, which is RI trigger name order, i.e. luck. On a fresh apply of THIS
  -- file, project_statuses is created before tickets and so cascades first, which
  -- would raise 23503 and take every integration teardown with it.
  constraint tickets_status_fk foreign key (project_id, status)
    references project_statuses (project_id, slug)
    on update no action on delete no action
    deferrable initially deferred,

  -- The blocked trigger keeps these three aligned, but a trigger is not a
  -- guarantee against a direct write. CLAUDE.md requires both edges.
  constraint tickets_blocked_coherent check (
    (is_blocked     and blocked_reason is not null and blocked_since is not null)
    or
    (not is_blocked and blocked_reason is null     and blocked_since is null)
  )
);

create index tickets_project_idx on tickets(project_id);
create index tickets_sprint_idx  on tickets(sprint_id);
create index tickets_epic_idx    on tickets(parent_epic_id);
-- The referencing side of tickets_status_fk. Every delete of a project_statuses row
-- (including the cascade from a project delete) probes (project_id, status);
-- tickets_project_idx alone does not cover the pair.
create index tickets_project_status_idx on tickets(project_id, status);

-- ============================================================
-- Ticket key generation  (atomic, race-safe)
--
-- Deliberately NOT security definer: it runs as the caller, so the update below
-- is only permitted by the `counters_owner` RLS policy. Atomicity therefore
-- rests on that policy continuing to grant the owner a write. If anyone ever
-- narrows counters_owner to read-only, ticket creation breaks here — that is
-- the intended failure, but it will not be obvious from the error.
-- ============================================================
create or replace function assign_ticket_key()
returns trigger language plpgsql
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

create trigger on_ticket_insert
  before insert on tickets
  for each row execute function assign_ticket_key();

-- ============================================================
-- Ticket key immutability
--
-- assign_ticket_key only fires BEFORE INSERT, so nothing stopped an owner (or a
-- bug) from UPDATE-ing key or number to anything at all, desyncing them from
-- project_counters and destroying the PROJECTKEY-N invariant. RLS does not help:
-- tickets_owner grants the owner FOR ALL over their own rows. Owner-scoped means
-- the damage is self-inflicted, but CLAUDE.md treats the key as an invariant.
--
-- Silently restoring beats raising: a PATCH that includes the whole row (as a
-- naive client will) should not fail merely for echoing the key back unchanged.
-- ============================================================
create or replace function freeze_ticket_key()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.key    := old.key;
  new.number := old.number;
  return new;
end;
$$;

create trigger on_ticket_key_freeze
  before update on tickets
  for each row execute function freeze_ticket_key();

-- ============================================================
-- Blocked flag sync  (keeps the 3 fields aligned deterministically)
-- ============================================================
-- search_path is pinned empty on the trigger functions below too. They touch no
-- tables and now() lives in pg_catalog (always implicitly searched), so an empty
-- path costs nothing and settles the linter.
create or replace function sync_blocked_fields()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if new.is_blocked and not coalesce(old.is_blocked, false) then
    new.blocked_since := now();            -- just became blocked
  elsif not new.is_blocked then
    new.blocked_since  := null;            -- unblocked: clear both
    new.blocked_reason := null;
  end if;
  return new;
end;
$$;

create trigger on_ticket_blocked_change
  before insert or update on tickets
  for each row execute function sync_blocked_fields();

-- ============================================================
-- updated_at maintenance
-- ============================================================
create or replace function set_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tickets_set_updated_at
  before update on tickets
  for each row execute function set_updated_at();

-- ============================================================
-- Row Level Security  (owner-scoped, every table)
-- ============================================================
alter table profiles          enable row level security;
alter table projects          enable row level security;
alter table project_counters  enable row level security;
alter table project_statuses  enable row level security;
alter table sprints           enable row level security;
alter table tickets           enable row level security;

-- profiles: a user sees and edits only their own row
create policy profiles_self on profiles
  for all
  using (id = auth.uid())
  with check (id = auth.uid());

-- projects: owner only
create policy projects_owner on projects
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- project_counters: reachable only via an owned project
create policy counters_owner on project_counters
  for all
  using (exists (select 1 from projects p
                 where p.id = project_counters.project_id
                   and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p
                 where p.id = project_counters.project_id
                   and p.owner_id = auth.uid()));

-- project_statuses: THREE policies, split by verb, and the split IS the security model.
--
-- This is the one table in this file not governed by a single `for all` policy, and the
-- departure is deliberate and load-bearing. tickets.status used to be guarded by a global
-- check constraint, so a client could not invent a status at all. SPRIN-79 replaced that
-- with a per-project vocabulary in a table that ALTER DEFAULT PRIVILEGES already grants
-- anon and authenticated full DML on — which makes these policies the ONLY guard left.
--
-- SPRIN-77 opened writes, and opened exactly two verbs:
--
--   * NO DELETE POLICY, deliberately. An owner deleting the `todo` row would permanently
--     break ticket creation, because tickets.status's default is a bare literal naming it.
--     A DELETE also strands every ticket sitting on the deleted status. SPRIN-80 owns both
--     halves — the delete UI and the is_initial resolution that makes it safe — and until
--     it lands, a DELETE from a client matches no policy, filters to zero rows, and changes
--     nothing. Collapsing these three into one `for all` grants DELETE silently and reopens
--     all of that. `rls.integration.test.ts` goes red if anyone does; that test exists for
--     this exact reason.
--
--   * UPDATE IS COLUMN-RESTRICTED, and the restriction is NOT expressible as a policy.
--     RLS has no access to the OLD row in a WITH CHECK, so "you may change name but not
--     slug" has to be a privilege, not a predicate. See the grant below — and note the
--     shape, because the obvious version of it does nothing at all.
--
-- DO NOT add `force row level security` to this table. It reads as hardening and is the
-- opposite: the seeding trigger is SECURITY DEFINER and runs as the table's owner
-- (postgres), which is exempt from RLS only while FORCE is off. Turn it on and there is no
-- INSERT policy for the trigger to satisfy, so EVERY project creation fails at insert time,
-- for every user. The same trap applies to the other tables here whose triggers are
-- definer-owned.
create policy statuses_owner_read on project_statuses
  for select
  using (exists (select 1 from projects p
                 where p.id = project_statuses.project_id
                   and p.owner_id = auth.uid()));

create policy statuses_owner_insert on project_statuses
  for insert
  with check (exists (select 1 from projects p
                      where p.id = project_statuses.project_id
                        and p.owner_id = auth.uid()));

create policy statuses_owner_update on project_statuses
  for update
  using      (exists (select 1 from projects p
                      where p.id = project_statuses.project_id
                        and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p
                      where p.id = project_statuses.project_id
                        and p.owner_id = auth.uid()));

-- The column restriction, and THE OBVIOUS FORM OF THIS IS A SILENT NO-OP.
--
-- `revoke update (slug) on project_statuses from authenticated` reads correctly and does
-- NOTHING: Postgres does not let a column-level REVOKE carve a hole in a table-level grant,
-- and ALTER DEFAULT PRIVILEGES gave authenticated table-wide `w` (measured: relacl was
-- `authenticated=arwdDxtm/postgres`). The table privilege must be revoked OUTRIGHT and the
-- permitted columns granted back.
--
-- `slug` is excluded because it is the fk target of tickets_status_fk: the fk is keyed on
-- the slug precisely so no ticket row is rewritten when the vocabulary changes, and a
-- movable slug would undo that. `is_initial` is excluded because
-- project_statuses_one_initial_per_project prevents TWO initial statuses but not ZERO, and
-- zero is a state SPRIN-80 must reach deliberately, not one an owner stumbles into.
-- `position` IS granted because reorder_project_statuses below is SECURITY INVOKER and
-- therefore writes that column as the caller.
revoke update on project_statuses from authenticated, anon;
grant  update (name, category, position) on project_statuses to authenticated;

-- AC4's edge. An INDEX rather than a table constraint because the key is an expression and
-- `unique (...)` on a table will not take one. lower(btrim(...)) mirrors
-- project_statuses_name_nonempty, which already btrims: "Done", "done" and " Done " are one
-- name to a user, so they are one name here. Scoped by project_id, so the same name in a
-- DIFFERENT project stays legal — that half of AC4 is as load-bearing as the rejection half.
create unique index project_statuses_project_name_unique
  on project_statuses (project_id, lower(btrim(name)));

-- Reorder, as a function, because project_statuses_project_position_unique is DEFERRABLE
-- INITIALLY DEFERRED and that deferral only helps WITHIN ONE TRANSACTION. PostgREST wraps
-- each request in its own, so N separate `PATCH position=` calls collide on the very first
-- swap — moving row 2 to position 1 violates the constraint against the row already there,
-- with no later statement in that transaction for the deferral to reach. One statement
-- inside one function is the only shape where the deferral does the job it was written for.
--
-- SECURITY INVOKER, not definer: the caller's own rights apply, so statuses_owner_update
-- still governs every row touched and a cross-tenant p_project_id updates nothing. Unlike
-- seed_project_statuses(), this function is not trying to do anything the caller may not
-- do, so it must not be granted the privilege to. The empty pinned search_path travels with
-- it anyway — a public function published as a PostgREST RPC is reachable by any
-- authenticated caller.
--
-- Callers pass the COMPLETE ordered slug list. ordinality assigns dense 1..N; a partial list
-- would leave omitted rows on their old positions and could collide at commit.
create or replace function reorder_project_statuses(p_project_id uuid, p_slugs text[])
returns setof public.project_statuses
language plpgsql
security invoker
set search_path = ''
as $$
begin
  return query
  update public.project_statuses s
     set position = o.ord
    from unnest(p_slugs) with ordinality as o(slug, ord)
   where s.project_id = p_project_id
     and s.slug = o.slug
  returning s.*;
end;
$$;

-- Functions are EXECUTE-to-public by default. Unlike seed_project_statuses() (a TRIGGER
-- function, which needs no EXECUTE at all and so is revoked from everyone), this one is
-- called directly, so authenticated must keep it.
revoke execute on function reorder_project_statuses(uuid, text[]) from public, anon;
grant  execute on function reorder_project_statuses(uuid, text[]) to authenticated;

-- sprints: via owned project
create policy sprints_owner on sprints
  for all
  using (exists (select 1 from projects p
                 where p.id = sprints.project_id
                   and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p
                 where p.id = sprints.project_id
                   and p.owner_id = auth.uid()));

-- tickets: via owned project
create policy tickets_owner on tickets
  for all
  using (exists (select 1 from projects p
                 where p.id = tickets.project_id
                   and p.owner_id = auth.uid()))
  with check (exists (select 1 from projects p
                 where p.id = tickets.project_id
                   and p.owner_id = auth.uid()));

commit;
