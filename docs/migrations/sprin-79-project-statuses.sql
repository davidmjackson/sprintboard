-- =============================================================================
-- SPRIN-79  Per-project statuses / board columns   (Rung 3 epic SPRIN-72, slice 1)
--
-- BEHAVIOUR-PRESERVING. After this the app looks and behaves exactly as now: the
-- same four slugs, the same four labels, the same order, the same tickets.status
-- text column with the same `default 'todo'`. No ticket row is rewritten.
--
-- SCOPE NOTE: this story is the DATABASE half only. The board still renders from
-- the constants in src/lib/domain.ts; switching it to read these rows is SPRIN-76,
-- which exists precisely so a red test is never ambiguous between "the migration
-- is wrong" and "the rendering is wrong".
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- One explicit transaction. If any statement errors, NOTHING lands.
--
-- RE-RUN: NOT idempotent by design. A second paste fails at step 4 (`create table`
-- already exists) and rolls back harmlessly — there is no partial state to repair,
-- so a loud failure beats a silent skip over a differently-shaped table. The one
-- piece that IS idempotent is the backfill, because the integration suites create
-- and drop projects on every CI run and could interleave with the paste.
--
-- The vocabulary is SERVER-OWNED in this slice: clients may SELECT project_statuses
-- and nothing else. Write access is SPRIN-77's, which is the story that also builds
-- the UI to render a changed vocabulary. Do not widen the policy here.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Bound the damage. A lock_timeout abort is the SAFE outcome: nothing lands,
--    just re-run. Measured: `authenticated` carries statement_timeout=8s and
--    `postgres` carries none, so without this the SQL editor waits forever while
--    every CI fixture insert queued behind it dies in eight seconds.
-- -----------------------------------------------------------------------------
set local lock_timeout      = '5s';
set local statement_timeout = '120s';

-- -----------------------------------------------------------------------------
-- 2. Preconditions.
-- -----------------------------------------------------------------------------
do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception
      'SPRIN-79: needs PostgreSQL 15+ (the existing `on delete set null (col)` syntax already does); found %',
      current_setting('server_version');
  end if;

  if exists (select 1 from public.tickets t
             where t.status not in ('todo','in_progress','in_review','done')) then
    raise exception
      'SPRIN-79: tickets exist with a status outside the four defaults. tickets_status_check '
      'should have made this impossible. Investigate before proceeding.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3. Close the race BEFORE reading `projects`.
--
--    Without this, a project committed after the backfill's snapshot but before
--    the FK is added ends up with NO statuses, and its tickets violate the new FK
--    INVISIBLY — ADD CONSTRAINT only validates rows visible to its own snapshot.
--    The migration would succeed and leave a project whose every future ticket
--    insert fails with 23503.
--
--    SHARE ROW EXCLUSIVE blocks INSERT/UPDATE/DELETE on `projects` but NOT SELECT.
--    After it, every project either already exists (the backfill sees it) or is
--    blocked until we commit (and then fires the seeding trigger). No third case.
--
--    Belt and braces, and the reason step 6's ordering matters even if someone
--    deletes this lock: `create trigger` itself takes SHARE ROW EXCLUSIVE on
--    `projects`, so creating the trigger BEFORE the backfill closes the same
--    window independently. Do not reorder them.
-- -----------------------------------------------------------------------------
lock table public.projects in share row exclusive mode;

