# SPRIN-85 — WIP limit per status (Kanban only) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-status numeric WIP limit, editable on the Settings tab of a Kanban project only, stored on `project_statuses.wip_limit` and validated at both edges.

**Architecture:** One new predicate in `domain.ts`, one new zod schema, one new write function, one new self-contained field component, and a boolean threaded `SettingsTab → StatusSettings → StatusRow`. Nothing on the board changes — that is SPRIN-86.

**Tech Stack:** React 19, TypeScript strict, Vite, Tailwind, shadcn/ui, zod **4**, Vitest **4**, Testing Library, Supabase JS against PostgREST.

**Spec:** `docs/superpowers/specs/2026-08-05-sprin-85-wip-limit-per-status-design.md` — read it. It records what was measured and why several things are shaped as they are.

---

## Global Constraints

Every task's requirements implicitly include all of this.

- **Verification is `npm run verify`.** Never `tsc --noEmit`, never a hand-picked subset of test files. `tsc --noEmit` checks **zero files** in this repo yet exits 0.
- **T1–T5 are lint ERRORS, not warnings**, over `**/*.{ts,tsx,mjs,js}`: functions ≤ **30 lines**, cyclomatic ≤ **10**, cognitive ≤ **15**, parameters ≤ **4**, files ≤ **400 lines**. Write to them from the first line. A genuine misfit is an ADR in this repo, **never an inline disable**.
  - **A default parameter costs a cyclomatic point.** Measure a function's real number with `npx eslint <file> --rule '{"complexity":["error",1]}'` — the linter otherwise reports complexity only on violation, so it is invisible until it breaks.
- **Status, type and column values live in `src/lib/domain.ts` and nowhere else.** No component may write `project.project_type === 'kanban'`; `src/test/project-type-single-expression.test.ts` has three scans that go red if it does — including one that forbids the bare `.project_type` **read** outside `domain.ts`.
  - A lower-case `kanban` **anywhere in non-test `src/`** outside `domain.ts` reddens that guard, **including in a comment**. The concept is `Kanban`; the value is `kanban`.
- **Never use a Postgres `ENUM`.** Not relevant to this diff, but do not "improve" any `text` + `check` column you pass.
- **The migration is already applied** and `src/lib/database.types.ts` is already regenerated. Do not hand-edit that file and do not run any migration.
- **Do not touch `renameProjectStatus`.** Its incidental zero-row guard is a recorded follow-up, deliberately out of scope (spec §4.4/§9).
- **Do not touch `BoardTab`** — rendering the limit is SPRIN-86.
- **Never assert an exact accessible name** for an element whose name is composed from several children. Substring/regex name queries (`{ name: /wip limit/i }`) are correct; an exact name is fine only when it comes from a single text node or an `aria-label`.
- **Plan code is a starting point, not gospel.** Deviating to match an established repo pattern is correct — **report every deviation**. Prefer reporting BLOCKED over silent invention.
- Run `npx prettier --write` on files you touch, or `npm run verify` will fail on formatting.

### The zod 4 caveat, read before Task 2

This repo is on **zod 4**, where `.transform()` returns a `ZodPipe`. The plan's schema chains `.refine()` after `.transform()`. Verify that actually type-checks and behaves; if zod 4 wants a different construction (`.check()`, `.superRefine()`, or a `.pipe()` into a second schema), **use whatever zod 4 actually supports** and report the deviation. The *behaviour table* in Task 2 is the contract — the construction is not.

---

## File structure

| file | responsibility |
|---|---|
| `src/lib/domain.ts` | `hasWipLimits`; `ProjectStatusUpdate` + its `Exact<>` key-set assertion |
| `src/lib/status-schemas.ts` | `WipLimitSchema` — the client edge |
| `src/lib/project-statuses.ts` | `setStatusWipLimit` — the write |
| `src/routes/StatusWipLimit.tsx` | **new.** The field: draft state, parse, no-op guard, write, error line |
| `src/routes/StatusRow.tsx` | renders the field when the project has WIP limits |
| `src/routes/StatusSettings.tsx` | threads the boolean |
| `src/routes/SettingsTab.tsx` | calls `hasWipLimits(project)` |
| `docs/sprintboard_phase1_schema.sql` | the column, the constraint, the four-column grant |

---

### Task 1: `hasWipLimits` and the widened `ProjectStatusUpdate`

**Files:**
- Modify: `src/lib/domain.ts`
- Test: `src/lib/domain.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `hasWipLimits(project: Pick<Project, 'project_type'>): boolean`
  - `ProjectStatusUpdate` = `Pick<TablesUpdate<'project_statuses'>, 'name' | 'category' | 'position' | 'wip_limit'>`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/domain.test.ts`. Find the existing `hasSprints` describe block and put this immediately after it, matching its style.

```ts
describe('hasWipLimits', () => {
  /**
   * A SECOND predicate, not a negated `hasSprints`. "Has sprints" and "has WIP limits" are
   * two different questions that share an answer only while there are exactly two project
   * types; a third would separate them. Asserted independently here for that reason —
   * writing `expect(hasWipLimits(p)).toBe(!hasSprints(p))` would encode the coincidence
   * this design exists to avoid.
   */
  it('is true for a Kanban project', () => {
    expect(hasWipLimits({ project_type: 'kanban' })).toBe(true)
  })

  it('is false for a Scrum project', () => {
    expect(hasWipLimits({ project_type: 'scrum' })).toBe(false)
  })

  it('covers every project type', () => {
    // The exhaustiveness control: if a third type ships, this fails until someone decides
    // which side of the predicate it falls on, rather than silently defaulting to false.
    expect(PROJECT_TYPES.filter((t) => hasWipLimits({ project_type: t }))).toEqual(['kanban'])
  })
})
```

