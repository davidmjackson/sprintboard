-- SPRIN-98b -- default privileges for the app_auth schema (epic SPRIN-75).
--
-- ASCII ONLY, like every migration here.
--
-- A SECOND, SMALL migration rather than an edit to sprin-98-project-members.sql, because
-- that one is already applied. Migrations in this project are hand-applied and are a
-- record of what was run; rewriting an applied file would make the record a lie.
--
-- ============================================================================
-- WHY
-- ============================================================================
-- Found by the SPRIN-98 adversarial review, and measured rather than theorised:
--
--   select count(*) from pg_default_acl d
--     join pg_namespace n on n.oid = d.defaclnamespace
--    where n.nspname = 'app_auth';                     -- 0
--
-- Every other schema in this database (auth, extensions, graphql, graphql_public,
-- public, realtime, storage) has default-ACL entries. app_auth, the newest and the one
-- holding SECURITY DEFINER functions, has none.
--
-- That matters because CREATE FUNCTION grants EXECUTE to PUBLIC by default, and
-- sprin-98-project-members.sql permanently granted `authenticated` USAGE on this schema
-- so its RLS policies can resolve the predicate names. The two facts compose badly: the
-- next `create function app_auth.<anything>` -- SPRIN-99, SPRIN-100 and SPRIN-101 all
-- add membership predicates -- is immediately callable by every signed-in user unless
-- its author remembers the two hand-written revoke lines that sit ~75 lines away from
-- where the function goes.
--
-- Deny by default is cheaper than remembering. This makes the revoke the DEFAULT rather
-- than a step, so a forgotten revoke fails closed instead of open.
--
-- It does NOT retro-fix the two existing functions -- default privileges apply only to
-- objects created AFTERWARDS. Those two are already correctly revoked (verified from
-- pg_proc.proacl: {postgres=X, authenticated=X}, no PUBLIC), so there is nothing to
-- repair; this is purely about the next one.

begin;

-- `for role postgres` names the role whose CREATEs this applies to. Default privileges are
-- keyed on the creating role, and omitting the clause defaults to the current role -- which
-- in the Supabase SQL editor IS postgres, so today the two forms are identical. It is
-- written explicitly as future-proofing (a migration applied by any other role would
-- otherwise protect nothing), NOT because it changes behaviour now. An earlier draft of
-- this comment called it "required, not decorative", which overstated it -- in a migration
-- whose whole review theme was not overclaiming.
alter default privileges for role postgres in schema app_auth
  revoke execute on functions from public;

commit;

-- ============================================================================
-- AFTER APPLYING
-- ============================================================================
-- Confirm from the catalogue, not from the editor:
--
--   select n.nspname, pg_get_userbyid(d.defaclrole) as owner, d.defaclobjtype,
--          d.defaclacl::text
--     from pg_default_acl d
--     join pg_namespace n on n.oid = d.defaclnamespace
--    where n.nspname = 'app_auth';
--
-- Expect one row, defaclobjtype = 'f' (functions), with PUBLIC absent from defaclacl.
--
-- Advisor expectation: NO change. This grants nothing and creates no object; it only
-- narrows what future objects are born with. Baseline at the time of writing is 16
-- performance lints and 1 security WARN -- re-derive with get_advisors rather than
-- trusting this line, and see the note in sprin-98-project-members.sql about
-- `unused_index` readings taken immediately after a migration.
--
-- NOTHING IN CI CAN SEE WHETHER THIS RAN. PostgREST cannot read pg_catalog, so the live
-- suites cannot assert a pg_default_acl row, and there is no other gate. That makes this
-- a guard whose gate is a human: if it is never applied, SPRIN-99/100/101 get exactly the
-- open door described above and nothing goes red. Applying it is therefore part of
-- SPRIN-98, not a nice-to-have deferred to whoever notices.