-- -----------------------------------------------------------------------------
-- 4. The table. A board column IS a status row; `position` is board order.
--
--    NO separate board_columns table: the mapping is 1:1 today, and the Rung 3
--    split is purely additive — create board_columns, seed one per status, add a
--    nullable project_statuses.column_id, backfill, set not null, move `position`.
--    No ticket row is touched, because tickets never reference a column.
--
--    text + check throughout. NEVER an enum (CLAUDE.md).
-- -----------------------------------------------------------------------------
create table public.project_statuses (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,

  -- Stable machine identity, and the fk target for tickets.status. Users rename
  -- `name`, never `slug` — the same division projects.key already uses.
  slug        text not null,

  -- The board column heading. Seeded to today's TICKET_STATUS_LABELS verbatim.
  name        text not null,

  -- Jira's status category, and the eventual home of the "done is terminal" rule
  -- currently inlined at src/lib/sprints.ts and src/routes/ProjectShell.tsx.
  -- The default is deliberately the NON-terminal middle bucket: a Rung 3 flow that
  -- forgets to set it produces a status that is not treated as Done, so incomplete
  -- tickets return to the backlog. Fail safe, not fail convenient.
  category    text not null default 'in_progress',

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
  constraint project_statuses_category_check
    check (category in ('todo','in_progress','done')),
  constraint project_statuses_position_positive
    check (position > 0),

  -- The fk target for tickets. NON-deferrable, so it remains a legal fk target and
  -- can still arbitrate ON CONFLICT.
  constraint project_statuses_project_slug_unique
    unique (project_id, slug),

  -- DEFERRABLE so a Rung 3 reorder can swap positions inside ONE statement without
  -- a temporary sentinel. NOTE: a DEFERRABLE constraint cannot be used for ON
  -- CONFLICT inference — upserts must target (project_id, slug).
  constraint project_statuses_project_position_unique
    unique (project_id, position) deferrable initially deferred,

  -- Redundant on its own (id is the PK). Exists so a Rung 3 board_columns table can
  -- point at a status with a COMPOSITE fk and prove same-project membership —
  -- exactly why sprints_id_project_unique and tickets_id_project_unique exist.
  constraint project_statuses_id_project_unique
    unique (id, project_id)
);

comment on table public.project_statuses is
  'Per-project ticket statuses. One row = one board column (1:1 at Rung 3 slice 1). '
  'SERVER-OWNED: clients may SELECT only; the seeding trigger is the sole writer. '
  'SPRIN-77 opens writes and MUST first move the terminal-status rule off the literal '
  '"done" at src/lib/sprints.ts and src/routes/ProjectShell.tsx onto category.';

-- At most one initial status per project. Same idiom as sprints_one_active_per_project,
-- and the same limitation: it prevents two, not zero.
create unique index project_statuses_one_initial_per_project
  on public.project_statuses (project_id) where is_initial;

-- -----------------------------------------------------------------------------
-- 5. RLS, immediately after the table and in the same transaction.
--
--    MEASURED, not assumed: ALTER DEFAULT PRIVILEGES in `public` grants anon,
--    authenticated and service_role full DML (arwdDxtm) on every new table. A table
--    created without a policy is world-writable to anonymous callers. The policy is
--    the ONLY guard, so it never leaves this transaction.
--
--    FOR SELECT, not FOR ALL — and this is the deliberate departure from the four
--    existing policies. Today a client cannot change the status vocabulary at all,
--    because it is a CHECK constraint. A FOR ALL policy would hand every owner
--    INSERT/UPDATE/DELETE on their own vocabulary over PostgREST, using only the
--    anon key and their own JWT, while the UI still hard-codes four columns:
--    a ticket set to an unknown status renders in NO column and vanishes, and an
--    owner deleting the `todo` row permanently breaks ticket creation. Both are
--    reachable in two ordinary requests. Write access belongs to SPRIN-77.
-- -----------------------------------------------------------------------------
alter table public.project_statuses enable row level security;

-- project_statuses: readable only via an owned project
create policy statuses_owner_read on public.project_statuses
  for select
  using (exists (select 1 from public.projects p
                 where p.id = project_statuses.project_id
                   and p.owner_id = auth.uid()));

