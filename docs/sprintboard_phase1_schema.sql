-- ============================================================
-- Sprintboard  Phase 1 schema
-- Scope: Scrum only, fixed 4 columns, fixed ticket schema,
--        owner-scoped RLS. Postgres / Supabase.
-- Run in the Supabase SQL editor or as a migration.
-- Parked to Rung 3: kanban, editable columns/workflows,
--        custom fields, teams/roles.
-- ============================================================

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

-- Auto-create a profile row on signup (runs as definer to bypass RLS at signup)
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email));
  return new;
end;
$$;

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
returns trigger language plpgsql as $$
begin
  insert into project_counters (project_id) values (new.id);
  return new;
end;
$$;

create trigger on_project_created
  after insert on projects
  for each row execute function create_project_counter();

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
  created_at  timestamptz not null default now()
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
  number         int  not null,                 -- the N in PROJECTKEY-N
  key            text not null,                 -- e.g. SPB-14
  summary        text not null,
  description    text,
  type           text not null default 'story'
                   check (type in ('epic','story','bug','task')),
  status         text not null default 'todo'
                   check (status in ('todo','in_progress','in_review','done')),
  assignee_id    uuid references auth.users(id) on delete set null,
  story_points   int,
  acceptance_criteria text,
  labels         text[] not null default '{}',
  sprint_id      uuid references sprints(id) on delete set null,   -- null = backlog
  parent_epic_id uuid references tickets(id)  on delete set null,  -- story/bug/task -> epic

  -- Epic-only fields. Feed the Rung 2 AI decomposition feature.
  context        text,
  deliverables   jsonb not null default '[]',

  -- Blocked as a synced flag, not a board column.
  is_blocked     boolean not null default false,
  blocked_reason text,
  blocked_since  timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint tickets_project_number_unique unique (project_id, number)
);

create index tickets_project_idx on tickets(project_id);
create index tickets_sprint_idx  on tickets(sprint_id);
create index tickets_epic_idx    on tickets(parent_epic_id);

-- ============================================================
-- Ticket key generation  (atomic, race-safe)
-- ============================================================
create or replace function assign_ticket_key()
returns trigger language plpgsql as $$
declare
  v_key text;
  v_num int;
begin
  -- Atomic increment under row lock. Concurrent inserts serialise here.
  update project_counters
     set last_number = last_number + 1
   where project_id = new.project_id
   returning last_number into v_num;

  select key into v_key from projects where id = new.project_id;

  new.number := v_num;
  new.key    := v_key || '-' || v_num;
  return new;
end;
$$;

create trigger on_ticket_insert
  before insert on tickets
  for each row execute function assign_ticket_key();

-- ============================================================
-- Blocked flag sync  (keeps the 3 fields aligned deterministically)
-- ============================================================
create or replace function sync_blocked_fields()
returns trigger language plpgsql as $$
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
returns trigger language plpgsql as $$
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
alter table profiles         enable row level security;
alter table projects         enable row level security;
alter table project_counters enable row level security;
alter table sprints          enable row level security;
alter table tickets          enable row level security;

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