Add `hasWipLimits` to the existing import from `./domain`, and `PROJECT_TYPES` if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/domain.test.ts`
Expected: FAIL — `hasWipLimits` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/lib/domain.ts`, directly after `hasSprints`:

```ts
/**
 * Whether a project's board columns carry WIP limits. THE single expression of the rule —
 * no component, filter or test may write the comparison itself, and
 * `src/test/project-type-single-expression.test.ts` says so in a form that goes red.
 *
 * Deliberately a SECOND predicate rather than `!hasSprints(project)`. They are two
 * different questions that happen to share an answer while there are exactly two project
 * types; a third would separate them, and a single negated predicate would not survive it.
 * `hasSprints`'s own docblock promised this function would arrive in SPRIN-85 with its
 * first caller rather than earlier as an unreferenced export.
 *
 * Takes the narrowest shape it reads, matching `hasSprints`, so a test can pass
 * `{ project_type: 'kanban' }` without inventing eight irrelevant columns.
 */
export function hasWipLimits(project: Pick<Project, 'project_type'>): boolean {
  return project.project_type === 'kanban'
}
```

Then widen the write type and its assertion. Replace the `AssertProjectStatusUpdateColumns` type:

```ts
export type AssertProjectStatusUpdateColumns = Expect<
  Exact<keyof ProjectStatusUpdate, 'name' | 'category' | 'position' | 'wip_limit'>
>
```

and `ProjectStatusUpdate` itself:

```ts
export type ProjectStatusUpdate = Pick<
  TablesUpdate<'project_statuses'>,
  'name' | 'category' | 'position' | 'wip_limit'
>
```

Extend that alias's existing docblock — do not replace it. Add:

```
 * SPRIN-85 added `wip_limit`, and the grant was rewritten in the same commit
 * (docs/migrations/sprin-85-wip-limit.sql). The two must move together: a table REVOKE
 * cascades to column grants, so that migration re-grants ALL FOUR columns, and this alias
 * is the client-side mirror of exactly that list. `slug` and `is_initial` remain absent
 * from both.
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/domain.test.ts src/test/project-type-single-expression.test.ts`
Expected: PASS. The AST guard must stay green — `hasWipLimits` lives in `domain.ts`, which is the one file permitted to name the value and compare it.

- [ ] **Step 5: Prove the `Exact<>` assertion actually bites**

This is a mutation, not a test. Temporarily add `| 'slug'` to `ProjectStatusUpdate`'s `Pick`, run `npm run build`, and confirm it is a **compile error**. Then revert.

Expected: `Type 'false' does not satisfy the constraint 'true'` on `AssertProjectStatusUpdateColumns`.

If it compiles, the assertion is decoration and the whole grant mirror is unguarded — report that as BLOCKED rather than continuing.

- [ ] **Step 6: Commit**

```bash
git add src/lib/domain.ts src/lib/domain.test.ts
git commit -m "Add hasWipLimits and widen ProjectStatusUpdate to wip_limit"
```

---

### Task 2: `WipLimitSchema` — the client edge

**Files:**
- Modify: `src/lib/status-schemas.ts`
- Test: `src/lib/status-schemas.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `WipLimitSchema`, a zod schema parsing `string` → `number | null`. Consumed by Task 4.

**The contract** — this table is what must hold, whatever construction zod 4 wants:

| input | outcome |
|---|---|
| `''` | `null` |
| `'   '` | `null` (trimmed first) |
| `'3'` | `3` |
| `'1'` | `1` |
| `'007'` | `7` |
| `'2147483647'` | `2147483647` |
| `'0'` | rejected, message A |
| `'-1'` | rejected, message B |
| `'1.5'` | rejected, message B |
| `'abc'` | rejected, message B |
| `'1e3'` | rejected, message B |
| `'2147483648'` | rejected, message C |

Message A: `A limit must be at least 1. Leave it empty for no limit.`
Message B: `Use a whole number, or leave it empty for no limit.`
Message C: `That limit is too large.`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/status-schemas.test.ts`:

```ts
describe('WipLimitSchema', () => {
  /**
   * The client edge of validate-at-both-edges. The set this accepts is exactly the set the
   * database accepts — `project_statuses_wip_limit_positive` (`> 0`) plus the column's own
   * `int` type. Anything wider earns the user an error they cannot act on: a fractional
   * value is a 22P02 from the type, an out-of-range one a 22003.
   */
  it.each([
    ['', null],
    ['   ', null],
    ['1', 1],
    ['3', 3],
    ['007', 7],
    ['2147483647', 2147483647],
  ])('parses %o to %o', (input, expected) => {
    const result = WipLimitSchema.safeParse(input)
    expect(result.success).toBe(true)
    expect(result.data).toBe(expected)
  })

  it('refuses 0 with a message that says what empty means', () => {
    const result = WipLimitSchema.safeParse('0')
    expect(result.success).toBe(false)
    expect(result.error!.issues[0]!.message).toBe(
      'A limit must be at least 1. Leave it empty for no limit.',
    )
  })

  it.each(['-1', '1.5', 'abc', '1e3', '+5', '5 '])(
    'refuses %o as not a whole number',
    (input) => {
      const result = WipLimitSchema.safeParse(input)
      expect(result.success).toBe(false)
      expect(result.error!.issues[0]!.message).toBe(
        'Use a whole number, or leave it empty for no limit.',
      )
    },
  )

  /**
   * The boundary, both sides. int4's ceiling is the column's own limit, not a product
   * decision — one past it is a 22003 the user cannot act on, so the schema refuses it
   * here where it can explain itself. The literal is deliberately absent from the copy:
   * 2147483647 is noise to a person.
   */
  it('refuses one past int4 max', () => {
    const result = WipLimitSchema.safeParse('2147483648')
    expect(result.success).toBe(false)
    expect(result.error!.issues[0]!.message).toBe('That limit is too large.')
  })
})
```

