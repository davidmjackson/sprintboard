-- =============================================================================
-- SPRIN-80  Delete a status without stranding the tickets on it
--           (Rung 3 epic SPRIN-72, slice 4 — the last)
--
-- BOTH HALVES SHIP HERE, AND NEITHER IS SAFE ALONE. Adding a DELETE policy while
-- tickets.status still defaults to the bare literal 'todo' breaks ticket creation
-- permanently for any project whose `todo` row is deleted — and a NEW project's
-- `todo` holds no tickets, so it is deletable even under the "refuse a non-empty
-- status" rule this story implements.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- RE-RUN: safe. Every statement is idempotent.
-- =============================================================================

begin;

set local lock_timeout      = '5s';
set local statement_timeout = '120s';

-- 1. Preconditions.
do $$
declare v_bad int;
begin
  if not exists (select 1 from pg_policy
                 where polrelid = 'public.project_statuses'::regclass
                   and polname  = 'statuses_owner_update') then
    raise exception 'SPRIN-80: statuses_owner_update is missing. Apply SPRIN-77 first.';
  end if;

  -- The promotion trigger and the insert resolution both assume exactly one initial
  -- status per project. Prove it BEFORE depending on it.
  select count(*) into v_bad from public.projects p
   where (select count(*) from public.project_statuses s
           where s.project_id = p.id and s.is_initial) <> 1;
  if v_bad > 0 then
    raise exception 'SPRIN-80: % project(s) do not have exactly one is_initial status.', v_bad;
  end if;
end $$;

-- 2. The DELETE policy. project_statuses now carries FOUR policies split by verb:
--    read, insert, update, delete. Keep the split — but be honest about what enforces it.
--
--    ALL FOUR PREDICATES ARE IDENTICAL, so a single `for all` policy would be
--    BEHAVIOURALLY INDISTINGUISHABLE: INSERT ignores USING, UPDATE gets both, SELECT and
--    DELETE get USING. The narrowing that genuinely bites — an owner cannot write
--    `is_initial` or `slug` — is a column PRIVILEGE, not a policy, and survives a collapse
--    untouched. So no Vitest test can go red on it: PostgREST cannot read pg_policy, and
--    an earlier draft of this comment (and of the schema file and rls.integration.test.ts)
--    claimed one does. The ONLY thing pinning the four-way split is step 7's post-state
--    assertion in this file, which runs at APPLY time and not in CI.
--
--    The split is still wanted: it is the shape SPRIN-75's membership model will diverge
--    the predicates within, and re-splitting a collapsed policy under a live security
--    rewrite is strictly worse than keeping them apart now.
--
--    `(select auth.uid())` rather than a bare `auth.uid()` is DELIBERATE and differs
--    from the surrounding policies: it keeps this policy out of the auth_rls_initplan
--    advisor. The existing eight warnings are pre-existing and are SPRIN-75's to fix
--    together; this story must not add a ninth. Do not "make it consistent".
--    (Measured before writing this: EXPLAIN over the same predicate renders the
--    scalar subquery as an InitPlan, evaluated once per query rather than per row.)
drop policy if exists statuses_owner_delete on public.project_statuses;
create policy statuses_owner_delete on public.project_statuses
  for delete
  using (exists (select 1 from public.projects p
                 where p.id = project_statuses.project_id
                   and p.owner_id = (select auth.uid())));

-- MEASURED, not assumed: relacl on this table is already `authenticated=ardDxtm`, so
-- the grant below is a no-op and the REVOKE is the statement that changes something —
-- `anon` holds table-level DELETE today and has no reason to. RLS was the only thing
-- standing between anon and this table for that verb; now the privilege is gone too.
grant  delete on public.project_statuses to authenticated;
revoke delete on public.project_statuses from anon;

