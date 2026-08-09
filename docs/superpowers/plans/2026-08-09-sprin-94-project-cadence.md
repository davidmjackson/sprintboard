# SPRIN-94 — See a project's sprint cadence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every project carries a sprint cadence — a length in whole weeks and an ISO start
weekday — defaulting to 2 weeks starting Monday, shown read-only on the Settings tab and
hidden entirely for Kanban projects.

**Architecture:** Two `not null` checked `int` columns on `projects` (migration A), surfaced
through the generated `Database` types into the existing `Project` row type. The display
string is derived by a single pure function in `src/lib/domain.ts`, rendered by a new
`CadenceSettings` section that `SettingsTab` composes beside `StatusSettings` and
`CustomFieldSettings`. No write path in this story — the form is SPRIN-97.

**Tech Stack:** React, TypeScript (strict, `noUncheckedIndexedAccess`), Tailwind, shadcn/ui,
Supabase Postgres + PostgREST, Vitest, Testing Library.

**Story 1 of 4 in epic SPRIN-74.** Design:
`docs/superpowers/specs/2026-08-09-sprin-74-sprint-cadence-design.md`. **Read it first.**
The sibling keys are out of build order: SPRIN-97 is story 2, SPRIN-96 story 3, SPRIN-95
story 4.

## Global Constraints

- **`npm run verify` is the gate.** Never a subset — it is `lint && format:check && build && test`,
  and a local loop of `lint` + `typecheck` + `test:unit` has reported green on a red branch
  in this repo more than once.
- **T1–T5 are errors:** 30-line functions, cyclomatic 10, cognitive 15, 4 parameters,
  400-line files (`skipBlankLines` + `skipComments` both on). Write to them from the first
  line. A genuine misfit is an ADR, never an inline disable.
- **Migrations are hand-applied.** Produce the SQL, hand David **one** copy-paste command,
  wait for his output. `apply_migration` is unavailable on purpose.
- **Advisor baseline is not zero.** Re-derive with `get_advisors` after applying; compare
  against the measured baseline (**16 performance / 1 security** at 2026-08-09) and add no
  new lints.
- **Never use a Postgres `ENUM`.** These columns are `int` + named `check` constraints.
- **The seven live `*.integration.test.ts` suites cannot run locally** — the local Supabase
  URL is a placeholder and they fail hard with `ENOTFOUND`. Their first real execution is CI.
  Push early so CI can falsify claims local runs cannot.
- **The tripwire is the GAP.** `npm test` collects exactly **7 more files** than `test:unit`.
  Measured at this branch point: **76 total**. This story adds one unit test file, so expect
  **77** and a gap that is still 7.
- Imperative commit summaries. Never a heredoc for a commit message — write the message to a
  file and use `git commit -F`.

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/migrations/sprin-94-project-cadence.sql` | **Create.** Migration A: the two columns, their named checks, and a post-state block proving no privilege moved. |
| `docs/sprintboard_phase1_schema.sql` | **Modify.** The `create table projects` block gains the two columns, so a rebuild from the doc produces today's schema. |
| `src/lib/database.types.ts` | **Modify (regenerate).** `Project` inherits the columns automatically. |
| `src/lib/domain.ts` | **Modify.** `SprintCadence`, `SPRINT_WEEKDAYS`, `SPRINT_LENGTH_WEEKS`, `cadenceSummary`. The single place the vocabulary and the copy live. |
| `src/lib/domain.test.ts` | **Modify.** Unit tests for `cadenceSummary`. |
| `src/routes/CadenceSettings.tsx` | **Create.** The read-only Settings section. Presentational; no reads, no writes. |
| `src/routes/CadenceSettings.test.tsx` | **Create.** Its own tests. |
| `src/routes/SettingsTab.tsx` | **Modify.** Composes the section, gated on `hasSprints`. |
| `src/routes/SettingsTab.test.tsx` | **Modify.** Scrum shows it; Kanban does not. |
| `src/test/projects.integration.test.ts` | **Modify.** Live: the defaults (AC2) and both range checks (AC5). |

**Why `CadenceSettings` is presentational and takes a `SprintCadence`, not a `Project`.** It
follows `hasSprints(project: Pick<Project, 'project_type'>)` — the narrowest shape it reads,
so a test can build one without inventing eight irrelevant columns. Keeping the read in
`SettingsTab` also keeps the project-type comparison out of the component, which
`src/test/project-type-single-expression.test.ts` actively enforces.

---

### Task 1: Migration A — the columns, applied and proven live

**Files:**
- Create: `docs/migrations/sprin-94-project-cadence.sql`
- Modify: `docs/sprintboard_phase1_schema.sql` (the `create table projects` block, ~line 63)
- Test: `src/test/projects.integration.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `projects.sprint_length_weeks int not null default 2` and
  `projects.sprint_start_weekday int not null default 1`, with named constraints
  `projects_sprint_length_weeks_range` and `projects_sprint_start_weekday_range`.

