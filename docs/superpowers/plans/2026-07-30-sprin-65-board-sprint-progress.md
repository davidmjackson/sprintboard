# SPRIN-65 Sprint Progress on the Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the board say what sprint it is showing, what each card is worth, and how the sprint's points are spread across the four fixed columns.

**Architecture:** One new aggregate selector in `src/lib/board.ts` (`summariseColumn`) does all the arithmetic; `BoardTab` composes it through a small local presentational component so no new branch lands in `BoardTab` itself. `SprintDates` is lifted out of `SprintsTab` into its own module so the board can reuse the sprint date-formatting rules instead of restating them. Everything is a pure read over state `ProjectShellContext` already holds — no new fetch, no new write, no schema change.

**Tech Stack:** React 19 + TypeScript (strict), Tailwind v4, Vitest + Testing Library (jsdom), ESLint (T1–T5 as errors).

**Spec:** `docs/superpowers/specs/2026-07-30-sprin-65-board-sprint-progress-design.md` — read it before Task 1.

## Global Constraints

Every task's requirements implicitly include this section. Violating any of these turns CI red or silently loses coverage.

1. **`BoardTab`'s function body is at cyclomatic complexity EXACTLY 10, which is the T2 limit.** Adding one `if`, one `&&`, or one ternary directly inside the `BoardTab` function reddens `npm run lint` and therefore CI. Put new conditionals inside a *different* function (a child component). Verify with:
   `npx eslint src/routes/BoardTab.tsx --rule 'complexity: ["error", 1]'` — it must still say **10**, never 11.
2. **`npx tsc --noEmit` checks ZERO files in this repo and exits 0.** It is not a type check. The type check is `npm run build`.
3. **The full gate is `npm run verify`** (format check + lint + build + the whole test suite, including live Supabase integration suites). The controller runs it. Per-task, run `npx vitest run <your test file>` plus `npx eslint <the files you touched>`.
4. **Never inline the four board-column names.** They come from `TICKET_STATUS_LABELS` in `@/lib/domain`, always. Same for ticket-type names (`TICKET_TYPE_LABELS`). This is a CLAUDE.md rule.
5. **For numeric fields use `!= null` / `== null`, never a falsy check.** `0` is a real story-point estimate on a Scrum board, not "unestimated". A `ticket.story_points ? …` is a defect here, not a style choice.
6. **To give a bare number a unit, use real `sr-only` text, never `aria-label`.** A `<span>` maps to `role="generic"`, on which ARIA 1.2 *prohibits* `aria-label`; browsers honour it so it looks fine and axe-core flags it as serious. Real text also makes the assertion (and its positive control) available in jsdom. Copy the pattern from `src/routes/BacklogTab.tsx`.
7. **Do not edit `src/routes/SprintsTab.test.tsx`.** Task 3 moves a component out of `SprintsTab.tsx`; that suite staying green *without being touched* is the entire proof the move was behaviour-preserving.
8. **Add no live/integration tests.** This story adds no query, no write and no RLS change. A live test would re-cover an existing read and burn the shared GoTrue auth budget for nothing.
9. **Watch for the orphaned docblock.** Inserting or deleting a top-level symbol under a file-level JSDoc silently re-anchors that comment to whatever now follows. This repo has been bitten three times. After moving or adding a top-level symbol, read what the comment above it now binds to.
10. **Commit messages: single-line `git commit -m "…"` only.** Never a heredoc and never `-m "$(printf …)"` — a global guard hook word-splits them. Imperative summaries.
11. **`rm -rf` is blocked by a guard hook.** Use `git mv` / `rmdir`. Don't work around it.
12. **This plan's code is a starting point, not gospel.** If an established repo pattern contradicts it, follow the repo and **report the deviation** in your completion report. Prefer reporting BLOCKED over inventing a mechanism the plan didn't specify.

---

### Task 1: The `summariseColumn` selector

**Files:**
- Modify: `src/lib/board.ts` (append; the file is currently ~30 lines and holds `selectActiveSprint` and `selectBlockedTickets`)
- Test: `src/lib/board.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `Ticket` from `./domain` (already imported by `board.ts`).
- Produces, relied on by Task 5:
  ```ts
  export type ColumnSummary = { count: number; points: number; unestimated: number }
  export function summariseColumn(tickets: readonly Ticket[]): ColumnSummary
  ```

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/board.test.ts`. Note the existing `ticket()` helper at the top of that file requires `id` and `is_blocked`; reuse it, do not write a second helper.

