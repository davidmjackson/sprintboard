-- SPRIN-90 — Migration A: the project_fields table.
--
-- Epic SPRIN-71 (custom fields), story 1 of 6. Design:
--   docs/superpowers/specs/2026-08-05-sprin-71-custom-fields-design.md §3.1, §3.4
--
-- ADDITIVE ONLY. This migration creates one table and touches no existing one. `tickets`
-- is not reshaped, now or by any story in this epic: core ticket fields stay real columns
-- and only custom ones go in a flexible store, which is what Jira itself does.
--
-- Hand-applied. The Supabase MCP is read_only=true on purpose, so this file is run in the
-- SQL editor and `get_advisors` is checked afterwards.

begin;

create table project_fields (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,

  -- Stable machine identity. Users rename `name`, never `slug` — the same division
  -- project_statuses.slug and projects.key already use. Story 3's ticket_field_values
  -- does not key on it (it keys on field_id), but story 5's project_field_options does,
  -- so that renaming a select option rewrites no value rows.
  slug       text not null,

  -- The field's label, as shown on the form and in the detail sidebar. The ONLY column
  -- this migration grants UPDATE on.
  name       text not null,

  -- NEVER an enum. `ticket.type`, `sprint.status` and `projects.project_type` are all
  -- text + a check for the same reason: widening a check is one line, altering an enum
  -- type is a painful migration. Converting this to a `create type … as enum` would look
  -- like an improvement and is the single most damaging change anyone could make here.
  --
  -- 'select' is accepted from the start even though story 5 is what renders it. The
  -- alternative — widening the check later — would mean a second migration for a value
  -- the design already fixed, and a half-open vocabulary in the meantime.
  type       text not null
               check (type in ('text','paragraph','number','date','select')),

  created_at timestamptz not null default now(),

  -- Mirrors project_statuses_slug_format exactly. Lowercase, leading letter, ≤30 chars,
  -- so a slug is always a legal identifier fragment.
  constraint project_fields_slug_format
    check (slug ~ '^[a-z][a-z0-9_]{0,29}$'),
  constraint project_fields_name_nonempty
    check (btrim(name) <> '' and length(name) <= 40),

  constraint project_fields_project_slug_unique unique (project_id, slug),

  -- Both are redundant on their own (id is the PK). They exist so story 3's
  -- ticket_field_values can point at a definition with COMPOSITE fks:
  --
  --   (field_id, project_id) -> makes "a ticket in project A holding project B's field"
  --                             unrepresentable rather than merely discouraged
  --   (field_id, type)       -> lets the value row carry a copy of the type, which is the
  --                             only way its "populated column matches the type" CHECK can
  --                             be written at all, since a CHECK body may not subquery
  --
  -- This is the same device as tickets_id_project_unique and
  -- project_statuses_id_project_unique. Do not drop them as unused: nothing references
  -- them until story 3, and dropping one then is a schema change under a shipped table.
  constraint project_fields_id_project_unique unique (id, project_id),
  constraint project_fields_id_type_unique    unique (id, type)
);

-- No separate index on project_id is needed: project_fields_project_slug_unique leads with
-- it, which is what the fk lookup uses. Adding one would be a duplicate index and a NEW
-- advisor warning — the opposite of the goal. (Three unindexed fks on `tickets` are already
-- flagged; this migration adds none.)

alter table project_fields enable row level security;

-- DO NOT add `force row level security`. It reads as hardening and is the opposite: the
-- project-creation path runs SECURITY DEFINER triggers owned by postgres, which are exempt
-- from RLS only while FORCE is off. The same trap is recorded on project_statuses. This
-- table has no definer trigger today, but story 6's delete path and any future seeding
-- would inherit the same exposure, and a FORCE added here "for consistency" would be
-- copied to a table that does.