Note `'5 '` is in the not-a-whole-number list only if trimming happens **before** the digit check — it does, so `'5 '` trims to `'5'` and would PASS. **Remove `'5 '` from that list** and instead add a separate case asserting `'  5  '` parses to `5`. (This is a deliberate trap in the plan: check it rather than copying it.)

Add `WipLimitSchema` to the import from `./status-schemas`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/status-schemas.test.ts`
Expected: FAIL — `WipLimitSchema` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/lib/status-schemas.ts`:

```ts
/**
 * int4's ceiling. `project_statuses.wip_limit` is `int`, so a larger value is refused by the
 * COLUMN TYPE with a 22003 the user can do nothing about. The bound is the database's, not a
 * product opinion — which is why it is a constant with this comment rather than a number in
 * a message. `2147483647` in user-facing copy is noise.
 */
const INT4_MAX = 2147483647

/** A run of digits and nothing else. Refuses `-1`, `1.5`, `+5`, `1e3` and `abc` with one
 *  message, because they are one mistake from the user's side: that is not a whole number. */
const WHOLE_NUMBER = /^\d+$/

/**
 * A status's WIP limit, as typed into the settings field.
 *
 * **Empty means NO LIMIT and parses to `null`** — that is the story's AC3, and it is why this
 * schema takes a string rather than a number: the DOM hands us `''`, and `Number('')` is `0`,
 * which is the one value that must never be stored. Parsing the empty case explicitly is what
 * keeps "no limit" from silently becoming "a limit of zero".
 *
 * Zero gets its OWN message rather than joining the not-a-whole-number set, because it is a
 * different mistake: the user typed a number, and the thing they need to know is that empty —
 * not `0` — is how "no limit" is said. `0` is not "unlimited", it is a column no work may
 * ever enter, which nothing in the UI can express and no user means.
 *
 * The accepted set is exactly the database's: `project_statuses_wip_limit_positive` plus the
 * `int` column type. Validating wider here would hand the user a 22P02 or a 22003 from
 * PostgREST, which carries no remedy.
 */
export const WipLimitSchema = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || WHOLE_NUMBER.test(value),
    'Use a whole number, or leave it empty for no limit.',
  )
  .transform((value) => (value === '' ? null : Number(value)))
  .refine(
    (value) => value === null || value >= 1,
    'A limit must be at least 1. Leave it empty for no limit.',
  )
  .refine((value) => value === null || value <= INT4_MAX, 'That limit is too large.')

export type WipLimitValue = z.output<typeof WipLimitSchema>
```

**If zod 4 will not chain `.refine()` after `.transform()`**, restructure however zod 4 wants (a `.pipe()` into `z.union([z.null(), z.number().int().min(1).max(INT4_MAX)])` is one option) and keep the message strings and the behaviour table exactly. Report the deviation.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/status-schemas.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Prove the messages are distinguishable**

Confirm by reading the run output that the `'0'` case and the `'-1'` case produce **different** messages. If both produce the not-a-whole-number one, the ordering of the refinements is wrong and the zero case is unreachable — that is a real defect, not a cosmetic one.

- [ ] **Step 6: Commit**

```bash
git add src/lib/status-schemas.ts src/lib/status-schemas.test.ts
git commit -m "Add WipLimitSchema, the client edge of the WIP limit rule"
```

---

### Task 3: `setStatusWipLimit` — the write

**Files:**
- Modify: `src/lib/project-statuses.ts`
- Test: `src/lib/project-statuses.test.ts`

**Interfaces:**
- Consumes: `ProjectStatusUpdate` from Task 1.
- Produces: `setStatusWipLimit(id: string, wipLimit: number | null): Promise<StatusWriteResult<ProjectStatus>>`. Consumed by Task 4.

**The mock chain, and why it needs care.** `src/lib/project-statuses.test.ts` gives every PostgREST chain its own link functions, because chains diverge after the same method name. This function's chain is

```
from().update().eq().select()      <- TERMINAL. No .single().
```

