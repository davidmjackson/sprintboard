-- =============================================================================
-- SPRIN-82  A Kanban project has no sprints   (Rung 3 epic SPRIN-73, slice 2)
--
-- ONE STATEMENT: revoke the table-wide UPDATE privilege on `projects` from the
-- two client roles. That turns SPRIN-81's app-layer immutability claim into a
-- database control.
--
-- WHY THIS STORY AND NOT SPRIN-81. SPRIN-81's own migration file says the
-- hardening "was deliberately left out of this story's scope", and it was right
-- to: nothing read `project_type`, so a rewritten value changed no behaviour.
-- SPRIN-82 is the story that makes behaviour depend on the column — the Sprints
-- nav link, the /sprints route and the ticket sprint picker are all now decided
-- by `hasSprints(project)`. A claim only needs a control once something rests
-- on it. Something now does.
--
-- MEASURED LIVE BEFORE WRITING THIS FILE, not recalled — `pg_class.relacl`:
--
--   projects           postgres=arwdDxtm/postgres
--                      anon=arwdDxtm/postgres            <- holds w (UPDATE)
--                      authenticated=arwdDxtm/postgres   <- holds w (UPDATE)
--                      service_role=arwdDxtm/postgres
--
--   project_statuses   authenticated=ardDxtm/postgres    <- no w: SPRIN-77 held
--                      anon=arDxtm/postgres
--
-- Nobody GRANTED those. Supabase's ALTER DEFAULT PRIVILEGES hands anon and
-- authenticated full DML on every new table in `public`, so the privilege is
-- there by default and the REVOKE is the statement that changes something.
-- `project_statuses` is shown as the control: its `w` is already gone, which is
-- how we know a revoke of this shape sticks on this database.
--
-- NO COLUMNS ARE GRANTED BACK, because nothing in `src/` updates `projects` at
-- all. Verified by reading the tree, not assumed: the only two call sites are
-- `.insert()` (src/lib/projects.ts:40) and `.select()` (src/lib/projects.ts:67).
-- After this migration the app holds INSERT, SELECT and DELETE on `projects`
-- and no UPDATE, which is exactly the set it uses.
--
-- THIS IS NOT THE project_statuses SHAPE, AND THE KNOWN TRAP DOES NOT ARISE.
-- Say this out loud so the next reader does not assume it was missed. The trap
-- (see the long comment above the project_statuses grants in
-- docs/sprintboard_phase1_schema.sql) is that `revoke update (project_type) on
-- projects from authenticated` reads correctly and is a SILENT NO-OP: Postgres
-- does not let a column-level REVOKE carve a hole in a table-level grant. That
-- shape is what forces the revoke-then-grant-columns-back dance on
-- project_statuses. It is irrelevant here because the statement below revokes
-- the TABLE privilege itself, and there is no column-level grant to get wrong.
-- If a later story ever needs one column back, it must use `grant update (col)`
-- — see THE COST below.
--
-- WHAT THIS IS AND IS NOT. It closes a DATA-INTEGRITY hole, not a
-- tenant-isolation one. There was never a cross-tenant hole here: `projects_owner`
-- is `for all` on `owner_id = auth.uid()`, so the write was already confined to
-- the owner's own row, and a stranger's PATCH was already filtered to zero rows.
-- What this prevents is the owner doing it to themselves — flipping their own
-- Scrum project to Kanban and stranding their own sprints and every ticket on
-- them behind a UI that, as of this story, no longer shows sprints at all. The
-- rows would still be there; nothing in the app would ever render them again.
--
-- CONSEQUENCE FOR AN EXISTING TEST, which is real and is handled in this story's
-- diff rather than left to be discovered. `src/test/rls.integration.test.ts`'s
-- "B cannot UPDATE any of it" counted rows, because RLS FILTERS rather than
-- raises: an unauthorised update returns success with zero rows. After this
-- revoke, B's `update` on `projects` is refused by the PRIVILEGE before any
-- policy is consulted, so it returns 42501 with `data === null` and the
-- row-count assertion fails. The `projects` line was DELETED from that test
-- rather than re-pointed at `null`: re-pointing it would make it pass because
-- of this grant, so deleting `projects_owner` would no longer redden it — two
-- controls on one write, and the test could no longer tell you which is
-- holding. Nothing was lost: `projects` keeps its cross-tenant SELECT and DELETE
-- coverage in that same suite, and its cross-tenant INSERT coverage (the
-- spoofed-`owner_id` 42501) in `src/test/projects.integration.test.ts`, which is
-- also where the new owner-side 42501 assertion for this migration lives.
--
-- THE COST, STATED PLAINLY, AND IT IS THREE THINGS RATHER THAN ONE. A future
-- "rename a project" story cannot work until it runs
--
--     grant update (name) on projects to authenticated;
--
-- That is one line, and it is the correct direction of travel: deny by default,
-- widen deliberately and visibly. Do not pre-grant columns nothing writes yet.
-- But it does NOT stand alone. That story owes three things, and the second and
-- third are the ones that will be forgotten because nothing goes red to ask for
-- them:
--
--   1. `grant update (name) on projects to authenticated;` — this file's line.
--   2. Narrow the AST guard in `src/test/project-type-immutability.test.ts` so
--      check 5 inspects an update's PAYLOAD for `project_type` instead of
--      forbidding every write to `projects`. Without this the guard blocks the
--      merge — which is the one obligation that announces itself.
--   3. **Restore a cross-tenant `projects` UPDATE row-count assertion to
--      `src/test/rls.integration.test.ts`'s "B cannot UPDATE any of it".** The
--      line SPRIN-82 deleted (see CONSEQUENCE FOR AN EXISTING TEST above) was
--      removed because no UPDATE privilege remained for RLS to filter. A column
--      grant hands that privilege back for `name`, so `projects_owner` becomes
--      load-bearing again for a verb nothing tests — and B renaming A's project
--      is a real cross-tenant write. Bring it back as
--      `.update({ name: 'pwned' })` and assert `[]`, the same shape `sprints`
--      and `tickets` still use.
--
-- Obligation 3 is also written where that story will actually be reading: the
-- comment above the revoke in docs/sprintboard_phase1_schema.sql, and the note
-- in rls.integration.test.ts explaining the deleted line. A migration banner is
-- not somewhere a future author has any reason to open.
--
-- WHY anon IS INCLUDED. It holds the identical `arwdDxtm` and has no policy on
-- this table, so it can update nothing today regardless. A privilege that
-- nothing may use is exactly how the next audit produces a false positive, and
-- SPRIN-80 revoked DELETE from anon on project_statuses for the same reason.
--
-- WHAT THIS DOES NOT REPLACE. The AST guard in
-- `src/test/project-type-immutability.test.ts` stays. The two layers fail on
-- DISJOINT mutations — restoring this grant TABLE-WIDE reddens the live 42501
-- assertion in src/test/projects.integration.test.ts and leaves the guard
-- green; adding a `.update({ project_type })` to `src/` reddens the guard and
-- leaves the live assertion green (the app would simply get a 42501 it does not
-- handle). Neither is the other's backstop, so neither hides the other's
-- regression.
--
-- THAT FIRST HALF IS CONDITIONAL, AND THE CONDITION IS THE SHAPE OF THE
-- RE-GRANT. An earlier draft of this banner said flatly that "restoring this
-- grant reddens the live test", which is true only of `grant update on
-- projects` — the table-wide form. It is FALSE of the column form this file
-- itself prescribes for a future rename story: after
--
--     grant update (name) on projects to authenticated;
--
-- `project_type` is still not a granted column, so the owner-side PATCH still
-- earns its 42501 and that test stays green — while UPDATE on `projects`
-- reaches RLS again for `name`. The privilege layer is then partially back with
-- nothing in the suite noticing, which is precisely why obligation 3 under THE
-- COST below exists: no test anywhere currently asserts that B cannot rename
-- A's project. Do not read the disjointness argument above as covering the
-- column case. It does not.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- One explicit transaction. If any statement errors, NOTHING lands.
--
-- RE-RUN: safe, and a no-op. REVOKE on a privilege that is not held succeeds
-- silently; no data is touched and no row is rewritten. The post-state block
-- below re-verifies the end state either way.
-- =============================================================================

begin;

-- 1. The whole change.
revoke update on projects from authenticated, anon;

-- 2. Post-state check. Re-reads relacl and fails the transaction if either role
--    still holds UPDATE.
--
--    The same two honest limits as SPRIN-81's block apply, and are worth
--    restating rather than assuming the reader has that file open:
--
--      a) It runs INSIDE the transaction that just did the revoke, so it is
--         reading back its own work. There is no path where the REVOKE above
--         succeeds and this readback disagrees. What it actually catches is
--         someone editing the REVOKE and not this block — a different role
--         name, a different table.
--      b) CI cannot see any of this. PostgREST has no access to pg_catalog, so
--         no test in the repo can read relacl. What pins live BEHAVIOUR is the
--         42501 assertion in src/test/projects.integration.test.ts, which runs
--         against the real database on every PR.
--
--    The NOTICE is not decoration: it prints the full ACL so a human running
--    this by hand can see `arwdDxtm` become `ardDxtm` for both roles, which is
--    the actual evidence the migration did what its banner says.
do $$
declare
  acl_text text;
  offenders text;
begin
  select coalesce(array_to_string(rel.relacl, E'\n  '), '(null - owner-only)')
    into acl_text
  from pg_class rel
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'projects';

  -- Not dead code despite the coalesce: a SELECT INTO that matches NO ROW sets the
  -- target to NULL without ever evaluating its select list, so this fires exactly
  -- when public.projects does not exist. The coalesce covers the other case — a
  -- relation whose relacl is NULL, which means default (owner-only) privileges.
  if acl_text is null then
    raise exception 'SPRIN-82: no public.projects relation found';
  end if;

  raise notice 'SPRIN-82: projects relacl is now: %', acl_text;

  select string_agg(p.grantee::regrole::text || '=' || p.privilege_type, ', ')
    into offenders
  from pg_class rel
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  cross join lateral aclexplode(rel.relacl) as p
  where nsp.nspname = 'public'
    and rel.relname = 'projects'
    and p.privilege_type = 'UPDATE'
    and p.grantee::regrole::text in ('authenticated', 'anon');

  if offenders is not null then
    raise exception 'SPRIN-82: UPDATE on projects is still granted to: %', offenders;
  end if;
end $$;

commit;
