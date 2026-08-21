# SPRIN-99 Config Tables Membership — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the last four owner-scoped tables to the membership model — admin-only writes and member reads on the three configuration tables, member read and write on `ticket_field_values`.

**Architecture:** Sixteen per-verb RLS policies are dropped and recreated. The verb split already exists, so nothing structural changes: only the predicate (`owner_id = auth.uid()` becomes an `app_auth` call) and the role clause (none becomes `to authenticated`). No grants change, no schema changes, no function changes.

**Tech Stack:** Postgres 15 / Supabase RLS, `app_auth` SECURITY DEFINER predicates, Vitest live integration suites, supabase-js.

**Spec:** `docs/superpowers/specs/2026-08-21-sprin-99-config-tables-membership-design.md`

## Global Constraints

- **Migrations are hand-applied.** The Supabase MCP is `read_only=true` on purpose. Produce the SQL; David runs it. Never attempt `apply_migration`.
- **Migrations are ASCII-only.** No smart quotes, no em-dashes, no arrows. Use `--`, `->`, `"`.
- **Every new policy carries `to authenticated`.** All four tables grant `anon` SELECT (and `project_statuses` grants anon INSERT). `anon` holds no EXECUTE on `app_auth`, so a policy without the clause makes anonymous requests raise `42501: permission denied for schema app_auth` instead of being filtered.
- **Never a Postgres ENUM.** Not relevant to this diff, but it remains the single most damaging change to this schema.
- **Lint thresholds are errors:** 30-line functions, cyclomatic 10, cognitive 15, 4 parameters, 400-line files. Scope is `**/*.{ts,tsx,mjs,js}`. `npm run lint` gates the merge. Test files are NOT exempt from T1-T5 except per ADR 0002.
- **Verification is `npm run verify`**, never a hand-assembled subset, never `npx tsc --noEmit`.
- **Live suites need real env.** Prefix live commands with `env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY` — `~/.bashrc` exports PLACEHOLDER Supabase config and `loadEnv` outranks `.env.local`.
- **Never follow `signIn()` with `auth.getUser()`.** Read the id from the admin API response or `userId(client)`. Extra auth round-trips trip GoTrue's rate limiter and produce a bare null-`id` TypeError in `beforeAll`.

## File Structure

| File | Responsibility |
|---|---|
| `docs/migrations/sprin-99-config-tables-membership.sql` | **Create.** The sixteen policies, plus the reasoning that must survive the story. |
| `docs/sprintboard_phase1_schema.sql` | **Modify.** Carries the live policy definitions; currently states the owner-scoped ones. |
| `src/test/config-membership.integration.test.ts` | **Create.** The admin-vs-member boundary suite. |
| `verify-gate.test.mjs` | **Modify** (`LIVE_SUITES`, around line 437). The executable half of the test-count tripwire. |
| `CLAUDE.md` | **Modify.** Tables-on-membership line, advisor baseline, test-gap prose, retirement of the initplan sweep. |

---

### Task 1: The migration, and the schema doc that mirrors it

**Files:**
- Create: `docs/migrations/sprin-99-config-tables-membership.sql`
- Modify: `docs/sprintboard_phase1_schema.sql` (the `project_statuses` policy block around line 991, and the equivalent blocks for the other three tables)

**Interfaces:**
- Consumes: `app_auth.is_project_member(p_project_id uuid)` and `app_auth.is_project_admin(p_project_id uuid)` — both `stable security definer`, both EXECUTE-granted to `authenticated` only.
- Produces: sixteen policy names later tasks assert on — `statuses_member_read`, `statuses_admin_insert`, `statuses_admin_update`, `statuses_admin_delete`, and the same four shapes prefixed `fields_`, `options_`, and `tfv_member_{read,insert,update,delete}`.

- [ ] **Step 1: Write the migration file**

```sql
-- SPRIN-99: the four config tables move from ownership to membership.
--
-- This is the LAST owner-scoped group in the schema. After this migration no table
-- in `public` resolves to `owner_id = auth.uid()`.
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
-- RLS WITH CHECK fires BEFORE foreign-key validation, and a policy guards only the
-- columns it reads -- so a project_id predicate normally leaves the other fk columns
-- tenant-unguarded. Here it does not, because every fk on this table is COMPOSITE on
-- project_id:
--
--     tfv_ticket_fk (ticket_id, project_id) -> tickets(id, project_id)
--     tfv_field_fk  (field_id,  project_id) -> project_fields(id, project_id)
--
-- A row claiming your project_id cannot reference another tenant's ticket or field:
-- the composite key has no matching parent. Verified from pg_constraint, 2026-08-21.
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
```

- [ ] **Step 2: Prove the SQL parses before handing it over**