which shares three links with `renameProjectStatus`'s `from().update().eq().select().single()` and diverges at the fourth. The existing `selectUpdate` mock returns `{ single }`. For this function's tests, override it per-test with `selectUpdate.mockResolvedValue({ data, error })` so the awaited value is the terminal payload. Document that in the chain comment at the top of the file.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/project-statuses.test.ts`:

```ts
describe('setStatusWipLimit', () => {
  it('sends wip_limit and nothing else', async () => {
    selectUpdate.mockResolvedValue({ data: [{ id: 'st1', wip_limit: 4 }], error: null })
    vi.mocked(supabase.from).mockReturnValue({ update } as never)

    await setStatusWipLimit('st1', 4)

    expect(update).toHaveBeenCalledWith({ wip_limit: 4 })
    // The payload is the WHOLE argument, not a superset containing it. `toHaveBeenCalledWith`
    // is already exact on objects, and that exactness is the point: the request must stay
    // inside the column grant, and an extra key would be a 42501 against the live database
    // on a path this mocked test never reaches.
    expect(eqUpdate).toHaveBeenCalledWith('id', 'st1')
  })

  it('sends null to clear the limit', async () => {
    selectUpdate.mockResolvedValue({ data: [{ id: 'st1', wip_limit: null }], error: null })
    vi.mocked(supabase.from).mockReturnValue({ update } as never)

    const result = await setStatusWipLimit('st1', null)

    expect(update).toHaveBeenCalledWith({ wip_limit: null })
    expect(result).toEqual({ ok: true, value: { id: 'st1', wip_limit: null } })
  })

  /**
   * THE GUARD THAT MATTERS. RLS FILTERS an UPDATE rather than raising on it, so a row
   * belonging to another tenant — or one another tab already deleted — comes back as
   * exactly `error: null, data: []`. Without the row-count check that is indistinguishable
   * from a write that worked, and the caller would patch its list with a row the database
   * never touched.
   */
  it("reports 'stale' when the update matched no row and did not error", async () => {
    selectUpdate.mockResolvedValue({ data: [], error: null })
    vi.mocked(supabase.from).mockReturnValue({ update } as never)

    const result = await setStatusWipLimit('gone', 4)

    expect(result).toEqual({ ok: false, error: 'stale' })
  })

  it("reports 'unknown' on a write error", async () => {
    selectUpdate.mockResolvedValue({ data: null, error: { code: '23514', message: 'check' } })
    vi.mocked(supabase.from).mockReturnValue({ update } as never)

    const result = await setStatusWipLimit('st1', 0)

    expect(result).toEqual({ ok: false, error: 'unknown' })
  })
})
```

Add `setStatusWipLimit` to the existing import list from `./project-statuses`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/project-statuses.test.ts`
Expected: FAIL — `setStatusWipLimit` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/lib/project-statuses.ts`, after `renameProjectStatus`:

```ts
/**
 * Set (or clear) a status's WIP limit. `null` means no limit.
 *
 * `wip_limit` is the ONLY column sent, which is a privilege property rather than tidiness:
 * `authenticated` holds UPDATE on exactly (name, category, position, wip_limit) as of
 * SPRIN-85's migration, so a patch touching `slug` or `is_initial` is refused by Postgres
 * before any policy is consulted. `satisfies ProjectStatusUpdate` is what makes that
 * structural — the generated row type offers every column, so a wrong write would otherwise
 * compile and fail only at runtime, against the live database, somewhere a mocked-client
 * unit test never goes.
 *
 * **The row count is checked EXPLICITLY, and that is a departure from `renameProjectStatus`
 * next door.** RLS FILTERS an UPDATE rather than raising on it, so a row belonging to
 * another tenant, or one another tab already deleted, returns exactly `error: null,
 * data: []` — a write that changed nothing, indistinguishable from one that worked unless
 * the count is checked. `renameProjectStatus` gets that protection only INCIDENTALLY, via
 * `.single()` erroring on zero rows; this is the deliberate shape `deleteProjectStatus` and
 * `reorderProjectStatuses` both use, and the one new code should be written in.
 *
 * Every failure collapses to the generic tags: the caller chose a number, not a name, so
 * there is no `duplicate` to reach. A check-constraint violation is unreachable from the
 * app — `WipLimitSchema` refuses the same set the constraint does — and if it somehow
 * arrives it is `unknown` with generic retry copy, which is the honest answer to a refusal
 * the user cannot act on.
 */
