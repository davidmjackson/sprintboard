# SPRIN-86 — The board flags an over-limit column: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Kanban board column whose status carries a WIP limit shows its card count against that limit and says — in words — when it is over.

**Architecture:** Two new selectors in `src/lib/board.ts` hold the rules (is the board filtered; what limit should this column display), `BoardColumnSummary` in `src/routes/BoardTab.tsx` gains a `limit` prop and renders one more `·`-segment, and `BoardTab` wires them together with function calls rather than new branches. **The limit is soft: nothing anywhere refuses a move.**

**Tech Stack:** React 19, TypeScript strict, Tailwind, Vitest + Testing Library (jsdom). No new dependency, no migration, no schema change.

**Spec:** `docs/superpowers/specs/2026-08-05-sprin-86-board-flags-over-limit-column-design.md`. Read §2 (soft limit) and §5.1 (the filter decision) before Task 3.

## Global Constraints

- **The limit is SOFT — it warns, it never blocks.** Dragging a card into an at-limit or over-limit column must SUCCEED and persist. No guard, no disabled drop target, no confirmation, no rollback. Task 4 is the pin that makes violating this go red.
- **No migration, no schema change, no grant change.** `wip_limit` and its column-level UPDATE grant shipped in SPRIN-85. `listProjectStatuses` already calls `.select()` with no column list, so `wip_limit` already arrives on every row — the read path needs no widening.
- **Board rules live in `src/lib/board.ts`, never inlined in a component** (CLAUDE.md). Status/type/column definitions live in `src/lib/domain.ts` and nowhere else. No new constant is needed in either.
- **T1–T5 are errors, enforced by `npm run lint`:** 30-line functions, cyclomatic 10, cognitive 15, 4 parameters, 400-line files. Measured starting points: `BoardTab` **7/10**, `BoardColumnSummary` **4/10**, `BoardColumnEmpty` **3/10**, `BoardTab.tsx` 194/400 counted lines, `board.ts` 42/400. Test files have `max-lines` and `max-lines-per-function` **off**; T2 and T4 still apply to them.
- **Exact copy, used verbatim in code and tests:** `` · limit 3 `` when at or under, `` · over limit 3 `` when over (the number is the status's `wip_limit`). Nothing is appended when there is no limit.
- **Verification is `npm run verify`** — never `tsc --noEmit`, never a hand-picked subset. `npm run test:unit` is a local fast loop, never evidence.
- **Test-file tripwire:** `npx vitest list --filesOnly | wc -l` reads **64** today and must read **65** when this story is done (one new file, Task 3). The gap against `test:unit` stays **7**.
- **Never assert an exact accessible name** on an element whose name is composed from several children. Assert DOM text scoped with `within(...)`, never an unscoped `getByText`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/board.ts` | Modify | Gains `isBoardFiltered` (Task 1) and `selectColumnLimit` (Task 2). Board rules, no rendering. |
| `src/lib/board.test.ts` | Modify | Unit tests for both new selectors. |
| `src/routes/BoardTab.tsx` | Modify | `BoardColumnEmpty` takes `filtering` (Task 1); `BoardColumnSummary` takes `limit` and renders the segment (Task 3); `BoardTab` computes `filtered` once and calls `selectColumnLimit` per column. |
| `src/routes/BoardTab.test.tsx` | Modify | Fixture truthfulness only: `SEEDED_STATUSES` states `wip_limit: null` (Task 3). Its existing tests are otherwise **unedited**, which is what makes them evidence that Tasks 1 and 3 changed no behaviour. |
| `src/routes/BoardTab.wipLimit.test.tsx` | **Create** | ACs 1, 2, 4, 5, the filter case, and (Task 4) the AC3 soft-limit pin. |

---

### Task 1: Name the "is the board filtered" rule

`BoardColumnEmpty` computes `blockedOnly || isSearchActive(query)` inline today. Task 3 needs the same answer in a second place, so it becomes one named rule in `board.ts`. This is a pure refactor: **no behaviour changes**, and `BoardTab.test.tsx`'s existing "No matches." tests must pass untouched — they are the evidence.

**Files:**
- Modify: `src/lib/board.ts`
- Modify: `src/routes/BoardTab.tsx:73-84` (`BoardColumnEmpty`) and its call site at `:348`
- Test: `src/lib/board.test.ts`

**Interfaces:**
- Consumes: `isSearchActive(query: string): boolean` from `src/lib/ticket-search.ts` (no import cycle — that module imports only `./domain`).
- Produces: `isBoardFiltered(blockedOnly: boolean, query: string): boolean`, used by Task 3.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/board.test.ts`:

```ts
describe('isBoardFiltered', () => {
  it('is false when neither filter is on', () => {
    expect(isBoardFiltered(false, '')).toBe(false)
  })

  it('is true under the blocked-only filter alone', () => {
    expect(isBoardFiltered(true, '')).toBe(true)
  })

  it('is true under a search query alone', () => {
    expect(isBoardFiltered(false, 'MP-1')).toBe(true)
  })

  // Whitespace is not a query — `isSearchActive` trims, and this rule must not
  // second-guess it. A board showing everything must not claim to be filtered.
  it('is false when the query is only whitespace', () => {
    expect(isBoardFiltered(false, '   ')).toBe(false)
  })

  it('is true when both filters are on', () => {
    expect(isBoardFiltered(true, 'MP-1')).toBe(true)
  })
})
```

Add `isBoardFiltered` to the existing import from `./board` at the top of the file.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/board.test.ts`
Expected: FAIL — `isBoardFiltered is not a function` (or a TypeScript error that it is not exported).

- [ ] **Step 3: Implement the selector**

In `src/lib/board.ts`, add the import and the function:

```ts
import { isSearchActive } from './ticket-search'

/**
 * Whether the board is narrowing what it shows — the blocked-only filter, the SPRIN-68
 * search, or both.
 *
 * This `||` lived inside `BoardColumnEmpty` until SPRIN-86, where its docblock recorded
 * that the location was once forced by complexity pressure and had become "a preference,
 * not a forced move". Two callers need the same answer now — the empty message and the
 * WIP-limit segment, which is suppressed while filtering (see `selectColumnLimit`) — so
 * the rule is named once here, where board rules live, rather than computed twice.
 *
 * Whitespace is not a query: `isSearchActive` trims, and this composes with it rather
 * than re-deciding it.
 */
export function isBoardFiltered(blockedOnly: boolean, query: string): boolean {
  return blockedOnly || isSearchActive(query)
}
```

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/lib/board.test.ts`
Expected: PASS.

- [ ] **Step 5: Move `BoardColumnEmpty` onto it**

In `src/routes/BoardTab.tsx`, change the component to take the answer rather than compute it, and rewrite the first paragraph of its docblock to say where the rule went (keep the rest — the `role="status"` reasoning is still true):

```tsx
function BoardColumnEmpty({ filtering }: { filtering: boolean }) {
  return (
    <p role="status" className="text-muted-foreground text-xs">
      {filtering ? 'No matches.' : 'No tickets yet.'}
    </p>
  )
}
```

Delete the now-unused `isSearchActive` import from `BoardTab.tsx` **only if** nothing else in that file uses it (check first — `selectMatchingTickets` is a different import and stays).

- [ ] **Step 6: Wire the call site**

In `BoardTab`, immediately after `visibleTickets` is computed (`src/routes/BoardTab.tsx:301-304`):

```tsx
// One answer, read by the empty message and by every column's WIP limit. A function
// call, not a branch: `BoardTab` measured 7 of 10 cyclomatic before SPRIN-86.
const filtered = isBoardFiltered(blockedOnly, query)
```

and change the call site from `<BoardColumnEmpty blockedOnly={blockedOnly} query={query} />` to `<BoardColumnEmpty filtering={filtered} />`.

- [ ] **Step 7: Prove the refactor changed nothing**

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: PASS, with **no edits to that file** — including the four tests around lines 886–936 ("an emptied column says No matches", the blocked-filter-alone case, and the whitespace-only-query case). If any needed editing to pass, the refactor changed behaviour: stop and fix the code, not the test.

- [ ] **Step 8: Re-measure complexity**

Run: `npx eslint src/routes/BoardTab.tsx src/lib/board.ts --rule '{"complexity":["error",1]}'`
Expected: `BoardTab` still **7**, `BoardColumnEmpty` now **2** (was 3), `isBoardFiltered` **2**.

- [ ] **Step 9: Commit**

```bash
git add src/lib/board.ts src/lib/board.test.ts src/routes/BoardTab.tsx
git commit -m "Name the board's filtered-state rule (SPRIN-86)"
```

---

### Task 2: The rule for what limit a column displays

**Files:**
- Modify: `src/lib/board.ts`
- Test: `src/lib/board.test.ts`

**Interfaces:**
- Consumes: `hasWipLimits(project: Pick<Project, 'project_type'>): boolean` from `src/lib/domain.ts` (added by SPRIN-85; this is its first consumer). `ProjectStatus` from `src/lib/domain.ts` — `wip_limit` is `number | null`.
- Produces: `selectColumnLimit(project: Pick<Project, 'project_type'>, status: Pick<ProjectStatus, 'wip_limit'>, filtered: boolean): number | null`, used by Task 3.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/board.test.ts` (`project()` already exists in that file; add a small status factory beside it):

```ts
/** A status with only the field this rule reads. `wip_limit` is always stated. */
function status(wip_limit: number | null): Pick<ProjectStatus, 'wip_limit'> {
  return { wip_limit }
}

describe('selectColumnLimit', () => {
  it('gives a kanban column its limit when nothing is filtered', () => {
    expect(selectColumnLimit(project('kanban'), status(3), false)).toBe(3)
  })

  it('gives null when the status has no limit', () => {
    expect(selectColumnLimit(project('kanban'), status(null), false)).toBeNull()
  })

  /**
   * The gate that makes SPRIN-86 AC5 true. A CHECK body may not contain a subquery, so
   * the database WILL store a wip_limit on a Scrum project's status row (SPRIN-85 §3.4)
   * — the value below is a row the database can really hold, not an impossible one. The
   * project type is the only thing that keeps it inert.
   */
  it('gives null on a scrum project even when the row carries a limit', () => {
    expect(selectColumnLimit(project('scrum'), status(3), false)).toBeNull()
  })

  /**
   * SPRIN-86 §5.1. The column summary describes the cards on screen; under a filter it is
   * showing fewer cards than the column holds, so it makes no WIP claim at all rather than
   * an understated one.
   */
  it('gives null while the board is filtered, limit or no limit', () => {
    expect(selectColumnLimit(project('kanban'), status(3), true)).toBeNull()
  })
})
```

Add `selectColumnLimit` to the `./board` import and `ProjectStatus` to the `./domain` type import.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run src/lib/board.test.ts`
Expected: FAIL — `selectColumnLimit is not a function`.

- [ ] **Step 3: Implement the selector**

In `src/lib/board.ts`:

```ts
/**
 * The WIP limit this column should display, or `null` for "display none" — the whole of
 * SPRIN-86's "should this column show a limit" rule, in one place a unit test can attack.
 *
 * TWO GATES, AND BOTH ARE LOAD-BEARING.
 *
 * `hasWipLimits` is what makes AC5 true. SPRIN-85 §3.4 recorded that a CHECK body may not
 * contain a subquery, so it cannot reach `projects.project_type` and the database will
 * store a `wip_limit` on a SCRUM project's status row. That value is inert only because
 * nothing reads it — and this function is the thing that reads it. Deleting this gate does
 * not merely relax a preference; it puts a Kanban-only feature on a Scrum board using data
 * the database really holds. Written as `hasWipLimits(project)` rather than a comparison
 * here: this module may not compare the project type itself, and a test says so.
 *
 * `filtered` is §5.1 of the design. A WIP limit is a claim about the column's real
 * occupancy, but the summary renders the ALREADY-FILTERED column, so under a filter the
 * two disagree — five cards against a limit of three read as "1 card" the moment
 * Blocked-only is ticked. Judging against the visible count was rejected: filtered counts
 * are always <= real occupancy, so an over-limit column would quietly stop warning with
 * nothing saying the number was partial. The board declines to make the claim instead,
 * which keeps the summary's own invariant whole — nothing on that line ever disagrees with
 * the cards below it.
 */
export function selectColumnLimit(
  project: Pick<Project, 'project_type'>,
  status: Pick<ProjectStatus, 'wip_limit'>,
  filtered: boolean,
): number | null {
  if (filtered || !hasWipLimits(project)) return null
  return status.wip_limit
}
```

Extend the existing `./domain` imports: `hasWipLimits` as a value, `ProjectStatus` as a type.

- [ ] **Step 4: Run the test and watch it pass**

Run: `npx vitest run src/lib/board.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove each gate independently**

Mutation check, by hand, reverting after each — a selector whose tests have only ever been seen to pass has established nothing:

1. Change `!hasWipLimits(project)` to `false` → the scrum test must fail, and only it.
2. Change `filtered ||` to `false ||` → the filtered test must fail, and only it.

If a mutation reddens **no** test, the test for that gate is vacuous. If it reddens **all** of them, the cases are not independent. Revert both.

- [ ] **Step 6: Lint and commit**

```bash
npm run lint
git add src/lib/board.ts src/lib/board.test.ts
git commit -m "Decide when a board column shows a WIP limit (SPRIN-86)"
```

---

### Task 3: Render the limit — ACs 1, 2, 4, 5

**Files:**
- Modify: `src/routes/BoardTab.tsx:44-53` (`BoardColumnSummary`) and its call site at `:345`
- Modify: `src/routes/BoardTab.test.tsx` — **fixture only**, one line
- Create: `src/routes/BoardTab.wipLimit.test.tsx`

**Interfaces:**
- Consumes: `selectColumnLimit` (Task 2), `isBoardFiltered` via `filtered` (Task 1), `summariseColumn(tickets): { count, points, unestimated }` (existing).
- Produces: `BoardColumnSummary({ tickets, limit }: { tickets: readonly Ticket[]; limit: number | null })`.

- [ ] **Step 1: Make the existing fixture tell the truth**

In `src/routes/BoardTab.test.tsx`, `SEEDED_STATUSES` spreads `DEFAULT_PROJECT_STATUSES`, which carries no `wip_limit` — so every status in that harness currently has `wip_limit: undefined`, a row the database can never return (`.select()` always sends the column). Add it, for the same reason the file's own comment states `sprint_id` on every ticket fixture:

```ts
const SEEDED_STATUSES = DEFAULT_PROJECT_STATUSES.map((status, i) => ({
  ...status,
  id: `1ecd8f0${i}-0000-4000-8000-000000000000`,
  project_id: 'p1',
  // Stated, never omitted: `wip_limit` is `number | null` and `.select()` always sends the
  // column, so an absent field would be a row the database cannot produce (SPRIN-86).
  wip_limit: null,
})) as unknown as ProjectStatus[]
```

This is the only edit to this file. Everything else in it stays untouched.

- [ ] **Step 2: Write the failing tests**

Create `src/routes/BoardTab.wipLimit.test.tsx`. It needs its own harness — copy the `vi.mock('@/lib/tickets')` block, `ctxWith`, and `renderTab` shapes from `BoardTab.test.tsx:1-95` rather than exporting them from that file (a test file exporting helpers is not a pattern this repo uses).

```tsx
import type { ComponentType } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { BoardTab } from './BoardTab'
import type { ProjectShellContext } from './ProjectShell'
import type { ProjectStatus, ProjectType } from '@/lib/domain'
import * as tickets from '@/lib/tickets'

vi.mock('@/lib/tickets', async (orig) => ({
  ...(await orig<typeof tickets>()),
  updateTicket: vi.fn(),
}))

// Two columns is enough for every case here and keeps each assertion's scope obvious.
// `wip_limit` is stated on both rows, always: it is what this suite is about, and an
// omitted field would be a row `.select()` can never return.
function statuses(limits: { todo: number | null; doing: number | null }): ProjectStatus[] {
  return [
    {
      id: '1ecd8f00-0000-4000-8000-000000000000',
      project_id: 'p1',
      slug: 'todo',
      name: 'To Do',
      category: 'todo',
      position: 1,
      is_initial: true,
      wip_limit: limits.todo,
    },
    {
      id: '1ecd8f01-0000-4000-8000-000000000000',
      project_id: 'p1',
      slug: 'doing',
      name: 'Doing',
      category: 'in_progress',
      position: 2,
      is_initial: false,
      wip_limit: limits.doing,
    },
  ] as unknown as ProjectStatus[]
}

// Three cards in To Do, one in Doing. `sprint_id` is null on every row: these boards are
// Kanban, so `selectBoardScope` shows every ticket whatever its sprint.
const TICKETS = [
  { id: 't1', key: 'MP-1', number: 1, summary: 'First', type: 'story', status: 'todo', sprint_id: null, story_points: 3, is_blocked: true },
  { id: 't2', key: 'MP-2', number: 2, summary: 'Second', type: 'story', status: 'todo', sprint_id: null, story_points: 5, is_blocked: false },
  { id: 't3', key: 'MP-3', number: 3, summary: 'Third', type: 'bug', status: 'todo', sprint_id: null, story_points: null, is_blocked: false },
  { id: 't4', key: 'MP-4', number: 4, summary: 'Fourth', type: 'task', status: 'doing', sprint_id: null, story_points: 2, is_blocked: false },
] as never

function ctxWith(
  project_type: ProjectType,
  rows: ProjectStatus[],
  fields: Partial<ProjectShellContext> = {},
): ProjectShellContext {
  return {
    project: { project_type } as never,
    tickets: TICKETS,
    ticketsPhase: 'loaded',
    sprints: [],
    sprintsPhase: 'loaded',
    statuses: rows,
    statusesPhase: 'loaded',
    onStatusCreated: vi.fn(),
    onStatusUpdated: vi.fn(),
    onStatusDeleted: vi.fn(),
    onStatusesReordered: vi.fn(),
    onRetry: vi.fn(),
    onSprintCreated: vi.fn(),
    onSprintUpdated: vi.fn(),
    onSprintCompleted: vi.fn(),
    currentUser: { id: 'u1', email: 'dev@example.com' },
    onOpenTicket: vi.fn(),
    onTicketUpdated: vi.fn(),
    onTicketDeleted: vi.fn(),
    ...fields,
  }
}

function renderTab(Tab: ComponentType, ctx: ProjectShellContext) {
  function Provider() {
    return <Outlet context={ctx} />
  }
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<Provider />}>
          <Route path="*" element={<Tab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

// Scope every assertion to its own column. The strings here are short and an unscoped
// `getByText(/limit 3/)` would happily match the other column — SPRIN-65 shipped a badge
// outside its own button with all twelve tests still green.
function column(label: string) {
  return screen.getByRole('heading', { name: label }).closest('section') as HTMLElement
}

describe('a Kanban column with a WIP limit', () => {
  // AC1
  it('shows its count against the limit when under it', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: null, doing: 3 })))
    const doing = within(column('Doing'))
    expect(doing.getByText(/1 card/i)).toBeInTheDocument()
    expect(doing.getByText(/limit 3/i)).toBeInTheDocument()
    expect(doing.queryByText(/over limit/i)).not.toBeInTheDocument()
  })

  // AC1 — the at-limit boundary. Three cards against a limit of three is NOT over.
  it('does not say over at exactly the limit', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: 3, doing: null })))
    const todo = within(column('To Do'))
    expect(todo.getByText(/3 cards/i)).toBeInTheDocument()
    expect(todo.getByText(/limit 3/i)).toBeInTheDocument()
    expect(todo.queryByText(/over limit/i)).not.toBeInTheDocument()
  })

  // AC2 — the WORDS. This is the assertion that fails if anyone conveys the state with
  // colour alone. It is deliberately NOT combined with the class assertion below: one test
  // holding both would pass while either half was deleted.
  it('says "over limit" in words when the count exceeds it', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: 2, doing: null })))
    expect(within(column('To Do')).getByText(/over limit 2/i)).toBeInTheDocument()
  })

  // AC2 — colour as REINFORCEMENT, never the carrier.
  it('renders the over-limit summary in the destructive colour', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: 2, doing: null })))
    expect(within(column('To Do')).getByText(/over limit 2/i)).toHaveClass('text-destructive')
    expect(within(column('Doing')).getByText(/1 card/i)).toHaveClass('text-muted-foreground')
  })
})

