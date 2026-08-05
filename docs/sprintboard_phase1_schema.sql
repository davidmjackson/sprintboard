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
  -- SPRIN-81 widened this to include 'kanban' (epic SPRIN-73). Still text + check,
  -- NEVER an enum: widening a check is one line, altering an enum type is not.
  -- Postgres normalises a single-element IN to an equality, so before SPRIN-81 the
  -- live constraint read `CHECK ((project_type = 'scrum'::text))` despite the IN here.
  project_type text not null default 'scrum' check (project_type in ('scrum', 'kanban')),
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
-- OWNER-WRITABLE as of SPRIN-77 and SPRIN-80, but NOT the way every other table is.
-- Clients may SELECT, INSERT, UPDATE (three columns only) and DELETE — FOUR policies,
-- one per verb. See the policy block at the foot of this file; the split by verb IS the
-- security model here, not an accident of how it was written.
--
-- DELETE is bounded by two things that are not policies and cannot be: a project must
-- keep at least one status (project_statuses_delete_guard, below — a statement about
-- SIBLING rows, which no constraint can see), and tickets_status_fk refuses a status
-- that still holds tickets. Those two refusals are the only ones the client models.
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

  -- Where new tickets land, and as of SPRIN-80 that is literal rather than nominal:
  -- resolve_initial_ticket_status() reads this column to fill a new ticket's status, and
  -- tickets.status no longer carries a column default that could disagree with it.
  --
  -- NOT derived from position: under a position-derived default, dragging Done to the
  -- front of the board would silently start creating tickets in Done. Exactly one row per
  -- project carries it — project_statuses_one_initial_per_project prevents TWO, and the
  -- delete guard plus the promotion trigger below are what prevent ZERO.
  is_initial  boolean not null default false,

  -- Soft WIP limit for this board column, NULL meaning no limit (SPRIN-85). Read only for
  -- Kanban projects; a value on a Scrum project's row is inert, and stays inert because
  -- project_type is immutable in the database. A CHECK body may not subquery, so this
  -- column cannot be constrained to Kanban projects — recorded, accepted, and inherited by
  -- any future project-type conversion story.
  --
  -- The limit WARNS, it never blocks. Nothing here refuses a ticket entering an at-limit
  -- status, deliberately: a hard limit would need a trigger on tickets counting sibling
  -- rows, the exact shape that broke the cascade in SPRIN-80, and it would strand work
  -- whenever a limit was lowered below a column's occupancy.
  wip_limit   int,

  created_at  timestamptz not null default now(),

  constraint project_statuses_slug_format
    check (slug ~ '^[a-z][a-z0-9_]{0,29}$'),
  constraint project_statuses_name_nonempty
    check (btrim(name) <> '' and length(name) <= 40),
  constraint project_statuses_position_positive
    check (position > 0),
  constraint project_statuses_wip_limit_positive
    check (wip_limit is null or wip_limit > 0),

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

-- One project's CUSTOM FIELD DEFINITIONS (SPRIN-90, epic SPRIN-71). Applied by
-- docs/migrations/sprin-90-project-fields.sql.
--
-- ADDITIVE, and that is the epic's central rule rather than a preference: core ticket fields
-- stay real columns and only custom ones go in a flexible store, which is what Jira itself
-- does. `tickets` is not reshaped by this table or by any later story in the epic. A future
-- reader will be tempted to "unify" the two; that direction costs query performance, type
-- safety and every existing index.
create table project_fields (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- Stable machine identity; users rename `name`, never this. Same division as
  -- project_statuses.slug and projects.key.
  slug       text not null,

  -- The field's label. The ONLY column authenticated may UPDATE (see the grants below).
  name       text not null,

  -- NEVER an enum, for the same reason as every other vocabulary in this file: widening a
  -- check is one line, altering an enum type is a migration.
  --
  -- IMMUTABLE after insert, enforced by the grant rather than by a trigger. That is not
  -- tidiness: story 3's ticket_field_values carries a DENORMALISED COPY of this value, so
  -- that its "the populated value column matches the field's type" CHECK can be written at
  -- all (a CHECK body may not contain a subquery). The copy is sound only while the original
  -- cannot change. Granting UPDATE on this column would silently re-type existing values.
  type       text not null
               check (type in ('text','paragraph','number','date','select')),

  created_at timestamptz not null default now(),

  constraint project_fields_slug_format
    check (slug ~ '^[a-z][a-z0-9_]{0,29}$'),
  constraint project_fields_name_nonempty
    check (btrim(name) <> '' and length(name) <= 40),

  constraint project_fields_project_slug_unique unique (project_id, slug),

  -- Redundant on their own (id is the PK). They exist so story 3's ticket_field_values can
  -- point at a definition with COMPOSITE fks: (field_id, project_id) makes "a ticket in
  -- project A holding project B's field" unrepresentable, and (field_id, type) is what lets
  -- the value row carry the type copy described above. Same device as
  -- tickets_id_project_unique. Do not drop them as unused before story 3 lands.
  constraint project_fields_id_project_unique unique (id, project_id),
  constraint project_fields_id_type_unique    unique (id, type)
);

