-- SPRIN-88 — the ticket_field_values table.
--
-- Epic SPRIN-71 (custom fields), story 3 of 6. Designs:
--   docs/superpowers/specs/2026-08-05-sprin-71-custom-fields-design.md §3.2, §3.4
--   docs/superpowers/specs/2026-08-07-sprin-88-ticket-field-values-design.md §3, §8
--
-- The epic design calls this "migration B". GO BY THE FILENAME, NOT THE LETTER: SPRIN-91
-- shipped a grants migration the epic design did not anticipate and it took the B slot
-- (sprin-91-project-fields-insert.sql). Story 5 follows this one.
--
-- ADDITIVE ONLY. This migration creates one table and touches no existing one. `tickets` is
-- not reshaped, now or by any story in this epic: core ticket fields stay real columns and
-- only custom ones go in a flexible store, which is what Jira itself does.
--
-- Hand-applied. The Supabase MCP is read_only=true on purpose, so this file is run in the
-- SQL editor and `get_advisors` is checked afterwards.
--
-- NOTE FOR WHOEVER PASTES THIS: Supabase's SQL editor lints statically and will warn
-- "creates a table without enabling Row Level Security". That is a FALSE POSITIVE — RLS is
-- enabled below, inside the same transaction. Do not accept its offer to reorder the file.

begin;

