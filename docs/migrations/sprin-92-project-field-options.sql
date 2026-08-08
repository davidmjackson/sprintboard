-- SPRIN-92 — project_field_options (epic SPRIN-71, custom fields, story 5).
--
-- DEPARTS from the epic design's §3.3 in one place: the table carries `project_id`.
-- Without it the options list cannot be READ. Every ProjectShell read is
-- `useTaggedRead(projectId, nonce, fn)`, so a list function must be
-- `(projectId) => Promise<T[]>`; the alternatives are a PostgREST embedded join or a
-- second query fed by the fields list, both of which are the "new plumbing" the epic's
-- own §4.4 forbids. `ticket_field_values` already carries `project_id` for the same
-- reason — a TENANCY column, not a selectivity one.
--
-- The column cannot drift: `pfo_field_fk` constrains (field_id, project_id) against
-- project_fields (id, project_id). That order matches `project_fields_id_project_unique`
-- and `tfv_field_fk` exactly. Writing (project_id, id) would demand a SECOND unique
-- constraint over the same two columns in the other order, for nothing.
--
-- There is deliberately NO direct `references projects(id)`. It would be redundant —
-- project_fields.project_id already references projects, so the cascade arrives here
-- transitively — and it would add a further unindexed-foreign-key advisor INFO for no
-- control. `ticket_field_values` declares `project_id uuid not null` the same way.

begin;

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

  -- Character for character `project_fields_slug_format`. The slug is DERIVED
  -- client-side by the shared `slugForName`, so the database must hold the same rule or
  -- the derivation is the only thing enforcing it.
  constraint pfo_slug_format check (slug ~ '^[a-z][a-z0-9_]{0,29}$'),
  constraint pfo_label_nonempty check (btrim(label) <> '' and length(label) <= 40),
  constraint pfo_position_positive check (position > 0)
);

alter table project_field_options enable row level security;

-- Four policies, shaped exactly like tfv_owner_*: no TO clause (matching every existing
-- policy in this schema), qualified column reference in the subquery, and
-- `(select auth.uid())` NEVER bare `auth.uid()`. The advisor baseline is 8
-- auth_rls_initplan warnings; this story must not add a ninth.
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

-- AC2 and AC4 in one constraint. ON DELETE CASCADE is AC4: deleting an option CLEARS it
-- from every ticket holding it. `no action` (the default) would refuse the delete with
-- 23503 and strand an option that could never be removed once used.
--
-- `value_option` already exists (SPRIN-88) and tfv_one_value_matching_type already
-- requires it non-null for 'select' and null for the other four types. This migration
-- adds NO column to ticket_field_values.
alter table ticket_field_values add constraint tfv_option_fk
  foreign key (field_id, value_option)
  references project_field_options (field_id, slug)
  on delete cascade;

-- GRANTS. The table is BORN with full CRUD for authenticated AND anon; "we never granted
-- it" is not true and never was. The revoke is written TABLE-WIDE and the permitted
-- columns granted back afterwards, because `revoke update (col)` against a table-wide
-- grant is a SILENT NO-OP, while a table-level revoke CASCADES to column grants.
revoke insert, update, delete on project_field_options from authenticated, anon;

grant insert (project_id, field_id, slug, label, position)
  on project_field_options to authenticated;

-- UPDATE on `label` ALONE is what makes AC3 a DATABASE property rather than a
-- convention: a patch touching `slug` earns 42501 before any policy is consulted, so no
-- value row can be orphaned by a rename. `position` is insertable but not updatable —
-- there is no reorder surface, so a writable position would be machinery with no caller.
grant update (label) on project_field_options to authenticated;

-- DELETE is granted here, unlike migration A, because AC4 needs it in THIS story. Postgres
-- has no column-level DELETE, so this is table-wide and RLS is the only thing in front of
-- it — which is why options_owner_delete exists and why a live test proves it.
grant delete on project_field_options to authenticated;

commit;

-- ADVISOR DELTA, measured after this migration was applied (David, from the catalogue):
--
--   security:    1 WARN (leaked-password protection) — unchanged from baseline.
--   performance: 14 -> 16. TWO NEW unindexed_foreign_keys INFOs:
--                  pfo_field_fk on project_field_options
--                  tfv_option_fk on ticket_field_values
--   auth_rls_initplan: still 8 — no new warning. The `(select auth.uid())` form worked.
--
-- THE PLAN'S PREDICTION WAS WRONG. It expected pfo_field_fk to go unflagged because the
-- primary key (field_id, slug) LEADS with field_id, reasoning from SPRIN-88's note that the
-- advisor "matches on the leading column". It does not. The real rule, as SPRIN-88 itself
-- re-derived after first getting this same thing wrong: the fk's column list must be a
-- PREFIX of some index's column list. (field_id, project_id) is not a prefix of
-- (field_id, slug) — the second column differs — so leading-column overlap alone is not
-- enough, and the advisor flags it correctly by that rule.
--
-- Both new INFOs are ACCEPTED, no index added, for the same reasoning SPRIN-88 recorded for
-- ticket_field_values_field_id_idx: project_id in pfo_field_fk is a TENANCY column, not a
-- selectivity one (given field_id, project_id is already determined), and the only cascade
-- lookup pfo_field_fk serves — deleting a project_fields row by id — is already served by
-- this table's own primary key on (field_id, slug), which leads with field_id. tfv_option_fk
-- is the fourth such INFO on ticket_field_values, for the identical reason recorded there:
-- ticket_field_values_field_id_idx already covers a field_id lookup.
--
-- A covering index for either fk is a further migration, and it is DAVID'S CALL, not this
-- story's — see the closed fk-index question recorded for ticket_field_values. Do not add
-- one here.
