# SPRIN-92 Single-Select Custom Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `select` custom fields a real, editable option list — options managed on Settings, chosen on a ticket, and rejected by the database when they are not on the list.

**Architecture:** A new `project_field_options` table keyed `(field_id, slug)`, referenced by a new `tfv_option_fk` on `ticket_field_values (field_id, value_option)`. A new `project-field-options.ts` data module mirrors `project-fields.ts`. A new `CustomFieldOptions.tsx` renders the editor inline under `select` rows. The two existing type-keyed control maps get a real `<select>` in place of today's disabled placeholder.

**Tech Stack:** React 19, TypeScript strict, Tailwind, shadcn/ui, Supabase (PostgREST + RLS), Vitest, react-hook-form + zod.

**Spec:** `docs/superpowers/specs/2026-08-08-sprin-92-single-select-fields-design.md` — read it before Task 1. It records two deliberate departures from the epic design and the reasons.

## Global Constraints

- **Lint thresholds are errors and gate the merge (T1–T5):** 30-line functions, cyclomatic 10, cognitive 15, 4 parameters, 400-line files. `max-lines` and `max-lines-per-function` skip blanks and comments. Verify with `npm run lint`.
- **Verification is `npm run verify`** — never `tsc --noEmit` (the root config checks **zero** files and exits 0; use `npm run typecheck`). Never a hand-picked subset of tests.
- **The seven live `*.integration.test.ts` suites cannot run locally** — the local Supabase URL is a placeholder and they fail with `ENOTFOUND`. Locally run `npm run test:unit` (65 files / 1158 tests before this story). **CI is the gate** for anything live.
- **The tripwire gap between `npm test` and `npm run test:unit` must stay 7.** All live assertions go in the existing `src/test/rls.integration.test.ts`. Creating a new `*.integration.test.ts` file changes a documented invariant and would require `CLAUDE.md` updating in the same commit.
- **Migrations are hand-applied.** The Supabase MCP is `read_only=true`; `apply_migration` is unavailable and that is not a fault to route around. Produce SQL, validate it read-only, hand David **one** copy-paste command, wait.
- **Never use a Postgres `ENUM`.** `text` + `check` throughout.
- **Advisor baseline 2026-08-08: 1 security WARN, 14 performance lints.** The rule is *add no new lints*, not *reach zero*. Measure after applying and record any delta in the migration file.
- **Status/type vocabularies live in `src/lib/domain.ts` and nowhere else.** Options are user data, not a vocabulary — `domain.ts` gains a shape, not values.
- **Every `.select()` names its columns.** A bare `.select()` is the class SPRIN-86 turned into a user-visible defect.
- **Commit before mutation testing.** `git checkout` destroys uncommitted work.
- Imperative commit summaries. Commit message bodies via `git commit -F <file>` — **never a heredoc** (the External-Guard hook is global and heredocs hang the terminal).

## File Structure

| File | Responsibility |
|---|---|
| `docs/migrations/sprin-92-project-field-options.sql` | **Create.** The table, its four policies, its grants, and `tfv_option_fk`. |
| `docs/sprintboard_phase1_schema.sql` | **Modify.** Add the new table + policies. `domain.test.ts` parses this file and fails if a table arrives without its policies. |
| `src/lib/database.types.ts` | **Regenerate** after the migration is applied. Nothing compiles against the table until this happens. |
| `src/lib/domain.ts` | **Modify.** `ProjectFieldOption` and `ProjectFieldOptionUpdate` types only. |
| `src/lib/field-schemas.ts` | **Modify.** `AddOptionSchema`, `RenameOptionSchema`. |
| `src/lib/project-field-options.ts` | **Create.** All five data functions. Mirrors `project-fields.ts`. |
| `src/lib/project-field-options.test.ts` | **Create.** Unit tests with a mocked supabase client. |
| `src/routes/CustomFieldOptions.tsx` | **Create.** The options list, add form, and delete-with-count confirm. |
| `src/routes/CustomFieldOptions.test.tsx` | **Create.** |
| `src/routes/CustomFieldSettings.tsx` | **Modify.** `CustomFieldRow` renders the editor for `select` fields. |
| `src/routes/TicketCustomFields.tsx` | **Modify.** `CONTROLS.select` becomes a real `<select>`. |
| `src/routes/CreateTicketCustomFields.tsx` | **Modify.** `CREATE_CONTROLS.select` likewise. |
| `src/routes/ProjectShell.tsx` | **Modify.** The fourth read; threads `options` / `optionsPhase`. |
| `src/test/rls.integration.test.ts` | **Modify.** AC2 and AC3 live assertions. |

---

### Task 1: Migration D — the table, its policies, its grants

**Files:**
- Create: `docs/migrations/sprin-92-project-field-options.sql`
- Modify: `docs/sprintboard_phase1_schema.sql`
- Regenerate: `src/lib/database.types.ts`

**Interfaces:**
- Consumes: `project_fields (id, project_id)` — the unique constraint `project_fields_id_project_unique` **already exists** (SPRIN-90). Do not add another.
- Produces: table `project_field_options (project_id, field_id, slug, label, position)`; constraint `tfv_option_fk` on `ticket_field_values`.

- [ ] **Step 1: Write the migration SQL**

Create `docs/migrations/sprin-92-project-field-options.sql`:

```sql
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
```

- [ ] **Step 2: Validate the SQL read-only before handing it over**

Use the Supabase MCP `execute_sql` (a READ — it cannot apply DDL) against a deliberately
broken probe to prove the statement *parses*. A `42704` (undefined object) rather than a
`42601` (syntax error) is the signal that the parser accepted it.

Do not skip this. Handing David SQL that fails to parse costs a round trip he has to drive.

- [ ] **Step 3: Hand David ONE copy-paste command and STOP**

Give exactly one command, on one line, fenced with `---` rules above and below, and wait for
his output before doing anything else. Do not lay out subsequent steps in the same message.

- [ ] **Step 4: Verify the migration landed, from the catalogue**

Do not trust the editor's success message. Confirm via `execute_sql`:
- `project_field_options` exists with RLS **on** and force **off**
- exactly four `options_owner_*` policies, all using `(select auth.uid())`
- `relacl` shows neither role carrying `a` (insert) or `w` (update) **at table level**
- exactly five column grants at `authenticated=a`, and exactly one at `authenticated=w` (`label`)
- `tfv_option_fk` exists on `ticket_field_values`

- [ ] **Step 5: Run `get_advisors` and record the delta in the migration file**

Baseline is 1 security WARN + 14 performance lints. Append a comment block to the migration
recording the measured numbers and, for any **new** `unindexed_foreign_keys` INFO, either an
index or an explicit acceptance with the reason.