-- All four policies ship now, because they are the table's security design rather than one
-- story's feature. Note precisely which are PROVEN by this story's tests:
--
--   read   — proven. A live test asserts a second user reads ZERO rows (RLS FILTERS on
--            USING, it does not raise), paired with an owner-side positive control on the
--            same row so "zero" cannot mean "the read was broken".
--   insert — NOT proven by this story, deliberately and by construction. INSERT is revoked
--            from `authenticated` below, so a cross-tenant insert earns 42501 from the
--            missing GRANT and never reaches the policy. A revoked grant and an RLS WITH
--            CHECK violation share that SQLSTATE, and with nobody holding INSERT there is
--            no positive control to tell them apart — the test would pass with this policy
--            deleted. Story 2 grants INSERT and proves it there.
--   update — proven only for `name`, the one granted column (see the grant block).
--   delete — NOT proven. DELETE is revoked below; story 6 grants it and proves it.
--
-- `(select auth.uid())`, never the bare `auth.uid()`. Wrapped in a scalar subquery the call
-- plans as an InitPlan and is evaluated once per query instead of once per row, which keeps
-- these four policies out of Supabase's auth_rls_initplan advisor. Eight such warnings are
-- already outstanding on the older tables; they are SPRIN-75's to fix when every policy is
-- rewritten to a membership check. This story's job is to add ZERO. Do not "make it
-- consistent" with the older bare-call policies — that is the wrong direction.

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

-- GRANTS. THE TABLE IS BORN WITH FULL CRUD FOR BOTH APP ROLES — this block is the only
-- thing that changes that, and its shape is not stylistic.
--
-- MEASURED, 2026-08-05, from pg_default_acl (NOT information_schema, whose grant views
-- return zero rows under the read-only MCP role and read exactly like "no privileges"):
--
--   public, tables: anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres
--
-- ALTER DEFAULT PRIVILEGES therefore hands a NEW table insert, select, update and delete to
-- BOTH roles the moment it is created. "We simply never granted it" is not true here and
-- never was. RLS would still deny anon (it has no policy), but that leaves one control
-- where the project's own precedent has two.
--
-- The revoke is written TABLE-WIDE and the permitted column granted back afterwards,
-- because the obvious form is a silent no-op: Postgres does not let a column-level REVOKE
-- carve a hole in a table-level grant. Equally, a table-level REVOKE **cascades** to column
-- grants ("the corresponding column privileges (if any) are automatically revoked on each
-- column of the table, as well" — PostgreSQL REVOKE reference), so any later migration
-- widening this set must RESTATE EVERY GRANTED COLUMN, not just add its new one. SPRIN-85
-- learned that on project_statuses; it applies verbatim to stories 2 and 6.
revoke insert, update, delete on project_fields from authenticated, anon;

-- `name` alone. Not slug: it is the identity other tables key on, and a movable slug would
-- undo story 5's "renaming an option rewrites no value rows". Not type: §2.3 of the design
-- makes the type immutable, and that immutability is what makes story 3's denormalised
-- field_type copy sound in the first place — a writable type would silently re-type every
-- existing value. Both refusals are asserted live, against a `name` update on the SAME ROW
-- as a positive control, so a blanket row-level refusal cannot masquerade as column
-- privilege.
grant update (name) on project_fields to authenticated;

-- SELECT is deliberately left as the default grant for BOTH roles. authenticated needs it
-- (listProjectFields), and anon holding it is harmless and consistent with every other
-- table here: with no read policy, RLS filters anon to zero rows. That is the same contract
-- the keepalive cron depends on elsewhere — an empty array is the success signal.

commit;

-- POST-STATE. This block is a convenience for whoever runs the file; it is NOT a control.
-- It reads back its own work inside the same session, and a `like '%x%'` shape test passes
-- on a superset. The real evidence is the live integration suite, which runs on every PR.
--
--   select relname, relacl::text, relrowsecurity, relforcerowsecurity
--     from pg_class where relname = 'project_fields'
--       and relnamespace = 'public'::regnamespace;
--
-- EXPECT: relrowsecurity = true, relforcerowsecurity = false, and NEITHER anon nor
-- authenticated carrying `w` or `d`. If either does, the revoke did not take.
--
--   select attname, attacl::text from pg_attribute
--     where attrelid = 'public.project_fields'::regclass and attacl is not null;
--
-- EXPECT: exactly one row — name, granted to authenticated. If `slug` or `type` appears
-- here, stop: the immutability this epic's storage design rests on is not in force.