- [ ] **Step 1: Write the migration file**

Create `docs/migrations/sprin-94-project-cadence.sql`:

```sql
-- =============================================================================
-- SPRIN-94  See a project's sprint cadence
--           (Rung 3 epic SPRIN-74, story 1 — "Migration A" in the epic design)
--
-- PURELY ADDITIVE. Two not-null columns with defaults, and two named range
-- checks. NO GRANT CHANGES AT ALL — and that absence is deliberate, not an
-- oversight. `authenticated` already holds table-level INSERT and SELECT on
-- `projects`, and a table-level grant covers columns added later, so the new
-- columns are readable and insertable the moment they exist. What they are NOT
-- is updatable: there is no UPDATE privilege on this table for either client
-- role, which is SPRIN-82's end state and stays true after this file runs.
-- Making the cadence editable is SPRIN-97's job and SPRIN-97's migration.
--
-- MEASURED LIVE BEFORE WRITING THIS FILE, not recalled. Read 2026-08-09 from
-- `pg_class.relacl` and `pg_attribute.attacl`:
--
--   projects  relacl:
--     postgres=arwdDxtm/postgres
--     anon=ardDxtm/postgres              <- no w
--     authenticated=ardDxtm/postgres     <- no w: SPRIN-82's revoke held
--     service_role=arwdDxtm/postgres
--
--   projects  attacl:  NONE. No column on this table carries an ACL.
--
-- READ THOSE TWO CATALOGUES, NOT information_schema. Both
-- `information_schema.column_privileges` and `role_table_grants` return ZERO
-- ROWS for this table — they filter to grants the CURRENT role is party to, and
-- the read-only MCP user is party to none. An empty result there is not
-- evidence of an empty ACL, and reading it as such is how a story concludes a
-- table has no privileges at all. (This file's author made exactly that mistake
-- first and corrected it; SPRIN-85's banner records the same trap.)
--
-- WHY int + CHECK AND NEVER AN ENUM. The standing rule on this schema. Widening
-- 1-4 to 1-6 is one line against a check and a painful type migration against an
-- enum. Same reasoning as `ticket.type`, `sprint.status` and `project_type`.
--
-- WHY THE CONSTRAINTS ARE NAMED rather than left to Postgres. Constraint names
-- are client-visible API in this codebase: src/lib/project-statuses.ts and its
-- siblings parse them out of error messages to choose which remedy to show. The
-- live tests for AC5 assert these names, so a generated name would make the
-- assertion a guess.
--
-- WHY ISO WEEKDAYS, 1 = MONDAY .. 7 = SUNDAY. It matches Postgres `isodow`, so
-- any future SQL that has to reason about the cadence agrees with the client for
-- free, with no off-by-one translation layer to get wrong.
--
-- WHY not null WITH DEFAULTS rather than nullable. Every project has a cadence,
-- including the Kanban projects that never read one. A nullable column would buy
-- nothing and cost a null branch at every read site, including SPRIN-96's date
-- pre-fill. Existing rows are backfilled by the default.
--
-- A KANBAN PROJECT CARRIES A CADENCE IT NEVER READS, and that is inert by
-- design, exactly as `wip_limit` is inert on a Scrum project's status row
-- (SPRIN-85). A CHECK body may not contain a subquery, so the constraint cannot
-- reach across to `project_type` — and because SPRIN-82 made `project_type`
-- immutable IN THE DATABASE, such a row can never become a Scrum row later. If a
-- project-type conversion story is ever built, it inherits this alongside
-- SPRIN-85's `wip_limit` obligation.
--
-- NO RLS CHANGE. `projects_owner` is a single `for all` policy on
-- `owner_id = auth.uid()` whose expressions name no columns, so it covers the
-- new columns with no edit.
--
-- NO INDEX. Nothing filters or joins on either column; they are read as part of
-- the project row the shell already selects in full.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- If any statement errors, NOTHING lands.
--
-- RE-RUN: NOT idempotent — `add column` and `add constraint` both error if the
-- object already exists, and the transaction then rolls the whole thing back.
-- That is the safe failure. `if not exists` was deliberately NOT used: it would
-- let a re-run silently skip the add and then verify a schema nobody re-applied.
-- =============================================================================

begin;

-- 1. The columns. Defaults backfill every existing row; not null makes the
--    absence of a cadence unrepresentable.
alter table projects
  add column sprint_length_weeks  int not null default 2,
  add column sprint_start_weekday int not null default 1;

comment on column projects.sprint_length_weeks is
  'Sprint length in whole weeks, 1 to 4. Read only for Scrum projects '
  '(hasSprints in src/lib/domain.ts); a value on a Kanban project is inert by '
  'design. Editable from SPRIN-97 onwards, not before.';

comment on column projects.sprint_start_weekday is
  'ISO weekday a sprint starts on: 1 = Monday .. 7 = Sunday, matching Postgres '
  'isodow. Suggests dates in the create-sprint dialog (SPRIN-96); it never '
  'constrains them.';

-- 2. The ranges, named because the live tests assert the names.
alter table projects
  add constraint projects_sprint_length_weeks_range
    check (sprint_length_weeks between 1 and 4);

alter table projects
  add constraint projects_sprint_start_weekday_range
    check (sprint_start_weekday between 1 and 7);

-- 3. Post-state check. Fails the transaction unless the end state is exactly
--    the intended one.
--
--    Its two honest limits, restated rather than assumed (SPRIN-82 and
--    SPRIN-85's files make the same disclosure):
--      a) It runs INSIDE the transaction that just did the work, so it reads
--         back its own writes. What it catches is someone EDITING the
--         statements above and not this block.
--      b) CI cannot see any of this — PostgREST has no pg_catalog access, so no
--         test in the repo can read relacl or attacl. What pins live BEHAVIOUR
--         is AC2 and AC5 in src/test/projects.integration.test.ts.
--
--    Four assertions, because they fail independently:
--      i)   both columns exist, are not null, and carry the intended defaults
--      ii)  both named check constraints exist
--      iii) neither client role holds table-wide UPDATE — this file must not
--           have changed that, and SPRIN-97 is where it legitimately does
--      iv)  neither new column carries ANY column-level ACL — the mirror of
--           (iii) at column granularity, and the thing that would quietly make
--           SPRIN-97's grant a no-op-shaped surprise
do $$
declare
  col_state     text;
  missing_cons  text[];
  tbl_offenders text;
  col_acl       text;
begin
  -- (i) Columns, nullability and defaults.
  select string_agg(
           format('%s(notnull=%s,default=%s)', a.attname, a.attnotnull,
                  coalesce(pg_get_expr(d.adbin, d.adrelid), 'NONE')),
           ', ' order by a.attname)
    into col_state
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = 'public.projects'::regclass
    and a.attnum > 0
    and not a.attisdropped
    and a.attname in ('sprint_length_weeks', 'sprint_start_weekday');

  if col_state is distinct from
     'sprint_length_weeks(notnull=t,default=2), sprint_start_weekday(notnull=t,default=1)'
  then
    raise exception 'SPRIN-94: unexpected cadence column state: %', coalesce(col_state, 'NONE');
  end if;

  -- (ii) Both named checks present.
  select array_agg(c order by c)
    into missing_cons
  from unnest(array['projects_sprint_length_weeks_range',
                    'projects_sprint_start_weekday_range']) as c
  where not exists (
    select 1 from pg_constraint
    where conrelid = 'public.projects'::regclass
      and contype = 'c'
      and conname = c
  );

  if missing_cons is not null then
    raise exception 'SPRIN-94: missing check constraint(s): %',
      array_to_string(missing_cons, ', ');
  end if;

  -- (iii) No table-wide UPDATE for either client role. SPRIN-82's end state.
  select string_agg(p.grantee::regrole::text, ', ' order by p.grantee::regrole::text)
    into tbl_offenders
  from pg_class rel
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  cross join lateral aclexplode(rel.relacl) as p
  where nsp.nspname = 'public'
    and rel.relname = 'projects'
    and p.privilege_type = 'UPDATE'
    and p.grantee::regrole::text in ('authenticated', 'anon');

  if tbl_offenders is not null then
    raise exception
      'SPRIN-94: table-wide UPDATE on projects is granted to: % — SPRIN-82 revoked it',
      tbl_offenders;
  end if;

  -- (iv) Neither new column carries a column-level ACL.
  select string_agg(format('%s->%s', a.attname, p.grantee::regrole::text), ', ')
    into col_acl
  from pg_attribute a
  cross join lateral aclexplode(a.attacl) as p
  where a.attrelid = 'public.projects'::regclass
    and a.attname in ('sprint_length_weeks', 'sprint_start_weekday')
    and p.grantee::regrole::text in ('authenticated', 'anon');

  if col_acl is not null then
    raise exception 'SPRIN-94: unexpected column privileges on the cadence columns: %', col_acl;
  end if;

  raise notice 'SPRIN-94: ok — cadence columns added, no privilege moved';
end $$;

commit;
```