-- 3. A project must keep at least one status. Nothing but a trigger can express this:
--    it is a statement about the SIBLING rows, which no constraint can see.
--
--    SECURITY DEFINER so the count is of ALL sibling rows rather than the rows the
--    caller's policies happen to expose. Under SPRIN-75's membership model, where read
--    may be broader or narrower than write, an invoker-side count would silently start
--    guarding the wrong thing.
create or replace function public.project_statuses_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- THE CASCADE ESCAPE HATCH, AND IT IS LOAD-BEARING — WITHOUT IT, DELETING A PROJECT
  -- FAILS. `projects` cascades to `project_statuses`, and that cascade is ONE statement
  -- (`delete from project_statuses where project_id = $1`) removing every row. This
  -- BEFORE ROW trigger fires per row, and a plpgsql SPI query is not read-only, so it
  -- takes a FRESH snapshot with a bumped command id: the siblings this very statement
  -- has already removed are INVISIBLE to the count below. On the last row the count
  -- reads 1 and the guard aborts a delete that was always legitimate.
  --
  -- The parent lookup is the discriminator, and it is exact rather than heuristic: the
  -- RI cascade runs as an AFTER trigger on `projects`, so by the time it reaches here
  -- the project row is already gone. "Keep at least one status" is vacuous for a
  -- project that no longer exists, so returning early is correct on its own terms and
  -- not merely a workaround. Step 6 (f) is the test — it deletes the smoke projects and
  -- requires four rows to go.
  --
  -- AND THE SAME LOOKUP IS THE CONCURRENCY LOCK. `for update` is not decoration: without
  -- it this guard is a check-then-act across two transactions and BOTH of its invariants
  -- can be broken by two concurrent PostgREST requests, each of which is its own READ
  -- COMMITTED transaction:
  --
  --   (a) ZERO STATUSES. A project down to two statuses; T1 deletes one and T2 deletes
  --       the other. An uncommitted delete is still visible as PRESENT to the other
  --       snapshot, so each counts 2, each passes, both commit, and the project ends with
  --       none — SB002 on every subsequent ticket insert.
  --   (b) ZERO INITIAL STATUSES. Statuses A(initial, pos 1), B(pos 2), C(pos 3). T1
  --       deletes A while T2 deletes B. T1's promotion (step 4) resolves the
  --       lowest-position survivor to B; T2 commits first; T1's `update ... where id = B`
  --       then matches no row and nothing is initial afterwards.
  --
  -- NEITHER IS RECOVERABLE FROM THE UI: `is_initial` is outside the column UPDATE grant
  -- and createProjectStatus hardcodes `is_initial: false`, so a bricked project needs SQL.
  --
  -- THE LOCK IS ON `projects`, NOT ON `project_statuses`, AND THAT IS THE POINT. Locking
  -- the outgoing status row would be free — the DELETE already holds it — and would
  -- serialise nothing, because (a) and (b) are races between deletes of DIFFERENT rows.
  -- What both need is a mutex over the whole per-project vocabulary, and the parent row
  -- is the only object every delete for that project already touches. So every delete for
  -- one project queues behind the same row while deletes across different projects stay
  -- fully parallel.
  --
  -- LOCK ORDER: NOT SETTLED, AND THIS COMMENT NO LONGER PRETENDS IT IS. It used to read
  -- "Order is stable and deadlock-free: the executor has already taken the row lock on the
  -- status tuple before firing this trigger, so every caller takes status-then-project" —
  -- a mechanism offered as the REASON no deadlock can form. It cannot carry that weight.
  --
  --   * CERTAIN: a BEFORE ROW DELETE trigger runs before the target tuple is DELETED. It may
  --     cancel the row operation by returning NULL, which is only meaningful while the
  --     removal has not happened. That is the documented BEFORE-trigger contract.
  --   * NOT CERTAIN: whether that tuple is already LOCKED when this body runs. Locking and
  --     deleting are different acts, so the contract above decides nothing about it — and
  --     PostgreSQL's ExecBRDeleteTriggers appears to take an exclusive tuple lock (through
  --     GetTupleForTrigger) BEFORE invoking the trigger, which would make the original claim
  --     right about the lock and wrong about nothing else. NOTHING HERE HAS TESTED EITHER
  --     READING: there is no local PostgreSQL to reproduce it against, and the agents that
  --     wrote and reviewed this have read-only access to the live database.
  --
  -- So read "deadlock-free" as UNPROVEN, not established. If the tuple is locked first, a
  -- concurrent `delete from projects` runs the REVERSE order — it locks the project row, then
  -- its RI cascade reaches these rows — and a circular wait between the two is possible.
  -- PostgreSQL detects that and aborts one side with 40P01: a clean rollback, not corruption,
  -- and it needs a status delete racing a delete of that same project. Worth knowing; not
  -- worth a lock-ordering scheme on this evidence.
  --
  -- The CASCADE path cannot deadlock against this guard, and that part does NOT depend on any
  -- of the above: by the time the cascade reaches here the parent project row is already gone
  -- WITHIN that transaction, so the lookup below finds nothing and returns at the escape hatch
  -- without ever waiting on `projects` — and that transaction holds the project's own lock in
  -- any case.
  --
  -- ALL OF THIS IS REASONED, NOT TESTED. No test in this repo opens two concurrent sessions,
  -- so neither the deadlock question nor the mutual exclusion `for update` exists to provide
  -- has any coverage: step 6's smoke block stays entirely green with the `for update` removed.
  perform 1 from public.projects p where p.id = old.project_id for update;
  if not found then
    return old;
  end if;

  -- Counted AFTER the lock, and the ordering is what makes the count trustworthy. plpgsql
  -- SPI queries are not read-only, so under READ COMMITTED this statement takes a snapshot
  -- at the moment it runs — i.e. after any transaction we queued behind has committed. A
  -- count taken before the lock would be exactly the stale read race (a) exploits.
  if (select count(*) from public.project_statuses s
       where s.project_id = old.project_id) <= 1 then
    raise exception 'A project must keep at least one status.'
      using errcode = 'SB001';
  end if;
  return old;
