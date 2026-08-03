# SPRIN-81 — Create a project as Scrum or Kanban

**Epic:** SPRIN-73 · **Spec:** `docs/superpowers/specs/2026-08-03-sprin-73-kanban-project-type-design.md`
**Branch:** `feat/sprin-81-project-type` · **Base:** `30b8c6e`

---

## Verified against the live database before planning

| Assumption | Reality |
|---|---|
| Constraint name | `projects_project_type_check`, body normalised by PG to `CHECK ((project_type = 'scrum'::text))` |
| Column | `project_type text NOT NULL DEFAULT 'scrum'::text` |
| RLS | one policy, `projects_owner`, `FOR ALL`, `owner_id = auth.uid()` on both `USING` and `WITH CHECK` |
| Write paths | exactly two `from('projects')` calls in non-test source: the insert and the select. **No update path exists.** |

Consequences that shape the plan:

- **AC3 is satisfied by the column default**, not by code. The test still asserts it, because the
  default is what keeps every fixture insert and the Playwright E2E creating Scrum projects.
- **Immutability is app-layer only.** `projects_owner` is `FOR ALL`, so RLS permits an owner to
  `PATCH` their own project's `project_type`. Contained to the owner's own project, so not a
  tenant-isolation issue — recorded, not fixed, because hardening it means a grant rewrite and
  that would widen the story.

## Global constraints for every task

- **`npm run verify` is the gate.** Never `tsc --noEmit` — it checks **zero files** here and exits 0.
- **T1–T5 apply to every file**: 30-line functions, cyclomatic 10, cognitive 15, 4 params, 400 lines.
  Write to them from the first line; a genuine misfit is an ADR, never an inline disable.
- **Never a Postgres ENUM.** `project_type` stays `text` + `check`.
- **Values live in `domain.ts` and nowhere else.** No component or schema may inline `'kanban'`.
- Run `npm run format:check` — a subagent running only its own tests leaves the formatter unrun.

## Task 1 — `domain.ts`: widen `ProjectType`, mirroring `TICKET_TYPES`

`ProjectType` is a bare union today (`'scrum'`) with no runtime array. Give it the exact shape
`TicketType` has, because `CreateProjectDialog` needs the values and the labels to render options:

```ts
export type ProjectType = 'scrum' | 'kanban'

export const PROJECT_TYPES = ['scrum', 'kanban'] as const satisfies readonly ProjectType[]

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  scrum: 'Scrum',
  kanban: 'Kanban',
}

export function isProjectType(value: string): value is ProjectType { ... }

export type AssertProjectTypesExhaustive = Expect<Exact<ProjectType, (typeof PROJECT_TYPES)[number]>>
```

Keep `AssertProjectTypeColumn` as it is. Follow `TICKET_TYPE_LABELS`' existing shape exactly —
check it before writing, do not guess.

**Tests** (`src/lib/domain.test.ts`): `PROJECT_TYPES` holds both values; `PROJECT_TYPE_LABELS` has a
label for every member of `PROJECT_TYPES` (derived from the array, not a second hard-coded list —
otherwise the test drifts with the thing it guards); `isProjectType` accepts both and rejects
`'waterfall'`.

## Task 2 — `projects.ts`: carry the type through the insert

`createProject` takes a fourth field. **T4 caps parameters at 4** and this function already takes a
single object — keep it an object, add `projectType: ProjectType`, do not add a positional argument.

The insert passes `project_type: input.projectType`. Do **not** default it in TypeScript: the column
default is the single source of that decision, and a client-side default would be a second one.

**Tests** (`src/lib/projects.test.ts`): follow the existing mock shape in that file. Assert the
insert payload carries `project_type: 'kanban'` when asked, and `'scrum'` when asked. Assert the
existing `23505 → duplicate_key` mapping still holds.

## Task 3 — `CreateProjectDialog`: offer the choice

Mirror `CreateTicketDialog.tsx:107-118` — that is the established shape for this exact problem:

- schema: `projectType: z.enum([...PROJECT_TYPES] as [ProjectType, ...ProjectType[]])`
- `defaultValues: { ..., projectType: 'scrum' }`
- `<select className={selectClass} {...field}>` over `PROJECT_TYPES`, labelled from
  `PROJECT_TYPE_LABELS`; `selectClass` comes from `./form-primitives`
- a `<FormLabel>Type</FormLabel>` and a `<FormDescription>` saying it **cannot be changed later** —
  that sentence is the only place immutability is user-visible

**Tests** (`src/routes/CreateProjectDialog.test.tsx`): the select renders both options; Scrum is
selected by default; choosing Kanban and submitting calls `createProject` with
`projectType: 'kanban'`; submitting untouched passes `'scrum'`.

## Task 4 — `ProjectShellHeader`: the type badge

A badge beside the project key. Copy the existing badge classes from `TicketCard.tsx:35`
(`bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[10px] font-medium uppercase`) rather
than inventing a new treatment.

**It renders for BOTH types** — a Scrum project shows "Scrum". That is deliberate and is the reason
stories 82 and 83 have a positive control instead of another absence to prove.

**Chrome uppercases `text-transform` in its AX tree and jsdom does not**, so **never assert an exact
accessible name on this badge**. Assert its DOM text, scoped with `within(...)`.

**Tests**: `ProjectShellHeader` has no test file of its own; it is covered through
`src/routes/ProjectShell.test.tsx`. Add there, following that file's existing render helper.

## Task 5 — the live database contract

`src/test/projects.integration.test.ts` already contains "creates a project the owner can read back,
**defaulting project_type to scrum**" — the new cases belong beside it.

Two new tests:

1. an insert with `project_type: 'kanban'` **succeeds** and reads back as `'kanban'`;
2. an insert with `project_type: 'waterfall'` **fails**, and the error is the check violation
   (`23514`) — assert the code, not a message.

**TEARDOWN TRAP — do not copy the surrounding style here.** The existing tests do
`if (data) createdIds.push(data.id)` *after* their assertions, so a failed expect strands a project
in the shared database forever. **Push the id BEFORE asserting.** A teardown delete is an
obligation; an assertion is only a report.

**These two tests are written FIRST and are expected to be RED** until the migration is applied —
test 1 fails because the check still forbids `'kanban'`. That red is the signal the migration is
real. Do not apply the migration to make them green before they have been seen failing.

## Task 6 — pin AC5 (nothing writes `project_type` after insert)

AC5 is a claim about our code, and this repo already pins claims like it by reading source
(`domain.test.ts` parses the schema doc; `check-bundle.mjs` scans `dist/`). Add a test that scans
`src/**/*.{ts,tsx}`, excluding test files, and asserts **no `.update(` or `.upsert(` call is made
against `from('projects')`**.

Verify the test can fail: add such a call temporarily, watch it go red, remove it. A guard nobody
has watched fail is not known to be a guard.

## Task 7 — the migration and the schema doc

Write `docs/migrations/sprin-81-project-type-kanban.sql`:

```sql
alter table projects drop constraint projects_project_type_check;
alter table projects add constraint projects_project_type_check
  check (project_type in ('scrum', 'kanban'));
```

Update the `project_type` line in `docs/sprintboard_phase1_schema.sql` to match. The schema doc is
the record of what the database is; leaving it stale is how the next story plans off a fiction.

**David applies this by hand.** The agent never applies it. Run `get_advisors` afterwards.

## Order

1 → 2 → 3 → 4 in code; 5 and 6 (tests) written **before** the migration is applied; 7 last, then the
stop for David, then `npm run verify` in full.