- [ ] **Step 2: Validate the SQL parses before handing it over**

`execute_sql` on the read-only MCP is a READ — it cannot apply this. Validate by asking
Postgres to parse a deliberately non-applying variant. Run via the Supabase MCP:

```sql
select pg_get_expr(conbin, conrelid) from pg_constraint where conname = 'projects_sprint_length_weeks_range';
```

Expected: zero rows (the constraint does not exist yet). This confirms the connection works
and the constraint is genuinely absent, so the migration is not about to collide.

- [ ] **Step 3: Hand David the migration**

Give **one** copy-paste command, on its own, fenced with `---` rules, and then STOP and wait
for his output. Do not proceed to step 4 until he confirms it ran.

The command opens the file so he can copy it into the SQL editor:

```bash
cat /var/www/sprintboard/docs/migrations/sprin-94-project-cadence.sql
```

Expected on success in the SQL editor: `NOTICE: SPRIN-94: ok — cadence columns added, no privilege moved`.

- [ ] **Step 4: Verify the applied state from the catalogue**

Do not trust the notice alone — re-read it independently, per "a surprising result is a
hypothesis, and so is a reassuring one". Run via the Supabase MCP:

```sql
select a.attname, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as default_expr
from pg_attribute a
left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = 'public.projects'::regclass
  and a.attname in ('sprint_length_weeks', 'sprint_start_weekday');
```