-- No separate index on project_id: project_fields_project_slug_unique leads with it, which
-- is what the fk lookup uses. Adding one would be a duplicate index and a new advisor
-- warning. (Verified after applying: get_advisors reported no new lints.)

-- There is deliberately NO `position` column and no ordering UI. Fields sort by
-- (created_at, slug) — `created_at` is the intent, `slug` breaks ties so the sequence is
-- total and stable across reads. A position column with no reorder surface would be
-- created_at with extra machinery; reordering is its own story if ever wanted.

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

-- ------------------------------------------------------------
-- Status deletion guards (SPRIN-80)
-- ------------------------------------------------------------
-- A project must keep at least one status. This is a statement about the SIBLING rows,
-- which no constraint can see, so it has to be a trigger.
--
-- SECURITY DEFINER so the count is of ALL sibling rows rather than the rows the caller's
-- policies happen to expose. Under SPRIN-75's membership model, where read may be broader
-- or narrower than write, an invoker-side count would silently start guarding the wrong
-- thing. SB001 is a custom SQLSTATE rather than the P0001 default so the client keys off
-- a code that cannot be reworded — see deleteError() in src/lib/project-statuses.ts.
create or replace function project_statuses_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- THE CASCADE ESCAPE HATCH, AND IT IS LOAD-BEARING — WITHOUT IT, DELETING A PROJECT
  -- FAILS. `projects` cascades to `project_statuses`, and that cascade is ONE statement
  -- removing every row. This BEFORE ROW trigger fires per row, and a plpgsql SPI query is
  -- not read-only, so it takes a FRESH snapshot with a bumped command id: the siblings
  -- this very statement has already removed are INVISIBLE to the count below. On the last
  -- row the count reads 1 and the guard aborts a delete that was always legitimate.
  --
  -- The parent lookup is the discriminator, and it is exact rather than heuristic: the RI
  -- cascade runs as an AFTER trigger on `projects`, so by the time it reaches here the
  -- project row is already gone. "Keep at least one status" is vacuous for a project that
  -- no longer exists, so returning early is correct on its own terms.
  if not exists (select 1 from public.projects p where p.id = old.project_id) then
    return old;
  end if;

  if (select count(*) from public.project_statuses s
       where s.project_id = old.project_id) <= 1 then
    raise exception 'A project must keep at least one status.'
      using errcode = 'SB001';
  end if;
  return old;
end;
$$;

revoke execute on function public.project_statuses_delete_guard() from public, anon, authenticated;

create trigger project_statuses_delete_guard
  before delete on project_statuses
  for each row execute function project_statuses_delete_guard();

