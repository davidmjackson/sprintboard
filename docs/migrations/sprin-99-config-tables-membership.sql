-- SPRIN-99: the four config tables move from ownership to membership.
--
-- This is the LAST owner-scoped group in the schema: after this migration no table in
-- `public` resolves its MEMBERSHIP or CONFIGURATION access through `projects.owner_id`.
--
-- CORRECTION (post-apply, comment only). These two lines used to read "no table in
-- `public` resolves to `owner_id = auth.uid()`", full stop, which is false and always
-- was. Two deliberate self-scoped predicates survive and are not this story's to remove:
-- `projects_bootstrap_insert` (`owner_id = (select auth.uid())`, so creating a project
-- does not require a membership row that cannot exist yet) and the three `profiles`
-- write policies (`id = (select auth.uid())`, self-writes that never widened).
--
-- 1. WHY EVERY POLICY BELOW CARRIES "to authenticated"
--
-- Measured 2026-08-21 from pg_class.relacl. All four tables grant `anon` SELECT, and
-- `project_statuses` additionally grants `anon` INSERT. A policy with no TO clause
-- covers `public`, anon included. Policy expressions are evaluated as the CALLING role,
-- and `anon` holds neither USAGE on `app_auth` nor EXECUTE on its functions -- so an
-- anonymous request against a clause-less app_auth policy raises
-- `42501 permission denied for schema app_auth` where it previously got a clean, empty
-- result. That is the SPRIN-100 rule, and it binds on all four of these tables.
--
-- 2. WHY THE VERB SPLIT IS KEPT, AND WHY THAT IS NOT AN INCONSISTENCY
--
-- These sixteen policies are ALREADY split per verb, so read-broader-than-write costs
-- no structural change here. That is the opposite of the board tables, where a single
-- `for all` policy is load-bearing because `completeSprint`'s guard relies on read and
-- write being co-extensive. Do not "harmonise" the two shapes: on `sprints` and
-- `tickets` the single policy IS the guarantee; here the split IS the feature.
--
-- 3. WHY A PREDICATE ON project_id ALONE IS SUFFICIENT ON ticket_field_values
--
-- CORRECTION (post-apply, comment only -- no DDL below was changed). This section used
-- to assert that "every fk on this table is COMPOSITE on project_id", cited as verified
-- from pg_constraint on 2026-08-21, and listed two constraints. That was FALSE: the
-- table has FOUR foreign keys and only two of them carry project_id. The conclusion
-- survives, but it needs the transitive argument spelled out below rather than the
-- direct one that was claimed. Re-measured from pg_constraint, 2026-08-21:
--
--     tfv_ticket_fk (ticket_id, project_id) -> tickets(id, project_id)
--     tfv_field_fk  (field_id,  project_id) -> project_fields(id, project_id)
--     tfv_option_fk (field_id,  value_option) -> project_field_options(field_id, slug)
--     tfv_type_fk   (field_id,  field_type)   -> project_fields(id, type)
--
-- RLS WITH CHECK fires BEFORE foreign-key validation, and a policy guards only the
-- columns it reads -- so a project_id predicate normally leaves the other fk columns
-- tenant-unguarded. Here it does not, in two steps:
--
--   * DIRECTLY, for ticket_id and field_id. Both are keyed to project_id by a composite
--     fk, so a row claiming your project_id cannot name another tenant's ticket or field:
--     the composite key has no matching parent.
--   * TRANSITIVELY, for value_option and field_type. Neither of their fks mentions
--     project_id, so neither is pinned to a tenant by itself. Both are keyed on field_id
--     as their other column, and field_id is already pinned to project_id by
--     tfv_field_fk -- so an option or a type can only be one belonging to a field of the
--     project the row claims. The correlation is inherited through field_id, not carried
--     by the constraint itself.
--
-- The practical consequence of the correction: this reasoning depends on tfv_field_fk
-- STAYING composite on project_id. Narrow that one constraint to (field_id) alone and
-- two of the other three fks quietly stop being tenant-scoped, with nothing in the
-- policy text to show for it.
--
-- 4. WHY ticket_field_values IS MEMBER-WRITABLE WHILE THE OTHER THREE ARE NOT
--
-- Setting a custom field's VALUE on a ticket is daily board work. Defining the FIELD is
-- the administrative act. Confirmed by David, 2026-08-21. The accepted cost is that a
-- member can overwrite a teammate's custom field values; there is no per-field
-- permission model and building one is not in this epic.
--
-- 5. WHAT THIS MIGRATION DELIBERATELY DOES NOT DO
--
-- No GRANT changes. The column grants already encode the writable surface (UPDATE is
-- restricted to name/category/position/wip_limit on project_statuses, to `name` on
-- project_fields, to `label` on project_field_options) and are orthogonal to WHO may
-- write. Changing both layers in one migration would make any failure ambiguous between
-- them. anon's unused INSERT grant on project_statuses stays for the same reason -- and
-- it is inert twice over, since after this migration anon matches no policy at all and
-- is default-denied.
--
-- 6. NO BOOTSTRAP PROBLEM HERE, UNLIKE SPRIN-101
--
-- All three `projects` AFTER INSERT triggers -- create_project_counter,
-- seed_project_admin and seed_project_statuses -- are SECURITY DEFINER, so seeding
-- bypasses RLS entirely and there is no ordering race between the membership row and
-- the status rows. Verified from pg_proc.prosecdef, 2026-08-21. The one INVOKER
-- function touching these tables is reorder_project_statuses, which touches
-- project_statuses alone and carries no hidden ownership check.