Expected: two rows, both `attnotnull = true`, defaults `2` and `1`.

- [ ] **Step 5: Run the advisors and compare against the baseline**

Run `get_advisors` for both `security` and `performance`. Expected: **16 performance / 1
security**, unchanged. Two new columns with no fk and no index cannot add a lint; if the
count moved, something else did it and it must be explained before proceeding.

- [ ] **Step 6: Update the schema doc**

In `docs/sprintboard_phase1_schema.sql`, add both columns to the `create table projects`
block (~line 63) and both named constraints beside `projects_key_format`. This doc is never
applied, but it is the file a rebuild would come from — and it has drifted three times in
this project's history, each time discovered by accident. Match the migration exactly.

- [ ] **Step 7: Write the failing live tests**

Add to `src/test/projects.integration.test.ts`, inside the existing
`describe.skipIf(!hasRlsCredentials)('S3.1 project-creation contract', …)` block:

```ts
/**
 * SPRIN-94 AC2 — every project is born with a cadence, and the DATABASE is what
 * supplies it. `createProject` sends neither column, exactly as it sends no
 * `project_type`, so a default that regressed to null or to a different number would
 * surface here and nowhere in the client.
 */
it('defaults a new project to a two-week cadence starting Monday (SPRIN-94 AC2)', async () => {
  const key = runKey()
  const { data, error } = await a
    .from('projects')
    .insert({ owner_id: userAId, name: 'Cadence default', key })
    .select('id, sprint_length_weeks, sprint_start_weekday')
    .single()

  expect(error).toBeNull()
  createdIds.push(data!.id)
  expect(data!.sprint_length_weeks).toBe(2)
  expect(data!.sprint_start_weekday).toBe(1)
})

/**
 * SPRIN-94 AC5, both halves. The CONSTRAINT NAME is asserted, not just the SQLSTATE:
 * `projects_key_format` and `projects_owner_key_unique` also live on this table, so a
 * bare 23514 would pass on a violation this test is not about — and `runKey()` is
 * random, so that is not hypothetical.
 */
it('rejects a sprint length outside 1-4 (projects_sprint_length_weeks_range -> 23514)', async () => {
  const { data, error } = await a
    .from('projects')
    .insert({ owner_id: userAId, name: 'Bad length', key: runKey(), sprint_length_weeks: 5 })
    .select('id')
    .single()

  expect(data).toBeNull()
  expect(error?.code).toBe('23514')
  expect(error?.message).toContain('projects_sprint_length_weeks_range')
})

it('rejects a start weekday outside 1-7 (projects_sprint_start_weekday_range -> 23514)', async () => {
  const { data, error } = await a
    .from('projects')
    .insert({ owner_id: userAId, name: 'Bad weekday', key: runKey(), sprint_start_weekday: 8 })
    .select('id')
    .single()

  expect(data).toBeNull()
  expect(error?.code).toBe('23514')
  expect(error?.message).toContain('projects_sprint_start_weekday_range')
})
```

