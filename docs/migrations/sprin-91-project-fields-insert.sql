-- SPRIN-91 — Migration B: INSERT on project_fields.
--
-- Epic SPRIN-71 (custom fields), story 2 of 6. Design:
--   docs/superpowers/specs/2026-08-06-sprin-91-add-rename-custom-field-design.md §3
--
-- GRANTS ONLY. No table, column, constraint, index or policy is created, altered or
-- dropped. All four policies (fields_owner_read/insert/update/delete) already exist —
-- migration A shipped them as the table's security design rather than one story's feature.
-- This migration is what makes `fields_owner_insert` REACHABLE, and therefore what makes it
-- provable: until now a cross-tenant insert died on the missing GRANT before the policy was
-- consulted, and since a revoked grant and an RLS WITH CHECK violation share SQLSTATE 42501,
-- there was no positive control able to say which refused it. Story 1 declined to ship that
-- test rather than ship one that would pass with the policy deleted. This story pays it.
--
-- Hand-applied. The Supabase MCP is read_only=true on purpose, so this file is run in the
-- SQL editor and `get_advisors` is checked afterwards.

begin;

-- THE WHOLE INTENDED GRANT STATE, RESTATED. Not `grant insert (…)` on its own, which would
-- also work today.
--
-- A table-level REVOKE **cascades** to column grants — "the corresponding column privileges
-- (if any) are automatically revoked on each column of the table, as well" (PostgreSQL
-- REVOKE reference). The dangerous edit is therefore not this migration but the NEXT one:
-- story 6 grants DELETE, and an author who writes `revoke insert, update, delete …; grant
-- delete …` there would silently drop BOTH `update (name)` and the INSERT grant below, with
-- nothing in the diff saying so and no error at apply time.
--
-- A block that always states the complete set is idempotent, safe to re-run, and makes the
-- cascade harmless by construction. `update` is included in the revoke even though
-- `update (name)` is immediately restored, because a partial reset is exactly the shape that
-- invites the next author to write their own partial reset.
--
-- MEASURED BEFORE WRITING THIS, 2026-08-06, from the catalog rather than assumed:
--   table  project_fields   anon=rDxtm/postgres, authenticated=rDxtm/postgres
--   column name             authenticated=w/postgres
-- (r=SELECT, w=UPDATE, a=INSERT, d=DELETE, D=TRUNCATE.) So `authenticated` held SELECT plus
-- UPDATE(name) and no INSERT, which is the state migration A intended and this widens.
revoke insert, update, delete on project_fields from authenticated, anon;

-- INSERT ON FOUR COLUMNS, NOT ON THE TABLE. The two omissions are deliberate:
--
--   created_at — this is the SORT KEY. §2.5 of the epic design makes (created_at, slug) the
--                field order, with no `position` column standing behind it, so a writable
--                created_at is a writable sort order and the ordering rule stops being a
--                database property. The default is now(); withholding the column costs
--                nothing and makes the rule structural.
--   id         — gen_random_uuid(). A client that cannot supply a primary key cannot collide
--                with one, and nothing in the app has any reason to choose one.
--
-- `.insert(…).select()` still works: the RETURNING clause needs SELECT, which is granted
-- table-wide. Column-level INSERT is sufficient on its own — table-level INSERT is not
-- required when every assigned column is granted. That last claim is the only one here not
-- read back from the catalog, so the live suite exercises a real insert through the APP ROLE
-- rather than through adminClient(): a wrong reading of the privilege model goes red in CI
-- instead of shipping.
grant insert (project_id, slug, name, type) on project_fields to authenticated;

-- Unchanged from migration A, restated because the revoke above cascaded it away. `name`
-- alone: not slug (the identity other tables key on — a movable slug would undo story 5's
-- "renaming an option rewrites no value rows"), and not type (§2.3 makes the type immutable,
-- and that immutability is what makes story 3's denormalised field_type copy sound at all).
grant update (name) on project_fields to authenticated;

-- DELETE IS DELIBERATELY NOT GRANTED. Story 6 grants it and proves it, exactly as migration A
-- said it would. `rls.integration.test.ts` pins the current no-DELETE state, so that story
-- cannot widen the privilege without a test going red first — deny by default, widen visibly.
--
-- `anon` keeps SELECT, unchanged and deliberate (David, 2026-08-06). anon reads zero rows
-- because auth.uid() is NULL, NOT because no policy covers it: all four policies are created
-- without a TO clause, so they apply to `public`, which includes anon. The real inconsistency
-- is schema-wide — `tickets` still carries full arwdDxtm for anon, and every table grants
-- TRUNCATE to both roles — and it wants one deliberate sweep with SPRIN-75 rather than a
-- piecemeal revoke on whichever table a story happens to touch.

commit;

-- POST-STATE. A convenience for whoever runs the file; it is NOT a control. It reads back its
-- own work in the same session, and a `like '%x%'` shape test passes on a superset. The real
-- evidence is the live integration suite, which runs on every PR.
--
--   select relname, relacl::text, relrowsecurity, relforcerowsecurity
--     from pg_class where relname = 'project_fields'
--       and relnamespace = 'public'::regnamespace;
--
-- EXPECT: unchanged from migration A — relrowsecurity = true, relforcerowsecurity = false,
-- and NEITHER anon nor authenticated carrying `a`, `w` or `d` at TABLE level. The new INSERT
-- is a COLUMN grant and must not appear here. If `authenticated` shows `a`, the grant was
-- written table-wide and created_at is writable.
--
--   select attname, attacl::text from pg_attribute
--     where attrelid = 'public.project_fields'::regclass and attacl is not null
--     order by attname;
--
-- EXPECT: exactly four rows —
--   name        authenticated=aw/postgres   (INSERT + UPDATE)
--   project_id  authenticated=a/postgres
--   slug        authenticated=a/postgres
--   type        authenticated=a/postgres
-- If `created_at` or `id` appears, stop: the ordering rule above is not in force. If `name`
-- shows only `a`, the revoke cascaded and the UPDATE re-grant did not take, and rename is
-- broken.