begin;

-- ---------------------------------------------------------------- project_statuses
drop policy if exists statuses_owner_read on public.project_statuses;
drop policy if exists statuses_owner_insert on public.project_statuses;
drop policy if exists statuses_owner_update on public.project_statuses;
drop policy if exists statuses_owner_delete on public.project_statuses;

create policy statuses_member_read on public.project_statuses
  for select
  to authenticated
  using (app_auth.is_project_member(project_id));

create policy statuses_admin_insert on public.project_statuses
  for insert
  to authenticated
  with check (app_auth.is_project_admin(project_id));

-- The predicate is repeated in WITH CHECK rather than left to default, so a row cannot
-- be updated INTO a project the caller does not administer.
create policy statuses_admin_update on public.project_statuses
  for update
  to authenticated
  using (app_auth.is_project_admin(project_id))
  with check (app_auth.is_project_admin(project_id));

create policy statuses_admin_delete on public.project_statuses
  for delete
  to authenticated
  using (app_auth.is_project_admin(project_id));

-- ------------------------------------------------------------------ project_fields
drop policy if exists fields_owner_read on public.project_fields;
drop policy if exists fields_owner_insert on public.project_fields;
drop policy if exists fields_owner_update on public.project_fields;
drop policy if exists fields_owner_delete on public.project_fields;

create policy fields_member_read on public.project_fields
  for select
  to authenticated
  using (app_auth.is_project_member(project_id));

create policy fields_admin_insert on public.project_fields
  for insert
  to authenticated
  with check (app_auth.is_project_admin(project_id));

create policy fields_admin_update on public.project_fields
  for update
  to authenticated
  using (app_auth.is_project_admin(project_id))
  with check (app_auth.is_project_admin(project_id));

create policy fields_admin_delete on public.project_fields
  for delete
  to authenticated
  using (app_auth.is_project_admin(project_id));

-- ----------------------------------------------------------- project_field_options
drop policy if exists options_owner_read on public.project_field_options;
drop policy if exists options_owner_insert on public.project_field_options;
drop policy if exists options_owner_update on public.project_field_options;
drop policy if exists options_owner_delete on public.project_field_options;

create policy options_member_read on public.project_field_options
  for select
  to authenticated
  using (app_auth.is_project_member(project_id));

create policy options_admin_insert on public.project_field_options
  for insert
  to authenticated
  with check (app_auth.is_project_admin(project_id));

create policy options_admin_update on public.project_field_options
  for update
  to authenticated
  using (app_auth.is_project_admin(project_id))
  with check (app_auth.is_project_admin(project_id));

create policy options_admin_delete on public.project_field_options
  for delete
  to authenticated
  using (app_auth.is_project_admin(project_id));

-- ------------------------------------------------------------- ticket_field_values
-- MEMBER on every verb: this table is board work, not configuration. See section 4.
drop policy if exists tfv_owner_read on public.ticket_field_values;
drop policy if exists tfv_owner_insert on public.ticket_field_values;
drop policy if exists tfv_owner_update on public.ticket_field_values;
drop policy if exists tfv_owner_delete on public.ticket_field_values;

create policy tfv_member_read on public.ticket_field_values
  for select
  to authenticated
  using (app_auth.is_project_member(project_id));

create policy tfv_member_insert on public.ticket_field_values
  for insert
  to authenticated
  with check (app_auth.is_project_member(project_id));

-- WITH CHECK matters most here: project_id is itself writable on this table, so without
-- it a member could move a value row between two projects.
create policy tfv_member_update on public.ticket_field_values
  for update
  to authenticated
  using (app_auth.is_project_member(project_id))
  with check (app_auth.is_project_member(project_id));

create policy tfv_member_delete on public.ticket_field_values
  for delete
  to authenticated
  using (app_auth.is_project_member(project_id));

commit;