- [ ] **Step 8: Confirm the live tests cannot run locally, and say so**

Run: `npx vitest run src/test/projects.integration.test.ts`
Expected: they **fail hard** with `ENOTFOUND` against the placeholder Supabase URL — they do
not skip. This is the documented local behaviour, not a defect. Their first real execution is
CI, which is why step 9 pushes rather than waiting for a green local run.

- [ ] **Step 9: Commit and push**

```bash
git add docs/migrations/sprin-94-project-cadence.sql docs/sprintboard_phase1_schema.sql src/test/projects.integration.test.ts
git commit -F <message-file>
git push -u origin sprin-94-project-cadence
```

Commit summary: `Add the sprint cadence columns to projects (SPRIN-94)`.

---

### Task 2: Types and the domain vocabulary

**Files:**
- Modify: `src/lib/database.types.ts` (regenerated)
- Modify: `src/lib/domain.ts`
- Test: `src/lib/domain.test.ts`

**Interfaces:**
- Consumes: the two columns from Task 1, live in the database.
- Produces:
  - `type SprintCadence = Pick<Project, 'sprint_length_weeks' | 'sprint_start_weekday'>`
  - `const SPRINT_WEEKDAYS: readonly { iso: number; label: string }[]`
  - `const SPRINT_LENGTH_WEEKS: readonly number[]`
  - `function cadenceSummary(cadence: SprintCadence): string`

- [ ] **Step 1: Regenerate the database types**

Use the Supabase MCP `generate_typescript_types` and write the result to
`src/lib/database.types.ts`. `Project` is `Omit<Tables<'projects'>, 'project_type'> & …`, so
it gains both columns with no edit to the row type itself.

Run: `npx tsc -p tsconfig.app.json --noEmit`
Expected: PASS. (This is a type check only — it is **not** verification. `npm run verify` in
Task 4 is.)

- [ ] **Step 2: Write the failing tests**

Add to `src/lib/domain.test.ts`:

```ts
describe('cadenceSummary (SPRIN-94)', () => {
  it('names the length and the start weekday', () => {
    expect(cadenceSummary({ sprint_length_weeks: 2, sprint_start_weekday: 1 })).toBe(
      '2 weeks, starting Monday',
    )
  })

  it('uses the singular for a one-week cadence', () => {
    expect(cadenceSummary({ sprint_length_weeks: 1, sprint_start_weekday: 5 })).toBe(
      '1 week, starting Friday',
    )
  })

  // Every ISO weekday, so a transposed or off-by-one label table goes red. Monday must be
  // 1 and Sunday 7 — matching Postgres `isodow` — because SPRIN-96 will do date arithmetic
  // against these numbers and a shifted table would silently move every suggested sprint.
  it.each([
    [1, 'Monday'],
    [2, 'Tuesday'],
    [3, 'Wednesday'],
    [4, 'Thursday'],
    [5, 'Friday'],
    [6, 'Saturday'],
    [7, 'Sunday'],
  ])('maps ISO weekday %i to %s', (iso, label) => {
    expect(cadenceSummary({ sprint_length_weeks: 3, sprint_start_weekday: iso })).toBe(
      `3 weeks, starting ${label}`,
    )
  })

  // Unreachable through the database, which constrains the column to 1-7 — but reachable
  // through this function, so the branch is covered rather than vacuous. A fallback that
  // threw, or that silently rendered "undefined", would be worse than a plain number.
  it('falls back to the ISO number for a weekday outside 1-7', () => {
    expect(cadenceSummary({ sprint_length_weeks: 2, sprint_start_weekday: 9 })).toBe(
      '2 weeks, starting day 9',
    )
  })
})

describe('SPRINT_LENGTH_WEEKS (SPRIN-94)', () => {
  // Pinned against the database's own range check. If migration A's constraint and this
  // list ever disagree, the picker SPRIN-97 builds from it offers a value the database
  // refuses, or hides one it allows.
  it('is exactly the range projects_sprint_length_weeks_range permits', () => {
    expect([...SPRINT_LENGTH_WEEKS]).toEqual([1, 2, 3, 4])
  })
})
```