-- -----------------------------------------------------------------------------
-- 6. Seed on project creation — by EVERY creation path.
--
--    A trigger, not client code: there are four ways a projects row appears (the
--    app's createProject, raw fixture inserts across the integration suites, the
--    Playwright E2E through the real dialog, and a human pasting SQL). Only a
--    trigger covers all four, and it fires in the parent's transaction, so "a
--    project with no statuses" is not a reachable state.
--
--    SECURITY DEFINER, following handle_new_user and NOT create_project_counter.
--    That is forced by the select-only policy above: an invoker function's INSERT
--    would be denied. It pays for the privilege exactly as handle_new_user does —
--    an empty pinned search_path, schema-qualified references, and a revoke. It
--    cannot be abused: it only ever fires after a projects INSERT that already
--    passed projects_owner's WITH CHECK, so new.id is a project the caller owns.
--
--    AFTER, not BEFORE: the projects row must be visible for the fk to resolve.
--
--    Two triggers now fire on this event, in NAME order:
--      on_project_created (the counter) then on_project_created_statuses.
--    Neither depends on the other; the name states the order rather than stumbling
--    into it.
--
--    The four values are inlined here and again in the backfill, deliberately. A
--    shared helper returning a table would be published by PostgREST as an
--    anon-callable RPC, and handle_new_user's `revoke execute` remedy cannot be
--    applied to it without breaking whichever function calls it. The duplication is
--    bounded to this file plus the schema doc and is pinned by test.
-- -----------------------------------------------------------------------------
create or replace function public.seed_project_statuses()
returns trigger
language plpgsql
security definer
set search_path = ''
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

create trigger on_project_created_statuses
  after insert on public.projects
  for each row execute function public.seed_project_statuses();

-- -----------------------------------------------------------------------------
-- 7. Backfill every project that already exists.
--
--    Runs as `postgres` in the SQL editor, which owns these tables and has
--    BYPASSRLS, so it seeds EVERY owner's projects, not just the operator's. That
--    is required, and it is the reason this must be a hand-run migration rather
--    than anything the app could do.
--
--    Idempotent via ON CONFLICT, arbitrated by the non-deferrable
--    project_statuses_project_slug_unique.
-- -----------------------------------------------------------------------------
insert into public.project_statuses
  (project_id, slug, name, category, position, is_initial)
select p.id, d.slug, d.name, d.category, d.ord, d.is_initial
  from public.projects p
 cross join (values
   ('todo',        'To Do',       'todo',        1, true),
   ('in_progress', 'In Progress', 'in_progress', 2, false),
   ('in_review',   'In Review',   'in_progress', 3, false),
   ('done',        'Done',        'done',        4, false)
 ) as d(slug, name, category, ord, is_initial)
on conflict (project_id, slug) do nothing;

-- -----------------------------------------------------------------------------
-- 8. Pre-flight, BEFORE we constrain tickets. Without these the failure mode is a
--    bare 23503 from ADD CONSTRAINT naming no row and no cause.
--
--    The invariant asserted is "every project has AT LEAST the four default slugs",
--    not "exactly four rows": exactly-four is a today-only fact and would make this
--    file hostile to a legitimate Rung 3 project with five columns.
-- -----------------------------------------------------------------------------
do $$
declare
  v_unseeded int;
  v_dangling int;
  v_initial  int;
begin
  select count(*) into v_unseeded
    from public.projects p
   where exists (
     select 1 from (values ('todo'),('in_progress'),('in_review'),('done')) as d(slug)
      where not exists (select 1 from public.project_statuses s
                         where s.project_id = p.id and s.slug = d.slug)
   );
  if v_unseeded > 0 then
    raise exception
      'SPRIN-79: % project(s) are missing one or more of the four default statuses '
      'after backfill. Aborting before the tickets fk is added.', v_unseeded;
  end if;

  select count(*) into v_initial
    from public.projects p
   where (select count(*) from public.project_statuses s
           where s.project_id = p.id and s.is_initial) <> 1;
  if v_initial > 0 then
    raise exception
      'SPRIN-79: % project(s) do not have exactly one is_initial status.', v_initial;
  end if;

  select count(*) into v_dangling
    from public.tickets t
   where not exists (select 1 from public.project_statuses s
                      where s.project_id = t.project_id and s.slug = t.status);
  if v_dangling > 0 then
    raise exception
      'SPRIN-79: % ticket(s) hold a status with no matching project_statuses row. '
      'The fk would reject them. Aborting.', v_dangling;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 9. Index the referencing side of the new fk. Every DELETE of a project_statuses
--    row (including the cascade from a project delete) probes
--    `tickets where project_id = ? and status = ?`; without this that is a seq scan
--    per deleted status row — four per project teardown, on every integration run.
--    tickets_project_idx alone does not cover the pair.
-- -----------------------------------------------------------------------------
create index tickets_project_status_idx on public.tickets (project_id, status);