Add `summariseColumn` and `ColumnSummary` to the existing import from `./board`.

```ts
describe('summariseColumn', () => {
  it('returns zeroes for an empty column', () => {
    expect(summariseColumn([])).toEqual({ count: 0, points: 0, unestimated: 0 })
  })

  it('counts the tickets and sums their points', () => {
    const column = [
      ticket({ id: 't1', is_blocked: false, story_points: 3 }),
      ticket({ id: 't2', is_blocked: false, story_points: 5 }),
    ]
    expect(summariseColumn(column)).toEqual({ count: 2, points: 8, unestimated: 0 })
  })

  it('treats a null estimate as 0 points and tallies it as unestimated', () => {
    const column = [
      ticket({ id: 't1', is_blocked: false, story_points: 3 }),
      ticket({ id: 't2', is_blocked: false, story_points: null }),
      ticket({ id: 't3', is_blocked: false, story_points: null }),
    ]
    expect(summariseColumn(column)).toEqual({ count: 3, points: 3, unestimated: 2 })
  })

  // The one that matters: 0 is a real estimate. A falsy check would count this
  // ticket as unestimated, which on a Scrum board is a different claim entirely.
  it('treats a 0-point ticket as ESTIMATED, contributing 0', () => {
    const column = [
      ticket({ id: 't1', is_blocked: false, story_points: 0 }),
      ticket({ id: 't2', is_blocked: false, story_points: 2 }),
    ]
    expect(summariseColumn(column)).toEqual({ count: 2, points: 2, unestimated: 0 })
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/lib/board.test.ts`
Expected: FAIL — `summariseColumn is not a function` / a TS error that it is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/board.ts`:

```ts
/** What a board column is worth, in one pass: how many cards, how many points, and how
 *  many of those cards carry no estimate at all.
 *
 *  The three numbers are always read together by the same caller, so they are one
 *  function rather than three — one iteration, one place to change the rule, and one
 *  mutation target. Kept here beside `selectActiveSprint` and `selectBlockedTickets`
 *  rather than inlined in `BoardTab`, because board rules live in this module
 *  (CLAUDE.md forbids inlining domain rules in components).
 *
 *  `story_points` is `int` and NULLABLE, and the null case is the point of `unestimated`:
 *  a column whose total is understated by unpointed work must say so rather than quietly
 *  report a smaller number. The guard is `== null`, never a falsy check — **0 is a real
 *  estimate**, not "unestimated", and the difference is the whole signal on a Scrum board. */
export type ColumnSummary = { count: number; points: number; unestimated: number }