end;
$$;

revoke execute on function public.project_statuses_delete_guard() from public, anon, authenticated;

drop trigger if exists project_statuses_delete_guard on public.project_statuses;
create trigger project_statuses_delete_guard
  before delete on public.project_statuses
  for each row execute function public.project_statuses_delete_guard();

-- 4. Deleting the initial status promotes the lowest-position survivor.
--
--    AFTER, NOT BEFORE, and that is forced rather than stylistic:
--    project_statuses_one_initial_per_project is a PARTIAL unique index, a partial index
--    cannot be a constraint, and only a constraint can be DEFERRABLE. During a BEFORE
--    DELETE the outgoing row still holds is_initial = true, so setting it on another row
--    collides immediately. After the delete there is nothing to collide with.
--
--    The guard in step 3 has already run, so a survivor is guaranteed to exist.
--
--    IT ALSO INHERITS THE GUARD'S LOCK, and that is what closes race (b) — do not read
--    this function as unsynchronised just because it takes no lock of its own. The BEFORE
--    trigger has already taken `for update` on the parent project, and a row lock is held
--    to end of transaction, so this AFTER trigger runs with every other delete for that
--    project queued behind it. Its subquery is a plpgsql SPI query, not read-only, so
--    under READ COMMITTED it takes a fresh snapshot at the moment it runs: any sibling a
--    transaction we queued behind removed is already gone from it, and the promotion
--    lands on a row that still exists. DO NOT MOVE THE LOCK OUT OF STEP 3 — the two
--    functions are one critical section, and only one of them takes it.
--
--    `order by position limit 1` is deterministic only because
--    project_statuses_project_position_unique exists. That constraint is DEFERRABLE
--    INITIALLY DEFERRED, so inside a multi-statement transaction two rows CAN transiently
--    share a position; the tie would then be broken arbitrarily. Nothing does that today
--    (the reorder RPC is the only writer that relies on the deferral, and it does not
--    delete), but a future caller that deletes and reorders in one transaction turns this
--    into a coin toss.
--
--    No cascade escape hatch is needed here, unlike step 3: AFTER ROW triggers fire at
--    the END of their statement, so during a project cascade every sibling is already
--    gone, the subquery finds nothing, and the update touches no rows.
create or replace function public.project_statuses_promote_initial()
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