`pfo_field_fk` on `(field_id, project_id)` is expected to go unflagged — the primary key index
`(field_id, slug)` leads with `field_id`, and SPRIN-88's migration records that the linter
matches on the **leading column**. `tfv_option_fk` may add a fourth INFO to `ticket_field_values`.

**Do not re-open the `(field_id)` index question.** David settled it: keep the index, add
nothing, accept the INFOs.

- [ ] **Step 6: Regenerate `database.types.ts`**

Nothing can compile against the new table until this is done. Use the Supabase MCP
`generate_typescript_types` and write the result to `src/lib/database.types.ts`.

- [ ] **Step 7: Add the table to `docs/sprintboard_phase1_schema.sql`**

Copy the `create table` and all four policies. `domain.test.ts` parses this file and fails if a
table appears without its policies — that is how `ticket_field_values` was caught in SPRIN-88.

- [ ] **Step 8: Run the gate**

Run: `npm run typecheck && npm run test:unit`
Expected: PASS. This task adds no test file, so the counts should be unchanged from the branch
point — but re-derive rather than trusting any number written down here.

- [ ] **Step 9: Commit**

```bash
git add docs/migrations/sprin-92-project-field-options.sql docs/sprintboard_phase1_schema.sql src/lib/database.types.ts
git commit -F <message-file>
```

---

### Task 2: Domain types and form schemas

**Files:**
- Modify: `src/lib/domain.ts`
- Modify: `src/lib/field-schemas.ts`
- Test: `src/lib/field-schemas.test.ts`

**Interfaces:**
- Consumes: `Tables<'project_field_options'>` from Task 1's regenerated types.
- Produces: `ProjectFieldOption`, `ProjectFieldOptionUpdate`, `AddOptionSchema`, `RenameOptionSchema`, `AddOptionValues`, `RenameOptionValues`.

- [ ] **Step 1: Write the failing schema tests**

Append to `src/lib/field-schemas.test.ts`:

```ts
describe('AddOptionSchema', () => {
  it('trims the label', () => {
    expect(AddOptionSchema.parse({ label: '  High  ' })).toEqual({ label: 'High' })
  })

  it('refuses an empty label', () => {
    const result = AddOptionSchema.safeParse({ label: '   ' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Give the option a label')
  })

  it('refuses a label over 40 characters, matching pfo_label_nonempty', () => {
    const result = AddOptionSchema.safeParse({ label: 'x'.repeat(41) })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Keep the label to 40 characters or fewer')
  })

  it('refuses a label with no derivable slug, which Rename accepts', () => {
    expect(AddOptionSchema.safeParse({ label: '参照' }).success).toBe(false)
    expect(RenameOptionSchema.safeParse({ label: '参照' }).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/field-schemas.test.ts`
Expected: FAIL — `AddOptionSchema is not defined`.

- [ ] **Step 3: Add the types to `domain.ts`**

```ts
/**
 * One choosable value of a `select` custom field (SPRIN-92). The definition is
 * `ProjectField`; the ticket's stored value is `TicketFieldValue.value_option`.
 *
 * No narrowing wrapper is needed — unlike `ProjectField.type`, every column here is a
 * plain scalar with no client-side union to keep honest.
 */
export type ProjectFieldOption = Tables<'project_field_options'>

/**
 * The UPDATE shape, mirroring a column-level GRANT exactly as `ProjectFieldUpdate` does.
 * `authenticated` holds UPDATE on `label` alone, so `.update({ slug })` must be a COMPILE
 * error rather than a runtime 42501 discovered only against the live database.
 */
export type ProjectFieldOptionUpdate = { label: string }
```

- [ ] **Step 4: Add the schemas to `field-schemas.ts`**

```ts
/**
 * The option add/rename rules. The 40-character cap and the trim mirror
 * `pfo_label_nonempty` (`btrim(label) <> '' and length(label) <= 40`), so a label this
 * schema accepts is one the database accepts.
 *
 * The `slugForName` refine is on ADD only, exactly as `addName` is — an add derives a
 * slug and a rename never does, so refusing an underivable label on rename would be a
 * constraint the database does not have.
 */
const optionLabel = z
  .string()
  .trim()
  .min(1, 'Give the option a label')
  .max(40, 'Keep the label to 40 characters or fewer')

const addOptionLabel = optionLabel.refine(
  (value) => slugForName(value) !== null,
  'Include at least one character from a–z or 0–9 in the label',
)

export const AddOptionSchema = z.object({ label: addOptionLabel })
export const RenameOptionSchema = z.object({ label: optionLabel })

export type AddOptionValues = z.input<typeof AddOptionSchema>
export type RenameOptionValues = z.input<typeof RenameOptionSchema>
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/field-schemas.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/domain.ts src/lib/field-schemas.ts src/lib/field-schemas.test.ts
git commit -F <message-file>
```

---

### Task 3: `listProjectFieldOptions`

**Files:**
- Create: `src/lib/project-field-options.ts`
- Create: `src/lib/project-field-options.test.ts`

**Interfaces:**
- Consumes: `ProjectFieldOption` (Task 2), `supabase` from `./supabase`.
- Produces: `listProjectFieldOptions(projectId: string): Promise<ProjectFieldOption[]>`, `OPTION_COLUMNS`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/project-field-options.test.ts`. Note the mock gives **each `.order()` its own
function** — sharing one would make `(position, slug)` and `(slug, position)` indistinguishable,
and the second key is the tie-break that makes the sequence total.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listProjectFieldOptions } from './project-field-options'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

const orderSlug = vi.fn()
const orderPosition = vi.fn(() => ({ order: orderSlug }))
const eq = vi.fn(() => ({ order: orderPosition }))
const select = vi.fn(() => ({ eq }))

function mockRows(data: unknown[] | null, error: { message: string } | null = null) {
  orderSlug.mockResolvedValue({ data, error })
}

const ROWS = [
  { project_id: 'p1', field_id: 'f1', slug: 'low', label: 'Low', position: 1 },
  { project_id: 'p1', field_id: 'f1', slug: 'high', label: 'High', position: 2 },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(supabase.from).mockReturnValue({ select } as never)
})

describe('listProjectFieldOptions', () => {
  it('names its columns explicitly rather than issuing a bare select', async () => {
    mockRows(ROWS)
    await listProjectFieldOptions('p1')
    expect(select).toHaveBeenCalledWith('project_id, field_id, slug, label, position')
  })

  it('filters by project and orders by position then slug', async () => {
    mockRows(ROWS)
    await listProjectFieldOptions('p1')
    expect(eq).toHaveBeenCalledWith('project_id', 'p1')
    expect(orderPosition).toHaveBeenCalledWith('position', { ascending: true })
    expect(orderSlug).toHaveBeenCalledWith('slug', { ascending: true })
  })

  it('returns the rows', async () => {
    mockRows(ROWS)
    await expect(listProjectFieldOptions('p1')).resolves.toEqual(ROWS)
  })

  it('THROWS on error rather than resolving to an empty list', async () => {
    mockRows(null, { message: 'boom' })
    await expect(listProjectFieldOptions('p1')).rejects.toThrow(
      'Could not load field options: boom',
    )
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/project-field-options.test.ts`
Expected: FAIL — cannot resolve `./project-field-options`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/project-field-options.ts`:

```ts
import { supabase } from './supabase'
import type { ProjectFieldOption } from './domain'

