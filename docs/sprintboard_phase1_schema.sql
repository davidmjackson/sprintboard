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
-- COLUMN ORDER HERE MATCHES THE LIVE TABLE, and it differs from a plain read of this
-- CREATE TABLE because it isn't how the table was actually built. `email` was added by
-- SPRIN-105's migration as `alter table profiles add column email text`, well after this
-- table (and created_at) already existed, so Postgres appended it physically at the end
-- rather than in whatever position a fresh CREATE TABLE would suggest. The live order is
-- id, display_name, created_at, email -- reproduced below rather than the SELECT-ordinal
-- order a from-scratch script would naturally produce. Harmless: PostgREST returns rows
-- as objects, not positional tuples, so no client code depends on this order. It matters
-- only if this file is ever replayed against a fresh database, where it would recreate a
-- schema-identical but column-order-different table -- worth knowing, not worth fixing.
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at   timestamptz not null default now(),
  -- SPRIN-105 — a SEPARATE MIRROR of auth.users.email, not a reuse of
  -- display_name. Nullable, deliberately: a `not null` would put signup itself
  -- behind the constraint (a future auth path without an email would fail inside
  -- handle_new_user and the user would get no profile row at all). Unique,
  -- because SPRIN-102 grants project membership by exact email and a unique
  -- constraint is what makes `.eq('email', x).single()` honest rather than
  -- hopeful — Postgres treats NULLs as distinct in a unique index, so any number
  -- of email-less profiles still coexist. display_name stays user-editable and
  -- keeps its own coalesce(..., new.email) fallback below; email never is — it
  -- can never become an identity key that a user can quietly change.
  email        text unique
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
  -- SPRIN-105 — email added alongside display_name. The two columns diverge from
  -- the same source on purpose: display_name is editable, email is not.
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email), new.email);
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
  -- SPRIN-94: sprint cadence. int + CHECK, never an enum, same reasoning as
  -- project_type above. Not null with defaults: every project has a cadence,
  -- including Kanban projects that never read one.
  sprint_length_weeks  int not null default 2,
  sprint_start_weekday int not null default 1,
  -- key: first char a letter, total length 2 to 4, uppercase alnum
  constraint projects_key_format check (key ~ '^[A-Z][A-Z0-9]{1,3}$'),
  constraint projects_owner_key_unique unique (owner_id, key),
  -- SPRIN-94: named because the live tests assert the names.
  constraint projects_sprint_length_weeks_range check (sprint_length_weeks between 1 and 4),
  constraint projects_sprint_start_weekday_range check (sprint_start_weekday between 1 and 7)
);

-- ============================================================
-- project_counters  (atomic ticket numbering, one row per project)
-- ============================================================
create table project_counters (
  project_id  uuid primary key references projects(id) on delete cascade,
  last_number int not null default 0
);

-- Create the counter row whenever a project is created.
--
-- SUPERSEDED BY SPRIN-100, at the foot of this file, which re-declares this
-- function as SECURITY DEFINER. On a fresh apply the later definition wins; this
-- one is left in place because the table and its trigger belong here and the
-- redeclaration cannot move earlier — the reason it became definer is that
-- counters_owner now resolves through app_auth, which does not exist yet at this
-- point in the file. Read the SPRIN-100 section for why, and do not "fix" the
-- duplication by deleting either copy.
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

-- ---------------------------------------------------------------------------
-- ticket_field_values (SPRIN-88, epic SPRIN-71 story 3)
--
-- One ticket's value for one custom field. ADDITIVE: `tickets` is not reshaped, so system
-- fields stay real columns and only custom ones live here — what Jira itself does.
--
-- Full rationale (the grant argument, the RLS policies, the index decision) lives in
-- docs/migrations/sprin-88-ticket-field-values.sql. Recorded here because CLAUDE.md points at
-- THIS file as "the database schema", and the composite-fk shapes below are what the epic's
-- whole tenancy argument rests on — a reader who only finds the forward references above
-- would have to reconstruct them.
-- ---------------------------------------------------------------------------
create table ticket_field_values (
  ticket_id    uuid not null,
  project_id   uuid not null,
  field_id     uuid not null,

  -- A DENORMALISED COPY of project_fields.type, held so the CHECK below can be written at all
  -- (a CHECK body may not contain a subquery). Sound only because project_fields.type is
  -- immutable by grant — see the note on that column above.
  field_type   text not null,

  -- One column per primitive rather than a jsonb blob or a text column cast on read: both
  -- alternatives give up the database's own type checking, and "2026-13-45" stores fine in text.
  value_text   text,
  value_number numeric,
  value_date   date,
  value_option text,

  primary key (ticket_id, field_id),

  -- CROSS-TENANT INTEGRITY. Both carry project_id, so "a ticket in project A holding project
  -- B's field" is unrepresentable. NOTE (established by review): RLS on this table reads ONLY
  -- project_id, so ticket_id/field_id/field_type are governed by these fks ALONE — including
  -- against another tenant. Do not narrow them to single columns during the SPRIN-75 membership
  -- rewrite; that would leave three identity columns with no cross-tenant control.
  constraint tfv_ticket_fk foreign key (ticket_id, project_id)
    references tickets (id, project_id) on delete cascade,
  constraint tfv_field_fk foreign key (field_id, project_id)
    references project_fields (id, project_id) on delete cascade,

  -- SPRIN-92. AC2 and AC4 in one constraint: ON DELETE CASCADE clears a ticket's value
  -- the moment the option it points at is deleted, rather than stranding it (the default
  -- `no action` would refuse the option delete with 23503 instead). In the real,
  -- hand-applied migration this arrived as a separate ALTER TABLE, because
  -- project_field_options did not exist yet when THIS table was first created
  -- (SPRIN-88) — it is written inline here, forward-referencing project_field_options
  -- below, to represent final cumulative state, matching how tfv_ticket_fk above already
  -- forward-references `tickets`, defined later in this same file.
  constraint tfv_option_fk foreign key (field_id, value_option)
    references project_field_options (field_id, slug) on delete cascade,

  -- Keeps the denormalised copy equal to the definition's. ON DELETE CASCADE matches
  -- tfv_field_fk deliberately: two fks to one table with different delete actions resolve in
  -- RI trigger name order, i.e. luck.
  constraint tfv_type_fk foreign key (field_id, field_type)
    references project_fields (id, type)
    on update no action on delete cascade,

  -- Exactly one value column populated, and it is the one the type calls for. `else false`
  -- means a sixth field type stores NOTHING until this constraint is edited — the intended
  -- failure. "No value" is the ABSENCE of the row, never a row of nulls, which is why clearing
  -- a field deletes it.
  constraint tfv_one_value_matching_type check (
    case field_type
      when 'text'      then value_text   is not null and value_number is null
                            and value_date is null and value_option is null
      when 'paragraph' then value_text   is not null and value_number is null
                            and value_date is null and value_option is null
      when 'number'    then value_number is not null and value_text is null
                            and value_date is null and value_option is null
      when 'date'      then value_date   is not null and value_text is null
                            and value_number is null and value_option is null
      when 'select'    then value_option is not null and value_text is null
                            and value_number is null and value_date is null
      else false
    end
  )
);