export async function setStatusWipLimit(
  id: string,
  wipLimit: number | null,
): Promise<StatusWriteResult<ProjectStatus>> {
  const { data, error } = await supabase
    .from('project_statuses')
    .update({ wip_limit: wipLimit } satisfies ProjectStatusUpdate)
    .eq('id', id)
    .select()

  if (error) return { ok: false, error: writeError(error) }
  const rows = (data ?? []) as ProjectStatus[]
  if (rows.length !== 1) return { ok: false, error: 'stale' }
  return { ok: true, value: rows[0]! }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/project-statuses.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutate the row-count guard**

Change `if (rows.length !== 1)` to `if (false)` and re-run. The `'stale'` test **must** fail. If it still passes, that test is vacuous — report it.

Then revert.

- [ ] **Step 6: Commit**

```bash
git add src/lib/project-statuses.ts src/lib/project-statuses.test.ts
git commit -m "Add setStatusWipLimit with an explicit zero-row guard"
```

---

### Task 4: `StatusWipLimitField` — the control

**Files:**
- Create: `src/routes/StatusWipLimit.tsx`
- Test: `src/routes/StatusWipLimit.test.tsx` (new)

**Interfaces:**
- Consumes: `WipLimitSchema` (Task 2), `setStatusWipLimit` (Task 3), `ProjectStatus` from `@/lib/domain`.
- Produces:
  ```ts
  export function StatusWipLimitField(props: {
    status: ProjectStatus
    onUpdated: (status: ProjectStatus) => void
  }): JSX.Element
  ```
  Consumed by Task 5.

**Behaviour contract:**

1. Renders an `<input>` labelled `WIP limit for <status name>`, whose value is the status's current limit, or `''` when it is `null`. Placeholder `None`.
2. **Blur** commits. **Enter** commits. **Escape** reverts the draft to the status's value and does not commit.
3. An invalid draft shows a `role="alert"` message from `WipLimitSchema` and **sends nothing**.
4. A draft that parses to the status's current value **sends nothing**.
5. A failed write shows a message and leaves the input showing the draft.
6. A successful write calls `onUpdated` with the returned row.

- [ ] **Step 1: Write the failing test**

Create `src/routes/StatusWipLimit.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { StatusWipLimitField } from './StatusWipLimit'
import type { ProjectStatus } from '@/lib/domain'
import { setStatusWipLimit } from '@/lib/project-statuses'

vi.mock('@/lib/project-statuses', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-statuses')>()),
  setStatusWipLimit: vi.fn(),
}))

const mockSet = vi.mocked(setStatusWipLimit)

/**
 * `wip_limit` is deliberately NOT equal to `position`, and the name is not the slug — the
 * same confound discipline as `StatusSettings.test.tsx`'s fixture, for the same reason: a
 * fixture whose values coincide cannot tell two different reads apart.
 */
function status(overrides: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    id: 'st2',
    project_id: 'p1',
    slug: 'in_build',
    name: 'Building',
    category: 'in_progress',
    position: 20,
    is_initial: false,
    wip_limit: 4,
    created_at: '2026-08-01T00:00:00+00:00',
    ...overrides,
  } as ProjectStatus
}

const onUpdated = vi.fn()

beforeEach(() => {
  mockSet.mockReset()
  onUpdated.mockReset()
})

function field(s: ProjectStatus = status()) {
  render(<StatusWipLimitField status={s} onUpdated={onUpdated} />)
  return screen.getByRole('spinbutton', { name: /wip limit for building/i })
}

describe('StatusWipLimitField', () => {
  it('shows the status’s current limit', () => {
    expect(field()).toHaveValue(4)
  })

  it('shows an empty field when there is no limit', () => {
    expect(field(status({ wip_limit: null }))).toHaveValue(null)
  })

  /**
   * THE POSITIVE CONTROL for every "sends nothing" assertion below. A spy asserted
   * `not.toHaveBeenCalled()` passes just as happily when the component never rendered, so
   * at least one case in this file must prove the same spy CAN be called.
   */
  it('commits a changed value on blur', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: true, value: status({ wip_limit: 7 }) })
    const input = field()

    await user.clear(input)
    await user.type(input, '7')
    await user.tab()

    expect(mockSet).toHaveBeenCalledWith('st2', 7)
    expect(onUpdated).toHaveBeenCalledWith(status({ wip_limit: 7 }))
  })

  it('commits on Enter', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: true, value: status({ wip_limit: 9 }) })
    const input = field()

    await user.clear(input)
    await user.type(input, '9{Enter}')

    expect(mockSet).toHaveBeenCalledWith('st2', 9)
  })

  it('clears the limit to null when emptied', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: true, value: status({ wip_limit: null }) })
    const input = field()

    await user.clear(input)
    await user.tab()

    expect(mockSet).toHaveBeenCalledWith('st2', null)
  })

  it('sends nothing when the value is unchanged', async () => {
    const user = userEvent.setup()
    const input = field()

    await user.click(input)
    await user.tab()

    expect(mockSet).not.toHaveBeenCalled()
  })

  it('refuses 0 with a message and sends nothing', async () => {
    const user = userEvent.setup()
    const input = field()

    await user.clear(input)
    await user.type(input, '0')
    await user.tab()

    expect(mockSet).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /A limit must be at least 1\. Leave it empty for no limit\./,
    )
  })

  it('reverts the draft on Escape without committing', async () => {
    const user = userEvent.setup()
    const input = field()

    await user.clear(input)
    await user.type(input, '8{Escape}')

    expect(mockSet).not.toHaveBeenCalled()
    expect(input).toHaveValue(4)
  })

  it('shows a message when the write fails', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: false, error: 'stale' })
    const input = field()

    await user.clear(input)
    await user.type(input, '5')
    await user.tab()

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onUpdated).not.toHaveBeenCalled()
  })
})
```

**Note the assertion style:** `toHaveTextContent` is given an **anchored regex**, never a bare string. A bare string is a substring match, so any additive reword of the copy survives it — the exact class SPRIN-87 hit in three consecutive review rounds. Apply that everywhere in this file.

**Note the role:** `<input type="number">` has the ARIA role `spinbutton`, not `textbox`. If the implementation ends up not using `type="number"`, the query changes — report the deviation.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/StatusWipLimit.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/routes/StatusWipLimit.tsx`:

```tsx
import { useState } from 'react'

import type { ProjectStatus } from '@/lib/domain'
import { setStatusWipLimit } from '@/lib/project-statuses'
import { WipLimitSchema } from '@/lib/status-schemas'
import { Input } from '@/components/ui/input'
import { GENERIC_CREATE_ERROR } from './CreateDialog'

/** The status's limit as the input shows it: `null` — no limit — is an empty field, never
 *  a `0`, which is the one value the rule forbids. */
function toDraft(limit: number | null): string {
  return limit === null ? '' : String(limit)
}

/**
 * One status's WIP limit, on the settings row.
 *
 * **Its own file and its own component**, rather than more of `StatusRow.tsx`, because this
 * is a self-contained write path — parse, guard, write, tag, report — of the same weight as
 * `StatusDeleteControl`. `StatusRow.tsx` already assembles three components; a fourth would
 * make it the place status editing lives rather than the place a status ROW is assembled.
 *
 * **Deliberately NOT built on `EditableText`,** for three reasons any one of which decides
 * it: that component commits a raw string with nowhere to parse-and-refuse before writing;
 * its numeric mode hardcodes `min={0}`, which contradicts the rule this adds; and its view
 * mode is a button, whereas a settings field should show its value and be directly
 * editable. There is also a recorded hazard in reusing it — its own `draft !== value` guard
 * is unpinned and unpinnable from `StatusSettings.test.tsx`, because the row's trim guard
 * shadows it. The no-op guard below is written explicitly and tested directly instead.
 *
 * A BLUR IS NOT AN INTENT TO WRITE. Tabbing through the settings tab would otherwise fire a
 * PATCH per status. The parsed value is compared with the row's own before anything is
 * sent — the same discipline as `StatusRow`'s rename.
 */
export function StatusWipLimitField({
  status,
  onUpdated,
}: {
  status: ProjectStatus
  onUpdated: (status: ProjectStatus) => void
}) {
  const [draft, setDraft] = useState(() => toDraft(status.wip_limit))
  const [error, setError] = useState<string | null>(null)

  async function commit() {
    const parsed = WipLimitSchema.safeParse(draft)
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? GENERIC_CREATE_ERROR)
      return
    }
    // Cleared BEFORE the no-op check, not after it: every commit is a fresh attempt, and the
    // previous attempt's message describes none of them. `StatusRow`'s rename fixed exactly
    // this bug from the other side.
    setError(null)
    if (parsed.data === status.wip_limit) return

    const result = await setStatusWipLimit(status.id, parsed.data)
    if (!result.ok) {
      setError(GENERIC_CREATE_ERROR)
      return
    }
    onUpdated(result.value)
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        className="h-8 w-20 text-sm"
        placeholder="None"
        aria-label={`WIP limit for ${status.name}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setDraft(toDraft(status.wip_limit))
            setError(null)
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit()
          }
        }}
      />
      {error ? (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      ) : null}
    </div>
  )
}
```

**Watch the thresholds.** `commit` is close to the cognitive limit and the `onKeyDown` handler adds branches to the component function. Measure before committing:

```bash
npx eslint src/routes/StatusWipLimit.tsx --rule '{"complexity":["error",1]}'
```

If `StatusWipLimitField` is at or near 10, extract the key handler into a named function outside the component.

**`min={1}` is a browser affordance, not the control.** `WipLimitSchema` is the control; the attribute only makes the spinner behave. Do not remove the schema check because the attribute exists.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/routes/StatusWipLimit.test.tsx`
Expected: PASS, all cases.

- [ ] **Step 5: Mutate the no-op guard**

Delete the `if (parsed.data === status.wip_limit) return` line and re-run. The "sends nothing when the value is unchanged" test **must** fail. If it does not, the test is vacuous.

Then revert and mutate the other way: make `commit` return early always. Every "commits" test must fail — that proves the positive control is real.

- [ ] **Step 6: Commit**

```bash
git add src/routes/StatusWipLimit.tsx src/routes/StatusWipLimit.test.tsx
git commit -m "Add the per-status WIP limit field"
```

---

### Task 5: Thread `hasWipLimits` to the row

**Files:**
- Modify: `src/routes/SettingsTab.tsx`
- Modify: `src/routes/StatusSettings.tsx`
- Modify: `src/routes/StatusRow.tsx`
- Test: `src/routes/StatusSettings.test.tsx`

**Interfaces:**
- Consumes: `hasWipLimits` (Task 1), `StatusWipLimitField` (Task 4).
- Produces: a `hasWipLimits: boolean` prop on both `StatusSettings` and `StatusRow`.

**The prop is named `hasWipLimits`, after the domain question — not `showWipLimit`.** AC1 is "absent, not merely hidden": a Scrum project is not declining to show a limit, it has no such concept. A display-flavoured name invites someone to satisfy it with `hidden`, which would ship a control every Scrum user can reach with a keyboard.

- [ ] **Step 1: Write the failing test**

In `src/routes/StatusSettings.test.tsx`, extend `renderSettings` to accept and pass `hasWipLimits` (default **`false`**, so every existing test keeps its current behaviour and the new prop cannot silently change 41 passing tests). Then add:

```tsx
describe('the WIP limit field (SPRIN-85 AC1)', () => {
  /**
   * ABSENT, not hidden and not disabled. A Scrum project has no WIP limits at all, so
   * `queryBy…` returning null is the assertion — a class check would pass on a control that
   * is still in the accessibility tree and still reachable by keyboard.
   */
  it('is absent for a project without WIP limits', () => {
    renderSettings({ hasWipLimits: false })

    expect(screen.queryByRole('spinbutton', { name: /wip limit/i })).toBeNull()
  })

  /**
   * The positive control for the assertion above. Without it, a renamed aria-label, a
   * component that throws, or a `renderSettings` that stopped rendering rows at all would
   * make the absence test pass while proving nothing.
   */
  it('is present, once per status, for a project with WIP limits', () => {
    renderSettings({ hasWipLimits: true })

    expect(screen.getAllByRole('spinbutton', { name: /wip limit/i })).toHaveLength(
      STATUSES.length,
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/StatusSettings.test.tsx`
Expected: FAIL — the present-case finds zero spinbuttons.

- [ ] **Step 3: Write the implementation**

`src/routes/SettingsTab.tsx` — add `hasWipLimits` to the `@/lib/domain` import and pass it:

```tsx
    <StatusSettings
      projectId={project.id}
      statuses={statuses}
      counts={counts}
      hasWipLimits={hasWipLimits(project)}
      onCreated={onStatusCreated}
      ...
```

`src/routes/StatusSettings.tsx` — add to the props type:

```tsx
  /** Whether this project has WIP limits AT ALL (`hasWipLimits` in domain.ts) — not whether
   *  to show a control. A Scrum project has no such concept, so the field is ABSENT rather
   *  than hidden or disabled, and this prop is named after the question rather than after
   *  the rendering so nobody satisfies it with `hidden`. */
  hasWipLimits: boolean
```

destructure it, and forward it to each `<StatusRow …>`.

`src/routes/StatusRow.tsx` — add the same prop with the same docblock, import `StatusWipLimitField`, and render it. Put it **between the category badge and `StatusDeleteControl`**, so the row reads name → category → limit → delete → reorder:

```tsx
      {hasWipLimits ? <StatusWipLimitField status={status} onUpdated={onUpdated} /> : null}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/routes/StatusSettings.test.tsx src/routes/SettingsTab.test.tsx`
Expected: PASS. All 41 pre-existing `StatusSettings` tests must still pass — the default of `false` is what guarantees that.

- [ ] **Step 5: Check the thresholds and the AST guard**

```bash
npx eslint src/routes/StatusRow.tsx src/routes/StatusSettings.tsx src/routes/SettingsTab.tsx --rule '{"complexity":["error",1]}'
npx vitest run src/test/project-type-single-expression.test.ts
```

The AST guard must be green: `SettingsTab` calls the predicate, it never reads `.project_type`.

- [ ] **Step 6: Commit**

```bash
git add src/routes/SettingsTab.tsx src/routes/StatusSettings.tsx src/routes/StatusRow.tsx src/routes/StatusSettings.test.tsx
git commit -m "Show the WIP limit field on a Kanban project's settings only"
```

---

### Task 6: The live database tests, and the schema doc

**Files:**
- Modify: `src/test/rls.integration.test.ts`
- Modify: `docs/sprintboard_phase1_schema.sql`

**Interfaces:** none — this task consumes nothing and produces nothing for later tasks.

**These run against the real Supabase project.** They need `RLS_TEST_A` / `RLS_TEST_B` credentials in `.env.local`. Add the new tests **inside the existing `describe('the owner can add, rename and reorder statuses (SPRIN-77)')` block**, which already has the `wp1` fixture project and whose tests run **in order and depend on each other** — the first plants `qa`, the rest act on it. Put the new tests **after** the existing `is_initial` test so they cannot disturb it.

- [ ] **Step 1: Write the tests**

```ts
    /**
     * SPRIN-85 AC2 and AC3, and the POSITIVE CONTROL for the widened grant. Every refusal
     * below is evidence only if this passes: if `wip_limit` had been left out of the
     * rewritten grant, this is the test that says so, and nothing else would.
     *
     * Written as set-then-read-back-then-clear rather than three tests, because AC2 is
     * literally "persists across a reload" — a second, separate SELECT is what a reload is.
     */
    it('the owner can set, re-read and clear a wip_limit', async () => {
      const set = await a
        .from('project_statuses')
        .update({ wip_limit: 3 })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(set.error).toBeNull()
      expect(set.data).toHaveLength(1)

      // AC2: a FRESH read, which is what "persists across a reload" means.
      const reread = await a
        .from('project_statuses')
        .select('slug, wip_limit')
        .eq('project_id', wp1)
        .eq('slug', 'qa')
      expect(reread.data).toEqual([{ slug: 'qa', wip_limit: 3 }])

      // AC3: empty clears to null, and null is stored as null rather than 0.
      const cleared = await a
        .from('project_statuses')
        .update({ wip_limit: null })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select('slug, wip_limit')
      expect(cleared.error).toBeNull()
      expect(cleared.data).toEqual([{ slug: 'qa', wip_limit: null }])
    })

    /**
     * SPRIN-85 AC4, the DATABASE half — and it is TWO mechanisms with two SQLSTATEs, which
     * is why they are asserted separately rather than as one "the database refuses it".
     *
     *   0 and -1 parse fine as integers and are refused by the CHECK      -> 23514
     *   1.5 never reaches the check; the COLUMN TYPE refuses it            -> 22P02
     *
     * A test asserting one code for all three would be asserting something false, and would
     * go green if the check constraint were dropped entirely (the type would still catch
     * 1.5, and 0 would then be stored happily).
     */
    it.each([0, -1])('the database refuses a wip_limit of %i', async (value) => {
      const { error } = await a
        .from('project_statuses')
        .update({ wip_limit: value })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(error!.code).toBe('23514') // OBSERVED: project_statuses_wip_limit_positive.
    })

    it('the database refuses a fractional wip_limit', async () => {
      const { error } = await a
        .from('project_statuses')
        .update({ wip_limit: 1.5 } as never)
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(error!.code).toBe('22P02') // OBSERVED: invalid input syntax for type integer.
    })

    /**
     * NOT AN AC — and in scope anyway. SPRIN-85's migration RESTATES the whole column list
     * in one grant, so a typo silently DROPS a column. Three of the four have a live
     * witness: `name` in the rename above, `position` through the reorder RPC (which is
     * SECURITY INVOKER and so writes as the caller), and `wip_limit` in the test above.
     *
     * `category` had NONE — it is only ever written on INSERT in this suite — so dropping
     * it from the rewritten grant would have shipped green. This closes the last
     * unwitnessed column of the exact control this story rewrites.
     */
    it('the owner can recategorise a status', async () => {
      const { data, error } = await a
        .from('project_statuses')
        .update({ category: 'done' })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select('slug, category')
      expect(error).toBeNull()
      expect(data).toEqual([{ slug: 'qa', category: 'done' }])

      // Put it back: the tests in this block run in order and share the `qa` row, and a
      // later reorder test counts on the vocabulary it was given.
      await a
        .from('project_statuses')
        .update({ category: 'in_progress' })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
    })
```

**Before writing the SQLSTATEs as fact, OBSERVE them.** Every `// OBSERVED:` comment in this suite means someone watched the code come back from the real database. Run the tests, read the actual codes, and correct the assertions to match reality rather than to match this plan. If `1.5` comes back as something other than `22P02` — PostgREST may coerce or reject it earlier — assert what actually happens and say so in the comment.

- [ ] **Step 2: Run the live tests**

Run: `npx vitest run src/test/rls.integration.test.ts`
Expected: PASS, including the two pre-existing AC5 tests (`slug` and `is_initial` both still `42501`).

If a failure matches one of the five recorded live-suite flake signatures in `CLAUDE.md`, wait and re-run. **Anything else is real** — do not weaken a suite to make it green.

- [ ] **Step 3: Update the schema doc**

In `docs/sprintboard_phase1_schema.sql`:

1. In the `create table project_statuses (…)` block, after `is_initial`, add:

```sql
  -- Soft WIP limit for this board column, NULL meaning no limit (SPRIN-85). Read only for
  -- Kanban projects; a value on a Scrum project's row is inert, and stays inert because
  -- project_type is immutable in the database. A CHECK body may not subquery, so this
  -- column cannot be constrained to Kanban projects — recorded, accepted, and inherited by
  -- any future project-type conversion story.
  --
  -- The limit WARNS, it never blocks. Nothing here refuses a ticket entering an at-limit
  -- status, deliberately: a hard limit would need a trigger on tickets counting sibling
  -- rows, the exact shape that broke the cascade in SPRIN-80, and it would strand work
  -- whenever a limit was lowered below a column's occupancy.
  wip_limit   int,
```

and beside the other named constraints:

```sql
  constraint project_statuses_wip_limit_positive
    check (wip_limit is null or wip_limit > 0),
```

2. Replace the grant line and extend the comment above it:

```sql
revoke update on project_statuses from authenticated, anon;
grant  update (name, category, position, wip_limit) on project_statuses to authenticated;
```

Add to that comment block:

```
-- SPRIN-85 added `wip_limit` to the granted set. THE LIST IS RESTATED IN FULL ON PURPOSE
-- and must stay that way: a table-level REVOKE cascades to column grants ("When revoking
-- privileges on a table, the corresponding column privileges (if any) are automatically
-- revoked on each column of the table, as well" — PostgreSQL REVOKE reference), so a
-- migration that revokes and then grants only the NEW column leaves authenticated able to
-- write that column and nothing else. `src/lib/domain.ts`'s ProjectStatusUpdate mirrors
-- this list and its Exact<> assertion makes widening one without the other a compile error.
```

- [ ] **Step 4: Confirm the schema doc still parses**

`src/lib/domain.test.ts` reads this file to check constraints and the seed trigger's VALUES list.

Run: `npx vitest run src/lib/domain.test.ts`
Expected: PASS. If the new constraint confuses a parser, fix the **test's** regex deliberately and say why — do not remove the constraint from the doc.

- [ ] **Step 5: Commit**

```bash
git add src/test/rls.integration.test.ts docs/sprintboard_phase1_schema.sql
git commit -m "Pin the wip_limit column and the widened grant against the live database"
```

---

## Final gate (the orchestrator runs this, not a subagent)

- [ ] `npm run verify` — in full. Not a subset, not a proxy.
- [ ] `npx vitest list --filesOnly | wc -l` and the `test:unit` equivalent — the gap must be **7**. A gap of 0 means the live suites silently skipped, which is a failure however green it looks.
- [ ] **0 skipped** in the run summary.
- [ ] `npx eslint . --max-warnings 0` is inside `npm run verify`; confirm it ran.

---

## Self-review notes

- **Spec coverage:** AC1 → Task 5; AC2/AC3 → Tasks 2, 3, 4 (client) and 6 (live); AC4 → Task 2 (client) and Task 6 (database); AC5 → **no task**, covered by two pre-existing live tests that Task 6 must keep green (spec §5.1). Spec §5.2's extra `category` test → Task 6.
- **Deliberate trap in Task 2, Step 1:** the `'5 '` case is wrong and the step says so. It is there because a worker who copies plan code without reading it will produce a failing test and blame the schema.
- **Type consistency:** `setStatusWipLimit(id, wipLimit)` is spelled identically in Tasks 3, 4 and the component. `hasWipLimits` is the predicate (Task 1) and the prop name (Task 5) — same word, two things, deliberately, because they carry the same meaning.