-- Deleting the initial status promotes the lowest-position survivor.
--
-- AFTER, NOT BEFORE, and that is forced rather than stylistic:
-- project_statuses_one_initial_per_project is a PARTIAL unique index, a partial index
-- cannot be a constraint, and only a constraint can be DEFERRABLE. During a BEFORE DELETE
-- the outgoing row still holds is_initial = true, so setting it on another row collides
-- immediately. After the delete there is nothing to collide with.
--
-- The guard above has already run, so a survivor is guaranteed to exist. No cascade escape
-- hatch is needed here: AFTER ROW triggers fire at the END of their statement, so during a
-- project cascade every sibling is already gone and the update touches no rows.
create or replace function project_statuses_promote_initial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_initial then
    update public.project_statuses
       set is_initial = true
     where id = (select s.id from public.project_statuses s
                  where s.project_id = old.project_id
                  order by s.position asc
                  limit 1);
  end if;
  return null;
end;
$$;

revoke execute on function public.project_statuses_promote_initial() from public, anon, authenticated;

create trigger project_statuses_promote_initial
  after delete on project_statuses
  for each row execute function project_statuses_promote_initial();

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
  -- NO COLUMN DEFAULT, AND THAT IS THE POINT (SPRIN-80). It used to default to the bare
  -- literal 'todo', which was safe only while the `todo` row could not be REMOVED. SPRIN-80
  -- opened DELETE on project_statuses, so it removed the default in the same migration —
  -- the two halves were never safe apart, because a NEW project's `todo` holds no tickets
  -- and so is deletable even under the "refuse a non-empty status" rule.
  --
  -- NOT NULL with no default therefore relies on resolve_initial_ticket_status(), a BEFORE
  -- INSERT trigger that fills a NULL status from the project's is_initial row. BEFORE
  -- triggers run ahead of the NOT NULL check, so an insert that omits `status` is filled
  -- rather than rejected; an insert that NAMES one is left alone. Restoring a literal
  -- default here would re-break exactly what that trigger exists to fix.
  status         text not null,
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
-- New ticket status resolution  (SPRIN-80)
--
-- Replaces tickets.status's old bare `default 'todo'`. A BEFORE INSERT trigger fires
-- before the NOT NULL check, so an insert that omits `status` arrives here as NULL and
-- leaves with the project's initial slug; an insert that NAMES a status is left alone.
--
-- SECURITY DEFINER for the same reason as project_statuses_delete_guard(): this read must
-- not depend on statuses_owner_read staying broad enough for whoever is inserting. SB002
-- is the "no initial status" case, which the delete guard and promotion trigger are
-- supposed to make unreachable — it is a loud failure, not a fallback.
-- ============================================================
create or replace function resolve_initial_ticket_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is null then
    select s.slug into new.status
      from public.project_statuses s
     where s.project_id = new.project_id and s.is_initial;

    if new.status is null then
      raise exception 'Project % has no initial status.', new.project_id
        using errcode = 'SB002';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.resolve_initial_ticket_status() from public, anon, authenticated;

create trigger resolve_initial_ticket_status
  before insert on tickets
  for each row execute function resolve_initial_ticket_status();

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
alter table project_fields    enable row level security;
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

-- project_statuses: FOUR policies, split by verb, and the split IS the security model.
--
-- This is the one table in this file not governed by a single `for all` policy, and the
-- departure is deliberate and load-bearing. tickets.status used to be guarded by a global
-- check constraint, so a client could not invent a status at all. SPRIN-79 replaced that
-- with a per-project vocabulary in a table that ALTER DEFAULT PRIVILEGES already grants
-- anon and authenticated full DML on — which makes these policies the ONLY guard left.
--
-- SPRIN-77 opened INSERT and UPDATE; SPRIN-80 opened DELETE. Two of the four carry rules
-- that no policy can express, so do not read the policy list as the whole model:
--
--   * DELETE IS BOUNDED BY TRIGGERS AND A FOREIGN KEY, not by its policy. The policy only
--     answers "is this your project". What stops the damage is tickets_status_fk (a status
--     still holding tickets raises 23503) and project_statuses_delete_guard (the last
--     status of a project raises SB001). SPRIN-80 shipped this policy in the SAME migration
--     that removed tickets.status's bare `default 'todo'`, because either alone is unsafe:
--     the default named a row that had become deletable, and a NEW project's `todo` holds
--     no tickets, so the fk would not have refused it.
--
--   * UPDATE IS COLUMN-RESTRICTED, and the restriction is NOT expressible as a policy.
--     RLS has no access to the OLD row in a WITH CHECK, so "you may change name but not
--     slug" has to be a privilege, not a predicate. See the grant below — and note the
--     shape, because the obvious version of it does nothing at all.
--
-- KEEP THE FOUR APART — BUT NOTHING IN CI WILL TELL YOU IF YOU DO NOT. All four
-- predicates are identical today, so a single `for all` policy is behaviourally
-- indistinguishable through PostgREST: INSERT ignores USING, UPDATE gets both, SELECT and
-- DELETE get USING. The narrowing that genuinely bites is the column UPDATE privilege
-- above, which is not a policy and survives a collapse untouched. An earlier version of
-- this comment claimed `rls.integration.test.ts` goes red on a collapse; it does not, and
-- it cannot — PostgREST has no access to pg_policy. The one pin is the post-state
-- assertion in `docs/migrations/sprin-80-status-deletes.sql`, which runs when a human
-- re-applies that file and NOT on any PR.
--
-- The split is still wanted: SPRIN-75's membership model is where these predicates start
-- to differ per verb (read broader than write), and re-splitting a collapsed policy in the
-- middle of a security rewrite is strictly worse than keeping them apart now.
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