The MCP is read-only, so a DDL statement that parses is refused for the RIGHT reason.
Run the file's body through `mcp__supabase__execute_sql`. Expected: SQLSTATE **25006**
(`cannot execute CREATE POLICY in a read-only transaction`). That proves it parses.
A **42601** is a syntax error and means the file is wrong. A **42P01**/**42883** means a
table or function name is wrong. Do not hand David SQL that has not returned 25006.

- [ ] **Step 3: Check for non-ASCII before handing it over**

Run: `LC_ALL=C grep -n '[^\x00-\x7F]' docs/migrations/sprin-99-config-tables-membership.sql`
Expected: no output. Any hit is a smart quote or dash that must be replaced.

- [ ] **Step 4: Mirror the change into the schema doc**

`docs/sprintboard_phase1_schema.sql` carries the LIVE policy definitions (the
`project_statuses` block is around line 991). Replace the four `statuses_owner_*`
policies, and the equivalent blocks for `project_fields`, `project_field_options` and
`ticket_field_values`, with the sixteen above. Keep the file's existing commentary style:
where a block is superseded, the file's convention is a short "MOVED. SPRIN-NN rewrote X
from ownership to membership" note pointing at the live definition, as at line 939.

- [ ] **Step 5: Commit**

```bash
git add docs/migrations/sprin-99-config-tables-membership.sql docs/sprintboard_phase1_schema.sql
git commit -m "Add SPRIN-99 migration: config tables resolve to membership"
```

---

### Task 2: The live boundary suite

**Files:**
- Create: `src/test/config-membership.integration.test.ts`
- Read for pattern: `src/test/board-membership.integration.test.ts` (the closest sibling — copy its fixture shape, its skip guard, and its teardown-deletes-first ordering)

**Interfaces:**
- Consumes: `adminClient`, `anonClient`, `assertServiceRoleOrExplain`, `hasServiceRoleKey`, `signInWithCredentials` from `./supabase-clients`.
- Produces: nothing other tasks import. Task 3 registers this exact path.

**The two assertion shapes, and getting them the wrong way round is the classic failure here:**

- A refused **INSERT** violates `WITH CHECK` and **raises** — assert `error` is non-null and the code is `42501`.
- A refused **UPDATE** or **DELETE** is filtered by `USING` and **changes zero rows, with no error** — assert the returned row array is empty, then read the row back with the service-role client to prove it is genuinely intact rather than merely un-returned.

**The column-grant trap.** A zero-row assertion is only honest on a column the role may actually UPDATE; on an ungranted column the privilege layer raises `42501` first and the test measures the grant instead of the policy. So the negative UPDATE must write:

| Table | Column the negative UPDATE must write |
|---|---|
| `project_statuses` | `name` (or `category` / `position` / `wip_limit`) |
| `project_fields` | **`name`** — nothing else is granted |
| `project_field_options` | **`label`** — nothing else is granted |
| `ticket_field_values` | any of the seven payload columns |

- [ ] **Step 1: Write the fixture**

Three fresh throwaway users, created via the admin API and signed in with
`signInWithCredentials` — never the long-lived A and B, because Vitest runs test files in
parallel against one shared database and `project-members.integration.test.ts` already
mutates A and B in its own `beforeAll`.

```ts
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import {
  adminClient,
  anonClient,
  assertServiceRoleOrExplain,
  hasServiceRoleKey,
  signInWithCredentials,
} from './supabase-clients'

assertServiceRoleOrExplain()

const PASSWORD = 'password123'

describe.skipIf(!hasServiceRoleKey)('SPRIN-99 config tables resolve to membership', () => {
  const admin = hasServiceRoleKey ? adminClient() : (undefined as never)
  const createdUserIds: string[] = []

  /** Creates the project, so `on_project_created_admin` makes them its sole admin. */
  let aClient: SupabaseClient<Database>
  /** Added to A's project as a plain `member`. Reads config, writes none of it. */
  let mClient: SupabaseClient<Database>
  let mId: string
  /** Belongs to no project at all. */
  let sClient: SupabaseClient<Database>

  let projectId: string
  /** A SECOND project A owns and M is NOT in -- separates "member here" from "member anywhere". */
  let otherProjectId: string
  let fieldId: string
  let ticketId: string
})
```

The membership row is inserted with the **service-role** client, not through the app —
a fixture must not be built out of the thing under test:

```ts
const join = await admin
  .from('project_members')
  .insert({ project_id: projectId, user_id: mId, role: 'member' })