/**
 * The columns this module reads, NAMED — not a bare `.select()`.
 *
 * `project-statuses.ts` uses a no-arg select and SPRIN-86 turned that into a user-visible
 * defect: it was the first reader of `wip_limit`, and narrowing the select left the whole
 * suite green while the board rendered `· limit undefined`. It is a CLASS, not one column.
 * The test asserts this exact string reaches PostgREST.
 */
const OPTION_COLUMNS = 'project_id, field_id, slug, label, position'

/**
 * One project's select-field options, across every `select` field it has.
 *
 * THROWS rather than resolving to `[]`, mirroring `listProjectFields`: `[]` is the COMMON
 * legitimate state here — most fields are not `select`, and a select field starts with no
 * options — so a silent empty is indistinguishable from a failed read. The caller reads
 * the phase, never the emptiness.
 *
 * **Ordered `(position, slug)`, and both keys are needed.** This CORRECTS the epic design,
 * which specifies `position` alone. Nothing makes `position` unique — the client derives it
 * as `max(position) + 1` from a list nothing refetches — so two options can tie and
 * PostgREST would return them in an arbitrary, unstable order. `slug` is unique per field
 * and breaks every tie. Identical to the `(created_at, slug)` guard on `listProjectFields`.
 */
export async function listProjectFieldOptions(projectId: string): Promise<ProjectFieldOption[]> {
  const { data, error } = await supabase
    .from('project_field_options')
    .select(OPTION_COLUMNS)
    .eq('project_id', projectId)
    .order('position', { ascending: true })
    .order('slug', { ascending: true })

  if (error) throw new Error(`Could not load field options: ${error.message}`)
  return data ?? []
}

/** The options belonging to one field, in the order `listProjectFieldOptions` established. */
export function optionsForField(
  options: readonly ProjectFieldOption[],
  fieldId: string,
): ProjectFieldOption[] {
  return options.filter((o) => o.field_id === fieldId)
}
```

- [ ] **Step 4: Add a test for `optionsForField`**

```ts
describe('optionsForField', () => {
  it('keeps only the named field and preserves the query order', () => {
    const other = { project_id: 'p1', field_id: 'f2', slug: 'a', label: 'A', position: 1 }
    expect(optionsForField([ROWS[0], other, ROWS[1]], 'f1')).toEqual([ROWS[0], ROWS[1]])
  })
})
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/lib/project-field-options.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/project-field-options.ts src/lib/project-field-options.test.ts
git commit -F <message-file>
```

---

### Task 4: `createProjectFieldOption`

**Files:**
- Modify: `src/lib/project-field-options.ts`
- Modify: `src/lib/project-field-options.test.ts`

**Interfaces:**
- Consumes: `uniqueSlugForName(name: string, taken: readonly string[]): string | null` from `./project-statuses`.
- Produces: `OptionWriteResult<T>`, `createProjectFieldOption(input: { projectId: string; fieldId: string; label: string; existing: readonly ProjectFieldOption[] }): Promise<OptionWriteResult<ProjectFieldOption>>`.

- [ ] **Step 1: Write the failing tests**

Add to the test file. The insert chain needs its own links — `.select()` returns `{ eq }` when
it starts a read and `{ single }` when it terminates a write, so a shared mock could only
return one and a test could not say which call it saw.

```ts
const single = vi.fn()
const selectInsert = vi.fn(() => ({ single }))
const insert = vi.fn(() => ({ select: selectInsert }))

function mockWrite(data: unknown, error: { code?: string; message?: string } | null = null) {
  single.mockResolvedValue({ data, error })
}