-- Serves the field-delete cascade and story 6's count-by-field_id. The ticket-delete cascade
-- is already served by the PK's leading column. Three unindexed-fk INFOs are ACCEPTED here:
-- every lookup a cascade performs is covered, and what goes unsatisfied is the advisor's
-- prefix rule rather than any query — project_id in those composite fks is a tenancy column,
-- not a selectivity one.
create index ticket_field_values_field_id_idx on ticket_field_values (field_id);

-- ---------------------------------------------------------------------------
-- project_field_options (SPRIN-92, epic SPRIN-71 story 5)
--
-- One option of one 'select' custom field. ADDITIVE: touches no existing table's shape
-- except the one new fk below on ticket_field_values.
--
-- Carries `project_id`, departing from the epic design's §3.3, because every
-- ProjectShell read is `useTaggedRead(projectId, nonce, fn)` and a list function must
-- be `(projectId) => Promise<T[]>` — an embedded join or a second query fed by the
-- fields list would both be the "new plumbing" the epic's own §4.4 forbids.
--
-- Full rationale (the grant argument, the advisor delta) lives in
-- docs/migrations/sprin-92-project-field-options.sql.
-- ---------------------------------------------------------------------------
create table project_field_options (
  project_id uuid not null,
  field_id   uuid not null,
  slug       text not null,
  label      text not null,
  position   int  not null,

  -- Keyed on SLUG rather than a surrogate id, so renaming a LABEL rewrites no value
  -- row. Same reasoning that keyed tickets_status_fk on (project_id, slug) in SPRIN-79.
  primary key (field_id, slug),

  constraint pfo_field_fk foreign key (field_id, project_id)
    references project_fields (id, project_id) on delete cascade,

  constraint pfo_slug_format check (slug ~ '^[a-z][a-z0-9_]{0,29}$'),
  constraint pfo_label_nonempty check (btrim(label) <> '' and length(label) <= 40),
  constraint pfo_position_positive check (position > 0)
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
-- SECURITY DEFINER, following handle_new_user. That is forced by the select-only
-- policy below: an invoker function's INSERT would be denied.
--
-- CORRECTED at SPRIN-100: this sentence used to read "and NOT
-- create_project_counter", contrasting the two. That contrast no longer exists —
-- SPRIN-100 made create_project_counter definer too, for a closely related
-- reason (it fires before the membership row that would authorise its insert).
-- All three of this table's AFTER INSERT triggers are now definer. It pays for the privilege the same way — an empty pinned search_path,
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
  constraint sprints_id_project_unique unique (id, project_id),
  -- SPRIN-95: a sprint may not end before it starts, mirroring the zod refine in
  -- src/lib/sprint-schemas.ts so the rule holds at both edges. `>=`, so a one-day
  -- sprint is legal. NO null guard is needed and none is wanted: the expression is
  -- NULL when either side is, and a CHECK passes on NULL, so a half-dated sprint
  -- stays legal. A `::date` variant is impossible — the timestamptz->date cast is
  -- STABLE and a CHECK may not contain a non-IMMUTABLE expression; both columns are
  -- written at UTC midnight by toUtcMidnight, so instant order and calendar-day
  -- order coincide anyway. Named because the live tests assert the name.
  constraint sprints_end_not_before_start check (end_date >= start_date)
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
  -- client-side.
  --
  -- CORRECTED AT SPRIN-100b, and this one mattered: these lines used to end
  -- "the trigger still assigns NULL when the counter update matches no row (a
  -- cross-tenant insert), and NOT NULL then aborts the statement. That abort is
  -- a security property. Do not add a default that hides it." The abort no
  -- longer happens. assign_ticket_key is SECURITY DEFINER, and project_counters
  -- is owned by postgres with relforcerowsecurity = false, so the counter update
  -- matches for ANY caller and `number` is never NULL on this path. The security
  -- property that remains is tickets_owner's WITH CHECK, which refuses the row
  -- before the constraint layer is reached. Instructing a future reader to
  -- preserve a deleted control is worse than saying nothing, which is why this
  -- says what actually holds instead.
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
-- SECURITY DEFINER since SPRIN-100b. This comment used to say the opposite —
-- "deliberately NOT security definer", so that the counter update below stayed
-- permitted only by `counters_owner`, making a mistake in that policy break
-- ticket creation loudly. That was a TRIPWIRE rather than a boundary, and
-- SPRIN-100b knowingly gave it up. Nothing replaces it. Do not restore the
-- sentence without restoring the invoker, and do not restore the invoker without
-- reading why it changed.
--
-- WHY IT HAD TO CHANGE, and the general trap: this function READS `projects` as
-- well as writing `project_counters`. Once SPRIN-100 made the board tables
-- resolve to membership, a member could update the counter but the
-- `select key into v_key from public.projects` below returned ZERO ROWS, because
-- `projects_owner` is still `owner_id = auth.uid()` and remains SPRIN-101's to
-- change. v_key was NULL, so the key was NULL, and the NOT NULL aborted every
-- member's ticket creation with 23502. A SECURITY INVOKER trigger has a hidden
-- dependency on every table it reads, not only the ones it writes.
--
-- The boundary that actually stops a stranger is unchanged and is NOT this
-- function: `tickets_owner`'s WITH CHECK is evaluated after BEFORE-triggers run,
-- so a stranger's insert is refused and this trigger's counter increment rolls
-- back with the statement. board-membership.integration.test.ts asserts both
-- halves.
--
-- FOR SPRIN-101: when `projects` SELECT resolves to membership, the reason for
-- this definer disappears and reverting it would restore the tripwire. Make that
-- a decision rather than an inheritance. See
-- docs/migrations/sprin-100b-ticket-key-definer.sql for the full argument.
-- ============================================================
create or replace function assign_ticket_key()
returns trigger language plpgsql
security definer set search_path = ''
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

-- A definer function must not keep an EXECUTE grant it does not need, and this one
-- needs none: Postgres checks EXECUTE on a trigger function at CREATE TRIGGER time,
-- not on each fire, so revoking it does not stop the trigger. Same shape as
-- create_project_counter, seed_project_admin and seed_project_statuses.
--
-- AFTER the create trigger above, deliberately, and matching every sibling. Because
-- the check happens at CREATE TRIGGER time, revoking first is harmless only while
-- this file is applied as the function's owner. Any other role would fail on the
-- trigger it just lost the privilege to create.
revoke execute on function assign_ticket_key() from public, anon, authenticated;

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
-- tickets_owner grants FOR ALL over every row the caller can reach.
--
-- "Owner-scoped means the damage is self-inflicted" was the rest of this sentence
-- until SPRIN-100, and it is no longer true — tickets_owner resolves to MEMBERSHIP,
-- so the rows in reach include other people's work in a shared project. The control
-- itself (this trigger) is unchanged and still holds; only the reason it seemed
-- unimportant has rotted. Note what the trigger does NOT pin: `project_id`. See the
-- reparent follow-up in docs/HANDOVER.md.
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
alter table ticket_field_values enable row level security;
alter table project_field_options enable row level security;
alter table sprints           enable row level security;
alter table tickets           enable row level security;

