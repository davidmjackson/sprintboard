# SPRIN-76 — Render the board from database statuses: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The board's columns, and the detail dialog's status picker, come from the project's
`project_statuses` rows instead of the `TICKET_STATUSES` constant — with no visible change,
because every project still has exactly the four seeded rows.

**Architecture:** A third `useTaggedRead` in `ProjectShell` (`listProjectStatuses`), shared with
both surfaces through `ProjectShellContext`. A new `firstUnready` selector collapses the now
three-way loading/failed gate so `BoardTab` stays under its cyclomatic ceiling. `domain.ts`
stops owning the status *values* and keeps owning the *shape*.

**Tech Stack:** React 19, TypeScript strict, Vitest + Testing Library, Supabase JS, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-31-sprin-76-board-from-db-statuses-design.md`

---

## Global Constraints

Every task's requirements implicitly include all of these.

- **Verification is `npm run verify`** — never a hand-assembled subset. `npx tsc --noEmit`
  checks **zero files** in this repo and exits 0; it is not a type check. `npm run build` is.
  Per-task you may run a scoped `npx vitest run <file>`, but never claim the task is done on
  that alone.
- **Lint thresholds are errors, not warnings** (`npm run lint`, `--max-warnings 0`):
  30-line functions, **cyclomatic 10**, cognitive 15, 4 params, 400-line files.
  `max-lines-per-function` is **off for `.tsx`**; cyclomatic is **not**.
- **Measured cyclomatic budgets at the start of this work — re-measure before adding a branch:**
  `BoardTab` **10/10 (zero spare)**, `ProjectShell` **10/10 (zero spare)**,
  `TicketDetailSidebar` **9/10 (one spare)**.
  Measure with:
  `npx eslint <file> --rule '{"complexity":["error",1]}'`
  Counted: `if`, `? :`, `&&`, `||`, `??`, loops, `case`. Not counted: plain calls, `!==`.
- **Never use a Postgres ENUM**, and never re-narrow `TicketStatus` back to a union. The
  vocabulary is per-project; the composite fk `tickets_status_fk (project_id, status) →
  project_statuses (project_id, slug)` is the real guard.
- **Status values are slugs, never uuids.** `tickets.status` is fk'd on `slug`. Writing
  `status.id` would put a uuid in a text column and the fk would reject it.
- **Domain rules do not live in components** (CLAUDE.md). Selectors go in `src/lib/*.ts`.
- **Reads throw, never resolve to `[]`.** `[]` is indistinguishable from "none", which is the
  S4.6 defect. Only a rejection carries failure.
- **The plan's code is a starting point, not gospel.** Deviating to match an established repo
  pattern is correct — **report every deviation**. Prefer reporting BLOCKED over inventing.
- **Distrust the test code below.** Plan test code in this repo has repeatedly contained tests
  that could not fail. After writing each test, ask: *would this fail if the behaviour it names
  regressed?* Every task has an explicit break-it step; if the test still passes, **the test is
  wrong — fix the test, not the code, and say so in your report.**
- **Commit messages:** imperative summary. Never use a heredoc (a global guard hook
  word-splits it) — use plain `-m` strings or `git commit -F <file>`.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/project-statuses.ts` (new) | The `project_statuses` read + the two name/option selectors | 1 |
| `src/lib/project-statuses.test.ts` (new) | Unit tests for the above | 1 |
| `src/lib/project-reads.ts` | Gains `firstUnready` — precedence across several tagged reads | 2 |
| `src/lib/project-reads.test.ts` | Tests for `firstUnready` | 2 |
| `src/lib/domain.ts` | `TicketStatus` widens to `string`; later loses the value constants | 3, 7 |
| `src/lib/domain.test.ts` | Loses the two SPRIN-79 bridging assertions | 7 |
| `src/routes/ProjectShell.tsx` | Third tagged read + two new context fields | 4 |
| `src/routes/LoadFailure.tsx` | `resource` union gains `'statuses'` + its copy line | 5 |
| `src/routes/BoardTab.tsx` | Columns from rows; one collapsed phase gate | 5 |
| `src/routes/TicketDetailDialog.tsx` | Plumbs `statuses` / `statusesPhase` to sidebar + header | 6 |
| `src/routes/TicketDetailSidebar.tsx` | Picker options from rows, disabled while loading | 6 |
| `src/routes/TicketDetailHeader.tsx` | Takes a resolved `statusName: string` | 6 |

---

## Task 1: The `project_statuses` read module

**Files:**
- Create: `src/lib/project-statuses.ts`
- Test: `src/lib/project-statuses.test.ts`

**Interfaces:**
- Consumes: `ProjectStatus` from `@/lib/domain` (already exported), `supabase` from `./supabase`.
- Produces:
  - `listProjectStatuses(projectId: string): Promise<ProjectStatus[]>`
  - `statusName(statuses: readonly ProjectStatus[], slug: string): string`
  - `statusOptions(statuses: readonly ProjectStatus[], current: string): { slug: string; name: string }[]`

**Context you need:** `src/lib/sprints.ts`'s `listSprints` is the exact shape to mirror
(filter on `project_id`, `.order(...)`, throw on error, cast the rows). `src/lib/sprints.test.ts`
shows the `vi.mock('@/lib/supabase', ...)` chain-stub pattern this repo uses.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/project-statuses.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listProjectStatuses, statusName, statusOptions } from './project-statuses'
import type { ProjectStatus } from './domain'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// listProjectStatuses: from('project_statuses').select().eq(...).order(...)
const order = vi.fn()
const eq = vi.fn(() => ({ order }))
const select = vi.fn(() => ({ eq }))

beforeEach(() => {
  order.mockReset()
  eq.mockReset()
  eq.mockReturnValue({ order })
  select.mockReset()
  select.mockReturnValue({ eq })
  vi.mocked(supabase.from).mockReset()
  vi.mocked(supabase.from).mockReturnValue({ select } as never)
})

/** Deliberately NOT in position order, and NOT the seeded four: a fixture that already
 *  looks like the answer cannot prove the code produced it. */