Import `cadenceSummary`, `SPRINT_LENGTH_WEEKS` and `SPRINT_WEEKDAYS` from `./domain` at the
top of the file, alongside the existing imports.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/lib/domain.test.ts`
Expected: FAIL — `cadenceSummary is not a function` / import errors.

- [ ] **Step 4: Write the implementation**

Add to `src/lib/domain.ts`, beside `hasSprints` and `ticketListLabels`:

```ts
/** The two cadence columns and nothing else — the narrowest shape a cadence reader needs. */
export type SprintCadence = Pick<Project, 'sprint_length_weeks' | 'sprint_start_weekday'>

/**
 * ISO weekdays, 1 = Monday … 7 = Sunday, in display order. The numbering matches Postgres
 * `isodow` deliberately: `projects.sprint_start_weekday` is stored on that scale, so no
 * translation layer exists between the database and this list to get wrong.
 *
 * Here rather than in a `<select>` for the same reason the four board column names were
 * never inlined in a component — one list, one place, and SPRIN-97's picker builds from it.
 */
export const SPRINT_WEEKDAYS = [
  { iso: 1, label: 'Monday' },
  { iso: 2, label: 'Tuesday' },
  { iso: 3, label: 'Wednesday' },
  { iso: 4, label: 'Thursday' },
  { iso: 5, label: 'Friday' },
  { iso: 6, label: 'Saturday' },
  { iso: 7, label: 'Sunday' },
] as const

/** The sprint lengths a project may choose, mirroring `projects_sprint_length_weeks_range`. */
export const SPRINT_LENGTH_WEEKS = [1, 2, 3, 4] as const

/**
 * A project's cadence in words: `'2 weeks, starting Monday'`.
 *
 * THE single expression of this sentence, so the read-only display here and SPRIN-97's form
 * cannot describe the same cadence two different ways.
 *
 * The out-of-range fallback is not dead code being defensive for its own sake. The database
 * constrains the column to 1–7, but this function's parameter is a plain `number`, so the
 * branch is reachable from the client and is tested. Rendering the raw ISO number is the
 * honest failure: it says what the data actually is, where a thrown error would take down a
 * settings tab over a display string and `undefined` would lie quietly.
 */