-- profiles: SPRIN-105 replaces the single self-only policy below with four
-- verb-split policies, widening SELECT to co-members and leaving every write
-- self-only. The replacement statements live in the SPRIN-105 section near the
-- foot of this file, after app_auth and project_members (SPRIN-98) exist --
-- profiles_read calls app_auth.shares_project_with, which reads
-- project_members, so it cannot be declared this early without a forward
-- reference. RLS on profiles is enabled above (with every other table); between
-- here and that section a fresh run of this file has no policy on profiles at
-- all, which is fail-closed and therefore safe, not a gap.

-- projects: owner only
create policy projects_owner on projects
  for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- project_counters: MOVED. SPRIN-100 rewrote counters_owner from ownership to
-- membership, so it now calls app_auth.is_project_member and cannot be declared
-- this early -- app_auth and project_members do not exist until the SPRIN-98
-- section at the foot of this file. Same forward-reference reasoning as
-- profiles_read above. The live definition is in the SPRIN-100 section at the
-- foot. Between here and there a fresh run of this file has no policy on
-- project_counters, which is fail-closed and therefore safe, not a gap.

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

-- SPRIN-82: the TABLE-level update privilege on `projects` is revoked outright, and until
-- SPRIN-97 nothing was granted back — because nothing in src/ updated the table
-- (createProject inserts, listProjects selects). The revoke is table-wide for the reason
-- spelled out above the project_statuses pair: a column-level REVOKE cannot carve a hole in
-- a table-level grant, so the table privilege has to go outright. It makes SPRIN-81's
-- app-layer "the project type cannot
-- change after creation" a database control, which matters as of SPRIN-82 because
-- hasSprints(project) now decides whether the Sprints tab, the /sprints route and the ticket
-- sprint picker exist. It is NOT a tenant-isolation fix — projects_owner already confined the
-- write to the owner's own row — it stops an owner stranding their own sprints behind a UI
-- that no longer shows them.
--
-- SPRIN-97 IS THE STORY THAT FIRST NEEDED A COLUMN BACK, and it paid all three of the debts
-- recorded here. The list is kept rather than deleted, because items 1 and 2 are owed again
-- by the next story that widens the writable set — and because item 3 was recorded WRONG, in
-- a way that would have shipped a test passing for the wrong reason.
--   1. `grant update (<col>) on projects to authenticated` — the line below the revoke.
--      SPRIN-97 grants sprint_length_weeks and sprint_start_weekday and nothing else, so
--      name, key and project_type stay immutable in the DATABASE and not merely in our code.
--      ⚠ A story widening the set must ADD its column to that grant (or add a second bare
--      `grant update (<new>)`). It must NOT copy the revoke-then-restate shape used on
--      project_statuses and project_fields above: a table-level revoke CASCADES to column
--      grants, so `revoke update on projects …; grant update (name) …` would silently strip
--      the two cadence columns and break the Settings cadence form with a 42501.
--   2. Narrow the AST guard in src/test/project-type-immutability.test.ts (check 5) so it
--      inspects an update's payload instead of forbidding every write to this table. That one
--      blocks the merge, so it cannot be forgotten. SPRIN-97 turned check 5 into a fail-closed
--      allowlist keyed on SPRINT_CADENCE_COLUMNS in src/lib/domain.ts — a payload whose keys
--      cannot be read statically is a FAILURE there, not a pass. Widening the grant therefore
--      means widening that constant too, in the same commit.
--   3. RESTORE the cross-tenant `projects` UPDATE row-count assertion to
--      src/test/rls.integration.test.ts's "B cannot UPDATE any of it". SPRIN-82 deleted it
--      because the revoke left no UPDATE privilege for RLS to filter; a column grant hands
--      that privilege back, so projects_owner is load-bearing again for a verb nothing tested.
--      SPRIN-97 restored it — but NOT in the shape this note originally prescribed.
--
--      ⚠ THIS NOTE USED TO SAY "bring it back as `.update({ name: 'pwned' })`". THAT WAS
--      WRONG, not merely out of date. It was written anticipating a RENAME story, which would
--      grant `name`. SPRIN-97 grants only the two cadence columns, so `name` is still revoked
--      and that update is refused by the PRIVILEGE before any policy is consulted: 42501 with
--      `data === null`, never the `[]` the assertion expects. It would simply fail — and the
--      tempting repair, asserting the error code instead, reproduces the exact defect the
--      deletion argued against: the line would then pass off the GRANT, so dropping
--      projects_owner would no longer redden it, and the assertion could no longer tell you
--      which of the two controls was holding.
--
--      THE RULE, so the next widening story gets it right first time: write a cross-tenant
--      row-count assertion on a column the calling role HAS been granted. Only a granted
--      column lets the UPDATE reach the policy at all, and RLS FILTERS on USING rather than
--      raising — so zero rows is evidence about RLS only once the privilege layer has already
--      been satisfied. On an ungranted column the same `[]` is unreachable, and any assertion
--      you can make instead is an assertion about the grant.
--
--      SPRIN-97 used `.update({ sprint_length_weeks: 4 })` — 4, not the default 2, so a no-op
--      update cannot be mistaken for a filtered one — asserting `[]`, paired with a re-read as
--      A proving the value is unchanged. `[]` alone is satisfied both by a write that matched
--      nothing and by one whose `.select()` was filtered afterwards; the row count plus the
--      unchanged value is the pair that tells them apart.
revoke update on projects from authenticated, anon;

-- SPRIN-97: the first columns ever granted back on this table (migration
-- docs/migrations/sprin-97-project-cadence-update.sql). COLUMN-level UPDATE only — no
-- table-level `w` is restored for either client role, which is precisely what keeps name,
-- key and project_type unwritable in the database while the Settings cadence form works.
-- Measured before applying: projects.attacl was EMPTY, so this creates the table's first
-- column ACL rather than widening one. src/lib/domain.ts's SPRINT_CADENCE_COLUMNS mirrors
-- this list on the client side and the AST guard reads it; keep the three in step.
grant update (sprint_length_weeks, sprint_start_weekday) on projects to authenticated;

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

