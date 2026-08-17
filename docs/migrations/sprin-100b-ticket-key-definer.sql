-- SPRIN-100b -- assign_ticket_key becomes SECURITY DEFINER
-- Epic SPRIN-75, story 3. Follow-up to sprin-100-board-tables-membership.sql,
-- which was already applied when this defect surfaced.
--
-- ASCII ONLY, same reason as every migration in this directory.
--
--
-- WHAT WENT WRONG, AND HOW IT WAS FOUND
--
-- sprin-100 made the board tables resolve to membership. A member who is not the
-- owner could then read and write tickets -- but CREATING one failed:
--
--   23502  null value in column "key" of relation "tickets"
--          violates not-null constraint
--
-- Found by board-membership.integration.test.ts's positive control on the ticket
-- key, which exists precisely because the key is the only observable proof that
-- the trigger's internals ran. Every other membership assertion passed. A suite
-- without that control would have reported this story green and shipped a
-- database where members cannot create tickets.
--
-- THE CAUSE IS NOT THE COUNTER, WHICH IS THE OBVIOUS SUSPECT AND IS INNOCENT.
-- assign_ticket_key does two reads-with-side-effects:
--
--   update public.project_counters ... returning last_number into v_num;  -- OK
--   select key into v_key from public.projects where id = new.project_id; -- NULL
--
-- counters_owner now resolves to membership, so the first statement succeeds for
-- a member. projects_owner is STILL `owner_id = auth.uid()` -- it is SPRIN-101's
-- to change and sprin-100 deliberately did not touch it -- so the second returns
-- ZERO ROWS for a member, v_key is NULL, and `v_key || '-' || v_num` is NULL.
--
-- Proved two independent ways rather than asserted: `number` is column 3 and
-- `key` is column 4, both NOT NULL, and Postgres reported `key`. Had v_num been
-- NULL the violation would have named `number` first. So the counter write
-- worked and only the projects read did not.
--
-- The general lesson, which outlives this fix: a SECURITY INVOKER trigger has a
-- hidden dependency on every table it READS, not only the ones it writes. Neither
-- SPRIN-100's nor SPRIN-101's story description mentioned that assign_ticket_key
-- reads projects at all.
--
--
-- THE FIX, AND WHAT IT COSTS
--
-- assign_ticket_key becomes SECURITY DEFINER, matching create_project_counter
-- (changed by sprin-100 for a closely related reason) and the two seeding
-- triggers. The function body is UNCHANGED; only the security context moves.
--
-- THIS DELETES A DELIBERATE CONTROL, and saying so plainly is the point of this
-- paragraph. The schema comment above assign_ticket_key read, until this
-- migration rewrote it:
--
--   "Deliberately NOT security definer: it runs as the caller, so the update
--    below is only permitted by the counters_owner RLS policy. Atomicity
--    therefore rests on that policy continuing to grant the writer a write. If
--    anyone ever narrows counters_owner to read-only, ticket creation breaks
--    here -- that is the intended failure."
--
-- That was a TRIPWIRE, not a boundary: it made a mistake in counters_owner fail
-- loudly instead of silently. It is genuinely lost, and nothing replaces it. What
-- is NOT lost is the boundary itself -- a stranger creating a ticket is refused by
-- tickets_owner's WITH CHECK, which is evaluated after BEFORE-triggers run, so the
-- counter increment this trigger performs is rolled back with the statement.
-- board-membership.integration.test.ts asserts that refusal (42501, with the
-- row-level-security message rather than the code alone) and re-reads with the
-- service-role client to prove nothing landed.
--
-- Alternatives considered, both rejected by David after the trade was put to him:
--
--   * Bring projects SELECT to membership now. It is the real end state and is
--     SPRIN-101's first AC, but it makes read broader than write on projects one
--     story BEFORE SPRIN-104 audits for exactly that -- every app-layer write path
--     on projects would start silently affecting zero rows for a member. Pulling a
--     hazard class forward into a story with no budget to audit it is worse than
--     the tripwire being lost.
--   * A membership-checked definer helper returning only projects.key, leaving
--     this function an invoker so the counter tripwire survives. Surgical, but it
--     buys one tripwire with a fourth security-definer function, and a naive
--     version that returned any project's key would be a cross-tenant oracle.
--
-- FOR WHOEVER WRITES SPRIN-101: once projects SELECT resolves to membership, the
-- reason this function needed the definer disappears. Reverting it would restore
-- the counter tripwire. That is a real option and it should be a decision, not an
-- inheritance -- which is why it is written down here rather than left to be
-- rediscovered.
--
-- NOTE ON THE REVOKE. CREATE OR REPLACE preserves an existing ACL, and this
-- function is currently EXECUTE-to-public. A definer function must not keep a
-- grant it does not need. Revoking EXECUTE does NOT stop the trigger firing:
-- Postgres checks EXECUTE on a trigger function at CREATE TRIGGER time, not on
-- each fire. seed_project_admin and create_project_counter both already sit at
-- {postgres, service_role} and their triggers fire for ordinary authenticated
-- users -- measured, not assumed.


begin;

create or replace function assign_ticket_key()
returns trigger
language plpgsql
security definer
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

revoke execute on function public.assign_ticket_key() from public, anon, authenticated;

commit;


-- ===========================================================================
-- AFTER APPLYING -- verify from the CATALOGUE, not the editor's "Success"
-- ===========================================================================
--
--   select proname, prosecdef, proacl::text, proconfig
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'assign_ticket_key';
--
--   EXPECT prosecdef = true, proconfig = {"search_path=\"\""},
--          proacl = {postgres=X/postgres,service_role=X/postgres}
--
-- And the trigger must still be attached and still BEFORE INSERT:
--
--   select tgname, tgenabled from pg_trigger
--   where tgrelid = 'public.tickets'::regclass and tgname = 'on_ticket_insert';
--
-- Advisors: this changes no policy, so expect the same 12 performance lints and
-- 1 security WARN sprin-100 left. In particular expect NO new
-- function_search_path_mutable lint -- the search_path was already pinned, which
-- is what makes the definer affordable.
--
-- The real proof is the suite:
--   env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY npm run verify
-- board-membership.integration.test.ts must go 16/16.