create table ticket_field_values (
  ticket_id    uuid not null,
  project_id   uuid not null,
  field_id     uuid not null,

  -- A COPY of project_fields.type, carried because a CHECK body may not contain a subquery
  -- and the check at the bottom of this table has to reach the definition's type. This is
  -- sound ONLY because a field's type can never change (epic design §2.3), and tfv_type_fk
  -- below is what keeps the copy honest rather than merely intended.
  --
  -- §2.2 and §2.3 of the epic design are therefore ONE decision, not two: typed columns are
  -- implementable only under an immutable type. A future story that introduces retyping must
  -- revisit this storage design, not just add an UPDATE.
  field_type   text not null,

  -- One column per primitive. The rejected alternatives, both recorded in the epic design:
  -- a jsonb blob on `tickets` (forbidden outright — it reshapes `tickets`, and has no real
  -- type, so "validate at both edges" would collapse to zod alone), and a single text column
  -- cast on read (every number and date becomes a string the database cannot check:
  -- "2026-13-45" stores fine and "10" sorts before "9").
  value_text   text,
  value_number numeric,
  value_date   date,
  value_option text,

  primary key (ticket_id, field_id),

  -- CROSS-TENANT INTEGRITY, the pattern tickets_sprint_fk and tickets_epic_fk already use:
  -- carrying project_id into both foreign keys makes "a ticket in project A holding project
  -- B's field" unrepresentable rather than merely discouraged. AC5 asserts it live.
  constraint tfv_ticket_fk foreign key (ticket_id, project_id)
    references tickets (id, project_id) on delete cascade,
  constraint tfv_field_fk foreign key (field_id, project_id)
    references project_fields (id, project_id) on delete cascade,

  -- Keeps the denormalised field_type equal to the definition's.
  --
  -- ON UPDATE NO ACTION, never CASCADE: cascading a type change would silently re-type every
  -- existing value, which §2.3 forbids. (Nothing can change a definition's type today —
  -- `authenticated` holds UPDATE on project_fields.name alone — so this is the belt to that
  -- grant's braces.)
  --
  -- ON DELETE CASCADE matches tfv_field_fk DELIBERATELY, rather than relying on that fk's
  -- cascade to clear the rows first. Two foreign keys to the same table with different delete
  -- actions resolve in RI trigger name order — i.e. luck, the same trap the schema's own
  -- comment on tickets_status_fk records. Making both cascade removes the ordering question.
  constraint tfv_type_fk foreign key (field_id, field_type)
    references project_fields (id, type)
    on update no action on delete cascade,

  -- Exactly one value column populated, and it is the one the type calls for.
  --
  -- The `else false` is deliberate: a type this check does not know about stores NOTHING,
  -- rather than storing anything. A sixth field type must therefore edit this constraint,
  -- which is the intended failure and not an obstacle.
  --
  -- The live suite covers all five arms plus this one, so `else false` is proven
  -- reachable-and-refusing rather than assumed. **That sentence was written before the test
  -- existed** — a review found every field_type literal in the suite was one of the five known
  -- types, making this the comment-as-control failure this repo has a rule against. The test is
  -- now real ("refuses an unrecognised field_type, reaching the check's else-false arm"), and it
  -- asserts 23514 rather than 23503 because CHECK constraints run during the row insert while
  -- foreign keys are AFTER-triggers — so this arm refuses the row before tfv_type_fk is
  -- consulted, even though the type matches no definition either.
  --
  -- "No value" is the ABSENCE of a row, not a row full of nulls. Clearing a field deletes its
  -- row, which is why this check can insist a value is present at all.
  constraint tfv_one_value_matching_type check (
    case field_type
      when 'text'      then value_text   is not null and value_number is null
                            and value_date is null and value_option is null
      when 'paragraph' then value_text   is not null and value_number is null
                            and value_date is null and value_option is null
      when 'number'    then value_number is not null and value_text is null
                            and value_date is null and value_option is null
      when 'date'      then value_date   is not null and value_text is null
                            and value_number is null and value_option is null
      when 'select'    then value_option is not null and value_text is null
                            and value_number is null and value_date is null
      else false
    end
  )
);

-- ONE INDEX, KEPT DELIBERATELY, AND FOUR INFO LINTS ACCEPTED WITH IT. Read this before
-- copying the pattern into story 5 — and before "fixing" the lints.
--
-- Two separate things went wrong here and only one of them was the SQL.
--
-- FIRST, the rule was derived from the wrong catalog. The original reasoning read: the advisor
-- flags three unindexed foreign keys, all on `tickets`, and does NOT flag tickets_status_fk
-- (project_id, status) — whose only covering index looked like tickets_project_number_unique
-- (project_id, number) — so the linter must match on the LEADING COLUMN rather than the full
-- set. That came from querying pg_constraint alone. pg_indexes was never read, and it holds
-- tickets_project_status_idx ON tickets (project_id, status), an EXACT cover. The unflagged fk
-- was never evidence of a leading-column rule; it was evidence of an index nobody looked for.
--
-- THE REAL RULE, re-derived and checked on five cases: the foreign key's column list must be a
-- PREFIX of some index's column list. tickets_epic_fk (parent_epic_id, project_id) is flagged
-- despite tickets_epic_idx (parent_epic_id) existing — the same shape as this index, which
-- settles it. So this index satisfies the advisor for NONE of the three fks, and applying the
-- migration added four INFOs: three unindexed_foreign_keys plus an unused_index for this one.
--
-- SECOND — and this is the part that matters — a flagged fk here is NOT a missing index.
-- Measured against pg_indexes 2026-08-07, every lookup a cascade actually performs is already
-- served:
--
--   tfv_ticket_fk (ticket_id, project_id)  delete a ticket -> find rows by ticket_id
--                                          served by ticket_field_values_pkey (ticket_id, field_id)
--   tfv_field_fk  (field_id, project_id)   delete a field  -> find rows by field_id
--                                          served by this index
--   tfv_type_fk   (field_id, field_type)   retarget a type -> find rows by field_id
--                                          served by this index
--
-- The reason the advisor disagrees is that project_id in those composite fks is a TENANCY
-- column, not a selectivity one. It is carried so a row cannot be re-pointed at another
-- project's ticket or field (see the grants note below — it is half of why the UPDATE grant is
-- not the control). Given ticket_id or field_id, project_id is already determined, so adding it
-- to an index narrows nothing. The advisor does not model that.
--
-- DECISION (David, session 58): keep this index, add nothing, accept the four INFOs. Covering
-- all three fks was the earlier lean and was rejected on measurement — it buys no lookup any
-- query performs, leaves three indexes that will never be scanned, and does not even win on
-- count (3 INFOs against this option's 4, trading unindexed_foreign_keys for unused_index).
-- Widening this one to (field_id, project_id) would silence exactly one lint and speed up
-- nothing.
--
-- Do NOT read "keep get_advisors at zero lints" as overriding this. That rule is read in this
-- repo as "add no lints you cannot account for", and the baseline has not been zero since
-- before SPRIN-79. These four are accounted for, above, with the measurement behind them.
--
-- The unused_index INFO self-clears at story 6 (SPRIN-93), which counts values by field_id and
-- is the first query to scan this index. It is not dead weight; it is early.
create index ticket_field_values_field_id_idx on ticket_field_values (field_id);

alter table ticket_field_values enable row level security;

-- DO NOT add `force row level security`. It reads as hardening and is the opposite: the
-- project-creation path runs SECURITY DEFINER triggers owned by postgres, which are exempt
-- from RLS only while FORCE is off. The same trap is recorded on project_statuses and
-- project_fields. This table has no definer trigger today; a FORCE added here "for
-- consistency" would be copied to one that does.

-- All four policies ship now, because they are the table's security design rather than one
-- story's feature. Unlike project_fields, EVERY ONE OF THEM IS REACHABLE AND PROVEN by this
-- story, because this story grants insert, update and delete together — the read is proven by
-- a cross-tenant zero-row assertion with an owner-side positive control on the same row, and
-- the three writes by cross-tenant refusals.
--
-- `(select auth.uid())`, never the bare `auth.uid()`. Wrapped in a scalar subquery the call
-- plans as an InitPlan and is evaluated once per query instead of once per row, which keeps
-- these four policies out of Supabase's auth_rls_initplan advisor. EIGHT such warnings are
-- already outstanding on the older tables (profiles, projects, project_counters, sprints,
-- tickets, and three on project_statuses), measured 2026-08-07. They are SPRIN-75's to fix
-- when every policy is rewritten to a membership check. This migration adds ZERO. Do not
-- "make it consistent" with the older bare-call policies — that is the wrong direction.
--
-- Ownership is reached through project_id rather than through ticket_id, deliberately: it is
-- one join instead of two, and project_id is the column both composite foreign keys already
-- pin to the ticket's own project, so the two cannot disagree.

create policy tfv_owner_read on ticket_field_values
  for select
  using (exists (select 1 from projects p
                 where p.id = ticket_field_values.project_id
                   and p.owner_id = (select auth.uid())));

create policy tfv_owner_insert on ticket_field_values
  for insert
  with check (exists (select 1 from projects p
                      where p.id = ticket_field_values.project_id
                        and p.owner_id = (select auth.uid())));

-- BOTH halves stated. USING filters which rows may be updated; WITH CHECK re-tests the
-- POST-image, and because the grant below permits UPDATE on project_id (see the grant block for
-- why), it is what stops a row being re-pointed at another owner's project by the update itself.
--
-- CORRECTED AT REVIEW: this comment used to claim the WITH CHECK was "load-bearing here in a way
-- it is not on project_fields". That was wrong twice. Postgres documents that when a policy
-- defines no WITH CHECK, the USING expression is used for the post-image as well — so OMITTING
-- it here would behave identically, and the clause is not falsifiable by deleting it. And
-- fields_owner_update has the identical shape anyway (confirmed in pg_policies), so there was no
-- contrast to draw. Stating it explicitly is still worth doing: it says what is intended rather
-- than relying on a default, and it survives someone later narrowing the USING clause. But do
-- not go looking for a mutation that proves it — there isn't one.
--
-- What DOES pin the post-image behaviour is the live test "the owner cannot move a value row
-- into a project they do not own" in rls.integration.test.ts, added at the same review after it
-- turned out §3 named this clause as a control and nothing exercised the UPDATE path at all.
create policy tfv_owner_update on ticket_field_values
  for update
  using      (exists (select 1 from projects p
                      where p.id = ticket_field_values.project_id
                        and p.owner_id = (select auth.uid())))
  with check (exists (select 1 from projects p
                      where p.id = ticket_field_values.project_id
                        and p.owner_id = (select auth.uid())));

create policy tfv_owner_delete on ticket_field_values
  for delete
  using (exists (select 1 from projects p
                 where p.id = ticket_field_values.project_id
                   and p.owner_id = (select auth.uid())));

-- GRANTS. THE TABLE IS BORN WITH FULL CRUD FOR BOTH APP ROLES — this block is the only thing
-- that changes that, and its shape is not stylistic.
--
-- MEASURED, from pg_default_acl (NOT information_schema, whose grant views return zero rows
-- under the read-only MCP role and read exactly like "no privileges"):
--   public, tables: anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres
-- ALTER DEFAULT PRIVILEGES hands a NEW table insert, select, update and delete to BOTH roles
-- the moment it is created. "We simply never granted it" is not true here and never was.
--
-- The revoke is written TABLE-WIDE and the permitted set granted back afterwards, because the
-- obvious form is a silent no-op: Postgres does not let a column-level REVOKE carve a hole in
-- a table-level grant. Equally a table-level REVOKE CASCADES to column grants ("the
-- corresponding column privileges (if any) are automatically revoked on each column of the
-- table, as well" — PostgreSQL REVOKE reference), so any later migration widening this set
-- must RESTATE EVERY GRANTED COLUMN, not just add its new one. Story 5 adds project_field_
-- options and touches value_option; that story owes this block a re-read, not an append.
revoke insert, update, delete on ticket_field_values from authenticated, anon;

-- INSERT AND UPDATE ON ALL EIGHT COLUMNS, and this is the one place this migration DEPARTS
-- from the epic design's §3.4. It is a considered departure, written down rather than slipped
-- in. The full argument is in this story's design §3; the short form:
--
-- PostgREST compiles `.upsert(row)` to `INSERT … ON CONFLICT DO UPDATE SET c = excluded.c`
-- for EVERY column in the payload, and Postgres requires UPDATE privilege on every column in
-- a SET list. The payload must carry ticket_id, project_id, field_id and field_type because
-- an INSERT needs them. So the narrow `grant update (value_*)` the epic design implies makes
-- every SECOND write to a field fail with 42501 — the insert succeeds, the update is refused.
--
-- The alternative was to drop the upsert for an update-then-insert-on-miss pair: two round
-- trips, and two tabs that both miss race into a 23505 an upsert does not produce. That buys
-- a narrower grant to defend a property TWO FOREIGN KEYS ALREADY DEFEND:
--
--   field_type  — tfv_type_fk refuses any value that is not the definition's own type (23503).
--                 The only "change" this grant permits is rewriting the value already there.
--   the ids     — tfv_ticket_fk and tfv_field_fk are composite on project_id, so a row cannot
--                 be re-pointed at another project's ticket or field; and tfv_owner_update's
--                 WITH CHECK re-tests ownership on the post-image, so it cannot be re-pointed
--                 at another owner's project either.
--
-- THE GRANT IS NOT THE CONTROL HERE, AND THE MIGRATION DOES NOT PRETEND IT IS. Three live
-- tests ship with this file and would fail without those constraints: a mismatched field_type
-- earning 23503 on tfv_type_fk, a cross-project field_id earning 23503 on tfv_field_fk, and a
-- wrong-column-for-the-type earning 23514 on tfv_one_value_matching_type, one case per type.
-- Each asserts the CONSTRAINT NAME and not only the SQLSTATE, because three constraints on
-- this table can all produce 23503 and `message` is the only channel PostgREST exposes for
-- constraint identity.
--
-- Written as an explicit eight-column list rather than a bare table grant so that adding a
-- ninth column is a decision someone has to make here, in this block, rather than a privilege
-- that arrives with the ALTER TABLE.
grant insert (ticket_id, project_id, field_id, field_type,
              value_text, value_number, value_date, value_option)
  on ticket_field_values to authenticated;

grant update (ticket_id, project_id, field_id, field_type,
              value_text, value_number, value_date, value_option)
  on ticket_field_values to authenticated;

-- DELETE IS GRANTED, TABLE-WIDE, because Postgres has no column-level DELETE and AC3 needs it:
-- clearing a custom field DELETES the row rather than storing a null, which is not a style
-- choice — tfv_one_value_matching_type makes a row of nulls unrepresentable, so deletion is
-- the only way to express "no value".
--
-- This is the FIRST DELETE grant in the epic. project_fields still holds none at all, and
-- story 6 is where that changes; rls.integration.test.ts pins that table's no-DELETE state so
-- the widening cannot happen without a test going red first. Deny by default, widen visibly.
grant delete on ticket_field_values to authenticated;

-- SELECT is deliberately left as the default grant for BOTH roles, matching project_fields and
-- David's call of 2026-08-06. authenticated needs it; anon holding it is harmless because anon
-- reads zero rows.
--
-- BE PRECISE ABOUT WHY, because the obvious explanation is wrong and the wrong one is
-- dangerous. It is NOT that anon is excluded by the absence of a policy. Every policy above is
-- created without a TO clause, so all four apply to `public` — which INCLUDES anon. anon reads
-- nothing because auth.uid() is NULL for an unauthenticated caller, so the EXISTS matches no
-- project and the policy evaluates false. Someone who believes anon is excluded by policy
-- ABSENCE could add a public-sharing SELECT policy and silently open this table to
-- unauthenticated callers.
--
-- The schema-wide anon inconsistency (tickets still carries full arwdDxtm for anon; every
-- table grants TRUNCATE to both roles) wants one deliberate sweep with SPRIN-75, from the
-- catalog, rather than a piecemeal revoke on whichever table a story happens to touch.

commit;

-- POST-STATE. A convenience for whoever runs the file; it is NOT a control. It reads back its
-- own work in the same session, and a `like` shape test passes on a superset. The real evidence
-- is the live integration suite, which runs on every PR.
--
--   select relname, relacl::text, relrowsecurity, relforcerowsecurity
--     from pg_class where relname = 'ticket_field_values'
--       and relnamespace = 'public'::regnamespace;
--
-- EXPECT: relrowsecurity = true, relforcerowsecurity = false, and at TABLE level neither role
-- carrying `a` or `w` (both are COLUMN grants and must not appear here). `authenticated` SHOULD
-- carry `d` — that is the DELETE grant above. If it carries `a` or `w`, a grant was written
-- table-wide and the eight-column list is not in force.
--
--   select attname, attacl::text from pg_attribute
--     where attrelid = 'public.ticket_field_values'::regclass and attacl is not null
--     order by attname;
--
-- EXPECT: exactly eight rows, each authenticated=aw/postgres.
--
--   select policyname, roles::text, cmd from pg_policies
--     where tablename = 'ticket_field_values' order by policyname;
--
-- EXPECT: four rows, roles {public} on each — see the SELECT note above for why that is
-- correct rather than alarming.
