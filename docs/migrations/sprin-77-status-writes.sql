-- =============================================================================
-- SPRIN-77  Manage a project's statuses: add, rename, reorder
--           (Rung 3 epic SPRIN-72, slice 3 — the first one a user can see)
--
-- WHAT THIS OPENS. SPRIN-79 made project_statuses deliberately SELECT-only and
-- named this story as the one that widens it. This migration adds INSERT and
-- UPDATE for the owning user and NOTHING ELSE:
--
--   * There is NO DELETE policy. Deleting a status strands the tickets sitting
--     on it, and an owner deleting `todo` would permanently break ticket
--     creation, because tickets.status's default is still the bare literal
--     'todo'. Both are SPRIN-80's problem, in the story that also replaces that
--     default with is_initial resolution. Until then DELETE matches no policy,
--     filters to zero rows, and changes nothing.
--
--   * UPDATE is restricted TO THREE COLUMNS: name, category, position. slug is
--     the fk target of tickets_status_fk and must never move — CLAUDE.md's rule
--     is that the fk is keyed on the slug precisely so no ticket row is ever
--     rewritten when the vocabulary changes.
--
-- THE COLUMN RESTRICTION IS NOT THE OBVIOUS STATEMENT. `revoke update (slug)`
-- alone would be a SILENT NO-OP: this table's relacl grants `authenticated`
-- table-wide `w`, and Postgres does not let a column-level REVOKE carve a hole
-- in a table-level grant. The table-level privilege must be revoked OUTRIGHT and
-- the permitted columns granted back. Step 4 does exactly that, and step 6's
-- smoke test proves it by trying to move a slug and requiring a 42501.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- One explicit transaction. If any statement errors, NOTHING lands.
--
-- RE-RUN: safe. Every statement is idempotent (`if not exists`, `drop policy if
-- exists` before create, `create or replace function`, and grants/revokes which
-- are naturally idempotent). The smoke test creates and destroys its own project
-- inside the transaction either way.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Bound the damage. A lock_timeout abort is the SAFE outcome: nothing lands,
--    just re-run. Same reasoning as SPRIN-79: `authenticated` carries
--    statement_timeout=8s, so without this the editor waits forever while every
--    CI fixture insert queued behind it dies in eight seconds.
-- -----------------------------------------------------------------------------
set local lock_timeout      = '5s';
set local statement_timeout = '120s';

-- -----------------------------------------------------------------------------
-- 2. Preconditions. Fail loudly if the world is not what SPRIN-79 left behind.
-- -----------------------------------------------------------------------------
do $$
declare
  v_dupes int;