drop trigger if exists project_statuses_promote_initial on public.project_statuses;
create trigger project_statuses_promote_initial
  after delete on public.project_statuses
  for each row execute function public.project_statuses_promote_initial();

-- 5. A new ticket's status resolves from is_initial, replacing the bare 'todo' default.
--
--    A BEFORE INSERT trigger fires before the NOT NULL check, so an insert that omits
--    `status` arrives here as NULL and leaves with a slug. An insert that NAMES a status
--    is left alone.
--
--    SECURITY DEFINER for the same reason as step 3: this read must not depend on
--    statuses_owner_read staying broad enough for whoever is inserting.
create or replace function public.resolve_initial_ticket_status()
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

drop trigger if exists resolve_initial_ticket_status on public.tickets;
create trigger resolve_initial_ticket_status
  before insert on public.tickets
  for each row execute function public.resolve_initial_ticket_status();

alter table public.tickets alter column status drop default;

-- -----------------------------------------------------------------------------
-- 6. Smoke test, as a real `authenticated` user, inside this transaction. If any
--    assertion fails the whole migration rolls back — which is why it lives here and
--    not in a follow-up script.
--
--    It proves, in order:
--      (a) POSITIVE CONTROL — an empty added status deletes, and exactly one row goes.
--          Every refusal below is only evidence of a guard if this passes first.
--      (b) a status holding a ticket is refused with foreign_key_violation, and BOTH
--          the ticket and the status survive.
--      (c) deleting down to one status works, and deleting that last one raises SB001.
--      (d) deleting the initial status promotes the lowest-position survivor, and a
--          ticket inserted with no `status` then lands on it.
--      (e) tickets.status carries no column default any more.
--      (f) the guard still refuses the last status while the caller already holds the
--          parent project's row lock — the guard's own `for update` is re-entrant and
--          does not turn a refusal into an error or a self-deadlock.
--      (g) a project delete still cascades — the guard does not block its own teardown,
--          and the added lock does not change that (the parent row is already gone, so
--          the escape hatch returns before any lock is attempted).
--
--    WHAT IT CANNOT PROVE. The guard's lock exists to serialise CONCURRENT transactions,
--    and a single-transaction smoke block has no second session. (f) and (g) pin the
--    lock's side effects — that it does not break a legitimate refusal or the cascade —
--    and nothing here pins the mutual exclusion itself. Do not add a step that pretends
--    to; the honest coverage is that removing `for update` leaves every assertion below
--    green, and only step 7's shape checks and this comment stand between a "tidy-up" and
--    the two races step 3 describes.
-- -----------------------------------------------------------------------------
do $$
declare
  v_owner  uuid;
  v_p1     uuid;
  v_p2     uuid;
  v_p3     uuid;
  v_p4     uuid;
  v_ticket uuid;
  v_n      int;
  v_slug   text;
  v_lowest text;
  v_hasdef boolean;