-- `(select auth.uid())`, not the bare `auth.uid()` the three policies above use, and the
-- inconsistency is DELIBERATE. Wrapped in a scalar subquery the call plans as an InitPlan,
-- evaluated once per query instead of once per row, which keeps this policy out of
-- Supabase's auth_rls_initplan advisor. The other eight warnings are pre-existing and are
-- SPRIN-75's to fix together, when every policy here is rewritten to a membership check;
-- SPRIN-80's job was to add none. Do not "make it consistent" in the wrong direction.
create policy statuses_owner_delete on project_statuses
  for delete
  using (exists (select 1 from projects p
                 where p.id = project_statuses.project_id
                   and p.owner_id = (select auth.uid())));

-- ALTER DEFAULT PRIVILEGES already granted both roles table-level DELETE (measured:
-- relacl read `authenticated=ardDxtm`), so the grant is a formality and the REVOKE is the
-- statement that changes something. anon has no policy on this table and no reason to hold
-- the privilege either.
grant  delete on project_statuses to authenticated;
revoke delete on project_statuses from anon;

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
-- project_statuses_one_initial_per_project prevents TWO initial statuses but not ZERO —
-- and since SPRIN-80 made ticket creation RESOLVE against that column, zero is no longer a
-- tidiness problem but a project that cannot create a ticket. Nothing an owner types moves
-- it: it is seeded on `todo` and moved only by project_statuses_promote_initial().
-- `position` IS granted because reorder_project_statuses below is SECURITY INVOKER and
-- therefore writes that column as the caller.
--
-- SPRIN-85 added `wip_limit` to the granted set. THE LIST IS RESTATED IN FULL ON PURPOSE
-- and must stay that way: a table-level REVOKE cascades to column grants ("When revoking
-- privileges on a table, the corresponding column privileges (if any) are automatically
-- revoked on each column of the table, as well" — PostgreSQL REVOKE reference), so a
-- migration that revokes and then grants only the NEW column leaves authenticated able to
-- write that column and nothing else. `src/lib/domain.ts`'s ProjectStatusUpdate mirrors
-- this list and its Exact<> assertion makes widening one without the other a compile error.
revoke update on project_statuses from authenticated, anon;
grant  update (name, category, position, wip_limit) on project_statuses to authenticated;

-- SPRIN-82: `projects` holds NO update privilege at all, and nothing is granted back —
-- because nothing in src/ updates the table (createProject inserts, listProjects selects).
-- This is the SAME statement as the line above with the opposite shape: no column-level
-- grant follows it, so the trap described above does not arise here. It makes SPRIN-81's
-- app-layer "the project type cannot change after creation" a database control, which
-- matters as of SPRIN-82 because hasSprints(project) now decides whether the Sprints tab,
-- the /sprints route and the ticket sprint picker exist. It is NOT a tenant-isolation fix
-- — projects_owner already confined the write to the owner's own row — it stops an owner
-- stranding their own sprints behind a UI that no longer shows them.
--
-- A FUTURE "RENAME A PROJECT" STORY OWES THREE THINGS, and only the first is obvious:
--   1. `grant update (name) on projects to authenticated` — right here.
--   2. Narrow the AST guard in src/test/project-type-immutability.test.ts (check 5) so it
--      inspects an update's payload for project_type instead of forbidding every write to
--      this table. That one blocks the merge, so it cannot be forgotten.
--   3. RESTORE the cross-tenant `projects` UPDATE row-count assertion to
--      src/test/rls.integration.test.ts's "B cannot UPDATE any of it". SPRIN-82 deleted it
--      because the revoke left no UPDATE privilege for RLS to filter — a column grant hands
--      that privilege straight back for `name`, so projects_owner becomes load-bearing again
--      for a verb nothing tests, and "B renames A's project" is a real cross-tenant write.
--      Nothing goes red to ask for this. That is why it is written next to the line that
--      causes it rather than only in the migration file nobody will reopen.
revoke update on projects from authenticated, anon;

-- SPRIN-90: project_fields. Four owner-scoped policies, all written with `(select
-- auth.uid())` rather than the bare call — wrapped in a scalar subquery it plans as an
-- InitPlan, evaluated once per query instead of once per row, which keeps them out of
-- Supabase's auth_rls_initplan advisor. Eight such warnings are outstanding on the older
-- tables above and are SPRIN-75's to fix when every policy is rewritten to a membership
-- check; this table's job was to add ZERO, and it did (verified with get_advisors after
-- applying). Do not "make it consistent" with the bare-call policies — wrong direction.
--
-- DO NOT add `force row level security` here either, for the reason recorded on
-- project_statuses: definer-owned triggers are exempt from RLS only while FORCE is off.
create policy fields_owner_read on project_fields
  for select
  using (exists (select 1 from projects p
                 where p.id = project_fields.project_id
                   and p.owner_id = (select auth.uid())));