export function cadenceSummary(cadence: SprintCadence): string {
  const weeks = cadence.sprint_length_weeks
  const day = SPRINT_WEEKDAYS.find((w) => w.iso === cadence.sprint_start_weekday)
  const unit = weeks === 1 ? 'week' : 'weeks'
  return `${weeks} ${unit}, starting ${day ? day.label : `day ${cadence.sprint_start_weekday}`}`
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/domain.test.ts`
Expected: PASS, all of them.

- [ ] **Step 6: Commit**

```bash
git add src/lib/database.types.ts src/lib/domain.ts src/lib/domain.test.ts
git commit -F <message-file>
```

Commit summary: `Add the sprint cadence vocabulary to domain (SPRIN-94)`.

---

### Task 3: The read-only `CadenceSettings` section

**Files:**
- Create: `src/routes/CadenceSettings.tsx`
- Test: `src/routes/CadenceSettings.test.tsx`

**Interfaces:**
- Consumes: `SprintCadence` and `cadenceSummary` from Task 2.
- Produces: `function CadenceSettings(props: { cadence: SprintCadence }): JSX.Element`

- [ ] **Step 1: Write the failing test**

Create `src/routes/CadenceSettings.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { CadenceSettings } from './CadenceSettings'

describe('CadenceSettings (SPRIN-94)', () => {
  it('states the cadence under its own heading', () => {
    render(<CadenceSettings cadence={{ sprint_length_weeks: 2, sprint_start_weekday: 1 }} />)

    // Scoped to the section, not a bare getByText: an unscoped query says the text exists
    // somewhere and nothing about where. SPRIN-65's points badge moved outside its button
    // and all twelve of its tests stayed green.
    const section = screen.getByRole('region', { name: /sprint cadence/i })
    expect(within(section).getByText('2 weeks, starting Monday')).toBeInTheDocument()
  })

  it('renders the cadence it is given, not a fixed default', () => {
    render(<CadenceSettings cadence={{ sprint_length_weeks: 1, sprint_start_weekday: 4 }} />)

    const section = screen.getByRole('region', { name: /sprint cadence/i })
    expect(within(section).getByText('1 week, starting Thursday')).toBeInTheDocument()
  })

  it('says the cadence is not editable yet', () => {
    render(<CadenceSettings cadence={{ sprint_length_weeks: 2, sprint_start_weekday: 1 }} />)

    const section = screen.getByRole('region', { name: /sprint cadence/i })
    // Read-only in this story. A button appearing here before SPRIN-97 ships its write
    // path would be a control that cannot work.
    expect(within(section).queryByRole('button')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/routes/CadenceSettings.test.tsx`
Expected: FAIL — cannot resolve `./CadenceSettings`.

- [ ] **Step 3: Write the implementation**

Create `src/routes/CadenceSettings.tsx`:

```tsx
import { cadenceSummary, type SprintCadence } from '@/lib/domain'

/**
 * The project's sprint cadence, read-only — a section of the Settings tab beside
 * `StatusSettings` and `CustomFieldSettings`.
 *
 * Presentational by design: it takes a `SprintCadence` rather than a `Project`, so it reads
 * the narrowest shape it needs (the same discipline as `hasSprints`) and holds no opinion
 * about project type. `SettingsTab` decides whether this section exists at all — which keeps
 * the project-type comparison in one place, where
 * `src/test/project-type-single-expression.test.ts` can see it.
 *
 * The editing form is SPRIN-97. Deliberately no button here: a control with no write path
 * behind it is worse than its absence.
 */
export function CadenceSettings({ cadence }: { cadence: SprintCadence }) {
  return (
    <section aria-labelledby="cadence-settings-heading" className="flex flex-col gap-2">
      <h2 id="cadence-settings-heading" className="text-lg font-semibold">
        Sprint cadence
      </h2>
      <p className="text-sm">{cadenceSummary(cadence)}</p>
      <p className="text-muted-foreground text-sm">
        New sprints are suggested from this. You can always change a sprint&rsquo;s dates.
      </p>
    </section>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/routes/CadenceSettings.test.tsx`
Expected: PASS, all three.

- [ ] **Step 5: Commit**

```bash
git add src/routes/CadenceSettings.tsx src/routes/CadenceSettings.test.tsx
git commit -F <message-file>
```

Commit summary: `Show a project's sprint cadence in settings (SPRIN-94)`.

---

### Task 4: Wire it into `SettingsTab`, gated on `hasSprints`

**Files:**
- Modify: `src/routes/SettingsTab.tsx`
- Test: `src/routes/SettingsTab.test.tsx`

**Interfaces:**
- Consumes: `CadenceSettings` from Task 3, `hasSprints` from `@/lib/domain`.
- Produces: nothing new — this is the composition step.

- [ ] **Step 1: Write the failing tests**

Add to `src/routes/SettingsTab.test.tsx`, using whatever project factory the file already
uses to build its `ProjectShellContext` (follow the existing `renderTab` / context helper
rather than inventing a second one):

```tsx
it('shows the sprint cadence for a Scrum project (SPRIN-94 AC3)', async () => {
  renderTab({ project: { ...scrumProject, sprint_length_weeks: 3, sprint_start_weekday: 2 } })

  const section = await screen.findByRole('region', { name: /sprint cadence/i })
  expect(within(section).getByText('3 weeks, starting Tuesday')).toBeInTheDocument()
})

it('shows no cadence section for a Kanban project (SPRIN-94 AC4)', async () => {
  renderTab({ project: { ...kanbanProject, sprint_length_weeks: 3, sprint_start_weekday: 2 } })

  // Wait for the tab to settle before asserting an absence, or this passes on a tab that
  // has not rendered anything yet.
  expect(await screen.findByRole('heading', { name: /custom fields/i })).toBeInTheDocument()

  expect(screen.queryByRole('region', { name: /sprint cadence/i })).not.toBeInTheDocument()
  // queryByRole EXCLUDES aria-hidden subtrees, so on its own it would pass on a section
  // that renders and is merely hidden from the a11y tree. The raw DOM query is what makes
  // this an assertion about the section not EXISTING.
  expect(document.body.textContent).not.toContain('3 weeks, starting Tuesday')
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/routes/SettingsTab.test.tsx`
Expected: FAIL — the Scrum test cannot find the region; the Kanban test passes vacuously
(note it, it is not evidence of anything until step 4).

- [ ] **Step 3: Write the implementation**

In `src/routes/SettingsTab.tsx`:

1. Add `hasSprints` to the existing `import { hasWipLimits } from '@/lib/domain'` line.
2. Add `import { CadenceSettings } from './CadenceSettings'` beside the other route imports.
3. Render it first inside the returned `<div className="flex flex-col gap-8">`, above
   `<StatusSettings …>`:

```tsx
{/* SPRIN-94. Above the status list because a project's rhythm frames the columns rather
    than the other way round. Gated on hasSprints, not on !hasWipLimits: they are two
    different questions that share an answer only while there are exactly two project
    types. No phase gate of its own — the cadence rides on `project`, which the shell has
    already resolved by the time this tab renders at all. */}
{hasSprints(project) && <CadenceSettings cadence={project} />}
```

`project` is assignable to `SprintCadence` — a `Project` is a superset — so no field
picking is needed at the call site.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/routes/SettingsTab.test.tsx`
Expected: PASS.

Then prove the Kanban test is not vacuous: temporarily change the gate to
`{true && <CadenceSettings cadence={project} />}` and re-run. The Kanban test must go **RED**.
Revert the change. A test that never fails pins nothing — this repo has 31 recorded shapes of
a suite passing for the wrong reason.

- [ ] **Step 5: Run the full gate**

Run: `npm run verify`
Expected: lint, format:check and build all clean; unit tests pass; the seven live suites fail
locally with `ENOTFOUND` as documented. **The live failures are expected locally and are not
a result** — CI is where they run for real.

If `format:check` complains, run `npx prettier --write` on the touched files. It is the step
local loops omit and it has reddened this project's CI before.

- [ ] **Step 6: Commit and push**

```bash
git add src/routes/SettingsTab.tsx src/routes/SettingsTab.test.tsx
git commit -F <message-file>
git push
```

Commit summary: `Show the cadence section for Scrum projects only (SPRIN-94)`.

- [ ] **Step 7: Open the PR and watch CI**

Open the PR against `main`, move SPRIN-94 to In Review, then **watch the checks before doing
anything else**. Confirm on the PR's own head commit:

- `verify` green, and its `headSha` equal to the PR head.
- **77 test files** collected, against `test:unit`'s 70 — the gap must still be **7**. A run
  whose count equals the `test:unit` count means the live suites silently skipped, and is a
  failure however green it looks.

If it goes red, read the failure before re-running. Only the four documented flake signatures
are safe to re-run after a cooldown; anything else is real.

---

## Self-Review

**Spec coverage.** Every AC has a task: AC1 and AC2 (Task 1, steps 1 and 7), AC3 (Tasks 3 and
4), AC4 (Task 4), AC5 (Task 1, step 7). The design's "also in scope" items — regenerating
`database.types.ts`, and adding `SprintCadence` / `SPRINT_WEEKDAYS` / `SPRINT_LENGTH_WEEKS`
to `domain.ts` — are Task 2.

**One spec item corrected here rather than carried forward.** The design flags `domain.ts` at
654 lines as a split risk against the 400-line threshold. **Measured: ~181 counted lines**,
because `max-lines` runs with `skipComments` and `skipBlankLines` and this file is mostly
docblock. There is ample headroom and no split is needed. The watch item is discharged, not
deferred.

**A second correction to the design's evidence, not its conclusion.** The spec cites
`information_schema.column_privileges` returning no rows as proof that `projects` carries no
column grants. That view returns nothing for this table regardless, because it filters to
grants the querying role is party to. The conclusion happens to be right — `pg_attribute.attacl`
is genuinely empty, re-derived 2026-08-09 — but the method does not support it, and SPRIN-97
leans on that fact far harder than this story does. The migration banner records the correct
catalogue to read.

**Type consistency.** `SprintCadence` is defined in Task 2 and consumed by Tasks 3 and 4 under
that exact name. `cadenceSummary` is spelled identically in its definition (Task 2), its tests
(Task 2), and its call site (Task 3). `SPRINT_WEEKDAYS` entries are `{ iso, label }` in both
the implementation and the test that indexes them.

**Placeholder scan.** No TBDs. Every code step carries the actual code; every run step carries
the actual command and its expected result.