begin
  select id into v_owner from auth.users order by created_at limit 1;
  if v_owner is null then
    raise exception 'SPRIN-80: no auth.users row to run the smoke test as. Aborting.';
  end if;

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  -- THE ROLE SWITCH IS A PRECONDITION OF EVERY ASSERTION BELOW, NOT A FORMALITY. If
  -- set_config('role', …) ever no-ops — a renamed role, a future GUC change, a
  -- copy-paste that drops the line — this block runs on as the migration's superuser,
  -- which BYPASSES RLS entirely. Step (a) would then pass without the DELETE policy
  -- existing at all, and the whole smoke test would be evidence of nothing.
  if current_user <> 'authenticated' then
    raise exception 'SPRIN-80 SMOKE FAIL: running as %, expected authenticated. The role '
                    'switch did not take, so every RLS assertion below would be vacuous.',
                    current_user;
  end if;

  insert into public.projects (owner_id, name, key)
  values (v_owner, 'SPRIN-80 smoke: deletes',
          'Z' || upper(substr(md5(random()::text), 1, 3)))
  returning id into v_p1;

  -- (a) POSITIVE CONTROL. Without it, every refusal below could be passing because the
  --     fixture is broken rather than because a guard works.
  insert into public.project_statuses (project_id, slug, name, category, position)
  values (v_p1, 'qa', 'Ready for QA', 'in_progress', 5);

  delete from public.project_statuses where project_id = v_p1 and slug = 'qa';
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'SPRIN-80 SMOKE FAIL: deleting an empty status removed % row(s), expected 1. '
                    'The DELETE policy is missing or does not match the owner.', v_n;
  end if;

  select count(*) into v_n from public.project_statuses where project_id = v_p1;
  if v_n <> 4 then
    raise exception 'SPRIN-80 SMOKE FAIL: % statuses survive, expected the 4 seeded ones', v_n;
  end if;

  -- (b) A ticket, created WITHOUT naming a status — which is already half of (d): the
  --     column default is gone, so only the BEFORE INSERT trigger can have filled it.
  insert into public.tickets (project_id, summary)
  values (v_p1, 'Sits on the initial status')
  returning id into v_ticket;

  select status into v_slug from public.tickets where id = v_ticket;
  if v_slug is distinct from 'todo' then
    raise exception 'SPRIN-80 SMOKE FAIL: a ticket inserted with no status landed on %, '
                    'expected the seeded initial status todo.', coalesce(v_slug, '<null>');
  end if;

  --     THE REFUSAL IS DEFERRED, AND THAT CHANGES HOW IT IS TESTED. tickets_status_fk is
  --     DEFERRABLE INITIALLY DEFERRED (measured), so the DELETE below does NOT raise where
  --     it stands — the violation would surface at COMMIT, i.e. after this block, taking
  --     the migration down with a message that names no test. PostgREST commits inside the
  --     request, which is why the client still sees a plain 23503; here the check has to be
  --     forced. Restored to deferred straight afterwards: (f) relies on the deferral.
  begin
    set constraints all immediate;
    delete from public.project_statuses where project_id = v_p1 and slug = 'todo';
    raise exception 'SPRIN-80 SMOKE FAIL: deleting a status holding a ticket was ALLOWED. '
                    'tickets_status_fk is the whole of that refusal, and it did not fire.';
  exception when foreign_key_violation then
    null;  -- 23503: expected. It is the code project-statuses.ts maps to `has_tickets`.
  end;
  set constraints all deferred;

  select count(*) into v_n from public.tickets where id = v_ticket and status = 'todo';
  if v_n <> 1 then
    raise exception 'SPRIN-80 SMOKE FAIL: the refused delete did not leave the ticket intact.';
  end if;

  select count(*) into v_n from public.project_statuses
   where project_id = v_p1 and slug = 'todo';
  if v_n <> 1 then
    raise exception 'SPRIN-80 SMOKE FAIL: the status the refused delete targeted is gone.';
  end if;

  -- (c) Down to one status, then the last one. A SECOND project, because v_p1 holds a
  --     ticket on its initial status and could never be emptied to one.
  insert into public.projects (owner_id, name, key)
  values (v_owner, 'SPRIN-80 smoke: last status',
          'X' || upper(substr(md5(random()::text), 1, 3)))
  returning id into v_p2;

  delete from public.project_statuses where project_id = v_p2 and not is_initial;
  get diagnostics v_n = row_count;
  if v_n <> 3 then
    raise exception 'SPRIN-80 SMOKE FAIL: clearing the 3 non-initial statuses removed % row(s)', v_n;
  end if;

  begin
    delete from public.project_statuses where project_id = v_p2;
    raise exception 'SPRIN-80 SMOKE FAIL: deleting the LAST status of a project was ALLOWED. '
                    'project_statuses_delete_guard did not fire.';
  exception when sqlstate 'SB001' then
    null;  -- expected. It is the code project-statuses.ts maps to `last`.
  end;

  select count(*) into v_n from public.project_statuses where project_id = v_p2;
  if v_n <> 1 then
    raise exception 'SPRIN-80 SMOKE FAIL: % statuses remain after the refused delete, expected 1', v_n;
  end if;

  -- (d) Promotion, and the promotion being REAL rather than a flag nobody reads.
  insert into public.projects (owner_id, name, key)
  values (v_owner, 'SPRIN-80 smoke: promotion',
          'W' || upper(substr(md5(random()::text), 1, 3)))
  returning id into v_p3;

  select s.slug into v_lowest from public.project_statuses s
   where s.project_id = v_p3 and not s.is_initial
   order by s.position asc limit 1;

  delete from public.project_statuses where project_id = v_p3 and is_initial;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'SPRIN-80 SMOKE FAIL: deleting the initial status removed % row(s), expected 1', v_n;
  end if;

  select count(*) into v_n from public.project_statuses
   where project_id = v_p3 and is_initial;
  if v_n <> 1 then
    raise exception 'SPRIN-80 SMOKE FAIL: % initial statuses after promotion, expected exactly 1. '
                    'Zero means the AFTER DELETE promotion did not run.', v_n;
  end if;

  select s.slug into v_slug from public.project_statuses s
   where s.project_id = v_p3 and s.is_initial;
  if v_slug is distinct from v_lowest then
    raise exception 'SPRIN-80 SMOKE FAIL: promoted %, expected the lowest-position survivor %',
                    coalesce(v_slug, '<null>'), coalesce(v_lowest, '<null>');
  end if;

  insert into public.tickets (project_id, summary)
  values (v_p3, 'Lands on the promoted status')
  returning status into v_slug;
  if v_slug is distinct from v_lowest then
    raise exception 'SPRIN-80 SMOKE FAIL: a ticket created after promotion landed on %, expected %. '
                    'The two halves of this story are not joined up.',
                    coalesce(v_slug, '<null>'), coalesce(v_lowest, '<null>');
  end if;

  -- (e) The bare literal default is what this story removes. Read the catalog rather
  --     than inferring it from (b) and (d), which would also pass with a default of
  --     'todo' still sitting there on any project whose initial status happens to be todo.
  select a.atthasdef into v_hasdef
    from pg_attribute a
   where a.attrelid = 'public.tickets'::regclass and a.attname = 'status';
  if v_hasdef then
    raise exception 'SPRIN-80 SMOKE FAIL: tickets.status still carries a column default.';
  end if;

  -- (f) The guard under an ALREADY-HELD parent row lock. Step 3 added `for update` to the
  --     guard's parent lookup, so a caller that has itself locked the project row now
  --     re-enters that lock from inside the trigger. Same transaction, so it is granted
  --     immediately — but a lock clause that could not be re-entered (or that raised
  --     rather than waited) would turn a legitimate delete into an error and the SB001
  --     refusal into something no client maps. Both halves are checked: the three
  --     non-initial deletes must SUCCEED and the last must still raise SB001.
  insert into public.projects (owner_id, name, key)
  values (v_owner, 'SPRIN-80 smoke: locked parent',
          'V' || upper(substr(md5(random()::text), 1, 3)))
  returning id into v_p4;

  perform 1 from public.projects p where p.id = v_p4 for update;

  delete from public.project_statuses where project_id = v_p4 and not is_initial;
  get diagnostics v_n = row_count;
  if v_n <> 3 then
    raise exception 'SPRIN-80 SMOKE FAIL: with the parent row already locked, clearing the '
                    '3 non-initial statuses removed % row(s). The guard''s FOR UPDATE is '
                    'not re-entrant.', v_n;
  end if;

  begin
    delete from public.project_statuses where project_id = v_p4;
    raise exception 'SPRIN-80 SMOKE FAIL: with the parent row already locked, deleting the '
                    'LAST status was ALLOWED. The guard did not fire.';
  exception when sqlstate 'SB001' then
    null;  -- expected: the lock changed nothing about the refusal.
  end;

  select count(*) into v_n from public.project_statuses where project_id = v_p4;
  if v_n <> 1 then
    raise exception 'SPRIN-80 SMOKE FAIL: % statuses remain on the locked-parent project, '
                    'expected 1', v_n;
  end if;

  -- (g) Teardown IS the cascade test. project_statuses now has a BEFORE DELETE guard, and
  --     the naive form of that guard blocks the last row of the cascade and makes deleting
  --     a project impossible — see the escape hatch in step 3. The lock does not change
  --     that: the RI cascade runs as an AFTER trigger on `projects`, so the parent row is
  --     already gone and the escape hatch returns before `for update` is ever reached.
  --     Four rows must go.
  delete from public.projects where id in (v_p1, v_p2, v_p3, v_p4);
  get diagnostics v_n = row_count;
  if v_n <> 4 then
    raise exception 'SPRIN-80 SMOKE FAIL: smoke project teardown removed % row(s), expected 4. '
                    'If this is 0, the delete guard is blocking the projects cascade.', v_n;
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  raise notice
    'SPRIN-80 SMOKE OK: empty-status delete, non-empty refusal with the ticket intact, '
    'last-status SB001 refusal, promotion of the lowest-position survivor, is_initial '
    'resolution on insert, no column default, the same refusal under an already-held '
    'parent row lock, and the projects cascade all pass.';