-- -----------------------------------------------------------------------------
-- 10. The foreign key. This is the whole story.
--
--     COMPOSITE, carrying project_id: exactly the tickets_sprint_fk /
--     tickets_epic_fk idiom. A plain fk on `status` alone cannot exist (slugs
--     repeat across projects); carrying project_id makes "a ticket in project A
--     holding project B's status" unrepresentable rather than merely discouraged.
--     Both referencing columns are NOT NULL, so MATCH SIMPLE always checks — there
--     is no null escape hatch, unlike sprint_id / parent_epic_id.
--
--     ON UPDATE NO ACTION, not CASCADE: the referencing column list includes
--     project_id, so ON UPDATE CASCADE would propagate a change to
--     project_statuses.project_id into tickets.project_id, silently moving tickets
--     between projects and possibly colliding with tickets_project_number_unique.
--
--     DEFERRABLE INITIALLY DEFERRED, and this is load-bearing, not tidiness.
--     `delete from projects` fires one cascade per referencing fk; each cascade runs
--     its OWN inner DELETE, whose own immediate checks fire at the end of THAT inner
--     statement. So a non-deferrable NO ACTION check is only safe if the tickets
--     cascade happens to run first — which is RI trigger name/OID order, i.e. luck.
--     It would work HERE and NOT on a fresh apply of docs/sprintboard_phase1_schema.sql,
--     where project_statuses must be created before tickets and therefore cascades
--     first — raising 23503 and taking every integration teardown and the E2E user
--     teardown with it. Deferring to COMMIT is correct in either order.
--
--     It weakens nothing that matters: RLS WITH CHECK still raises 42501 at statement
--     time, so the existing cross-tenant assertions are untouched. It DOES move a
--     rejected status from a statement-time error to a commit-time one.
--
--     tickets holds 0 rows (measured), so the validating scan under ACCESS
--     EXCLUSIVE is microseconds. See the LARGE-TABLE VARIANT in the design doc if
--     that ever stops being true.
-- -----------------------------------------------------------------------------
alter table public.tickets
  add constraint tickets_status_fk
  foreign key (project_id, status)
  references public.project_statuses (project_id, slug)
  on update no action
  on delete no action
  deferrable initially deferred;

-- -----------------------------------------------------------------------------
-- 11. Retire the global check constraint — AFTER the fk is in place, so `status` is
--     never unvalidated for an instant.
--
--     The fk is stronger where it counts: the old check accepted 'done' on any
--     project; the fk accepts 'done' only on a project that HAS a `done` status.
--     What the check also provided — that a client cannot invent a status — is
--     preserved in this slice by the select-only policy above, NOT by the fk. That
--     is why the policy is not FOR ALL, and why widening it is a story, not a tweak.
-- -----------------------------------------------------------------------------
alter table public.tickets drop constraint tickets_status_check;

-- -----------------------------------------------------------------------------
-- 12. Post-conditions, still inside the transaction.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'tickets_status_fk'
                    and conrelid = 'public.tickets'::regclass
                    and condeferrable and condeferred) then
    raise exception 'SPRIN-79: tickets_status_fk missing or not deferrable/deferred.';
  end if;

  if exists (select 1 from pg_constraint
              where conname = 'tickets_status_check'
                and conrelid = 'public.tickets'::regclass) then
    raise exception 'SPRIN-79: tickets_status_check still present.';
  end if;

  if not (select relrowsecurity from pg_class
           where oid = 'public.project_statuses'::regclass) then
    raise exception 'SPRIN-79: RLS is not enabled on project_statuses.';
  end if;

  -- Pins the select-only decision at migration time. This assertion is EXPECTED to
  -- be changed by SPRIN-77, consciously, together with the tests that mirror it.
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'project_statuses'
                    and policyname = 'statuses_owner_read' and cmd = 'SELECT') then
    raise exception
      'SPRIN-79: statuses_owner_read is missing or is not a SELECT-only policy.';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'project_statuses') <> 1 then
    raise exception 'SPRIN-79: project_statuses has more than one policy.';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.projects'::regclass
                    and tgname = 'on_project_created_statuses' and not tgisinternal) then
    raise exception 'SPRIN-79: on_project_created_statuses trigger is missing.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 13. LIVE SMOKE TEST, as `authenticated`, before COMMIT.