describe('createProjectFieldOption', () => {
  beforeEach(() => {
    vi.mocked(supabase.from).mockReturnValue({ select, insert } as never)
  })

  it('sends exactly the five granted columns and no others', async () => {
    mockWrite({ ...ROWS[0], slug: 'medium', label: 'Medium', position: 3 })
    await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Medium',
      existing: ROWS,
    })
    expect(insert).toHaveBeenCalledWith({
      project_id: 'p1',
      field_id: 'f1',
      slug: 'medium',
      label: 'Medium',
      position: 3,
    })
  })

  it('derives position as max(position) + 1', async () => {
    mockWrite(ROWS[0])
    await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Medium',
      existing: [{ ...ROWS[0], position: 7 }],
    })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ position: 8 }))
  })

  it('starts at position 1 when the field has no options', async () => {
    mockWrite(ROWS[0])
    await createProjectFieldOption({ projectId: 'p1', fieldId: 'f1', label: 'Low', existing: [] })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ position: 1 }))
  })

  it('de-duplicates the slug against the options already held', async () => {
    mockWrite(ROWS[0])
    await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Low',
      existing: ROWS,
    })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ slug: 'low_2' }))
  })

  it('sends NO request at all when no legal slug can be derived', async () => {
    const result = await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: '参照',
      existing: [],
    })
    expect(insert).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: 'unknown' })
  })

  it('reports a primary-key collision as stale', async () => {
    mockWrite(null, { code: '23505', message: 'duplicate key ... "project_field_options_pkey"' })
    const result = await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Low',
      existing: [],
    })
    expect(result).toEqual({ ok: false, error: 'stale' })
  })

  it('reports a DIFFERENT 23505 as unknown, not stale', async () => {
    mockWrite(null, { code: '23505', message: 'duplicate key ... "some_later_constraint"' })
    const result = await createProjectFieldOption({
      projectId: 'p1',
      fieldId: 'f1',
      label: 'Low',
      existing: [],
    })
    expect(result).toEqual({ ok: false, error: 'unknown' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/project-field-options.test.ts`
Expected: FAIL — `createProjectFieldOption is not exported`.

- [ ] **Step 3: Write the implementation**

Add to `src/lib/project-field-options.ts`:

```ts
import { uniqueSlugForName } from './project-statuses'

export type OptionWriteResult<T> = { ok: true; value: T } | { ok: false; error: OptionWriteError }

type OptionWriteError = 'stale' | 'unknown'

const UNIQUE_VIOLATION = '23505'

/**
 * The one unique constraint reachable from here, and why its remedy is `'stale'`.
 *
 * The slug is de-duplicated against a list the caller holds and nothing refetches, so a
 * 23505 on the primary key means exactly one thing: that list was older than the database.
 * Retrying the same submit reproduces it forever — the label was never the problem — so
 * reloading is the only remedy, which is what `'stale'` means everywhere in this codebase.
 *
 * An ALLOW-LIST on purpose. A 23505 naming a constraint added by a later story collapses to
 * `'unknown'` and generic retry copy, rather than a confident sentence telling the user to
 * reload for something a reload will not fix. Matching on the message is the only channel
 * PostgREST exposes: `code` is 23505, `details` and `hint` are null, and the constraint name
 * appears inside `message` alone — untranslated, because it comes from the catalog.
 */
const STALE_CONSTRAINT = 'project_field_options_pkey'

function writeError(error: { code?: string; message?: string } | null): OptionWriteError {
  if (!error || error.code !== UNIQUE_VIOLATION) return 'unknown'
  return (error.message ?? '').includes(STALE_CONSTRAINT) ? 'stale' : 'unknown'
}

/**
 * Add an option to a `select` field (AC1).
 *
 * ONE object parameter, not four positional ones: T4 caps parameters at 4, and an object is
 * this repo's idiom for a write's inputs.
 *
 * `existing` must be the options of THIS field only — pass `optionsForField(...)`. Handing it
 * the whole project's options would de-duplicate the slug against other fields' slugs, which
 * the primary key `(field_id, slug)` does not require, and would waste `low_2` on a field
 * that has no `low`.
 *
 * No legal slug means NO REQUEST AT ALL. Sending one would earn a check-constraint violation
 * naming `slug` — a column the user has never seen and cannot correct. `AddOptionSchema`
 * refuses these at the form edge where the message can explain itself; this is the backstop
 * for every other caller.
 */
export async function createProjectFieldOption(input: {
  projectId: string
  fieldId: string
  label: string
  existing: readonly ProjectFieldOption[]
}): Promise<OptionWriteResult<ProjectFieldOption>> {
  const label = input.label.trim()
  const slug = uniqueSlugForName(
    label,
    input.existing.map((o) => o.slug),
  )
  if (slug === null) return { ok: false, error: 'unknown' }

  const position = input.existing.reduce((max, o) => Math.max(max, o.position), 0) + 1

  const { data, error } = await supabase
    .from('project_field_options')
    // EXACTLY these five keys. `authenticated` holds INSERT on these columns alone, so any
    // extra key is a 42501. The test asserts the payload EXACTLY for that reason —
    // `objectContaining` would pass with an extra key present.
    .insert({ project_id: input.projectId, field_id: input.fieldId, slug, label, position })
    .select(OPTION_COLUMNS)
    .single()

  if (error) return { ok: false, error: writeError(error) }
  return { ok: true, value: data }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/project-field-options.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-field-options.ts src/lib/project-field-options.test.ts
git commit -F <message-file>
```

---

### Task 5: Rename, delete, and the ticket count

**Files:**
- Modify: `src/lib/project-field-options.ts`
- Modify: `src/lib/project-field-options.test.ts`

**Interfaces:**
- Produces:
  - `renameProjectFieldOption(fieldId: string, slug: string, label: string): Promise<OptionWriteResult<ProjectFieldOption>>`
  - `deleteProjectFieldOption(fieldId: string, slug: string): Promise<OptionWriteResult<void>>`
  - `countTicketsHoldingOption(fieldId: string, slug: string): Promise<number>`

- [ ] **Step 1: Write the failing tests**

```ts
describe('renameProjectFieldOption', () => {
  it('sends label ALONE, filtered on both key columns', async () => {
    mockWrite({ ...ROWS[0], label: 'Lowest' })
    await renameProjectFieldOption('f1', 'low', '  Lowest  ')
    expect(update).toHaveBeenCalledWith({ label: 'Lowest' })
    expect(eqUpdateField).toHaveBeenCalledWith('field_id', 'f1')
    expect(eqUpdateSlug).toHaveBeenCalledWith('slug', 'low')
  })
})

describe('deleteProjectFieldOption', () => {
  it('reports stale when no row was deleted', async () => {
    deleteSelect.mockResolvedValue({ data: [], error: null })
    await expect(deleteProjectFieldOption('f1', 'low')).resolves.toEqual({
      ok: false,
      error: 'stale',
    })
  })

  it('succeeds when exactly one row was deleted', async () => {
    deleteSelect.mockResolvedValue({ data: [{ slug: 'low' }], error: null })
    await expect(deleteProjectFieldOption('f1', 'low')).resolves.toEqual({
      ok: true,
      value: undefined,
    })
  })
})

describe('countTicketsHoldingOption', () => {
  it('asks for an exact head count on both key columns', async () => {
    countEqSlug.mockResolvedValue({ count: 3, error: null })
    await expect(countTicketsHoldingOption('f1', 'low')).resolves.toBe(3)
    expect(countSelect).toHaveBeenCalledWith('*', { head: true, count: 'exact' })
  })

  it('THROWS on error rather than reporting zero', async () => {
    countEqSlug.mockResolvedValue({ count: null, error: { message: 'boom' } })
    await expect(countTicketsHoldingOption('f1', 'low')).rejects.toThrow(
      'Could not count tickets holding that option: boom',
    )
  })

  it('THROWS on a MISSING count, which is not the same as zero', async () => {
    countEqSlug.mockResolvedValue({ count: null, error: null })
    await expect(countTicketsHoldingOption('f1', 'low')).rejects.toThrow()
  })
})
```

Add the matching mock links beside the existing ones:

```ts
const selectUpdate = vi.fn(() => ({ single }))
const eqUpdateSlug = vi.fn(() => ({ select: selectUpdate }))
const eqUpdateField = vi.fn(() => ({ eq: eqUpdateSlug }))
const update = vi.fn(() => ({ eq: eqUpdateField }))

const deleteSelect = vi.fn()
const eqDeleteSlug = vi.fn(() => ({ select: deleteSelect }))
const eqDeleteField = vi.fn(() => ({ eq: eqDeleteSlug }))
const del = vi.fn(() => ({ eq: eqDeleteField }))

const countEqSlug = vi.fn()
const countEqField = vi.fn(() => ({ eq: countEqSlug }))
const countSelect = vi.fn(() => ({ eq: countEqField }))
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/project-field-options.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Write the implementation**

```ts
import type { ProjectFieldOptionUpdate } from './domain'

/**
 * Rename an option's LABEL (AC3). `label` is the ONLY column sent, and that is a security
 * property rather than tidiness: `authenticated` holds UPDATE on `label` alone, so a patch
 * touching `slug` is refused by Postgres with 42501 before any policy is consulted.
 *
 * `satisfies ProjectFieldOptionUpdate` is what makes that structural instead of a comment.
 * The generated row type offers every column, so `.update({ slug })` would COMPILE and fail
 * only at runtime against the live database — somewhere a mocked unit test never goes.
 *
 * The slug is untouched by construction, which is the whole point: `tfv_option_fk` keys value
 * rows on the slug, so a rename must rewrite nothing but this one cell. AC3 is therefore true
 * by construction rather than by care.
 */
export async function renameProjectFieldOption(
  fieldId: string,
  slug: string,
  label: string,
): Promise<OptionWriteResult<ProjectFieldOption>> {
  const { data, error } = await supabase
    .from('project_field_options')
    .update({ label: label.trim() } satisfies ProjectFieldOptionUpdate)
    .eq('field_id', fieldId)
    .eq('slug', slug)
    .select(OPTION_COLUMNS)
    .single()

  if (error) return { ok: false, error: writeError(error) }
  return { ok: true, value: data }
}

/**
 * Delete an option (AC4). Its value rows go with it via `tfv_option_fk`'s cascade — that is
 * the AC, not a side effect: refusing the delete instead would make any option that was ever
 * used permanently undeletable.
 *
 * The affected row count is checked EXPLICITLY, like `deleteProjectStatus` and
 * `reorderProjectStatuses`, rather than leaning on `.single()`'s incidental zero-row error.
 * RLS FILTERS a delete rather than raising on it, so a cross-tenant or already-deleted row
 * comes back as a successful zero-row delete unless something counts.
 *
 * BOTH key columns are filtered. `field_id` alone would delete every option on the field.
 */
export async function deleteProjectFieldOption(
  fieldId: string,
  slug: string,
): Promise<OptionWriteResult<void>> {
  const { data, error } = await supabase
    .from('project_field_options')
    .delete()
    .eq('field_id', fieldId)
    .eq('slug', slug)
    .select('slug')

  if (error) return { ok: false, error: writeError(error) }
  if ((data ?? []).length !== 1) return { ok: false, error: 'stale' }
  return { ok: true, value: undefined }
}

/**
 * How many tickets hold this option (AC4 — the count is shown BEFORE the user commits).
 *
 * THROWS rather than resolving to zero on error — and on a MISSING count, treated the same
 * way — for the same reason `ticketCountsByStatus` does: **zero is what UNLOCKS the
 * destructive action**, so a failed count reported as zero would offer a delete whose blast
 * radius the user was told was nil.
 */
export async function countTicketsHoldingOption(fieldId: string, slug: string): Promise<number> {
  const { count, error } = await supabase
    .from('ticket_field_values')
    .select('*', { head: true, count: 'exact' })
    .eq('field_id', fieldId)
    .eq('value_option', slug)

  if (error) throw new Error(`Could not count tickets holding that option: ${error.message}`)
  if (count === null) throw new Error('Could not count tickets holding that option: no count')
  return count
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/project-field-options.test.ts && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-field-options.ts src/lib/project-field-options.test.ts
git commit -F <message-file>
```

---

### Task 6: The live database assertions (AC2, AC3)

**Files:**
- Modify: `src/test/rls.integration.test.ts`

**Interfaces:**
- Consumes: the migration from Task 1 (must be applied before this can pass).
- Produces: nothing importable — this task's deliverable is CI evidence.

**These tests cannot run locally.** The seven live suites fail with `ENOTFOUND` against the
placeholder URL. Write them, push, and read CI. Do not claim them green from a local run.

- [ ] **Step 1: Write the AC2 test — the fk refuses an off-list value**

Add a `describe` block beside the existing SPRIN-90 / SPRIN-88 blocks, following their fixture
style (seed a project, a `select` field, and one option).

```ts
it('AC2: refuses a value_option that is not one of the field options', async () => {
  // POSITIVE CONTROL FIRST. Without a successful write against the SAME row shape, a
  // blanket row-level refusal (a broken policy, a missing grant) would be indistinguishable
  // from tfv_option_fk doing its job.
  const good = await client.from('ticket_field_values').insert({
    ticket_id: ticketId,
    project_id: projectId,
    field_id: fieldId,
    field_type: 'select',
    value_option: 'low',
  })
  expect(good.error).toBeNull()

  const bad = await client.from('ticket_field_values').insert({
    ticket_id: otherTicketId,
    project_id: projectId,
    field_id: fieldId,
    field_type: 'select',
    value_option: 'not_an_option',
  })
  expect(bad.error?.code).toBe('23503')
  expect(bad.error?.message).toMatch(/tfv_option_fk/)
})
```

- [ ] **Step 2: Write the AC3 tests — a label rename rewrites no value row**

```ts
it('AC3: renaming a label leaves the stored value_option untouched', async () => {
  await client.from('ticket_field_values').insert({
    ticket_id: ticketId,
    project_id: projectId,
    field_id: fieldId,
    field_type: 'select',
    value_option: 'low',
  })

  const renamed = await client
    .from('project_field_options')
    .update({ label: 'Lowest' })
    .eq('field_id', fieldId)
    .eq('slug', 'low')
  expect(renamed.error).toBeNull()

  // Read the value BACK — the point of AC3 is that no value row was rewritten.
  const { data } = await client
    .from('ticket_field_values')
    .select('value_option')
    .eq('ticket_id', ticketId)
    .eq('field_id', fieldId)
    .single()
  expect(data?.value_option).toBe('low')
})

it('AC3: the slug is not writable — 42501 from the column grant', async () => {
  const { error } = await client
    .from('project_field_options')
    .update({ slug: 'renamed' })
    .eq('field_id', fieldId)
    .eq('slug', 'low')
  expect(error?.code).toBe('42501')
})
```

- [ ] **Step 3: Write the AC4 test — the cascade actually clears**

```ts
it('AC4: deleting an option clears every value row holding it', async () => {
  await client.from('ticket_field_values').insert({
    ticket_id: ticketId,
    project_id: projectId,
    field_id: fieldId,
    field_type: 'select',
    value_option: 'low',
  })

  const removed = await client
    .from('project_field_options')
    .delete()
    .eq('field_id', fieldId)
    .eq('slug', 'low')
  expect(removed.error).toBeNull()

  // Assert the COUNT, not the absence of an error — RLS filters rather than raising.
  const { count } = await client
    .from('ticket_field_values')
    .select('*', { head: true, count: 'exact' })
    .eq('ticket_id', ticketId)
    .eq('field_id', fieldId)
  expect(count).toBe(0)
})
```

- [ ] **Step 4: Confirm the tripwire is unchanged**

**Assert the GAP, never the absolute counts.** Both totals move with every unit-test file this
story adds; the difference between them is the invariant, and it must stay **7**.

```bash
npx vitest list --filesOnly | wc -l
npx vitest list --filesOnly --exclude '**/*.integration.test.ts' | wc -l
```

The two numbers must differ by exactly 7. If the gap moved, a new `*.integration.test.ts` file
was created and this task took the wrong approach — move the assertions into
`rls.integration.test.ts`.

- [ ] **Step 5: Commit and push, then read CI**

```bash
git add src/test/rls.integration.test.ts
git commit -F <message-file>
git push
```

Watch the `verify` check. Confirm the run's `headSha` equals the branch head and that it
collected **72** files — a run collecting 65 means the live suites skipped and is a failure
however green it looks.

---

### Task 7: `CustomFieldOptions` — the list and the add form

**Files:**
- Create: `src/routes/CustomFieldOptions.tsx`
- Create: `src/routes/CustomFieldOptions.test.tsx`

**Interfaces:**
- Consumes: `createProjectFieldOption`, `renameProjectFieldOption`, `optionsForField` (Tasks 3–4); `AddOptionSchema`, `RenameOptionSchema` (Task 2); `EditableText`, `SubmitButton`, `FormRootError` from the existing route modules.
- Produces: `<CustomFieldOptions field options onCreated onUpdated onDeleted />`.

- [ ] **Step 1: Write the failing tests**

Assert **DOM text and its container**, scoped with `within` — an unscoped `getByText` says the
text exists and nothing about where. Pair any name assertion with a **substring** role query,
never an exact accessible name: under jsdom a name composed from flex children is fused and is
not what a browser computes.

```ts
const OPTIONS = [
  { project_id: 'p1', field_id: 'f1', slug: 'high', label: 'High', position: 2 },
  { project_id: 'p1', field_id: 'f1', slug: 'low', label: 'Low', position: 1 },
]

it('lists the options in position order', () => {
  render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)
  const items = screen.getAllByRole('listitem')
  expect(items).toHaveLength(2)
  expect(within(items[0]).getByText('Low')).toBeInTheDocument()
  expect(within(items[1]).getByText('High')).toBeInTheDocument()
})

it('breaks a position TIE on slug, so the order is total', () => {
  const tied = [
    { ...OPTIONS[0], slug: 'zebra', label: 'Zebra', position: 1 },
    { ...OPTIONS[1], slug: 'apple', label: 'Apple', position: 1 },
  ]
  render(<CustomFieldOptions field={FIELD} options={tied} {...noopHandlers} />)
  const items = screen.getAllByRole('listitem')
  expect(within(items[0]).getByText('Apple')).toBeInTheDocument()
})

it('shows an empty state when the field has no options', () => {
  render(<CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} />)
  expect(screen.getByText('No options yet.')).toBeInTheDocument()
})

it('adds an option and hands the row up', async () => {
  vi.mocked(createProjectFieldOption).mockResolvedValue({ ok: true, value: OPTIONS[0] })
  const onCreated = vi.fn()
  render(<CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} onCreated={onCreated} />)

  await userEvent.type(screen.getByRole('textbox', { name: /option label/i }), 'High')
  await userEvent.click(screen.getByRole('button', { name: 'Add option' }))

  expect(createProjectFieldOption).toHaveBeenCalledWith({
    projectId: 'p1',
    fieldId: 'f1',
    label: 'High',
    existing: [],
  })
  expect(onCreated).toHaveBeenCalledWith(OPTIONS[0])
})

it('passes only THIS field\'s options as the de-duplication list', async () => {
  vi.mocked(createProjectFieldOption).mockResolvedValue({ ok: true, value: OPTIONS[0] })
  const mixed = [...OPTIONS, { ...OPTIONS[0], field_id: 'f2', slug: 'other' }]
  render(<CustomFieldOptions field={FIELD} options={mixed} {...noopHandlers} />)

  await userEvent.type(screen.getByRole('textbox', { name: /option label/i }), 'Medium')
  await userEvent.click(screen.getByRole('button', { name: 'Add option' }))

  expect(createProjectFieldOption).toHaveBeenCalledWith(
    expect.objectContaining({ existing: [OPTIONS[1], OPTIONS[0]] }),
  )
})

it('reports a stale list with copy that says to reload, not to retry', async () => {
  vi.mocked(createProjectFieldOption).mockResolvedValue({ ok: false, error: 'stale' })
  render(<CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} />)

  await userEvent.type(screen.getByRole('textbox', { name: /option label/i }), 'High')
  await userEvent.click(screen.getByRole('button', { name: 'Add option' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(/refresh the page/i)
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/routes/CustomFieldOptions.test.tsx`
Expected: FAIL — cannot resolve `./CustomFieldOptions`.

- [ ] **Step 3: Implement the component**

Keep each function under 30 counted lines and cyclomatic 10. Sort with a comparator that reads
`position` then `slug`, mirroring the query — the component must not depend on the server
having sorted, because the same list is filtered per field.

```tsx
const STALE_OPTIONS =
  'This list of options is out of date — refresh the page and try adding it again.'

function byPositionThenSlug(a: ProjectFieldOption, b: ProjectFieldOption) {
  return a.position - b.position || a.slug.localeCompare(b.slug)
}
```

The add form mirrors `AddFieldForm`: `useForm` + `zodResolver(AddOptionSchema)`, a form-level
`root` error (the label was never the problem for a `'stale'`), and `form.reset()` on success.
Each row uses `EditableText` for the label with `ariaLabel={`label of ${option.label}`}` and owns
its own `role="alert"` — a page-level banner could not say WHICH label was refused.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/routes/CustomFieldOptions.test.tsx && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/CustomFieldOptions.tsx src/routes/CustomFieldOptions.test.tsx
git commit -F <message-file>
```

---

### Task 8: Deleting an option, behind a count

**Files:**
- Modify: `src/routes/CustomFieldOptions.tsx`
- Modify: `src/routes/CustomFieldOptions.test.tsx`

**Interfaces:**
- Consumes: `countTicketsHoldingOption`, `deleteProjectFieldOption` (Task 5).
- Produces: the confirm UI inside `CustomFieldOptions`.

- [ ] **Step 1: Write the failing tests**

```ts
it('shows how many tickets hold the option before committing', async () => {
  vi.mocked(countTicketsHoldingOption).mockResolvedValue(3)
  render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)

  await userEvent.click(screen.getAllByRole('button', { name: /remove/i })[0])
  expect(await screen.findByText(/3 tickets/i)).toBeInTheDocument()
  expect(deleteProjectFieldOption).not.toHaveBeenCalled()
})

it('reads the count only when the confirm opens, not on render', () => {
  render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)
  expect(countTicketsHoldingOption).not.toHaveBeenCalled()
})

it('BLOCKS the delete when the count could not be read', async () => {
  vi.mocked(countTicketsHoldingOption).mockRejectedValue(new Error('boom'))
  render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)

  await userEvent.click(screen.getAllByRole('button', { name: /remove/i })[0])

  // Zero is what UNLOCKS a destructive action, so an unknown count must not read as zero.
  expect(await screen.findByRole('alert')).toHaveTextContent(/could not check/i)
  const confirm = screen.getByRole('button', { name: 'Remove option' })
  expect(confirm).toBeDisabled()
})

it('deletes on confirm and hands the removal up', async () => {
  vi.mocked(countTicketsHoldingOption).mockResolvedValue(0)
  vi.mocked(deleteProjectFieldOption).mockResolvedValue({ ok: true, value: undefined })
  const onDeleted = vi.fn()
  render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} onDeleted={onDeleted} />)

  await userEvent.click(screen.getAllByRole('button', { name: /remove/i })[0])
  await userEvent.click(await screen.findByRole('button', { name: 'Remove option' }))

  expect(deleteProjectFieldOption).toHaveBeenCalledWith('f1', 'low')
  expect(onDeleted).toHaveBeenCalledWith('f1', 'low')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/routes/CustomFieldOptions.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

Model on SPRIN-80's status delete, which is this project's precedent for count-before-commit.
The count is state of three shapes — `'counting' | { count: number } | 'failed'` — and the
confirm button is disabled unless the third is a number. Do not model it as `number | null`,
which makes "unknown" and "none" the same value; that is the whole defect this guards.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/routes/CustomFieldOptions.test.tsx && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 9: Wire the editor into Settings and add the fourth read

**Files:**
- Modify: `src/routes/CustomFieldSettings.tsx`
- Modify: `src/routes/CustomFieldSettings.test.tsx`
- Modify: `src/routes/ProjectShell.tsx`
- Modify: `src/routes/ProjectShell.test.tsx`

**Interfaces:**
- Consumes: `<CustomFieldOptions>` (Tasks 7–8), `listProjectFieldOptions` (Task 3).
- Produces: `options: ProjectFieldOption[]` and `optionsPhase: ReadPhase` threaded from `ProjectShell` to `CustomFieldSettings`, `TicketDetailDialog` and `CreateTicketDialog`.

- [ ] **Step 1: Write the failing wiring test**

`ProjectShell.test.tsx` must carry a **real wiring** test, as its `sprints`/`statuses`/`fields`
siblings do. SPRIN-88's review found the whole feature could be unplugged in three places with
1094 tests green; this is the test that stops the fourth read going the same way.

```ts
it('reads the project field options and passes them to the settings tab', async () => {
  vi.mocked(listProjectFieldOptions).mockResolvedValue(OPTIONS)
  renderShell()
  await userEvent.click(screen.getByRole('tab', { name: 'Settings' }))
  expect(listProjectFieldOptions).toHaveBeenCalledWith('p1')
  expect(await screen.findByText('Low')).toBeInTheDocument()
})
```

And in `CustomFieldSettings.test.tsx`:

```ts
it('renders the options editor for a select field and NOT for the others', () => {
  render(<CustomFieldSettings {...props} fields={[SELECT_FIELD, TEXT_FIELD]} options={OPTIONS} />)
  const rows = screen.getAllByRole('listitem')
  expect(within(rows[0]).getByRole('button', { name: 'Add option' })).toBeInTheDocument()
  expect(within(rows[1]).queryByRole('button', { name: 'Add option' })).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/routes/ProjectShell.test.tsx src/routes/CustomFieldSettings.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `ProjectShell.tsx`, beside the three existing reads:

```ts
const optionRead = useTaggedRead(activeProjectId, reloadNonce, listProjectFieldOptions)
const { phase: optionsPhase, items: options } = optionRead
```

In `CustomFieldRow`, render the editor beneath the name for `select` fields only. Measure the
row's cyclomatic complexity afterwards — a ternary costs a point:

```bash
npx eslint src/routes/CustomFieldSettings.tsx --rule '{"complexity":["error",1]}'
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 10: The ticket's select control

**Files:**
- Modify: `src/routes/TicketCustomFields.tsx`
- Modify: `src/routes/TicketCustomFields.test.tsx`

**Interfaces:**
- Consumes: `options` / `optionsPhase` (Task 9), `clearTicketFieldValue` and `setTicketFieldValue` from `ticket-field-values.ts`.
- Produces: a working `CONTROLS.select`.

- [ ] **Step 1: Write the failing tests**

```ts
it('offers a blank choice FIRST, then the options in order', () => {
  renderRow({ field: SELECT_FIELD, options: OPTIONS, optionsPhase: 'loaded' })
  const select = screen.getByRole('combobox', { name: /risk/i })
  const opts = within(select).getAllByRole('option')
  expect(opts[0]).toHaveValue('')
  expect(opts.map((o) => o.textContent)).toEqual(['—', 'Low', 'High'])
})

it('CLEARS rather than writing an empty string when the blank choice is picked', async () => {
  renderRow({ field: SELECT_FIELD, options: OPTIONS, optionsPhase: 'loaded', value: LOW_VALUE })
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /risk/i }), '')
  expect(clearTicketFieldValue).toHaveBeenCalledWith('t1', 'f1')
  expect(setTicketFieldValue).not.toHaveBeenCalled()
})

it('writes the option SLUG, not its label', async () => {
  renderRow({ field: SELECT_FIELD, options: OPTIONS, optionsPhase: 'loaded' })
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /risk/i }), 'low')
  expect(setTicketFieldValue).toHaveBeenCalledWith(
    expect.objectContaining({ fieldType: 'select', valueOption: 'low' }),
  )
})

it('is DISABLED while the options read has not loaded', () => {
  renderRow({ field: SELECT_FIELD, options: [], optionsPhase: 'loading' })
  expect(screen.getByRole('combobox', { name: /risk/i })).toBeDisabled()
})

it('is DISABLED when the options read FAILED — an empty list is not "no options"', () => {
  renderRow({ field: SELECT_FIELD, options: [], optionsPhase: 'failed' })
  expect(screen.getByRole('combobox', { name: /risk/i })).toBeDisabled()
})

it('is ENABLED with only the blank choice when the field genuinely has no options', () => {
  renderRow({ field: SELECT_FIELD, options: [], optionsPhase: 'loaded' })
  const select = screen.getByRole('combobox', { name: /risk/i })
  expect(select).toBeEnabled()
  expect(within(select).getAllByRole('option')).toHaveLength(1)
})

it('leaves the other four types unchanged', () => {
  renderRow({ field: TEXT_FIELD, options: [], optionsPhase: 'failed' })
  expect(screen.getByRole('button', { name: /customer ref/i })).toBeEnabled()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/routes/TicketCustomFields.test.tsx`
Expected: FAIL — the control is still the disabled placeholder.

- [ ] **Step 3: Implement**

Extend `ControlProps` with `options: readonly ProjectFieldOption[]` and `optionsReady: boolean`.
The other four entries ignore both. Keep `CONTROLS` a `Record<CustomFieldType, …>` and keep the
`const Control = CONTROLS[field.type]` binding — a call through a computed member is forbidden
under `src/` by `project-type-immutability.test.ts` check 1.

The blank option carries `value=""`. The commit handler routes `''` to `clearTicketFieldValue`;
this must not go through `parseFieldValue`'s generic path if that would produce an empty-string
write, because `tfv_option_fk` refuses `''`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/routes/TicketCustomFields.test.tsx && npm run lint`
Expected: PASS.

- [ ] **Step 5: Mutation-check the two highest-risk behaviours**

Commit first — `git checkout` destroys uncommitted work.

1. Change the blank branch to write `''` instead of clearing. **A test must go red.**
2. Change `optionsReady` to a constant `true`. **A test must go red.**

Restore with `git checkout -- src/routes/TicketCustomFields.tsx` after each. If either survives,
the test is vacuous and must be rewritten before moving on.

- [ ] **Step 6: Commit**

---

### Task 11: The create-ticket dialog's select control

**Files:**
- Modify: `src/routes/CreateTicketCustomFields.tsx`
- Modify: `src/routes/CreateTicketCustomFields.test.tsx`
- Modify: `src/routes/CreateTicketDialog.tsx`

**Interfaces:**
- Consumes: `options` / `optionsPhase` (Task 9).
- Produces: a working `CREATE_CONTROLS.select`.

- [ ] **Step 1: Write the failing tests**

Mirror Task 10's blank-first, disabled-when-unloaded and slug-not-label assertions against the
create dialog. Add one the detail sidebar does not need:

```ts
it('clears the draft option when the dialog is reopened', async () => {
  // Radix UNMOUNTS dialog content on close, so a close/reopen test would pass even with the
  // reset removed. Render the row OUTSIDE a dialog and call form.reset() directly.
  const { form } = renderRowWithForm({ field: SELECT_FIELD, options: OPTIONS })
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /risk/i }), 'low')
  act(() => form.reset())
  expect(screen.getByRole('combobox', { name: /risk/i })).toHaveValue('')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/routes/CreateTicketCustomFields.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`CREATE_CONTROLS.select` becomes a real `<select>` fed from the same `options` prop. Draft values
already live in react-hook-form as a `custom` record (SPRIN-89), so the reset is correct by
construction — do not add an `onClosed` handler.

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test:unit && npm run lint && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 12: Full verification and PR

**Files:** none — this task's deliverable is a green required check.

- [ ] **Step 1: Re-derive the test counts, and assert only the GAP**

```bash
npx vitest list --filesOnly | wc -l
npx vitest list --filesOnly --exclude '**/*.integration.test.ts' | wc -l
```

**The absolute numbers WILL have moved** — this story adds at least
`project-field-options.test.ts` and `CustomFieldOptions.test.tsx`, so both totals rise together.
That is expected and is not a regression. The invariant is that they differ by exactly **7**.

Do not copy either absolute into a commit message, the PR, `CLAUDE.md` or the handover as though
it were a constant: those numbers have been recorded wrongly in this repo more than once, which
is why the gap is the thing that is pinned.

- [ ] **Step 2: Run the real gate**

Run: `npm run lint && npm run format:check && npm run build && npm run test:unit`

The full `npm run verify` includes `npm test`, whose seven live suites cannot run here. Do not
report `verify` green from this machine — say what was run and let CI be the gate.

- [ ] **Step 3: Record what this hands to SPRIN-75 in `docs/HANDOVER.md`**

Spec §5 lists three items that become reachable under a membership model. They are worth more
now, while the reasoning is fresh, than reconstructed later. Add them to the handover's
"Owed to SPRIN-75" section:

- `project_field_options` is born with **TRUNCATE granted to both roles**, and TRUNCATE bypasses
  RLS. Not reachable through PostgREST today, so it is defence-in-depth — but `revoke truncate`
  is one line and would keep this table out of SPRIN-75's sweep.
- The policies read `project_id` **alone**, so `field_id` and `slug` are fk-governed including
  across tenants. Re-audit before narrowing those composite fks during the membership rewrite —
  that narrowing is what the *wrong* version of the SPRIN-88 finding would license.
- `deleteProjectFieldOption` filters on `(field_id, slug)` and leans on the policy's USING
  clause — a fresh instance of the SPRIN-64 class. Correct today; under read-broader-than-write
  a viewer-role delete would not be caught here.

Also add a session entry, and update the epic progress line: SPRIN-71 becomes **five of six**,
with only SPRIN-93 left.

- [ ] **Step 4: Open the PR**

Describe the two spec departures (the `project_id` column, the `(position, slug)` ordering), the
migration's advisor delta as measured, and exactly which commands were run locally versus in CI.

- [ ] **Step 5: Watch CI and diagnose any red BEFORE anything else**

A red required `verify` blocks the merge. Read the failure first: only the four documented
live-suite flake signatures are safe to re-run, and only after a cool-down. Confirm the run's
`headSha` equals the PR head and that it collected **72** files.

- [ ] **Step 6: Move SPRIN-92 to In Review**

Fetch transition ids; never hardcode them.

---

## Notes for the implementer

- **The seven live suites cannot run on this machine.** Anything depending on the database is
  proven by CI or not at all. A reviewer who "cannot verify" a live claim has established
  nothing — get such claims in front of CI early rather than late.
- **A survivor in mutation testing is ambiguous.** If a planted mutation kills nothing, plant one
  in a known-covered sibling as a seam control before concluding the test is vacuous.
- **Deviating from this plan is expected and welcome.** Plan code is an unrun draft — none of the
  snippets above have been executed. Two of the plan sketches in SPRIN-89 were wrong and the
  implementers caught both. If a snippet does not compile or a test is unreachable, fix it and
  **report the deviation** rather than bending the implementation to match the draft.