end $$;

-- -----------------------------------------------------------------------------
-- 7. Post-state assertions. The smoke test proves BEHAVIOUR; this proves the SHAPE
--    survived, so a future "tidy-up" that reverts the model is caught by the next apply
--    rather than by a user.
-- -----------------------------------------------------------------------------
do $$
declare v_cmds text; v_confdel char;
begin
  select string_agg(polcmd::text, ',' order by polcmd::text) into v_cmds
    from pg_policy where polrelid = 'public.project_statuses'::regclass;
  -- r select, a insert, w update, d delete. No '*' (for all).
  --
  -- THIS ASSERTION IS THE ONLY THING PINNING THE FOUR-WAY SPLIT, and it runs here, at
  -- apply time, NOT in CI. No Vitest test can stand in for it: PostgREST has no access to
  -- pg_catalog, and all four predicates are identical today, so a collapsed `for all`
  -- policy would behave the same through the API and every live suite would stay green.
  if v_cmds is distinct from 'a,d,r,w' then
    raise exception 'SPRIN-80: project_statuses policies are (%), expected exactly '
                    'select+insert+update+delete. A `for all` policy has appeared.', v_cmds;
  end if;

  -- THE GUARD THE STORY ASKS TO BE PROVEN. The non-empty-status refusal IS this fk, so its
  -- shape is the control: composite (project_id, status) and NO ACTION on delete. A cascade
  -- here would DELETE tickets when a status is removed — silent data loss.
  select confdeltype into v_confdel
    from pg_constraint where conname = 'tickets_status_fk'
                        and conrelid = 'public.tickets'::regclass;
  if v_confdel is null then
    raise exception 'SPRIN-80: tickets_status_fk does not exist. The non-empty guard is gone.';
  end if;
  if v_confdel <> 'a' then
    raise exception 'SPRIN-80: tickets_status_fk on delete is %, expected NO ACTION (a).', v_confdel;
  end if;

  if (select count(*) from pg_constraint
       where conname = 'tickets_status_fk' and cardinality(conkey) <> 2) > 0 then
    raise exception 'SPRIN-80: tickets_status_fk is no longer composite.';
  end if;

  -- The privilege half of step 2. The policy is only one of the two things standing
  -- between anon and a DELETE on this table, and the other one is not visible in pg_policy.
  if not has_table_privilege('authenticated', 'public.project_statuses', 'DELETE') then
    raise exception 'SPRIN-80: authenticated cannot DELETE project_statuses; the grant did not take.';
  end if;
  if has_table_privilege('anon', 'public.project_statuses', 'DELETE') then
    raise exception 'SPRIN-80: anon still holds DELETE on project_statuses; the revoke did not take.';
  end if;