const ROWS = [
  { slug: 'shipped', name: 'Shipped', category: 'done', position: 3 },
  { slug: 'triage', name: 'Triage', category: 'todo', position: 1 },
] as unknown as ProjectStatus[]

describe('listProjectStatuses', () => {
  it('reads this project only, ordered by position ascending', async () => {
    order.mockResolvedValue({ data: ROWS, error: null })

    await expect(listProjectStatuses('p1')).resolves.toEqual(ROWS)

    expect(supabase.from).toHaveBeenCalledWith('project_statuses')
    expect(eq).toHaveBeenCalledWith('project_id', 'p1')
    expect(order).toHaveBeenCalledWith('position', { ascending: true })
  })

  it('THROWS on error rather than resolving to [] — [] would read as "no statuses"', async () => {
    order.mockResolvedValue({ data: null, error: { message: 'boom' } })

    await expect(listProjectStatuses('p1')).rejects.toThrow(/Could not load statuses/)
  })
})

describe('statusName', () => {
  it('returns the row name for a known slug', () => {
    expect(statusName(ROWS, 'triage')).toBe('Triage')
  })

  // AC4. The fallback is the slug itself: never empty, never undefined, always identifying.
  it('falls back to the slug itself for a status it has never seen', () => {
    expect(statusName(ROWS, 'mystery')).toBe('mystery')
  })

  it('falls back when the list is empty, rather than throwing', () => {
    expect(statusName([], 'triage')).toBe('triage')
  })
})