-- ticket_field_values (SPRIN-88). Owner-scoped through `projects`, like every table above,
-- and all four written `(select auth.uid())` so this table adds ZERO auth_rls_initplan
-- warnings to the eight the older tables carry.
--
-- **These policies read `project_id` AND NOTHING ELSE**, which is the fact worth carrying
-- forward. `ticket_id`, `field_id` and `field_type` are invisible to RLS and are governed by
-- the composite foreign keys alone — including against another tenant. Establishing that cost
-- a CI failure and a security review. When SPRIN-75 rewrites these to a membership check, do
-- NOT narrow those fks to single columns on the theory that "RLS handles tenancy": it handles
-- exactly one of the four identity columns.
create policy tfv_owner_read on ticket_field_values
  for select
  using (exists (select 1 from projects p
                 where p.id = ticket_field_values.project_id
                   and p.owner_id = (select auth.uid())));

create policy tfv_owner_insert on ticket_field_values
  for insert
  with check (exists (select 1 from projects p
                      where p.id = ticket_field_values.project_id
                        and p.owner_id = (select auth.uid())));

-- The WITH CHECK is what stops an owner re-pointing a row at a project they do not own, given
-- that the grant deliberately permits UPDATE on project_id. Note Postgres would fall back to
-- the USING expression if it were omitted, so deleting it is not observable by mutation — the
-- live test "the owner cannot move a value row into a project they do not own" is what pins
-- the behaviour.
create policy tfv_owner_update on ticket_field_values
  for update
  using      (exists (select 1 from projects p
                      where p.id = ticket_field_values.project_id
                        and p.owner_id = (select auth.uid())))
  with check (exists (select 1 from projects p
                      where p.id = ticket_field_values.project_id
                        and p.owner_id = (select auth.uid())));

create policy tfv_owner_delete on ticket_field_values
  for delete
  using (exists (select 1 from projects p
                 where p.id = ticket_field_values.project_id
                   and p.owner_id = (select auth.uid())));

-- project_field_options (SPRIN-92). Four policies, shaped exactly like tfv_owner_*: no
-- TO clause, `(select auth.uid())` throughout — adds ZERO auth_rls_initplan warnings
-- (measured: still 8 after applying).
create policy options_owner_read on project_field_options
  for select
  using (exists (select 1 from projects p
                 where p.id = project_field_options.project_id
                   and p.owner_id = (select auth.uid())));

create policy options_owner_insert on project_field_options
  for insert
  with check (exists (select 1 from projects p
                      where p.id = project_field_options.project_id
                        and p.owner_id = (select auth.uid())));

create policy options_owner_update on project_field_options
  for update
  using      (exists (select 1 from projects p
                      where p.id = project_field_options.project_id
                        and p.owner_id = (select auth.uid())))
  with check (exists (select 1 from projects p
                      where p.id = project_field_options.project_id
                        and p.owner_id = (select auth.uid())));

create policy options_owner_delete on project_field_options
  for delete
  using (exists (select 1 from projects p
                 where p.id = project_field_options.project_id
                   and p.owner_id = (select auth.uid())));

-- ------------------------------------------------------------
-- GRANTS for the two custom-field write tables.
--
-- BOTH BLOCKS WERE MISSING FROM THIS FILE and were added together. ticket_field_values'
-- (SPRIN-88) and project_field_options' (SPRIN-92) policies were both recorded here without
-- the privileges beside them, so a rebuild from this document produced two tables carrying
-- the FULL default CRUD grant for `authenticated` — which is not a smaller version of the
-- real schema, it is a different one: `slug` becomes patchable and AC3's guarantee (a rename
-- can never orphan a value row, because the privilege to write `slug` does not exist) is a
-- convention again rather than a database property.
--
-- EVERY TABLE HERE IS BORN WITH FULL CRUD FOR authenticated AND anon — measured from
-- pg_default_acl, not information_schema, whose grant views return zero rows under a
-- read-only role and read exactly like "no privileges". So each revoke below is the statement
-- that changes something. Each is written TABLE-WIDE with the permitted columns granted back
-- afterwards, because `revoke update (col)` against a table-wide grant is a SILENT NO-OP and
-- a table-level revoke CASCADES to column grants. Any later migration widening either set
-- must RESTATE EVERY GRANTED COLUMN, not just add its new one.
--
-- SELECT is deliberately left at the default for both roles on both tables: authenticated
-- needs it, and anon reads zero rows because `auth.uid()` is NULL, so the policies' EXISTS
-- matches no project. That is RLS emptying the result, NOT the absence of a policy for anon —
-- these policies carry no TO clause, so they apply to `public`, which includes anon.
-- ------------------------------------------------------------

-- ticket_field_values (SPRIN-88). INSERT and UPDATE on ALL EIGHT columns, which departs from
-- the epic design deliberately: PostgREST compiles `.upsert(row)` to `INSERT … ON CONFLICT DO
-- UPDATE SET c = excluded.c` for every column in the payload, and Postgres requires UPDATE on
-- every column in a SET list — so a narrow `grant update (value_*)` makes every SECOND write
-- to a field 42501. The identity columns are defended by tfv_ticket_fk/tfv_field_fk (composite
-- on project_id), tfv_type_fk and tfv_owner_update's WITH CHECK, not by this grant. The full
-- argument is in docs/migrations/sprin-88-ticket-field-values.sql.
revoke insert, update, delete on ticket_field_values from authenticated, anon;

grant insert (ticket_id, project_id, field_id, field_type,
              value_text, value_number, value_date, value_option)
  on ticket_field_values to authenticated;

grant update (ticket_id, project_id, field_id, field_type,
              value_text, value_number, value_date, value_option)
  on ticket_field_values to authenticated;

-- Table-wide because Postgres has no column-level DELETE, and AC3 needs it: clearing a custom
-- field DELETES the row rather than storing a null, because tfv_one_value_matching_type makes
-- a row of nulls unrepresentable.
grant delete on ticket_field_values to authenticated;

-- project_field_options (SPRIN-92).
revoke insert, update, delete on project_field_options from authenticated, anon;

grant insert (project_id, field_id, slug, label, position)
  on project_field_options to authenticated;

-- UPDATE on `label` ALONE is what makes AC3 a DATABASE property rather than a convention: a
-- patch touching `slug` earns 42501 before any policy is consulted, so no value row can be
-- orphaned by a rename. `position` is insertable but not updatable — there is no reorder
-- surface, so a writable position would be machinery with no caller.
grant update (label) on project_field_options to authenticated;

-- Table-wide DELETE, so options_owner_delete is the ONLY thing in front of it. That is why
-- rls.integration.test.ts asserts a stranger's delete removes zero rows, rather than only
-- asserting the owner's own delete works.
grant delete on project_field_options to authenticated;