describe('a column with no limit to show', () => {
  // AC4
  it('renders exactly as it does today when the status has no limit', () => {
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: null, doing: null })))
    const todo = within(column('To Do'))
    expect(todo.getByText(/3 cards/i)).toBeInTheDocument()
    expect(todo.getByText(/8 points/i)).toBeInTheDocument()
    expect(todo.getByText(/1 unestimated/i)).toBeInTheDocument()
    expect(todo.queryByText(/limit/i)).not.toBeInTheDocument()
  })

  /**
   * AC5. The rows carry REAL limits and the board must still show none, because the project
   * is Scrum. SPRIN-85 §3.4: a CHECK cannot subquery `projects.project_type`, so this is a
   * row the database will genuinely store. Written with null limits instead, this test would
   * pass with the `hasWipLimits` gate deleted.
   */
  it('shows nothing on a Scrum board whose rows carry limits', () => {
    renderTab(BoardTab, ctxWith('scrum', statuses({ todo: 2, doing: 3 })))
    // A Scrum board with no active sprint renders its caption and no cards, so assert on
    // the whole document: the word must appear nowhere at all.
    expect(screen.queryByText(/limit/i)).not.toBeInTheDocument()
  })

  /**
   * SPRIN-86 §5.1. Under a filter the column is showing fewer cards than it holds, so the
   * board makes no WIP claim rather than an understated one. To Do holds three cards
   * against a limit of two — over — and exactly one of them is blocked.
   */
  it('drops the limit segment while a filter is active', async () => {
    const user = userEvent.setup()
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: 2, doing: null })))
    expect(within(column('To Do')).getByText(/over limit 2/i)).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /blocked only/i }))

    const todo = within(column('To Do'))
    expect(todo.getByText(/1 card/i)).toBeInTheDocument()
    expect(todo.queryByText(/limit/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run the tests and watch them fail**

Run: `npx vitest run src/routes/BoardTab.wipLimit.test.tsx`
Expected: FAIL. The AC4 and AC5 tests may already pass (nothing renders a limit yet) — that is fine and expected; the AC1 and AC2 tests must fail with "Unable to find an element with the text: /limit 3/i".

- [ ] **Step 4: Render the segment**

In `src/routes/BoardTab.tsx`, give `BoardColumnSummary` the prop and the segment:

```tsx
function BoardColumnSummary({
  tickets,
  limit,
}: {
  tickets: readonly Ticket[]
  limit: number | null
}) {
  const { count, points, unestimated } = summariseColumn(tickets)
  if (count === 0) return null
  const over = limit !== null && count > limit
  return (
    <span
      className={`${over ? 'text-destructive' : 'text-muted-foreground'} text-xs tabular-nums`}
    >
      {count === 1 ? '1 card' : `${count} cards`} · {points} points
      {unestimated > 0 ? ` · ${unestimated} unestimated` : ''}
      {limit === null ? '' : ` · ${over ? 'over limit' : 'limit'} ${limit}`}
    </span>
  )
}
```

Add to its docblock, above the existing text:

```
 * SPRIN-86 adds the WIP-limit segment. WHAT the limit is — and whether there is one to show
 * at all — is `selectColumnLimit`'s answer in `board.ts`, arriving here as a prop; this
 * component only decides UNDER versus OVER, from the same `count` it renders, so the number
 * the word "over" refers to is provably the number on screen.
 *
 * `limit === null` is strict on purpose. `ProjectStatus.wip_limit` is `number | null` and
 * `.select()` always sends the column, so `undefined` can only come from a test fixture that
 * omitted it — and a fixture that lies then renders "limit undefined" and reddens loudly,
 * rather than being silently absorbed by a nullish check.
 *
 * The colour is reinforcement and never the carrier: AC2 requires the state in TEXT, and the
 * word "over" is what satisfies it. Two separate tests pin the two halves.
```

- [ ] **Step 5: Wire the call site**

At `src/routes/BoardTab.tsx:345`:

```tsx
<BoardColumnSummary tickets={column} limit={selectColumnLimit(project, status, filtered)} />
```

Add `selectColumnLimit` to the existing `@/lib/board` import.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run src/routes/BoardTab.wipLimit.test.tsx src/routes/BoardTab.test.tsx src/lib/board.test.ts`
Expected: PASS, all three files. `BoardTab.test.tsx` passes with only the Step 1 fixture line changed — including its "gives an empty column no summary" test, which is what pins §5.2 of the spec: `BoardColumnSummary` keeps its `count === 0` early return, so an empty column still says nothing at all rather than `0 cards · 0 points · limit 3`.

- [ ] **Step 7: Re-measure complexity and lines**

Run: `npx eslint src/routes/BoardTab.tsx --rule '{"complexity":["error",1]}'`
Expected: `BoardColumnSummary` around **7–8**, `BoardTab` still **7**. Both must be **≤ 10**.

If `BoardColumnSummary` exceeds 10, extract the segment into a small file-local helper — `function limitPhrase(count: number, limit: number | null): string` returning `''`, `` ` · limit ${limit}` `` or `` ` · over limit ${limit}` `` — rather than widening any threshold. Widening a max in `eslint.config.js` reddens `verify-gate.test.mjs` by design.

Run: `npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 8: Commit**

```bash
git add src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx src/routes/BoardTab.wipLimit.test.tsx
git commit -m "Show a Kanban column's count against its WIP limit (SPRIN-86)"
```

---

### Task 4: Pin the soft limit — AC3

The load-bearing test of the story. Everything above is display; **this is the one that stops a future change turning a warning into a lock.** It tests behaviour that already works, so it will pass the moment it is written — which is exactly why it must be proven capable of failing before it is trusted.

**Files:**
- Modify: `src/routes/BoardTab.wipLimit.test.tsx`

**Interfaces:**
- Consumes: `updateTicket` from `@/lib/tickets`, already mocked at the top of the file (Task 3); `fireEvent` from `@testing-library/react`.

- [ ] **Step 1: Write the test**

Add to `src/routes/BoardTab.wipLimit.test.tsx`. Extend the imports to `import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'` and add `const updateTicket = vi.mocked(tickets.updateTicket)` beside the mock.

```tsx
/**
 * SPRIN-86 AC3, and the reason this suite exists. The WIP limit is SOFT: it warns, it never
 * blocks. Dragging a card into a column already AT its limit must succeed and persist.
 *
 * A hard limit was rejected for reasons recorded in the epic design §2.2 — enforcing it at
 * both edges would need a trigger on `tickets` counting sibling rows in the target column,
 * the exact shape that broke the cascade in SPRIN-80, and lowering a limit below a column's
 * occupancy would strand that column with no in-app way out.
 *
 * This test is what makes "improving" the limit into a block go RED rather than ship. Three
 * assertions, because a block could be implemented three ways: refusing the write, painting
 * the card back, or refusing with a message.
 */
describe('the WIP limit is soft', () => {
  it('lets a card drop into a column that is already at its limit (AC3)', async () => {
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', key: 'MP-1', status: 'doing', updated_at: '2026-08-05T00:00:00Z' },
    } as never)
    const onTicketUpdated = vi.fn()
    // Doing holds one card against a limit of one — full. To Do is the source.
    renderTab(BoardTab, ctxWith('kanban', statuses({ todo: null, doing: 1 }), { onTicketUpdated }))
    expect(within(column('Doing')).getByText(/limit 1/i)).toBeInTheDocument()

    fireEvent.dragStart(screen.getByRole('button', { name: /first/i })) // t1, status todo
    fireEvent.drop(column('Doing'))

    // 1. The optimistic apply happened — the card is not painted back.
    expect(onTicketUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', status: 'doing' }),
    )
    // 2. The write was actually sent, keyed on the SLUG.
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { status: 'doing' }))
    // 3. Nothing was refused: no error alert appeared.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it and watch it PASS**

Run: `npx vitest run src/routes/BoardTab.wipLimit.test.tsx`
Expected: PASS immediately. Nothing blocks today, so there is nothing to implement — this task ships a regression pin, not a behaviour.

- [ ] **Step 3: Prove it can fail — plant the mutation this test exists to catch**

Temporarily add a block to `moveTicket` in `src/routes/BoardTab.tsx`, right after the no-op guard, exactly as a well-meaning future change would:

```tsx
// TEMPORARY MUTATION — revert in Step 4.
const target = statuses.find((s) => s.slug === toStatus)
const occupancy = ticketsRef.current.filter((t) => t.status === toStatus).length
if (target?.wip_limit != null && occupancy >= target.wip_limit) {
  setMoveError(`${statusName(statuses, toStatus)} is at its WIP limit.`)
  return
}
```

Run: `npx vitest run src/routes/BoardTab.wipLimit.test.tsx`
Expected: **FAIL** — all three assertions of the AC3 test. If it passes, the test is vacuous and must be fixed before going any further; per the project's own record, a check that has only ever been seen to pass has established nothing.

- [ ] **Step 4: Revert the mutation**

```bash
git diff src/routes/BoardTab.tsx   # confirm the mutation is the ONLY change
git checkout src/routes/BoardTab.tsx
npx vitest run src/routes/BoardTab.wipLimit.test.tsx   # PASS again
```

Note: `git checkout` discards uncommitted work in that file. Task 3 is already committed, so there is nothing else to lose — verify with `git status` first if unsure.

- [ ] **Step 5: Commit**

```bash
git add src/routes/BoardTab.wipLimit.test.tsx
git commit -m "Pin the WIP limit as soft, never a block (SPRIN-86)"
```

---

### Task 5: Verify the whole gate, and the tripwire

**Files:** none changed unless a check fails.

- [ ] **Step 1: Re-derive the test-file counts**

Run: `npx vitest list --filesOnly | wc -l` → expect **65** (was 64).
Run: `npx vitest list --filesOnly --exclude '**/*.integration.test.ts' | wc -l` → expect **58** (was 57). That `--exclude` is exactly what the `test:unit` script applies.

The **gap must be 7**. A gap of 0 means the live suites silently skipped, and that is a failure however green the run looks.

- [ ] **Step 2: Run the real gate**

Run: `npm run verify`
Expected: green — lint, types, unit and live integration suites.

If a live suite fails, classify before re-running. The four documented transient signatures are in CLAUDE.md: a bare `TypeError: Cannot read properties of null (reading 'id')` in a `beforeAll`; the ES256 `unrecognized JWT kid` error; `AuthRetryableFetchError` with `status: 0` / `ECONNRESET`; and a `Test timed out in 5000ms` whose victim **moves between runs**. Anything else is real and belongs to this diff. Never weaken a suite to make it pass.

- [ ] **Step 3: Check the docs stayed true**

`BoardTab.tsx`'s module docblock and `BoardColumnSummary`'s docblock both quote complexity numbers. Confirm the numbers written in Tasks 1 and 3 match what `npx eslint … --rule '{"complexity":["error",1]}'` actually reports now, and correct any line that has gone stale. A recorded number that has drifted is worse than no number.

- [ ] **Step 4: Commit any doc corrections**

```bash
git add -u
git commit -m "Correct the recorded complexity figures (SPRIN-86)"
```

Skip this commit if Step 3 found nothing to correct.

---

## Done means

- All five ACs covered by a named test above, each proven capable of failing.
- `npm run verify` green locally **and** on the PR's own head commit — CI's result beats a local run.
- One PR, squash merged, **one reviewer** (this is board rendering: no migration, no privilege change, no security boundary). Ask that reviewer to **mutate, not read**: delete the `hasWipLimits` gate, delete the `filtered` gate, invert `count > limit`, and turn the drop handler into a block. Each should redden a named test.
- SPRIN-86 moved to Done in Jira only after merge — and with it, epic SPRIN-73 is complete.