describe('statusOptions', () => {
  it('maps the rows in the order given, without resorting them', () => {
    expect(statusOptions(ROWS, 'triage')).toEqual([
      { slug: 'shipped', name: 'Shipped' },
      { slug: 'triage', name: 'Triage' },
    ])
  })

  // A <select> whose value matches no <option> renders BLANK, and the next change event
  // would move the ticket somewhere the user never chose.
  it('appends the current status when it is not in the list, so the select stays controlled', () => {
    expect(statusOptions(ROWS, 'mystery')).toEqual([
      { slug: 'shipped', name: 'Shipped' },
      { slug: 'triage', name: 'Triage' },
      { slug: 'mystery', name: 'mystery' },
    ])
  })

  it('does not duplicate the current status when it IS in the list', () => {
    expect(statusOptions(ROWS, 'shipped')).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/project-statuses.test.ts`
Expected: FAIL — cannot resolve `./project-statuses`.

- [ ] **Step 3: Implement**

Write `src/lib/project-statuses.ts`. Give it a module docblock in this repo's voice explaining
(a) why the read throws, (b) that `position` order **is** the board column order, and (c) that
the fallback in `statusName` is AC4, with the slug as the chosen default.

```ts
import { supabase } from './supabase'
import type { ProjectStatus } from './domain'

export async function listProjectStatuses(projectId: string): Promise<ProjectStatus[]> {
  const { data, error } = await supabase
    .from('project_statuses')
    .select()
    .eq('project_id', projectId)
    .order('position', { ascending: true })

  if (error) throw new Error(`Could not load statuses: ${error.message}`)
  return (data ?? []) as ProjectStatus[]
}

export function statusName(statuses: readonly ProjectStatus[], slug: string): string {
  return statuses.find((s) => s.slug === slug)?.name ?? slug
}

export function statusOptions(
  statuses: readonly ProjectStatus[],
  current: string,
): { slug: string; name: string }[] {
  const options = statuses.map((s) => ({ slug: s.slug, name: s.name }))
  return options.some((o) => o.slug === current)
    ? options
    : [...options, { slug: current, name: current }]
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/project-statuses.test.ts`

- [ ] **Step 5: Break it — three mutations, quote each failure**

Run the *whole* file after each; revert before the next.

1. `statusName`: drop `?? slug` (return `…?.name as string`). Expect the two fallback tests red.
2. `statusOptions`: return `options` unconditionally. Expect "appends the current status" red.
3. `listProjectStatuses`: replace the `throw` with `return []`. Expect the THROWS test red.
   **Also delete the `.eq('project_id', projectId)` line** and confirm the first test goes red —
   without it, one owner's other projects' statuses would render as this project's columns.

If any mutation leaves the suite green, the test is wrong. Fix the test and report it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/project-statuses.ts src/lib/project-statuses.test.ts
git commit -m "Add the project_statuses read and its name/option selectors"
```

---

## Task 2: `firstUnready` — precedence across several tagged reads

**Files:**
- Modify: `src/lib/project-reads.ts`
- Test: `src/lib/project-reads.test.ts`

**Interfaces:**
- Consumes: `ReadPhase` (already exported from this module).
- Produces: `firstUnready<R>(reads: readonly { resource: R; phase: ReadPhase }[]): { resource: R; phase: 'failed' | 'loading' } | null`

**Why generic, and do not "simplify" it to `string`:** the only consumer passes
`resource` straight to `LoadFailure`, whose prop is a **closed union** — and that union is a
deliberate security control (its docblock explains that an open `string` channel would render
raw PostgREST error text into a `role="alert"`). A `string`-typed helper dissolves that control
silently. Keep `R` generic so it infers at the call site.

**The precedence rule — two passes, not one:** *any* `failed` beats *any* `loading`, then source
order within each kind. This is today's behaviour (`BoardTab` returns the sprints failure even
when tickets are still loading). A single ordered `find` would invert it.

- [ ] **Step 1: Write the failing tests**

Append a new `describe` block to `src/lib/project-reads.test.ts`; add `firstUnready` to the
existing import from `./project-reads`.

```ts
describe('firstUnready', () => {
  it('returns null when every read has loaded', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'loaded' },
        { resource: 'sprints', phase: 'loaded' },
      ]),
    ).toBeNull()
  })

  it('reports a failed read', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'loaded' },
        { resource: 'sprints', phase: 'failed' },
      ]),
    ).toEqual({ resource: 'sprints', phase: 'failed' })
  })

  it('reports a loading read when nothing has failed', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'loaded' },
        { resource: 'sprints', phase: 'loading' },
      ]),
    ).toEqual({ resource: 'sprints', phase: 'loading' })
  })

  // THE test. A single ordered scan returns the LOADING one here and silently changes
  // what the board shows: an error replaced by a spinner that never resolves.
  it('prefers a failure that comes AFTER a loading read in the list', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'loading' },
        { resource: 'sprints', phase: 'failed' },
      ]),
    ).toEqual({ resource: 'sprints', phase: 'failed' })
  })

  it('reports the first of several failures, in source order', () => {
    expect(
      firstUnready([
        { resource: 'tickets', phase: 'failed' },
        { resource: 'sprints', phase: 'failed' },
      ]),
    ).toEqual({ resource: 'tickets', phase: 'failed' })
  })

  it('returns null for an empty list', () => {
    expect(firstUnready([])).toBeNull()
  })
})
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/lib/project-reads.test.ts`
Expected: FAIL — `firstUnready` is not exported.

- [ ] **Step 3: Implement**

Add to `src/lib/project-reads.ts`, with a docblock stating the two-pass rule and why the
generic `R` exists (the `LoadFailure` closed union).

```ts
export function firstUnready<R>(
  reads: readonly { resource: R; phase: ReadPhase }[],
): { resource: R; phase: 'failed' | 'loading' } | null {
  const failed = reads.find((r) => r.phase === 'failed')
  if (failed) return { resource: failed.resource, phase: 'failed' }
  const loading = reads.find((r) => r.phase === 'loading')
  return loading ? { resource: loading.resource, phase: 'loading' } : null
}
```

The phase literal is rebuilt rather than cast, so the return type is honest without a
`as`-assertion.

- [ ] **Step 4: Run and confirm pass**

- [ ] **Step 5: Break it — both mutations on the guard**

1. **Collapse to one pass:** `reads.find((r) => r.phase !== 'loaded') ?? null` (returning it
   directly). Expect *"prefers a failure that comes AFTER a loading read"* red. This is the
   mutation the whole two-pass shape exists to stop.
2. **Invert the precedence:** search `loading` first, then `failed`. Expect the same test red.
3. **Delete the `if (failed) return …` early return** entirely (leaving only the loading pass).
   Expect the two failure tests red. Running *both* delete and invert is required here: a guard
   whose fallback is a superset of its guarded path is green when deleted and red when inverted,
   and only deletion answers "does this line carry its own weight".

- [ ] **Step 6: Confirm the lint budget moved the right way**

Run: `npx eslint src/lib/project-reads.ts --rule '{"complexity":["error",1]}'`
Record `firstUnready`'s reported complexity in your report (expected: 3).

- [ ] **Step 7: Commit**

```bash
git add src/lib/project-reads.ts src/lib/project-reads.test.ts
git commit -m "Add firstUnready: failed beats loading across several tagged reads"
```

---

## Task 3: Widen `TicketStatus` to `string`

**Files:**
- Modify: `src/lib/domain.ts`

**Interfaces:**
- Produces: `TicketStatus = string`.
- **Still exported after this task** (removed in Task 7, once no consumer is left):
  `TICKET_STATUSES`, `TICKET_STATUS_LABELS`, `isTicketStatus`.

**Why now, and why alone:** every later task writes a *slug* (a `string`) into a
`TicketStatus`-typed position. While `TicketStatus` is a four-member union that does not
compile. Widening first unblocks Tasks 5 and 6; deleting the constants is deferred to Task 7 so
that the **build itself** proves no consumer was missed.

- [ ] **Step 1: Widen the alias**

Replace the `TicketStatus` union with:

```ts
/**
 * A ticket's status: the `slug` of one of its project's `project_statuses` rows.
 *
 * Deliberately `string`, and deliberately NOT a union. The vocabulary is PER PROJECT as of
 * SPRIN-79, so no single union can describe it — and SPRIN-76's AC2 requires a new status row
 * to produce a new board column with no code change. Re-narrowing this to a union would
 * silently re-break that.
 *
 * What enforces it instead is stronger than the union ever was, because it is per-project and
 * lives in the database: the composite foreign key `tickets_status_fk (project_id, status) →
 * project_statuses (project_id, slug)`. The alias survives the widening only to say all of
 * this at the ~15 call sites that read it.
 */
export type TicketStatus = string
```

- [ ] **Step 2: Delete the two compile-time guards that can no longer hold**

Remove `AssertTicketStatusesExhaustive` (its `Exact<string, 'todo' | …>` is now `false`, so
`Expect<>` fails to compile) and `AssertTicketStatusColumn` (`Assignable<string, string>` is
vacuous — keeping it would assert nothing while looking like a guard).

Leave every `type`, `sprint status`, `project_type` and `StatusCategory` guard **untouched** —
those columns still have `check` constraints and their guards still bite.

- [ ] **Step 3: Update the `TICKET_STATUSES` docblock**

It currently says the array "survives only until SPRIN-76 … at which point it is deleted".
That is Task 7. Leave the constant, but do not leave a docblock that contradicts the code —
note that the widening has landed and the deletion follows in this same story.

- [ ] **Step 4: Verify the build and the whole suite still pass**

Run: `npm run build`
Then: `npx vitest run src/lib/domain.test.ts`

Both must pass with **no other file changed**. If anything else fails to compile, that is a
finding — report it rather than editing another file into this task.

- [ ] **Step 5: Commit**

```bash
git add src/lib/domain.ts
git commit -m "Widen TicketStatus to string: the vocabulary is per-project"
```

---

## Task 4: `ProjectShell` reads the project's statuses

**Files:**
- Modify: `src/routes/ProjectShell.tsx`
- Test: `src/routes/ProjectShell.test.tsx`

**Interfaces:**
- Consumes: `listProjectStatuses` (Task 1), `useTaggedRead` / `ReadPhase` (existing).
- Produces, on `ProjectShellContext`:
  - `statuses: ProjectStatus[]`
  - `statusesPhase: ReadPhase`

**Cyclomatic warning:** `ProjectShell` is at **10/10**. A `useTaggedRead` call, a destructure
and two object properties each cost **0**. A `??`, `||` or ternary costs **1 and reddens lint**.
Re-measure before and after with
`npx eslint src/routes/ProjectShell.tsx --rule '{"complexity":["error",1]}'`.

- [ ] **Step 1: Write the failing test**

In `src/routes/ProjectShell.test.tsx`, follow the file's existing mocking of `@/lib/tickets` and
`@/lib/sprints` to also mock `@/lib/project-statuses`. Add tests asserting:

```ts
it('reads the project statuses for the active project', async () => {
  // …render the shell for project 'p1'…
  await waitFor(() => expect(listProjectStatuses).toHaveBeenCalledWith('p1'))
})

it('Retry reloads the statuses too, not only tickets and sprints', async () => {
  // fail the statuses read, click the tab's Retry, assert listProjectStatuses ran twice
})
```

The second test is the one that matters: a third read wired outside the shared `reloadNonce`
would pass the first test and leave Retry silently partial.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/routes/ProjectShell.test.tsx`

- [ ] **Step 3: Implement**

```ts
import { listProjectStatuses } from '@/lib/project-statuses'
import type { Project, ProjectStatus, Sprint, Ticket } from '@/lib/domain'

// beside the existing two reads — the SAME reloadNonce, which is what makes Retry cover it
const statusRead = useTaggedRead(activeProjectId, reloadNonce, listProjectStatuses)

// beside the existing two destructures
const { phase: statusesPhase, items: statuses } = statusRead
```

Add to the `ProjectShellContext` type, with docblocks matching the existing `tickets` /
`sprints` entries (`[]` while loading and when failed — always read the phase first), and add
`statuses` and `statusesPhase` to the `satisfies ProjectShellContext` object literal.

Update the component docblock: the shell now owns **three** project-scoped reads, and statuses
are shared for the same reason as sprints — the board and the detail dialog both need them.

- [ ] **Step 4: Run and confirm pass**

- [ ] **Step 5: Break it**

Give the statuses read its own constant nonce (`useTaggedRead(activeProjectId, 0, …)`).
Expect the Retry test red. Quote the failure.

- [ ] **Step 6: Re-measure complexity**

Run: `npx eslint src/routes/ProjectShell.tsx --rule '{"complexity":["error",1]}'`
Expected: still **10**. If it is 11, you added a branch — find and remove it; do not raise the
threshold.

- [ ] **Step 7: Commit**

```bash
git add src/routes/ProjectShell.tsx src/routes/ProjectShell.test.tsx
git commit -m "Read the project's statuses in the shell and share them on the context"
```

---

## Task 5: The board renders its columns from the rows

**Files:**
- Modify: `src/routes/LoadFailure.tsx`, `src/routes/BoardTab.tsx`
- Test: `src/routes/BoardTab.test.tsx`

**Interfaces:**
- Consumes: `statuses` / `statusesPhase` (Task 4), `firstUnready` (Task 2), `statusName` (Task 1).
- Produces: no new exports. `LoadFailureResource` is exported from `LoadFailure.tsx` for reuse.

**Cyclomatic:** `BoardTab` is at **10/10**. The rewrite below spends **2** where the current
gate spends **4** (three `if`s + one `||`), landing at **8**. Re-measure and report the number.

**Do not touch the grid classes.** `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` stays verbatim:
AC1 requires an existing four-status project to render identically. An N-column layout is
SPRIN-77's call, when a fifth status first becomes reachable.

- [ ] **Step 1: Widen `LoadFailure`**

```ts
export type LoadFailureResource = 'tickets' | 'sprints' | 'statuses'

const FAILURE_COPY: Record<LoadFailureResource, string> = {
  tickets: 'Could not load tickets.',
  sprints: 'Could not load sprints.',
  statuses: 'Could not load statuses.',
}
```

and change the prop to `resource: LoadFailureResource`. **Keep the closed union and its
docblock** — do not widen it to `string`. Adding a case here is exactly the review moment that
docblock describes.

- [ ] **Step 2: Write the failing board tests**

Extend `ctxWith` in `src/routes/BoardTab.test.tsx` with `statuses` and `statusesPhase: 'loaded'`
defaults. **Give the default fixture the four seeded rows** so existing tests keep passing.

```ts
// Ordered 2,1 in the array but 1,2 by position: proves the ORDER comes from the data,
// not from array order. A fixture already in the right order proves nothing.
const FIVE_STATUSES = [
  { slug: 'in_progress', name: 'In Progress', category: 'in_progress', position: 2 },
  { slug: 'todo', name: 'To Do', category: 'todo', position: 1 },
  { slug: 'in_review', name: 'In Review', category: 'in_progress', position: 3 },
  { slug: 'done', name: 'Done', category: 'done', position: 4 },
  { slug: 'parked', name: 'Parked', category: 'todo', position: 5 },
] as unknown as ProjectStatus[]

it('renders one column per status row — five rows, five columns (AC2)', () => {
  renderTab(BoardTab, ctxWith({ statuses: FIVE_STATUSES, sprints: [ACTIVE_SPRINT] }))

  // Count the columns. Asserting only that "Parked" exists would still pass with the
  // four constants in place plus a stray heading.
  expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(5)
  expect(screen.getByRole('heading', { level: 2, name: 'Parked' })).toBeInTheDocument()
})

it('orders the columns by the list it is given, not by a hard-coded order', () => {
  renderTab(BoardTab, ctxWith({ statuses: FIVE_STATUSES, sprints: [ACTIVE_SPRINT] }))

  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
    'In Progress', 'To Do', 'In Review', 'Done', 'Parked',
  ])
})

it('shows a statuses failure with its own Retry', () => {
  renderTab(BoardTab, ctxWith({ statusesPhase: 'failed' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load statuses.')
})

it('shows Loading… while the statuses are still in flight', () => {
  renderTab(BoardTab, ctxWith({ statusesPhase: 'loading' }))
  expect(screen.getByText('Loading…')).toBeInTheDocument()
})

it('a failed tickets read still wins over a loading statuses read', () => {
  renderTab(BoardTab, ctxWith({ ticketsPhase: 'failed', statusesPhase: 'loading' }))
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load tickets.')
})

// Documented, not fixed. The composite fk makes this impossible in the database; SPRIN-80
// owns orphan safety. It is pinned so it can never become SILENT.
it('drops a ticket whose status matches no column', () => {
  const orphan = [{ ...TICKETS[0], id: 'x', key: 'MP-9', status: 'ghost', sprint_id: 's1' }] as never
  renderTab(BoardTab, ctxWith({ tickets: orphan, sprints: [ACTIVE_SPRINT] }))
  expect(screen.queryByText('MP-9')).not.toBeInTheDocument()
})
```

Note: the existing suite's active-sprint fixture and ticket `sprint_id` wiring must be reused —
read the file first; the board only renders the **active sprint's** tickets (S7.1), so a ticket
with `sprint_id: null` renders in no column regardless of status and would make the orphan test
pass vacuously. **Give the orphan ticket the active sprint's id**, and add a control assertion
that a sibling ticket with a valid status *does* render from the same fixture.

- [ ] **Step 3: Run and confirm failure**

- [ ] **Step 4: Implement the board**

Replace the three-way gate:

```tsx
const unready = firstUnready([
  { resource: 'tickets', phase: ticketsPhase },
  { resource: 'sprints', phase: sprintsPhase },
  { resource: 'statuses', phase: statusesPhase },
])
if (unready) {
  return unready.phase === 'failed' ? (
    <LoadFailure resource={unready.resource} onRetry={onRetry} />
  ) : (
    <p className="text-muted-foreground text-sm">Loading…</p>
  )
}
```

Replace the column loop's source and its heading:

```tsx
{statuses.map((status) => {
  const column = visibleTickets.filter((ticket) => ticket.status === status.slug)
  return (
    <section key={status.slug} onDrop={() => handleDrop(status.slug)} …>
      <h2 className="text-sm font-medium">{status.name}</h2>
```

`key` and the drop target both use **`status.slug`**, never `status.id` — see Global Constraints.

Replace the move-failure message's label lookup:

```tsx
setMoveError(`Could not move ${ticket.key} to ${statusName(statuses, toStatus)}. Please try again.`)
```

Update the component docblock: it currently opens *"The board: the four fixed columns … (from the
domain module — never inlined)"*. That is now false in both halves. Say where the columns come
from, that `position` order is the column order, and that a ticket whose status matches no column
renders nowhere — naming the fk as why that cannot happen and SPRIN-80 as who owns it.

- [ ] **Step 5: Run and confirm pass**

Run: `npx vitest run src/routes/BoardTab.test.tsx`

- [ ] **Step 6: Break it — four mutations**

1. Hard-code the column source back to a four-element literal. Expect the five-column and
   ordering tests red.
2. Sort `statuses` by `slug` before mapping. Expect the ordering test red.
3. Drop `{ resource: 'statuses', phase: statusesPhase }` from the `firstUnready` array. Expect
   the statuses-failed and statuses-loading tests red.
4. Use `status.id` instead of `status.slug` as the drop target. Expect a drag test red — **if
   nothing goes red, that is a finding**: it means no test observes what the drop actually
   writes, and a uuid could reach `tickets.status`. Report it and add the assertion.

- [ ] **Step 7: Re-measure complexity**

Run: `npx eslint src/routes/BoardTab.tsx --rule '{"complexity":["error",1]}'`
Expected: **8**. Report the actual number.

- [ ] **Step 8: Commit**

```bash
git add src/routes/BoardTab.tsx src/routes/LoadFailure.tsx src/routes/BoardTab.test.tsx
git commit -m "Render board columns from the project's status rows"
```

---

## Task 6: The detail dialog follows the board

**Files:**
- Modify: `src/routes/TicketDetailDialog.tsx`, `src/routes/TicketDetailSidebar.tsx`,
  `src/routes/TicketDetailHeader.tsx`, `src/routes/ProjectShell.tsx` (pass the two new props)
- Test: `src/routes/TicketDetailDialog.test.tsx`

**Interfaces:**
- Consumes: `statusOptions`, `statusName` (Task 1); `statuses` / `statusesPhase` (Task 4).
- Produces:
  - `TicketDetailDialog` props gain `statuses?: ProjectStatus[]` (default `[]`) and
    `statusesPhase?: ReadPhase` (default `'loading'`) — mirroring `sprints` / `sprintsPhase`
    **including the defaults**, so a standalone render stays honest.
  - `TicketDetailSidebar` props gain `statuses: ProjectStatus[]`, `statusesPhase: ReadPhase`.
  - `TicketDetailHeader` prop `statusName: string` replaces its internal label lookup.

**Cyclomatic:** `TicketDetailSidebar` is at **9/10** — one spare branch. `disabled={statusesPhase
!== 'loaded'}` costs **0** (`!==` is not a branch). Assembling the option list inline with a `??`
or `||` would cost 1 and put it at the ceiling; that is why `statusOptions` exists. Re-measure.

- [ ] **Step 1: Write the failing tests**

In `src/routes/TicketDetailDialog.test.tsx`:

```ts
it('lists the project status rows as picker options, not a fixed four', () => {
  // render with a statuses fixture containing a status the constants never had
  expect(screen.getByRole('option', { name: 'Parked' })).toBeInTheDocument()
})

it('disables the status picker until the list has loaded', () => {
  // statusesPhase: 'loading'
  expect(screen.getByLabelText('status')).toBeDisabled()
})

it('renders the status NAME in the header, from the row', () => {
  // ticket.status = 'in_review', rows name it 'In Review'
  expect(within(dialogHeader).getByText('In Review')).toBeInTheDocument()
})

it('falls back to the slug when the header status has no row (AC4)', () => {
  // ticket.status = 'ghost', rows do not contain it
  expect(within(dialogHeader).getByText('ghost')).toBeInTheDocument()
})

it('keeps the current status selectable when it has no row, so it is not silently lost', () => {
  // ticket.status = 'ghost'
  expect(screen.getByLabelText('status')).toHaveValue('ghost')
})
```

Scope every assertion with `within(...)` — an unscoped `getByText` says the text exists and
nothing about where. Read the file's existing render helper first and reuse it.

- [ ] **Step 2: Run and confirm failure**

- [ ] **Step 3: Implement**

`TicketDetailSidebar` — replace the `TICKET_STATUSES.map` block:

```tsx
<select
  aria-label="status"
  className={selectClass}
  value={ticket.status}
  disabled={statusesPhase !== 'loaded'}
  onChange={(e) => commit({ status: e.target.value })}
>
  {statusOptions(statuses, ticket.status).map((s) => (
    <option key={s.slug} value={s.slug}>
      {s.name}
    </option>
  ))}
</select>
```

The `as TicketStatus` cast on `e.target.value` goes away — `TicketStatus` is `string` now, so
the cast is a no-op that would hide a future re-narrowing.

**Rewrite the picker's docblock.** It currently claims the picker "is never disabled: the option
list is a compile-time constant, so there is no loading state to be honest about." That premise
is exactly what this story removes. Say instead that the list is a fetch now, that an enabled
picker over an empty list shows a blank value and offers nothing, and that it therefore follows
the sprint picker's pattern immediately below it.

`TicketDetailHeader` — take `statusName: string` and render it in place of
`TICKET_STATUS_LABELS[ticket.status]`.

`TicketDetailDialog` — add the two optional props with their defaults, pass `statuses` and
`statusesPhase` to the sidebar, and `statusName={statusName(statuses, ticket.status)}` to the
header. Note in the props docblock why the header takes a resolved string rather than the list:
it renders one label, and a second lookup site is a second place the fallback can drift.

`ProjectShell` — pass `statuses={statuses}` and `statusesPhase={statusesPhase}` to
`<TicketDetailDialog>`. **Adding props costs 0 complexity**; re-measure anyway.

- [ ] **Step 4: Run and confirm pass**

- [ ] **Step 5: Break it — three mutations**

1. Hard-code the picker's options back to the four constants. Expect the "Parked" option test red.
2. Remove `disabled={statusesPhase !== 'loaded'}`. Expect the disabled test red.
3. In the header, render `ticket.status` directly instead of the resolved `statusName`. Expect
   the "renders the status NAME" test red — **and check the AC4 fallback test does NOT go red**,
   since for an unknown slug both spellings agree. If the fallback test is the only one that
   fails, the name test is the vacuous one; report it.

- [ ] **Step 6: Re-measure both components**

Run: `npx eslint src/routes/TicketDetailSidebar.tsx src/routes/ProjectShell.tsx --rule '{"complexity":["error",1]}'`
Expected: sidebar **9**, shell **10**. Report actuals.

- [ ] **Step 7: Commit**

```bash
git add src/routes/TicketDetail*.tsx src/routes/ProjectShell.tsx src/routes/TicketDetailDialog.test.tsx
git commit -m "Drive the status picker and header label from the project's status rows"
```

---

## Task 7: Delete the constants — the build is the proof

**Files:**
- Modify: `src/lib/domain.ts`, `src/lib/domain.test.ts`

**Interfaces:** removes `TICKET_STATUSES`, `TICKET_STATUS_LABELS`, `isTicketStatus`.
Nothing is added.

**Keep `DEFAULT_PROJECT_STATUSES`.** It is the client half of the **seed** contract, not of the
board. Two tests hold it honest and both stay: `domain.test.ts` parses the seed trigger's VALUES
list out of the schema doc, and `rls.integration.test.ts` reads the rows the live database
actually seeded. Deleting it would remove the only assertion that a new project gets four
statuses at all.

- [ ] **Step 1: Delete the three exports from `src/lib/domain.ts`**

`TICKET_STATUSES`, `TICKET_STATUS_LABELS`, `isTicketStatus`. Update the module docblock: it
still describes the three-link chain for `ticket.status`, which no longer runs through a union.

- [ ] **Step 2: Delete the two SPRIN-79 bridging assertions from `src/lib/domain.test.ts`**

Around lines 239–256 — *"the seed and the board's four columns are the same list"* and its
labels sibling — plus the `TICKET_STATUSES`-driven tests near lines 304, 310, 333 and 340.
Their own docblock says SPRIN-76 removes them.

- [ ] **Step 3: Run the build — this is the actual test for this task**

Run: `npm run build`

A missed consumer is a **compile error**, which is exactly why the deletion was deferred to
last. If anything fails, fix that consumer here and report which one — a leftover means an
earlier task missed a call site.

- [ ] **Step 4: Confirm the seed chain survived**

Run: `npx vitest run src/lib/domain.test.ts`

Then **break it to prove the chain is still real**: change one entry in
`DEFAULT_PROJECT_STATUSES` (e.g. `name: 'To Do'` → `'Todo'`) and confirm
`domain.test.ts` goes red against the schema doc's trigger VALUES list. Revert.

If that mutation is now green, deleting the bridging assertions took the seed guard with it —
that is a **BLOCKED** finding, report it immediately.

- [ ] **Step 5: Grep for stragglers**

Run: `grep -rn "TICKET_STATUSES\|TICKET_STATUS_LABELS\|isTicketStatus" src/ e2e/`
Expected: no hits. Documentation under `docs/` may still mention them historically — leave it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/domain.ts src/lib/domain.test.ts
git commit -m "Delete TICKET_STATUSES: the board now reads the vocabulary from the database"
```

---

## Final verification (the plan's owner runs this, not a subagent)

- [ ] `npm run verify` in full — lint, format:check, build, and the whole test suite.
- [ ] Test-file tripwire: `npx vitest list --filesOnly | wc -l` minus
      `npx vitest list --filesOnly --exclude '**/*.integration.test.ts' | wc -l` must be **7**.
      Baseline before this work: **56 / 49**. Task 1 adds one unit file → expect **57 / 50**.
      A gap of 0 means the live suites silently skipped: that is a failure, however green.
- [ ] **0 skipped** in the run summary.
- [ ] `npm run e2e` — the Playwright happy path drags to "Done". The seeded names are unchanged
      so it should pass untouched; if it fails, that is a real finding, not a fixture to edit.
      Not the gate, but must not be left broken.