end $$;

-- The three triggers, by name, relation AND timing. tgtype is a bitmask: 1 ROW, 2 BEFORE,
-- 4 INSERT, 8 DELETE, 16 UPDATE. So BEFORE DELETE FOR EACH ROW is 11, AFTER DELETE FOR EACH
-- ROW is 9, BEFORE INSERT FOR EACH ROW is 7. Asserting the NAME alone would stay green if
-- the promotion were moved to BEFORE — the one change step 4 exists to prevent, and the one
-- that no client test can distinguish from a missing trigger.
do $$
declare v_bad text;
begin
  select string_agg(format('%s on %s: tgtype %s, expected %s',
                           e.tg, e.rel, coalesce(t.tgtype::text, 'ABSENT'), e.want),
                    '; ' order by e.tg)
    into v_bad
    from (values
      ('project_statuses_delete_guard',    'public.project_statuses', 11::int2),
      ('project_statuses_promote_initial', 'public.project_statuses',  9::int2),
      ('resolve_initial_ticket_status',    'public.tickets',           7::int2)
    ) as e(tg, rel, want)
    left join pg_trigger t
      on t.tgname = e.tg and t.tgrelid = e.rel::regclass and not t.tgisinternal
   where t.tgtype is distinct from e.want;
  if v_bad is not null then
    raise exception 'SPRIN-80: trigger check failed: %', v_bad;
  end if;