--
--     Everything above ran as postgres, which owns these tables and has BYPASSRLS —
--     so nothing above proves the policy predicate or the trigger actually works for
--     a real user. Without this block, the first thing to evaluate statuses_owner_read
--     is a CI run, AFTER commit and AFTER tickets_status_check has been dropped.
--
--     Verified prerequisites (queried live, not assumed): postgres is a member of
--     `authenticated` WITH ADMIN OPTION, and auth.uid() coalesces
--     current_setting('request.jwt.claim.sub') with
--     current_setting('request.jwt.claims')::jsonb->>'sub'.
--
--     This also proves the `revoke execute` above does not break the trigger
--     (EXECUTE is checked at CREATE TRIGGER time, not at fire time — the same
--     pattern handle_new_user has used since S1.1). If that assumption is wrong,
--     this block raises and the whole migration rolls back — which is why it is here.
--
--     It leaves nothing behind: the project it creates is deleted, and the delete is
--     itself the cascade-ordering test.
-- -----------------------------------------------------------------------------
do $$
declare
  v_owner  uuid;
  v_proj   uuid;
  v_key    text;
  v_n      int;
  v_status text;
  v_slug   text;
  v_del    int;
begin
  select id into v_owner from auth.users order by created_at limit 1;
  if v_owner is null then
    raise exception 'SPRIN-79: no auth.users row to run the smoke test as. Aborting.';
  end if;
  v_key := 'Z' || upper(substr(md5(random()::text), 1, 3));

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.projects (owner_id, name, key)
  values (v_owner, 'SPRIN-79 smoke', v_key)
  returning id into v_proj;

  -- The load-bearing assertion: the definer trigger seeded four rows AND
  -- statuses_owner_read lets their owner read them back.
  select count(*) into v_n
    from public.project_statuses where project_id = v_proj;
  if v_n <> 4 then
    raise exception
      'SPRIN-79 SMOKE FAIL: an authenticated owner sees % statuses, expected 4. '
      'This is seed_project_statuses() or statuses_owner_read, not the app.', v_n;
  end if;

  select slug into v_slug
    from public.project_statuses where project_id = v_proj and is_initial;
  if v_slug is distinct from 'todo' then
    raise exception
      'SPRIN-79 SMOKE FAIL: is_initial slug is %, expected todo (it must agree with '
      'tickets.status''s column default).', coalesce(v_slug, '<none>');
  end if;

  -- The vocabulary is server-owned: even its OWNER may not write it in this slice.
  begin
    insert into public.project_statuses (project_id, slug, name, category, position)
    values (v_proj, 'planted', 'Planted', 'in_progress', 9);
    raise exception
      'SPRIN-79 SMOKE FAIL: an owner was able to INSERT a status. The policy is not '
      'SELECT-only.';
  exception when insufficient_privilege then
    null;  -- 42501, expected
  end;

  insert into public.tickets (project_id, summary)
  values (v_proj, 'smoke')
  returning status into v_status;
  if v_status <> 'todo' then
    raise exception 'SPRIN-79 SMOKE FAIL: default status is %, expected todo', v_status;
  end if;

  -- Force the deferred fk to check NOW, then restore deferral so the delete below
  -- still exercises the order-independent path.
  set constraints public.tickets_status_fk immediate;
  set constraints public.tickets_status_fk deferred;

  delete from public.projects where id = v_proj;
  get diagnostics v_del = row_count;
  if v_del <> 1 then
    raise exception 'SPRIN-79 SMOKE FAIL: smoke project delete removed % rows, expected 1', v_del;
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  raise notice 'SPRIN-79 SMOKE OK: seed, read, write-refusal, default and cascade all pass.';
end $$;

-- PostgREST caches the schema. Without this, /rest/v1/project_statuses 404s until the
-- next reload. Delivered at COMMIT, so it is correctly a no-op if we abort.
notify pgrst, 'reload schema';

commit;
