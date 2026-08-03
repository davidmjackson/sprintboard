-- =============================================================================
-- SPRIN-81  A project can be Scrum or Kanban   (Rung 3 epic SPRIN-73, slice 1)
--
-- The whole schema change for the Kanban project type, and it is one widened
-- check — exactly as CLAUDE.md has promised since Phase 1.
--
-- NEVER AN ENUM. `project_type` stays `text` + a `check` constraint. Widening a
-- check is one line; altering an enum type is a painful migration, and this is
-- the single most damaging change anyone could make to this schema.
--
-- NOTE ON THE CONSTRAINT BODY: the schema doc writes this as
-- `check (project_type in ('scrum'))`, but Postgres normalises a single-element
-- IN to an equality, so the LIVE constraint currently reads
-- `CHECK ((project_type = 'scrum'::text))`. Verified on the live database before
-- writing this file. The drop-by-name below is unaffected either way.
--
-- WHAT THIS DOES NOT DO: it does not make the type immutable. `projects_owner`
-- is a single `for all` policy, so RLS permits an owner to UPDATE their own
-- project's `project_type`. Immutability is an APP-LAYER rule in this story
-- (no code path writes the column after insert, pinned by a test). That is
-- contained to the owner's own project rather than a tenant-isolation issue.
-- Hardening it means revoking the table UPDATE and re-granting columns — note
-- that `revoke update (project_type)` alone is a SILENT NO-OP against a
-- table-wide grant — and that was deliberately left out of this story's scope.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- One explicit transaction. If any statement errors, NOTHING lands.
--
-- RE-RUN: safe. A second paste drops and re-adds the same constraint, and the
-- post-state check below re-verifies it. No data is touched, and no existing row
-- can violate the widened check because the widened set is a superset.
-- =============================================================================

begin;

-- 1. Widen the vocabulary to include Kanban.
alter table projects drop constraint projects_project_type_check;

alter table projects add constraint projects_project_type_check
  check (project_type in ('scrum', 'kanban'));

-- 2. Post-state check. Fails the transaction if the constraint is missing or did
--    not widen. Two honest limits on it, added after review — the first draft of
--    this comment called it "the only place the shape is pinned", which overstated
--    what it does:
--
--      a) It runs INSIDE the transaction that just added the constraint, so it is
--         reading back its own work. There is no path where the ADD above succeeds
--         and this readback disagrees. What it actually catches is someone editing
--         the ADD statement and not this block.
--      b) `like '%kanban%'` is a SUBSTRING test, so it would also pass on a wider
--         vocabulary — `in ('scrum','kanban','waterfall')` satisfies it. Asserting
--         equality against the intended body would be stronger; that is worth doing
--         if this block is ever copied for another migration.
--
--    What actually pins live behaviour is the pair of integration tests in
--    src/test/projects.integration.test.ts: one inserts 'kanban' and reads it back,
--    the other asserts an unknown value is refused with 23514 AND names this
--    constraint. Those run against the real database on every PR. It remains true
--    that CI cannot read pg_catalog, so the constraint's exact TEXT is unpinned —
--    but its BEHAVIOUR is not.
do $$
declare
  def text;
begin
  select pg_get_constraintdef(con.oid) into def
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'projects'
    and con.conname = 'projects_project_type_check';

  if def is null then
    raise exception 'SPRIN-81: projects_project_type_check is missing after the migration';
  end if;

  if def not like '%kanban%' or def not like '%scrum%' then
    raise exception 'SPRIN-81: constraint did not widen as intended, got: %', def;
  end if;
end $$;

commit;