begin
  if not exists (select 1 from pg_class
                 where oid = 'public.project_statuses'::regclass and relrowsecurity) then
    raise exception 'SPRIN-77: RLS is not enabled on project_statuses. Apply SPRIN-79 first.';
  end if;

  if not exists (select 1 from pg_policy
                 where polrelid = 'public.project_statuses'::regclass
                   and polname  = 'statuses_owner_read') then
    raise exception 'SPRIN-77: statuses_owner_read is missing. Apply SPRIN-79 first.';
  end if;

  -- The unique index in step 3 builds over existing rows. If two statuses in one
  -- project already differ only by case or padding, the CREATE would fail with a
  -- bare 23505 naming no row. Say which project, before touching anything.
  select count(*) into v_dupes from (
    select project_id, lower(btrim(name))
      from public.project_statuses
     group by project_id, lower(btrim(name))
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'SPRIN-77: % project(s) already hold two statuses whose names differ only by '
      'case or surrounding space. Rename one of each pair before applying.', v_dupes;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3. AC4's edge: a duplicate status name within one project is rejected.
--
--    An INDEX, not a table constraint: the key is an expression, and `unique (...)`
--    on a table will not take one. lower(btrim(...)) mirrors the existing
--    project_statuses_name_nonempty check, which already btrims — "Done", "done"
--    and " Done " are one name to a user, so they are one name here.
--
--    Scoped by project_id, so the SAME name in a DIFFERENT project stays legal.
--    That half of AC4 is as load-bearing as the rejection half.
-- -----------------------------------------------------------------------------
create unique index if not exists project_statuses_project_name_unique
  on public.project_statuses (project_id, lower(btrim(name)));

-- -----------------------------------------------------------------------------
-- 4. Privileges. Read the header: the table-level revoke is the load-bearing
--    half, and the column grant alone would do nothing.
--
--    `position` is granted because reorder_project_statuses() in step 5 is
--    SECURITY INVOKER and therefore updates that column as the CALLER. A client
--    may also PATCH position directly; that is harmless, because two rows landing
--    on one position violates project_statuses_project_position_unique at commit
--    and surfaces as an ordinary 23505.
--
--    INSERT is deliberately left unrestricted at the column level — a foreign
--    project_id is refused by the new policy's WITH CHECK, a second is_initial by
--    project_statuses_one_initial_per_project, and a colliding position by the
--    deferred unique constraint. A column grant list there would pin nothing.
-- -----------------------------------------------------------------------------
revoke update on public.project_statuses from authenticated, anon;
grant  update (name, category, position) on public.project_statuses to authenticated;

-- -----------------------------------------------------------------------------
-- 5. The two write policies, and the reorder function.
--
--    THREE policies now live on this table, and the split IS the security model:
--    statuses_owner_read (select, from SPRIN-79), plus these two. Do NOT ever
--    "simplify" them into one `for all` — that silently grants DELETE and reopens
--    the broken-ticket-creation hole the header describes. A test in
--    rls.integration.test.ts goes red if anyone does.
--
--    DO NOT add `force row level security`. Unchanged from SPRIN-79 and now more
--    load-bearing, not less: seed_project_statuses() is SECURITY DEFINER and runs
--    as the table owner, exempt from RLS only while FORCE is off. Turn it on and
--    every project creation fails at insert time, for every user.
-- -----------------------------------------------------------------------------
drop policy if exists statuses_owner_insert on public.project_statuses;
create policy statuses_owner_insert on public.project_statuses
  for insert
  with check (exists (select 1 from public.projects p
                      where p.id = project_statuses.project_id
                        and p.owner_id = auth.uid()));

drop policy if exists statuses_owner_update on public.project_statuses;
create policy statuses_owner_update on public.project_statuses
  for update
  using      (exists (select 1 from public.projects p
                      where p.id = project_statuses.project_id
                        and p.owner_id = auth.uid()))
  with check (exists (select 1 from public.projects p
                      where p.id = project_statuses.project_id
                        and p.owner_id = auth.uid()));

-- Why a function, when every other write in this app is a plain PostgREST call:
-- project_statuses_project_position_unique is DEFERRABLE INITIALLY DEFERRED, and
-- that deferral only helps WITHIN ONE TRANSACTION. PostgREST wraps each request in
-- its own transaction, so N separate `PATCH position=` calls collide on the very
-- first swap — moving row 2 to position 1 violates the constraint against the row
-- already sitting there, with no later statement in that transaction for the
-- deferral to defer to. One statement inside one function is the only shape where
-- the deferral does the job SPRIN-79 wrote it to do.
--
-- SECURITY INVOKER, NOT DEFINER. The caller's own rights apply, so
-- statuses_owner_update still governs every row touched and a cross-tenant
-- p_project_id updates nothing. Unlike seed_project_statuses(), this function is
-- not trying to do anything the caller may not do, so it must not be granted the
-- privilege to. `set search_path = ''` travels with it anyway: a public function
-- published as a PostgREST RPC is reachable by any authenticated caller and must
-- not resolve names through a caller-controlled path.
--
-- Positions stay DENSE 1..N: ordinality is assigned over the caller's full ordered
-- slug list. A caller sending a PARTIAL list would leave the omitted rows on their
-- old positions and could collide at commit; the write layer always sends the whole
-- list and a unit test pins that it does.
create or replace function public.reorder_project_statuses(p_project_id uuid, p_slugs text[])
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

-- Functions are EXECUTE-to-public by default. anon must not reach this; unlike
-- seed_project_statuses() (a TRIGGER function, which needs no EXECUTE at all and
-- so is revoked from everyone), this one is called directly and `authenticated`
-- must keep it.
revoke execute on function public.reorder_project_statuses(uuid, text[]) from public, anon;
grant  execute on function public.reorder_project_statuses(uuid, text[]) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. Smoke test, as a real `authenticated` user, inside this transaction. If any
--    assertion fails the whole migration rolls back — which is why it is here and
--    not in a follow-up script.
--
--    It proves the three things that are easy to get wrong and impossible to see
--    afterwards: that the column revoke actually bites (it would have been a no-op
--    in the obvious form), that DELETE is refused, and that the duplicate-name
--    index catches a CASE-ONLY difference.
-- -----------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
  v_proj  uuid;
  v_proj2 uuid;
  v_key   text;
  v_n     int;
  v_name  text;
  v_pos   int[];
begin
  select id into v_owner from auth.users order by created_at limit 1;
  if v_owner is null then
    raise exception 'SPRIN-77: no auth.users row to run the smoke test as. Aborting.';
  end if;
  v_key := 'Y' || upper(substr(md5(random()::text), 1, 3));

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.projects (owner_id, name, key)
  values (v_owner, 'SPRIN-77 smoke', v_key)
  returning id into v_proj;

  -- (a) POSITIVE CONTROL. Without this, every refusal below could be passing
  --     because the fixture is broken rather than because the guard works.
  insert into public.project_statuses (project_id, slug, name, category, position)
  values (v_proj, 'qa', 'Ready for QA', 'in_progress', 5);

  select count(*) into v_n from public.project_statuses where project_id = v_proj;
  if v_n <> 5 then
    raise exception 'SPRIN-77 SMOKE FAIL: expected 4 seeded + 1 added = 5 statuses, found %', v_n;
  end if;

  -- (b) Rename works, and it is the whole of what a rename touches.
  update public.project_statuses set name = 'In QA'
   where project_id = v_proj and slug = 'qa';
  select name into v_name from public.project_statuses
   where project_id = v_proj and slug = 'qa';
  if v_name <> 'In QA' then
    raise exception 'SPRIN-77 SMOKE FAIL: rename did not apply (name is %)', v_name;
  end if;

  -- (c) THE ONE THAT CATCHES THE NO-OP. Moving a slug must be refused by the
  --     column privilege, not merely discouraged by a comment.
  begin
    update public.project_statuses set slug = 'qa2'
     where project_id = v_proj and slug = 'qa';
    raise exception
      'SPRIN-77 SMOKE FAIL: updating slug was ALLOWED. The table-level UPDATE revoke '
      'in step 4 did not take effect — a column-level revoke alone is a no-op.';
  exception when insufficient_privilege then
    null;  -- 42501: expected.
  end;

  -- (d) is_initial is not client-writable either: zero-initial is SPRIN-80's state
  --     to reach deliberately, not one an owner can stumble into here.
  begin
    update public.project_statuses set is_initial = false
     where project_id = v_proj and slug = 'todo';
    raise exception 'SPRIN-77 SMOKE FAIL: updating is_initial was ALLOWED.';
  exception when insufficient_privilege then
    null;
  end;

  -- (e) DELETE is refused. Note it does NOT raise: with no DELETE policy, RLS
  --     FILTERS to zero rows, and a DELETE matching nothing is not an error. The
  --     row count is the only evidence — asserting "no exception" would pass on a
  --     table that had been emptied.
  delete from public.project_statuses where project_id = v_proj and slug = 'qa';
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception
      'SPRIN-77 SMOKE FAIL: DELETE removed % row(s). A DELETE policy exists that should '
      'not — SPRIN-80 owns deletion.', v_n;
  end if;

  -- (f) AC4, and specifically the CASE-ONLY collision the plain unique (project_id,
  --     name) form would have let through.
  begin
    insert into public.project_statuses (project_id, slug, name, category, position)
    values (v_proj, 'qa_dup', 'in qa', 'in_progress', 6);
    raise exception
      'SPRIN-77 SMOKE FAIL: "in qa" was accepted alongside "In QA". The duplicate-name '
      'index is missing or is not case-insensitive.';
  exception when unique_violation then
    null;  -- 23505: expected.
  end;

  -- (g) The same name in a DIFFERENT project is fine. The other half of AC4, and
  --     the half a project_id-less index would silently break.
  insert into public.projects (owner_id, name, key)
  values (v_owner, 'SPRIN-77 smoke 2', 'Y' || upper(substr(md5(random()::text), 1, 3)))
  returning id into v_proj2;
  insert into public.project_statuses (project_id, slug, name, category, position)
  values (v_proj2, 'qa', 'In QA', 'in_progress', 5);
  delete from public.projects where id = v_proj2;

  -- (h) Reorder produces a DENSE 1..N in the order given, through the RPC the app
  --     actually calls.
  perform public.reorder_project_statuses(
    v_proj, array['qa','done','in_review','in_progress','todo']::text[]);

  select array_agg(position order by position) into v_pos
    from public.project_statuses where project_id = v_proj;
  if v_pos <> array[1,2,3,4,5] then
    raise exception 'SPRIN-77 SMOKE FAIL: positions after reorder are %, expected {1,2,3,4,5}', v_pos;
  end if;

  select slug into v_name from public.project_statuses
   where project_id = v_proj and position = 1;
  if v_name <> 'qa' then
    raise exception 'SPRIN-77 SMOKE FAIL: position 1 is %, expected qa', v_name;
  end if;

  -- (i) A reorder aimed at another project id touches nothing HERE. SECURITY INVOKER
  --     plus the function's own `s.project_id = p_project_id` are what make that true;
  --     a DEFINER function without an owner check would rewrite another tenant's board.
  --     Asserting the smoke project's order is UNCHANGED afterwards is the evidence —
  --     "the call did not raise" would pass even if it had scrambled every row.
  perform public.reorder_project_statuses(
    gen_random_uuid(), array['todo','done']::text[]);

  select slug into v_name from public.project_statuses
   where project_id = v_proj and position = 1;
  if v_name <> 'qa' then
    raise exception
      'SPRIN-77 SMOKE FAIL: a reorder aimed at another project id changed THIS project. '
      'position 1 is now %, expected qa.', v_name;
  end if;

  delete from public.projects where id = v_proj;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'SPRIN-77 SMOKE FAIL: smoke project delete removed % rows, expected 1', v_n;
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  raise notice
    'SPRIN-77 SMOKE OK: insert, rename, slug refusal, is_initial refusal, delete refusal, '
    'case-insensitive duplicate rejection, cross-project reuse, dense reorder and '
    'cross-tenant reorder isolation all pass.';
end $$;

-- -----------------------------------------------------------------------------
-- 7. Post-state assertions. The smoke test above proves BEHAVIOUR; this proves the
--    SHAPE survived, so a future "tidy-up" that reverts the model is caught by the
--    next apply rather than by a user.
-- -----------------------------------------------------------------------------
do $$
declare
  v_cmds text;
begin
  select string_agg(polcmd::text, ',' order by polcmd::text) into v_cmds
    from pg_policy where polrelid = 'public.project_statuses'::regclass;
  -- r = select, a = insert, w = update. No 'd' (delete), no '*' (for all).
  if v_cmds is distinct from 'a,r,w' then
    raise exception
      'SPRIN-77: project_statuses policies are (%), expected exactly select+insert+update. '
      'A `for all` policy or a DELETE policy has appeared.', v_cmds;
  end if;

  if has_table_privilege('authenticated','public.project_statuses','UPDATE') then
    raise exception 'SPRIN-77: authenticated still holds TABLE-level UPDATE; the revoke did not take.';
  end if;
  if not has_column_privilege('authenticated','public.project_statuses','name','UPDATE') then
    raise exception 'SPRIN-77: authenticated cannot UPDATE name; the column grant did not take.';
  end if;
  if has_column_privilege('authenticated','public.project_statuses','slug','UPDATE') then
    raise exception 'SPRIN-77: authenticated can still UPDATE slug.';
  end if;
end $$;

-- PostgREST caches the schema, and this migration adds an RPC. Without this,
-- /rest/v1/rpc/reorder_project_statuses 404s until the next reload. Delivered at
-- COMMIT, so it is correctly a no-op if we abort.
notify pgrst, 'reload schema';

commit;