-- THE TABLE WAS BORN WITH FULL CRUD FOR BOTH APP ROLES. Measured from pg_default_acl (not
-- information_schema, whose grant views return zero rows under a read-only role and read
-- exactly like "no privileges"): public tables default to anon=arwdDxtm, authenticated=
-- arwdDxtm. So this revoke is the statement that changes something — "we never granted it"
-- was never true of any table here.
--
-- Story 1 shipped no write path, so insert and delete were revoked and NOT granted back.
-- Both have since been granted, visibly and one migration each: SPRIN-91 (story 2) granted
-- INSERT on four columns, SPRIN-93 (story 6) granted DELETE, and live tests in
-- rls.integration.test.ts pin the current state so neither could have done it silently.
-- UPDATE(name) remains the only UPDATE privilege, which also gives AC4's refusal test a
-- positive control on the same row — without one, a blanket row-level refusal would be
-- indistinguishable from a working column privilege.
--
-- THIS BLOCK WAS STALE UNTIL SPRIN-93. It recorded the revoke and `update (name)` alone and
-- never gained SPRIN-91's INSERT grant, so a rebuild from this document produced a
-- project_fields that `authenticated` could not add a field to at all — every "add a custom
-- field" a 42501. The four statements below are now a literal copy of
-- docs/migrations/sprin-93-project-fields-delete.sql, which restates the WHOLE grant state for
-- exactly that reason: one file that states the whole truth beats three that each state a
-- third of it. Keep them equal.
--
-- The revoke is TABLE-WIDE with the columns granted back afterwards, because the obvious
-- form is a silent no-op (a column-level REVOKE cannot hole a table-level grant) and
-- because a table-level REVOKE **cascades** to column grants. Any later migration widening
-- this set must RESTATE EVERY GRANTED COLUMN, not just add its new one. `select` is
-- deliberately not in the revoke — see the paragraph below it.
revoke insert, update, delete on project_fields from authenticated, anon;

-- SPRIN-91. `created_at` stays withheld because it is half the SORT KEY, and a writable sort
-- key would make `(created_at, slug)` a client convention rather than a database property;
-- `id` stays withheld because a client that cannot supply a primary key cannot collide with
-- one.
grant insert (project_id, slug, name, type) on project_fields to authenticated;

-- UPDATE on `name` ALONE is what makes the name/slug division a DATABASE property rather than
-- a convention: a patch touching `slug` or `type` earns 42501 before any policy is consulted,
-- so no value row can be orphaned by a rename, and `field_type`'s denormalised copy on
-- ticket_field_values stays sound.
grant update (name) on project_fields to authenticated;

-- SPRIN-93. Table-wide, because Postgres has no column-level DELETE — so fields_owner_delete
-- is the ONLY thing in front of it, which is why rls.integration.test.ts asserts a stranger's
-- delete removes ZERO ROWS rather than only that the owner's own delete works. Its blast
-- radius is the largest of the three tables holding one: this delete cascades into ticket data
-- through tfv_field_fk AND into option data through pfo_field_fk.
grant delete on project_fields to authenticated;

-- SELECT is deliberately left as the default grant for both roles: authenticated needs it,
-- and anon reads zero rows.
--
-- NOT because there is no read policy for anon — there is. These four are created with no
-- `TO` clause, so they apply to `public`, which includes anon (verified against pg_policies:
-- roles = {public} on all four). anon reads nothing because `auth.uid()` is NULL, so the
-- EXISTS matches no project. Anyone adding a public-sharing SELECT policy here must scope it
-- explicitly; believing anon is excluded by policy absence would open this table silently.

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

-- sprints and tickets: MOVED, for the same forward-reference reason as
-- counters_owner above. SPRIN-100 rewrote sprints_owner and tickets_owner to call
-- app_auth.is_project_member, which does not exist until the SPRIN-98 section at
-- the foot of this file. Both live definitions are in the SPRIN-100 section
-- there, alongside counters_owner -- the three are one change and are kept
-- together so a reader sees the whole board-table boundary in one place.

commit;

-- ============================================================
-- SPRIN-98 — project_members (epic SPRIN-75, teams and roles)
-- ============================================================
-- Applied 2026-08-16. The FIRST table in this schema whose policies do not resolve
-- to `owner_id = auth.uid()`. It is no longer the only one, and it is no longer
-- inert: SPRIN-100 pointed the three board tables at `app_auth.is_project_member`,
-- so these rows now decide who can read and write every sprint, ticket and counter.
-- SPRIN-101 (`projects`) and SPRIN-99 (the config tables) are what remain.
--
-- This paragraph said "it is inert, populated, and waiting" until SPRIN-100, which
-- is exactly the sentence that stops being true the moment the first consumer lands.
--
-- STATEMENT ORDER IS LOAD-BEARING. The table is created before the app_auth
-- functions that read it, and those before the policies that call them. A
-- `language sql` body is fully parsed and analysed at CREATE time
-- (check_function_bodies defaults to on), so a forward reference fails the whole
-- migration with 42P01. A `language plpgsql` body is only syntax-checked, which is
-- why seed_project_admin may sit at the foot. The first draft got this wrong.
--
-- WHY A SEPARATE SCHEMA AND TWO DEFINER FUNCTIONS. A policy on project_members
-- cannot ask "is the caller a member?" by selecting from project_members —
-- Postgres raises `infinite recursion detected in policy`. Routing through
-- `projects` only defers it: at SPRIN-101 the projects policy starts checking
-- membership and the two recurse mutually. A SECURITY DEFINER function cuts the
-- cycle because RLS is not applied to table references inside it.
--
-- It lives in `app_auth`, NOT `public`, because PostgREST publishes every public
-- function as an RPC — the same hazard recorded at seed_project_statuses above.
--
-- HOW WE KNOW `app_auth` IS NOT EXPOSED, and how we DON'T. The first version of this
-- comment claimed the proof was mechanical: regenerating database.types.ts lists
-- `reorder_project_statuses` alone, so the helpers are unreachable. That is a
-- NON-SEQUITUR. The generator emits `public` regardless of the exposed list, so a
-- non-public schema is absent either way — `graphql_public` IS exposed and is also
-- absent from that file. The real check is live and asserted in
-- project-members.integration.test.ts: a request carrying `Accept-Profile: app_auth`
-- earns 406 / PGRST106 `Invalid schema: app_auth`. That flips the moment the schema
-- is added to the exposed list; the types file never would have.
--
-- BOTH FUNCTIONS READ auth.uid() AND NOTHING ELSE, so a caller can only ever learn
-- about THEMSELVES. That is what makes the definer privilege affordable, and it is
-- load-bearing: adding a user_id parameter to either signature turns a harmless
-- self-query into an oracle about other people.

create schema if not exists app_auth;
revoke all on schema app_auth from public;
grant usage on schema app_auth to authenticated;