if (join.error) throw new Error(`Fixture: could not add M as a member: ${join.error.message}`)
```

- [ ] **Step 2: Write the cases**

Each bullet is one `it`. Every negative is paired with the positive control named beside it.

1. `a member reads every status of a project they do not own` — expect 4 rows (the seeded vocabulary). **This is the live regression the story fixes**; it fails before the migration.
2. `a member reads the field definitions and their options` — positive.
3. `a member is refused a status insert, and the refusal RAISES` — `42501`. Control: A's identical insert succeeds.
4. `a member changes zero rows renaming a status` — write `name`; assert `[]`; service-role read-back proves the old name intact. Control: A's rename returns 1 row.
5. `a member changes zero rows deleting a status` — assert `[]` plus read-back. Control: A deletes a status A created.
6. `a member is refused a field insert and an option insert, and both RAISE` — `42501` each. Controls: A's succeed.
7. `a member changes zero rows renaming a field (name) or an option (label)` — the two granted columns. Controls: A's succeed.
8. `a member sets, updates and clears a ticket field value` — all positive; this table is member-writable.
9. `a stranger sees nothing on all four tables` — four empty arrays.
10. `a stranger is refused every write` — insert raises; update/delete return zero rows.
11. `an admin of one project gets no configuration write on another` — **M must be an admin somewhere for this case to mean anything.** Have M create their own project in the fixture (`on_project_created_admin` makes M its sole admin), then assert M's config writes against A's `projectId` are still refused, and M's identical write against M's own project succeeds. Without M holding an admin role anywhere, an `is_project_admin` that ignored its `project_id` argument entirely would pass every other case in this file — M would be admin nowhere and the bug would be invisible. Pair it with the plain-membership version: M is a member of `projectId` and gets nothing on `otherProjectId`.
12. `an anonymous caller is filtered, not errored` — for each of the four tables assert `error` is null and `data` is `[]`. **Never a 42501**: an `app_auth` schema error here is exactly the regression `to authenticated` exists to prevent.
13. `reorder_project_statuses reorders for an admin and returns zero rows for a member` — the one INVOKER function on these tables.

- [ ] **Step 3: Run the suite and watch it FAIL for the right reason**

```bash
env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY npx vitest run src/test/config-membership.integration.test.ts
```

Expected **before** the migration is applied: the member-read cases fail (0 rows, because
`statuses_owner_read` still demands ownership) and the member-write cases PASS for the wrong
reason (the owner policy already denies them). That asymmetry is the correct red. A suite
that is fully green before the migration is not testing the migration — stop and say so.

- [ ] **Step 4: Commit**

```bash
git add src/test/config-membership.integration.test.ts
git commit -m "Add the SPRIN-99 admin-vs-member boundary suite"
```

---

### Task 3: Register the suite, and update the documents it makes stale

**Files:**
- Modify: `verify-gate.test.mjs` (`LIVE_SUITES`, around line 437)
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the path created in Task 2, `src/test/config-membership.integration.test.ts`.

**Why this is its own task and not a footnote.** `LIVE_SUITES` is the executable half of the
test-count tripwire; the CLAUDE.md sentence is the prose half. SPRIN-98 updated the prose and
left the array, and SPRIN-105 did exactly the same thing one story later — so its suite was
collectable-but-unregistered for a whole story, which is the precise state the array exists to
make impossible. Both halves move in the same commit.

- [ ] **Step 1: Add the suite to `LIVE_SUITES`**

Append `'src/test/config-membership.integration.test.ts'` to the array, with a one-line
comment naming SPRIN-99. The sibling entries carry a short note explaining why the entry
exists; match that.

- [ ] **Step 2: Update CLAUDE.md — four separate claims are now false**

1. **The test-count gap: 11 -> 12**, and the file-count observation re-measured. Derive both, do not guess:
   `npx vitest list --filesOnly | wc -l` and the same with `--exclude '**/*.integration.test.ts'`.
2. **The membership list.** "Six tables now resolve to membership ... only the four config tables still resolve to `owner_id = auth.uid()`, pending SPRIN-99" becomes: every table resolves to membership; no table in `public` is owner-scoped. Note the third shape — the board tables ask **member**, `projects` asks **member to read, admin to write**, and the config tables ask **member to read, admin to write** except `ticket_field_values`, which asks **member** for everything.
3. **The advisor baseline.** Re-measure with `get_advisors` AFTER the migration is applied. Expect performance **11 -> 8** as the three `auth_rls_initplan` WARNs on `project_statuses` clear. Do not record an `unused_index` reading taken straight after applying — that advisor is about traffic, not schema.
4. **The `auth_rls_initplan` sweep bullet retires itself.** It says the sweep belongs to SPRIN-75 and that the last three WARNs are SPRIN-99's table. If they clear, say so and retire the bullet — it explicitly predicts its own retirement.

- [ ] **Step 3: Verify the registration actually bites**

Temporarily add `'**/config-membership.integration.test.ts'` to `vite.config.ts`'s `exclude`,
run `npx vitest run verify-gate.test.mjs`, and confirm it goes **RED**. Restore the file.
A registration that cannot fail is not a registration.

- [ ] **Step 4: Commit**

```bash
git add verify-gate.test.mjs CLAUDE.md
git commit -m "Register the SPRIN-99 suite and re-derive the counts it moves"
```

---

## After the tasks

1. **Hand David one copy-paste command** to apply `docs/migrations/sprin-99-config-tables-membership.sql`. One command, one terminal line, fully concrete.
2. **Re-read the catalog** to confirm sixteen policies exist with `roles = {authenticated}` and `app_auth` predicates — verify applied state from `pg_policies`, never from the editor's "Success".
3. **Run `npm run verify` in full** and confirm the file count matches the all-suites number with **0 skipped**. A count equal to the unit-only number means the live suites silently skipped, which is a failure however green it looks.
4. **Run `get_advisors`** and record the real numbers.