export function summariseColumn(tickets: readonly Ticket[]): ColumnSummary {
  let points = 0
  let unestimated = 0
  for (const t of tickets) {
    if (t.story_points == null) unestimated += 1
    else points += t.story_points
  }
  return { count: tickets.length, points, unestimated }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/lib/board.test.ts`
Expected: PASS, all four new tests plus the six existing ones.

- [ ] **Step 5: Lint the touched files**

Run: `npx eslint src/lib/board.ts src/lib/board.test.ts`
Expected: no output (clean).

- [ ] **Step 6: Prove the 0-point test is not vacuous**

Temporarily change `t.story_points == null` to `!t.story_points` and re-run `npx vitest run src/lib/board.test.ts`. The "treats a 0-point ticket as ESTIMATED" test **must** go red. Revert the mutation and re-run to confirm green. Report both observations — a test that stays green under this mutation is a finding, not a pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/board.ts src/lib/board.test.ts
git commit -m "Add summariseColumn: card count, point total and unestimated tally"
```

---

### Task 2: The story-points badge on a board card (AC1)

**Files:**
- Modify: `src/routes/TicketCard.tsx` (the right-hand group inside the top row, lines 33–38)
- Test: `src/routes/TicketCard.test.tsx` (append)

**Interfaces:**
- Consumes: nothing from Task 1. `TicketCard`'s props are unchanged — the badge is derived from `ticket.story_points`, which is already on the `Ticket` it receives.
- Produces: nothing consumed by later tasks. Task 5's board tests must not depend on this badge's text.

`TicketCard` measures cyclomatic 2 of 10, so the added ternary is safe here (Global Constraint 1 applies to `BoardTab`, not this file).

- [ ] **Step 1: Write the failing tests**

Append inside the existing `describe('TicketCard', …)` in `src/routes/TicketCard.test.tsx`. The file's `ticket` fixture is `{ id, key, type, summary }` cast `as Ticket`, so `story_points` is spread in per test.

```ts
it('shows the story points with a screen-reader unit (SPRIN-65 AC1)', () => {
  render(<TicketCard ticket={{ ...ticket, story_points: 5 } as Ticket} />)
  expect(screen.getByText('5')).toBeInTheDocument()
  expect(screen.getByText(/story points/i)).toBeInTheDocument()
})

// 0 is a real estimate. A falsy guard would hide this badge, silently turning an
// estimated-at-zero ticket into an unestimated one.
it('shows a 0-point estimate rather than hiding it', () => {
  render(<TicketCard ticket={{ ...ticket, story_points: 0 } as Ticket} />)
  expect(screen.getByText('0')).toBeInTheDocument()
  expect(screen.getByText(/story points/i)).toBeInTheDocument()
})

// Negative control. Its positive control is the two tests above: they prove the
// `/story points/i` text exists to be missing, so this assertion cannot pass
// merely because the string was never rendered anywhere.
it('shows no points badge for an unestimated ticket', () => {
  render(<TicketCard ticket={{ ...ticket, story_points: null } as Ticket} />)
  expect(screen.queryByText(/story points/i)).not.toBeInTheDocument()
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/routes/TicketCard.test.tsx`
Expected: the two positive tests FAIL (`Unable to find an element with the text: 5`). The negative-control test passes for the wrong reason at this point — that is expected and is exactly why the positive controls exist.

- [ ] **Step 3: Write the implementation**

In `src/routes/TicketCard.tsx`, inside the existing right-hand `<div className="flex items-center gap-1.5">`, **after** the type-badge `<span>`:

```tsx
{/* `!= null`, not a falsy check: 0 is a real estimate, not "unestimated" — the same
    rule the backlog row follows. The unit is real `sr-only` text rather than an
    `aria-label`, because a <span> is `role="generic"` and ARIA 1.2 prohibits
    aria-label there; the card is a <button>, so this text joins its accessible name. */}
{ticket.story_points != null ? (
  <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium tabular-nums">
    {ticket.story_points}
    <span className="sr-only"> story points</span>
  </span>
) : null}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/routes/TicketCard.test.tsx`
Expected: PASS — all three new tests and the eight existing ones.

- [ ] **Step 5: Check you did not break the card's accessible name**

The existing tests query the card by `{ name: /wire the board/i }`. Adding text inside the `<button>` extends its accessible name; a substring regex still matches. If any pre-existing test in this file went red, **stop and report** rather than editing that test — a red pre-existing assertion here means the badge landed in the wrong element.

- [ ] **Step 6: Lint the touched files**

Run: `npx eslint src/routes/TicketCard.tsx src/routes/TicketCard.test.tsx`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/routes/TicketCard.tsx src/routes/TicketCard.test.tsx
git commit -m "Show the story-point estimate on a board card"
```

---

### Task 3: Lift `SprintDates` into its own module

**Files:**
- Create: `src/routes/SprintDates.tsx`
- Modify: `src/routes/SprintsTab.tsx` (delete the local `SprintDates` at lines 12–23; add an import; drop the now-unused `formatSprintDate` import if nothing else in the file uses it)
- Test: none new. `src/routes/SprintsTab.test.tsx` **must not be edited** (Global Constraint 7).

**Interfaces:**
- Consumes: `formatSprintDate` from `@/lib/sprint-dates`, `Sprint` from `@/lib/domain`.
- Produces, relied on by Task 4:
  ```tsx
  export function SprintDates({ sprint }: { sprint: Sprint }): JSX.Element
  ```
  Renders a `<span>`; "No dates set" when both dates are absent, otherwise `start – end` with `—` standing in for a missing one.

This is a pure move. **The rendered output must be byte-identical** — same classes, same text, same en-dash `–` separator and the same `—` em-dash placeholder. If you find yourself improving it, stop: `SprintsTab.test.tsx` is the control, and a "small improvement" invalidates the proof.

- [ ] **Step 1: Create the new module**

`src/routes/SprintDates.tsx` — the function body copied verbatim from `SprintsTab.tsx` lines 12–23, plus a docblock and the two imports:

```tsx
import { formatSprintDate } from '@/lib/sprint-dates'
import type { Sprint } from '@/lib/domain'

/**
 * A sprint's date range, or an honest "No dates set" when it has neither.
 *
 * Both dates are nullable `timestamptz` columns holding calendar days, and
 * `formatSprintDate` slices the ISO string in UTC on purpose — formatting in a local zone
 * west of UTC renders midnight-UTC as the PREVIOUS day. Do not reformat with `Intl` here.
 *
 * Lifted out of `SprintsTab` by SPRIN-65 when the board grew a sprint caption that needs
 * the same three rules. Two copies would have meant two places for a timezone decision
 * that took a whole spec to get right.
 */
export function SprintDates({ sprint }: { sprint: Sprint }) {
  if (!sprint.start_date && !sprint.end_date) {
    return <span className="text-muted-foreground text-xs">No dates set</span>
  }
  const start = sprint.start_date ? formatSprintDate(sprint.start_date) : '—'
  const end = sprint.end_date ? formatSprintDate(sprint.end_date) : '—'
  return (
    <span className="text-muted-foreground font-mono text-xs tabular-nums">
      {start} – {end}
    </span>
  )
}
```

- [ ] **Step 2: Remove the local copy and import the new one**

In `src/routes/SprintsTab.tsx`: delete lines 12–23 (the local `SprintDates` function) and add `import { SprintDates } from './SprintDates'` alongside the other `./`-relative component imports. Then check whether `formatSprintDate` and the `Sprint` type are still referenced elsewhere in the file — if not, remove them from the imports or `npm run lint` fails on unused imports.

- [ ] **Step 3: Check the docblock did not re-anchor**

`SprintsTab.tsx`'s file-level docblock ("The project's sprints, newest first…") sits *below* the deleted function and immediately above `export function SprintsTab`. Read lines 1–30 of the edited file and confirm it still binds to `SprintsTab` and that nothing now sits between them. Report what you saw.

- [ ] **Step 4: Run the control suite — unedited**

Run: `npx vitest run src/routes/SprintsTab.test.tsx`
Expected: PASS, with the same number of tests as before the move. This is the deliverable of the task: green here, with the test file untouched, is the proof the move preserved behaviour.

- [ ] **Step 5: Type-check and lint**

Run: `npm run build`
Expected: succeeds. (`npx tsc --noEmit` is a no-op in this repo — Global Constraint 2.)

Run: `npx eslint src/routes/SprintDates.tsx src/routes/SprintsTab.tsx`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/routes/SprintDates.tsx src/routes/SprintsTab.tsx
git commit -m "Lift SprintDates out of SprintsTab into its own module"
```

---

### Task 4: The active-sprint caption on the board (AC2)

**Files:**
- Modify: `src/routes/BoardTab.tsx` (the `activeSprint !== null ? (…) : null` block, currently lines 121–131)
- Test: `src/routes/BoardTab.test.tsx` (append inside the existing `describe('BoardTab', …)`)

**Interfaces:**
- Consumes: `SprintDates` from `./SprintDates` (Task 3).
- Produces: nothing consumed by later tasks.

**The constraint that shapes this task:** `BoardTab` is at cyclomatic 10 of 10. There is already an `activeSprint !== null ? … : null` block wrapping the "Blocked only" checkbox. **Put the caption inside that existing block** — a second `activeSprint !== null ?` ternary would be an eleventh branch and would redden the gate. Wrap the two children in a fragment.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('BoardTab', …)` in `src/routes/BoardTab.test.tsx`. The file already has `ACTIVE_SPRINT` (`{ id: 's-active', status: 'active', name: 'Sprint 1', project_id: 'p1' }`, no dates) and a `boardCtx()` helper.

```ts
it('names the active sprint and its dates above the board (SPRIN-65 AC2)', () => {
  const dated = { ...(ACTIVE_SPRINT as object), start_date: '2026-07-20T00:00:00.000Z', end_date: '2026-08-03T00:00:00.000Z' }
  renderTab(BoardTab, boardCtx({ sprints: [dated] as never }))
  expect(screen.getByText('Sprint 1')).toBeInTheDocument()
  expect(screen.getByText('2026-07-20 – 2026-08-03')).toBeInTheDocument()
})

it('says the sprint has no dates rather than inventing a range', () => {
  renderTab(BoardTab, boardCtx())
  expect(screen.getByText('Sprint 1')).toBeInTheDocument()
  expect(screen.getByText(/no dates set/i)).toBeInTheDocument()
})

// Negative control: with no active sprint the caption must be absent, and the
// existing "No active sprint" message must still be the thing on screen.
it('shows no sprint caption when there is no active sprint', () => {
  renderTab(BoardTab, boardCtx({ tickets: [], sprints: [] }))
  expect(screen.queryByText('Sprint 1')).not.toBeInTheDocument()
  expect(screen.getByText(/no active sprint/i)).toBeInTheDocument()
})
```

If the en-dash in `'2026-07-20 – 2026-08-03'` does not match because Testing Library normalises whitespace differently than expected, use a function matcher or `getByText(/2026-07-20/)` plus `getByText(/2026-08-03/)` and **report the deviation**. Do not change `SprintDates`' output to suit the test.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: the first two FAIL (`Unable to find an element with the text: Sprint 1`). The third passes already — it is a control, not a driver.

- [ ] **Step 3: Write the implementation**

Add `import { SprintDates } from './SprintDates'` to `BoardTab.tsx`. Then replace the existing block:

```tsx
{activeSprint !== null ? (
  <label className="text-muted-foreground flex w-fit items-center gap-2 text-sm">
```

with a fragment carrying the caption first — **reusing the same single `activeSprint !== null` test**, adding no branch:

```tsx
{activeSprint !== null ? (
  <>
    {/* The board never said WHICH sprint it was showing. Both children hang off the
        ONE `activeSprint !== null` test on purpose: `BoardTab` sits at the T2
        cyclomatic limit of 10, so a second conditional here reddens the lint gate. */}
    <p className="flex flex-wrap items-baseline gap-2 text-sm">
      <span className="font-medium">{activeSprint.name}</span>
      <SprintDates sprint={activeSprint} />
    </p>
    <label className="text-muted-foreground flex w-fit items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={blockedOnly}
        onChange={(e) => setBlockedOnly(e.target.checked)}
        className="size-4"
      />
      Blocked only
    </label>
  </>
) : null}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: PASS — the three new tests and every pre-existing one, including the S7.3 blocked-filter tests that render this same block.

- [ ] **Step 5: Verify the complexity budget — the load-bearing check**

Run: `npx eslint src/routes/BoardTab.tsx --rule 'complexity: ["error", 1]'`
Expected: `Function 'BoardTab' has a complexity of 10`. If it says **11**, you added a branch — restructure until it says 10. Report the number you saw.

- [ ] **Step 6: Lint and type-check**

Run: `npx eslint src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx`
Expected: clean.

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx
git commit -m "Name the active sprint and its dates above the board"
```

---

### Task 5: Column count and point totals (AC3, AC4, AC5)

**Files:**
- Modify: `src/routes/BoardTab.tsx` (add a local `BoardColumnSummary` component; render it in the column `<h2>` row)
- Test: `src/routes/BoardTab.test.tsx` (append)

**Interfaces:**
- Consumes: `summariseColumn` and `ColumnSummary` from `@/lib/board` (Task 1); `TICKET_STATUS_LABELS` from `@/lib/domain` (already imported by `BoardTab.tsx`).
- Produces: nothing further.

**Two placement rules, both load-bearing:**

- **Every new conditional lives inside `BoardColumnSummary`, never in `BoardTab`.** `BoardTab` is at cyclomatic 10 of 10. Rendering `<BoardColumnSummary tickets={column} />` unconditionally from the `.map` callback adds no branch anywhere in `BoardTab`; the empty-column and unestimated conditionals then count against the new component's own budget, which starts at 1.
- **Put `BoardColumnSummary` ABOVE `BoardTab`'s docblock**, between the imports and that comment — not between the docblock and `export function BoardTab`. Inserting a symbol there would re-anchor the docblock to the new component, which is exactly the S4.6 defect where `FAILURE_COPY` landed between `LoadFailure`'s docblock and its function (Global Constraint 9).

- [ ] **Step 1: Write the failing tests**

Append inside `describe('BoardTab', …)` in `src/routes/BoardTab.test.tsx`. These need tickets with points in known columns, so define a local fixture:

```ts
const POINTED = [
  { id: 't1', key: 'MP-1', number: 1, summary: 'Three pointer', type: 'story', status: 'todo', sprint_id: 's-active', is_blocked: false, story_points: 3 },
  { id: 't2', key: 'MP-2', number: 2, summary: 'Five pointer', type: 'story', status: 'todo', sprint_id: 's-active', is_blocked: true, blocked_reason: 'waiting', story_points: 5 },
  { id: 't3', key: 'MP-3', number: 3, summary: 'No estimate', type: 'task', status: 'todo', sprint_id: 's-active', is_blocked: false, story_points: null },
  { id: 't4', key: 'MP-4', number: 4, summary: 'Shipped', type: 'bug', status: 'done', sprint_id: 's-active', is_blocked: false, story_points: 2 },
] as never

// `within` is already imported at the top of this file. Scope every assertion to its
// own column: the numbers are short strings and a page-wide `getByText('8')` would
// happily match a different column, or a card's own points badge.
function column(label: string) {
  return screen.getByRole('heading', { name: label }).closest('section') as HTMLElement
}

it('shows each column card count and point total (SPRIN-65 AC3)', () => {
  renderTab(BoardTab, boardCtx({ tickets: POINTED }))
  const todo = within(column('To Do'))
  expect(todo.getByText(/3 cards/i)).toBeInTheDocument()
  expect(todo.getByText(/8 points/i)).toBeInTheDocument()
  const done = within(column('Done'))
  expect(done.getByText(/1 card/i)).toBeInTheDocument()
  expect(done.getByText(/2 points/i)).toBeInTheDocument()
})

it('says when a column total is understated by unestimated work (AC5)', () => {
  renderTab(BoardTab, boardCtx({ tickets: POINTED }))
  expect(within(column('To Do')).getByText(/1 unestimated/i)).toBeInTheDocument()
  // Negative control: Done has no unestimated ticket, so it must not say so.
  expect(within(column('Done')).queryByText(/unestimated/i)).not.toBeInTheDocument()
})

it('gives an empty column no summary — "No tickets yet" already says it', () => {
  renderTab(BoardTab, boardCtx({ tickets: POINTED }))
  const review = within(column('In Review'))
  expect(review.getByText(/no tickets yet/i)).toBeInTheDocument()
  expect(review.queryByText(/points/i)).not.toBeInTheDocument()
})

// AC4: the numbers describe what is on screen. With the filter on, the To Do column
// shows one card worth 5, not three cards worth 8.
it('recounts against the visible cards when the blocked-only filter is on (AC4)', async () => {
  renderTab(BoardTab, boardCtx({ tickets: POINTED }))
  expect(within(column('To Do')).getByText(/8 points/i)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('checkbox', { name: /blocked only/i }))
  const todo = within(column('To Do'))
  expect(todo.getByText(/1 card/i)).toBeInTheDocument()
  expect(todo.getByText(/5 points/i)).toBeInTheDocument()
  expect(todo.queryByText(/8 points/i)).not.toBeInTheDocument()
  expect(todo.queryByText(/unestimated/i)).not.toBeInTheDocument()
})
```

The `column()` helper uses `.closest('section')` because each column is a `<section>` containing an `<h2>`. If the rendered structure makes that brittle, prefer giving the `<section>` an accessible name via `aria-labelledby` or `aria-label` and using `within(screen.getByRole('region', { name }))` — and **report the deviation**.

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: the first, second and fourth FAIL (`Unable to find an element with the text: /3 cards/i`). The third ("empty column no summary") passes vacuously for now — it is a control.

- [ ] **Step 3: Write the implementation**

Add to the imports in `BoardTab.tsx`:

```tsx
import { selectActiveSprint, selectBlockedTickets, summariseColumn } from '@/lib/board'
```

Add the component **above** `BoardTab`'s existing docblock:

```tsx
/**
 * What a column is worth, under its heading: how many cards, how many points, and — only
 * when there are any — how many cards carry no estimate, so a total is never silently
 * understated.
 *
 * It is a separate component for two reasons. `BoardTab` sits at the T2 cyclomatic limit
 * of 10, so its two conditionals have to be somebody else's; and the arithmetic itself is
 * `summariseColumn`'s, in `board.ts`, because board rules do not live in components.
 *
 * The caller passes the ALREADY-FILTERED column, so these numbers describe the cards
 * actually on screen — the blocked-only filter changes them. A total that disagreed with
 * the cards under it would be a distinct state wearing another state's face.
 *
 * Nothing is rendered for an empty column: "No tickets yet." is already there and says it
 * better than "0 cards · 0 points" would.
 */
function BoardColumnSummary({ tickets }: { tickets: readonly Ticket[] }) {
  const { count, points, unestimated } = summariseColumn(tickets)
  if (count === 0) return null
  return (
    <span className="text-muted-foreground text-xs tabular-nums">
      {count === 1 ? '1 card' : `${count} cards`} · {points} points
      {unestimated > 0 ? ` · ${unestimated} unestimated` : ''}
    </span>
  )
}
```

`Ticket` needs importing as a type in `BoardTab.tsx` — the file currently imports only `TicketStatus` from `@/lib/domain`, so extend that import: `import type { Ticket, TicketStatus } from '@/lib/domain'`.

Then, in the column `<section>`, replace the bare heading:

```tsx
<h2 className="text-sm font-medium">{TICKET_STATUS_LABELS[status]}</h2>
```

with a heading row that keeps the `<h2>` intact (the tests and any future a11y check rely on the heading role and its name being exactly the column label — do not fold the numbers into the `<h2>`):

```tsx
<div className="flex flex-wrap items-baseline justify-between gap-x-2">
  <h2 className="text-sm font-medium">{TICKET_STATUS_LABELS[status]}</h2>
  <BoardColumnSummary tickets={column} />
</div>
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: PASS — all four new tests and every pre-existing one.

- [ ] **Step 5: Verify the complexity budget — the load-bearing check**

Run: `npx eslint src/routes/BoardTab.tsx --rule 'complexity: ["error", 1]'`
Expected: `Function 'BoardTab' has a complexity of 10` — unchanged. `BoardColumnSummary` will report its own small number; that is fine, it only has to be ≤ 10. If `BoardTab` reports 11, a conditional leaked into it — move it into `BoardColumnSummary`. Report the numbers you saw.

- [ ] **Step 6: Check the docblock did not re-anchor**

Read the region between the imports and `export function BoardTab` and confirm the long "The board: the four fixed columns…" docblock still sits immediately above `export function BoardTab`, with `BoardColumnSummary` and its own docblock above it. Report what you saw.

- [ ] **Step 7: Prove the AC4 test is not vacuous**

Temporarily change `<BoardColumnSummary tickets={column} />` to `<BoardColumnSummary tickets={boardTickets.filter((t) => t.status === status)} />` — that is, count the unfiltered set. Re-run `npx vitest run src/routes/BoardTab.test.tsx`. The AC4 test **must** go red. Revert and re-run to confirm green. Report both observations; a green run under that mutation means AC4 is pinned by nothing.

- [ ] **Step 8: Lint and type-check**

Run: `npx eslint src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx`
Expected: clean.

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx
git commit -m "Show card counts and point totals in the board column headings"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| AC1 points badge, including 0, with sr-only unit | Task 2 |
| AC2 sprint caption with name and dates | Task 4 (enabled by Task 3) |
| AC3 count and points per column heading, labels from `domain.ts` | Task 5 |
| AC4 numbers follow the blocked-only filter | Task 5, steps 1 and 7 |
| AC5 unestimated contributes 0 and is called out | Tasks 1 and 5 |
| AC6 rules are named, unit-tested selectors in `src/lib` | Task 1 |
| D1 one aggregate selector in `board.ts` | Task 1 |
| D2 computed from the filtered column | Task 5 |
| D3 empty column shows no summary | Task 5 |
| D4 unestimated spelled out, only when > 0 | Task 5 |
| D5 badge mirrors the backlog row, top-row right group | Task 2 |
| D6 `SprintDates` extracted, `SprintsTab.test.tsx` untouched | Task 3 |
| D7 `BoardColumnSummary` local, above the docblock | Task 5 |
| Cyclomatic-10 constraint held | Tasks 4 and 5, explicit verify steps |
| No live integration tests | Global Constraint 8 |