create table project_members (
  project_id uuid not null references projects(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- text + check, never an enum. Same rule as ticket.type, sprint.status and
  -- project_type — widening a check is one line, altering an enum type is not.
  role       text not null,
  created_at timestamptz not null default now(),
  primary key (project_id, user_id),
  constraint project_members_role_check check (role in ('admin', 'member'))
);

-- The pk covers the project_id fk (a prefix of (project_id, user_id)); user_id has
-- no cover without this. It also serves "which projects does this user belong to",
-- which SPRIN-102 needs, so it is a real index rather than lint appeasement.
create index project_members_user_id_idx on project_members (user_id);

-- CORRECTED by SPRIN-105 (see that section, below) — this comment originally said
-- "STABLE, so the uid read happens once per statement rather than per row", which is
-- FALSE and is corrected here rather than in the shipped migration
-- (docs/migrations/sprin-98-project-members.sql), which is a historical record of what
-- was actually applied and is left alone. If the two read differently, this is why —
-- it is a correction, not drift.
--
-- The real mechanism: every call site here passes project_members.project_id, a
-- per-row column reference (a Var) from the table the policy filters, not a constant —
-- so STABLE does NOT let the planner hoist the call and evaluate it once per statement.
-- Postgres invokes is_project_member/is_project_admin once per candidate row, same as
-- every predicate in this file that takes a per-row argument; there is no
-- constant-argument call site anywhere in this schema. STABLE is still the honest
-- marking -- correct because the function reads only database state that cannot change
-- within the statement -- but it is not what keeps the internal uid read cheap. That is
-- a property of the body's own shape: `(select auth.uid())` is an uncorrelated scalar
-- subquery, so it is promoted to an InitPlan and evaluated once per invocation
-- regardless of volatility marking -- the same promotion would happen if the function
-- were VOLATILE. Both functions are also SECURITY DEFINER, and Postgres never inlines a
-- SECURITY DEFINER sql function, so each invocation runs its own cached body plan.
--
-- These policies need no `(select auth.uid())` wrapper, but the reason is textual, not
-- planning: the auth_rls_initplan advisor matches the literal text `auth.<fn>()` inside
-- a policy expression, and these policy bodies contain a function call and no bare
-- `auth.uid()` at all — auth.uid() appears only inside the function's own body. That is
-- why this migration added no such warning, and it is unrelated to call count.
create or replace function app_auth.is_project_member(p_project_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.project_members m
                 where m.project_id = p_project_id
                   and m.user_id = (select auth.uid()));
$$;

create or replace function app_auth.is_project_admin(p_project_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.project_members m
                 where m.project_id = p_project_id
                   and m.user_id = (select auth.uid())
                   and m.role = 'admin');
$$;

revoke execute on function app_auth.is_project_member(uuid) from public;
revoke execute on function app_auth.is_project_admin(uuid) from public;
grant  execute on function app_auth.is_project_member(uuid) to authenticated;
grant  execute on function app_auth.is_project_admin(uuid) to authenticated;

alter table project_members enable row level security;

-- Any member reads; only an admin writes. No TO clause, matching every policy
-- above — but note that on THIS table anon is stopped earlier, by the grants.
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

-- GRANTS. Born with full CRUD for authenticated AND anon; the revoke is table-wide
-- and the permitted columns granted back, because `revoke update (col)` against a
-- table-wide grant is a SILENT NO-OP while a table-level revoke CASCADES.
--
-- Measured from the catalogue after apply, 2026-08-16:
--   table  authenticated=rdDxtm   — no `a`, no `w`; anon absent entirely
--   column project_id=a  user_id=a  role=aw
--
-- `grant update (role)` ALONE closes the SET-list route: a patch touching project_id
-- or user_id earns 42501 before any policy is consulted. It does NOT make the row
-- immovable — an admin reaches the same end state with DELETE + INSERT, since both
-- policies constrain only the project and neither mentions user_id. State it as the
-- narrowing it is; an earlier draft overclaimed here. Unlike every
-- other table here, anon holds NOTHING — so an anon read is refused by the
-- privilege layer (42501, data null) rather than filtered to `[]` by a policy. That
-- asymmetry is deliberate and is asserted live.
--
-- WHAT THE REVOKE DOES NOT COVER, named because this table's grants were rebuilt to
-- be minimal and the audit line above enumerates `rdDxtm` without remarking on it:
-- `revoke insert, update, delete` leaves authenticated holding TRUNCATE (the `D`),
-- REFERENCES and TRIGGER. TRUNCATE is the one command RLS has no policy for, so all
-- four policies are blind to it — one `truncate project_members` would erase every
-- membership in the system. It is NOT reachable through PostgREST (which emits only
-- SELECT/INSERT/UPDATE/DELETE plus RPCs, and no RPC here runs dynamic SQL), and every
-- other table in this schema carries the same `D` for authenticated AND anon, so this
-- is the house convention rather than a SPRIN-98 regression. Note the asymmetry
-- anyway: the anon line one above uses the broad `revoke all` and this one does not.
-- Tightening it across the schema belongs to SPRIN-75's sweep, not to one table.
revoke all on project_members from anon;
revoke insert, update, delete on project_members from authenticated;
grant insert (project_id, user_id, role) on project_members to authenticated;
grant update (role) on project_members to authenticated;
grant delete on project_members to authenticated;

-- SECURITY DEFINER is FORCED: members_admin_insert requires an admin, and at
-- project-creation time nobody is one yet. An invoker function would deadlock the
-- bootstrap exactly as seed_project_statuses would have. It cannot be abused — it
-- fires only after a projects INSERT that already passed projects_owner's WITH
-- CHECK, and reads new.owner_id, which that policy just constrained to auth.uid().
create or replace function seed_project_admin()
returns trigger language plpgsql
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

-- Fires after on_project_created and before on_project_created_statuses, in name
-- order. Nothing depends on that; the name states it rather than stumbling into it.
--
-- SPRIN-100 KEPT THAT TRUE ON PURPOSE, and it nearly stopped being so. Once
-- counters_owner resolved to membership, on_project_created (the counter, and an
-- INVOKER) would have run BEFORE this trigger seeded the row authorising it, and
-- every project creation would have failed. The fix was to make that function
-- definer too, NOT to reorder the triggers — precisely so this comment keeps
-- holding. Revert the definer change and fire order silently becomes load-bearing.
create trigger on_project_created_admin
  after insert on projects
  for each row execute function seed_project_admin();

-- ============================================================
-- SPRIN-105 — profiles.email and co-member profile reads (epic SPRIN-75, story 2)
-- ============================================================
-- Applied 2026-08-16 -- hand-applied by David from
-- docs/migrations/sprin-105-profiles-email-and-co-member-reads.sql. Verified
-- from the catalogue, not just the editor reporting "Success". Widens profiles
-- from "my own row" to "my own row plus anyone I share a project with" for SELECT;
-- every write stays self-only.
--
-- STATEMENT ORDER IS LOAD-BEARING, same reasoning as SPRIN-98 above.
-- shares_project_with is `language sql`, so its body is fully parsed and
-- analysed at CREATE time (check_function_bodies defaults to on) and it reads
-- public.project_members — hence this whole section sits after project_members
-- exists, not up at the original profiles table declaration. handle_new_user is
-- `language plpgsql` and only syntax-checked, so its edit (above, at the
-- original declaration) had no such constraint.
--
-- WHAT THIS WIDENS, STATED PLAINLY. Joining a project makes your email address
-- visible to everyone else in that project. That is what Jira does and it is
-- the point of the feature, but it is a real disclosure decision rather than an
-- implementation detail. The boundary established here is: profile visibility
-- is CO-MEMBERSHIP and nothing wider. Writes do not widen at all.
--
-- "JOINING" OVERSTATES IT -- read this before trusting the sentence above.
-- Nothing in this schema requires the subject's consent to become a co-member.
-- members_admin_insert constrains only project_id, not user_id, and
-- seed_project_admin makes every project creator an admin of their own project
-- on creation -- so ANY authenticated user can create a project and then INSERT
-- an arbitrary user_id into project_members for it, with no action, consent or
-- notification from that user. Once this migration lands, that insert makes the
-- target's display_name and email readable by every other member of that
-- project. The ONLY reason this is not exploitable today is that nothing in the
-- app exposes a uuid oracle -- no search-by-uuid, no listing of every
-- auth.users.id, nothing that hands an attacker a stranger's id to insert.
-- SPRIN-102 ("add member by email") is exactly that oracle in reverse -- it
-- turns "knows a uuid" into "knows an email address" -- and it is SPRIN-102,
-- not this migration, that owns the decision of whether adding a member should
-- require that member's consent. The paragraph above describes the intended,
-- cooperative use of the feature, not an enforced boundary.
--
-- READ THIS BEFORE COPYING THE PATTERN. SPRIN-98's is_project_member and
-- is_project_admin consult (select auth.uid()) and NOTHING ELSE, so a caller
-- can only ever learn about themselves — adding a user_id parameter to either
-- would turn a harmless self-query into an oracle about other people. That
-- warning stands; shares_project_with is a THIRD function that does take
-- another user's id, affordable here for a different, weaker, and precisely
-- stateable reason:
--   * one side of the join is pinned to (select auth.uid()) -- it answers "do I
--     share a project with X", never "do X and Y share a project";
--   * its answer is exactly co-extensive with the policy that calls it --
--     anything it reveals about X, a select on X's profile row already
--     reveals, so it opens no new channel;
--   * it is not independently reachable -- app_auth is absent from the exposed
--     schema list, so PostgREST publishes no RPC for it.
-- Do not read this function as a precedent for "parameters are fine now" —
-- a future predicate without all three properties needs its own argument.
--
-- STABLE, not VOLATILE, because the result cannot change within a statement --
-- that marking is correct and stays. Do NOT read it as "the uid read happens
-- once per statement", and do NOT read is_project_member/is_project_admin above
-- as a counter-example either: NONE of the three predicates is hoisted. Every
-- real call site -- shares_project_with(profiles.id) here, and
-- is_project_member(project_members.project_id) /
-- is_project_admin(project_members.project_id) above -- passes a per-row column
-- reference (a Var) from the table the policy filters, not a literal. There is
-- no constant-argument call site anywhere in this schema, so Postgres invokes
-- every one of them once per candidate row. Measured with pg_get_userbyid as a
-- stand-in probe: a Var-argument call showed 693 invocations against a
-- multi-row table, a constant-argument call showed 1 -- confirming what a Var
-- argument costs, not showing that any predicate here avoids it.
--
-- STABLE is still the honest marking, and it is not a performance trick at this
-- call site: it is correct because the function reads only database state that
-- cannot change within the statement (project_members), nothing more. What
-- actually keeps the internal uid read cheap is a property of the FUNCTION
-- BODY'S SHAPE, not of STABLE: (select auth.uid()) is an uncorrelated scalar
-- subquery, so it is promoted to an InitPlan and evaluated once per invocation
-- regardless of how the function is marked -- the same promotion would happen
-- if it were VOLATILE. All three functions are also SECURITY DEFINER, and
-- Postgres never inlines a SECURITY DEFINER sql function, so each invocation
-- runs that cached body plan rather than being substituted into the caller. Do
-- not credit STABLE with anything about evaluation counts here.
--
-- CORRECTED (third time -- see the "not this text" trap below). This paragraph
-- used to claim the advisor matches the literal text `auth.<fn>()` and that
-- NONE of these policy bodies contain it, with "the reason is the SAME one for
-- all three predicates". Both claims are false, and profiles_read is the
-- counter-example: its stored expression is `(id = (select auth.uid())) OR
-- app_auth.shares_project_with(id)`, which plainly contains the text
-- `auth.uid()`. Measured across the live catalogue: roughly thirteen policies
-- contain that literal text and earn no warning, while the seven that DO warn
-- are the ones containing an UNWRAPPED call.
--
-- The real rule: the advisor flags a policy expression containing an
-- `auth.<fn>()` or `current_setting()` call that is NOT wrapped in a scalar
-- subquery. Wrapping it in `(select ...)` is the documented fix and is exactly
-- what clears the warning -- see CLAUDE.md's note on profiles_self.
--
-- THE REASON DIFFERS BETWEEN THE TWO FAMILIES, and "the same reason" is the
-- error to avoid repeating:
--   * members_read / members_admin_insert / members_admin_update /
--     members_admin_delete (project_members, SPRIN-98, above) contain no
--     auth.<fn>() call at all -- the uid read happens inside
--     is_project_member's / is_project_admin's own function body, not in the
--     policy expression.
--   * profiles_read / profiles_self_insert / profiles_self_update /
--     profiles_self_delete (this section) DO contain a call, and are clean
--     because it is already wrapped: `(select auth.uid())`, not bare
--     `auth.uid()`.
--
-- What stays true, re-verified with EXPLAIN: no call site here passes a
-- constant (every call passes a Var -- profiles.id, project_members
-- .project_id); STABLE does not cause the InitPlan promotion (that comes from
-- the subquery being uncorrelated, and would happen under VOLATILE too);
-- Postgres never inlines a SECURITY DEFINER sql function.
create or replace function app_auth.shares_project_with(p_user_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;

-- A NEW FUNCTION IN app_auth IS BORN EXECUTE-TO-PUBLIC. There are no default
-- privileges on this schema — SPRIN-98 tried to add them, the editor reported
-- "Success" every time, and pg_default_acl still held zero rows for app_auth
-- afterwards — so the hand-revoke below is the only thing standing between this
-- function and every signed-in user. anon is deliberately absent: it holds
-- USAGE on neither the schema nor, after the grants below, anything on profiles.
revoke execute on function app_auth.shares_project_with(uuid) from public;
grant  execute on function app_auth.shares_project_with(uuid) to authenticated;

-- One `for all` becomes four, split by verb. The split PRESERVES CURRENT WRITE
-- BEHAVIOUR VERB FOR VERB — `for all` already covered all four verbs, so
-- writing them out separately narrows nothing. Self-DELETE stays permitted: it
-- is a pre-existing footgun (delete your profile row and handle_new_user will
-- not rebuild it, since it fires on auth.users INSERT alone), but narrowing it
-- here would be a scope change smuggled in under a widening story. Left as
-- found.
--
-- No TO clause, matching every other policy in this schema — the consequence,
-- recorded because it has caused a misdiagnosis before, is that a policy
-- without TO covers anon as well, so a 42501 on an anonymous request has two
-- possible authors. The revoke below settles it on this table: anon holds
-- nothing, so it is refused at the privilege layer before any policy runs.
--
-- (select auth.uid()), not bare auth.uid(): the old profiles_self was one of
-- the eight auth_rls_initplan WARNs, and the wrapped form clears that one for
-- free since the policy is being rewritten anyway. The sweep across the
-- remaining tables still belongs to SPRIN-75, not here.
--
-- IF EXISTS, unlike the migration file's plain `drop policy`. This doc is meant
-- to run top to bottom from an empty database, and the original
-- `profiles_self` policy was removed from its declaration site above (see the
-- comment there) rather than recreated only to be dropped here -- so by the
-- time this statement runs in a fresh execution of this file, the policy never
-- existed and a bare `drop policy` would fail with 42704. In the real,
-- already-applied database the policy genuinely exists, which is exactly the
-- case the actual migration file targets -- its bare `drop policy` is the
-- correct, stronger statement there and must stay that way.
drop policy if exists profiles_self on profiles;

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

-- GRANTS. profiles was BORN with anon=arwdDxtm — full CRUD — like every table
-- in this schema before its grants were deliberately narrowed; survivable while
-- the table held only a display name, not what we want standing alone in front
-- of a column of email addresses. This changes nothing OBSERVABLE (anon already
-- saw zero rows, since id = auth.uid() is id = null for an anonymous caller,
-- which filters everything) but changes the FAILURE SHAPE a test must assert
-- on: a privilege refusal is 42501 with data === null, an RLS filter is
-- error: null, data: []. Table-wide, not column-level, matching SPRIN-98's
-- reasoning: `revoke ... (col)` against a table-wide grant is a silent no-op,
-- while a table-level revoke cascades.
revoke all on profiles from anon;

-- ============================================================
-- SPRIN-100 — the board tables resolve to membership (epic SPRIN-75, story 3)
-- ============================================================
-- Applied 2026-08-17, and verified from the catalogue rather than from the SQL
-- editor's "Success" -- the verification queries are at the foot of
-- docs/migrations/sprin-100-board-tables-membership.sql. Do not trust this line
-- on its own; an earlier draft of it claimed "Applied" while the migration was
-- still pending, which is exactly the drift this file warns about elsewhere.
--
-- counters_owner, sprints_owner and tickets_owner move from
-- `projects.owner_id = auth.uid()` to project MEMBERSHIP, with NO role predicate:
-- both 'admin' and 'member' do board work. Their original owner-scoped bodies
-- sat in the main body of this file and have been replaced there by pointers to
-- this section, because they now call app_auth.is_project_member and would be a
-- forward reference declared that early. Same treatment as profiles_read.
--
-- THE POLICY NAMES STILL SAY "_owner" AND NO LONGER MEAN IT. Kept because
-- SPRIN-100's acceptance criteria enumerate all three by name and SPRIN-103 and
-- SPRIN-104 will reference them. Read the predicate, not the name.
--
-- ALL THREE STAY SINGLE `for all` POLICIES WITH ONE PREDICATE IN BOTH CLAUSES,
-- and that is load-bearing rather than tidy. completeSprint's guard in
-- src/lib/sprints.ts is correct ONLY because read and write on `sprints` are the
-- same question: the guard reads a sprint's status, then writes, and if read ever
-- became broader than write a caller could pass the guard and reach the write.
-- The isolation suite would NOT flag that. It is also why David rejected a
-- read-only viewer role for the whole epic. Do not split these per verb.
--
-- WHY `to authenticated`, WHICH THE OWNER-SCOPED ORIGINALS DID NOT CARRY. These
-- three tables grant anon full CRUD (anon=arwdDxtm), and a policy with no TO
-- clause covers `public`, anon included. Policy expressions are evaluated as the
-- CALLING role, and anon holds no USAGE on app_auth and no EXECUTE on its
-- functions — so without this clause an anonymous request would raise
-- `permission denied for schema app_auth` (42501) where it used to receive a
-- clean empty array. The cron-job.org keepalive does an anonymous GET on
-- /rest/v1/tickets and expects 200 with a JSON array; breaking it pauses the
-- free-tier project after ~7 days, and a paused database blocks EVERY merge.
-- With `to authenticated` anon matches no policy, RLS filters it to zero rows,
-- and the contract is preserved exactly while anon's reach is strictly narrower.
-- keepalive.integration.test.ts asserts the contract at the cron's own URL;
-- board-membership.integration.test.ts asserts the shape on all three tables.
create policy counters_owner on project_counters
  for all
  to authenticated
  using      (app_auth.is_project_member(project_counters.project_id))
  with check (app_auth.is_project_member(project_counters.project_id));

create policy sprints_owner on sprints
  for all
  to authenticated
  using      (app_auth.is_project_member(sprints.project_id))
  with check (app_auth.is_project_member(sprints.project_id));

create policy tickets_owner on tickets
  for all
  to authenticated
  using      (app_auth.is_project_member(tickets.project_id))
  with check (app_auth.is_project_member(tickets.project_id));

-- create_project_counter BECOMES SECURITY DEFINER, and this is the bootstrap
-- problem arriving one story before the story that documents it.
--
-- Three AFTER INSERT ... FOR EACH ROW triggers exist on projects, and same-timing
-- triggers fire in NAME ORDER. `on_project_created` is a prefix of
-- `on_project_created_admin`, so the counter insert runs FIRST — before the
-- membership row that would authorise it exists. As an invoker it would fail
-- counters_owner's WITH CHECK and every project creation would fail.
--
-- Its two sibling triggers on this table, seed_project_admin and
-- seed_project_statuses, are already definer for exactly this reason, so this is
-- consistency rather than a new privilege shape. It inserts new.id and nothing
-- caller-controlled, so its authority is inherited from the projects INSERT
-- policy that just admitted the row.
--
-- Rejected: renaming the trigger to sort after the seeding. That would make
-- alphabetical fire order load-bearing and invisible, and would falsify SPRIN-98's
-- own comment that nothing depends on that ordering.
--
-- CREATE OR REPLACE PRESERVES AN EXISTING ACL. This function was
-- EXECUTE-to-public; a definer function must not keep a grant it does not need,
-- so the revoke below brings it to {postgres, service_role}, the same shape as
-- both definer siblings. It returns trigger, so PostgREST cannot call it as an
-- RPC in any case — defence in depth, not the closing of a live hole.
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