create policy fields_owner_insert on project_fields
  for insert
  with check (exists (select 1 from projects p
                      where p.id = project_fields.project_id
                        and p.owner_id = (select auth.uid())));

create policy fields_owner_update on project_fields
  for update
  using      (exists (select 1 from projects p
                      where p.id = project_fields.project_id
                        and p.owner_id = (select auth.uid())))
  with check (exists (select 1 from projects p
                      where p.id = project_fields.project_id
                        and p.owner_id = (select auth.uid())));

create policy fields_owner_delete on project_fields
  for delete
  using (exists (select 1 from projects p
                 where p.id = project_fields.project_id
                   and p.owner_id = (select auth.uid())));

-- THE TABLE WAS BORN WITH FULL CRUD FOR BOTH APP ROLES. Measured from pg_default_acl (not
-- information_schema, whose grant views return zero rows under a read-only role and read
-- exactly like "no privileges"): public tables default to anon=arwdDxtm, authenticated=
-- arwdDxtm. So this revoke is the statement that changes something — "we never granted it"
-- was never true of any table here.
--
-- Story 1 ships no write path, so insert and delete are revoked and NOT granted back;
-- stories 2 and 6 grant them, visibly, and a live test pins the current state so they
-- cannot do it silently. UPDATE(name) alone is granted, which also gives AC4's refusal test
-- a positive control on the same row — without one, a blanket row-level refusal would be
-- indistinguishable from a working column privilege.
--
-- The revoke is TABLE-WIDE with the column granted back afterwards, because the obvious
-- form is a silent no-op (a column-level REVOKE cannot hole a table-level grant) and
-- because a table-level REVOKE **cascades** to column grants. Any later migration widening
-- this set must RESTATE EVERY GRANTED COLUMN, not just add its new one.
revoke insert, update, delete on project_fields from authenticated, anon;
grant  update (name) on project_fields to authenticated;

-- SELECT is deliberately left as the default grant for both roles: authenticated needs it,
-- and anon holding it is filtered to zero rows by the absence of a read policy — the same
-- contract the keepalive cron depends on elsewhere.

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