end $$;

-- And their privilege posture. SECURITY DEFINER is what lets the guard count rows the
-- caller cannot see, so definer-to-invoker is a one-token change that silently narrows
-- what is being guarded — the same class of change CLAUDE.md flags on
-- reorder_project_statuses, in the opposite direction. The pinned empty search_path is
-- the price of that privilege.
do $$
declare v_bad text; v_n int;
begin
  -- Counted first, because the check below is a filter: if the functions were missing
  -- entirely it would aggregate nothing and pass. Absence must not read as conformance.
  select count(*) into v_n from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('project_statuses_delete_guard',
                       'project_statuses_promote_initial',
                       'resolve_initial_ticket_status');
  if v_n <> 3 then
    raise exception 'SPRIN-80: expected 3 new trigger functions in public, found %', v_n;
  end if;

  select string_agg(format('%s (definer=%s, config=%s)', p.proname, p.prosecdef,
                           coalesce(array_to_string(p.proconfig, ','), 'none')), '; '
                    order by p.proname)
    into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('project_statuses_delete_guard',
                       'project_statuses_promote_initial',
                       'resolve_initial_ticket_status')
     and (not p.prosecdef
          or p.proconfig is null
          or not ('search_path=""' = any (p.proconfig)));
  if v_bad is not null then
    raise exception 'SPRIN-80: these functions are not SECURITY DEFINER with a pinned '
                    'empty search_path: %', v_bad;
  end if;
end $$;

-- PostgREST caches the schema, including column defaults. tickets.status just lost one,
-- and a stale cache would keep offering it. Delivered at COMMIT, so correctly a no-op if
-- anything above aborts.
notify pgrst, 'reload schema';

commit;
