# SPRIN-68 — Find a ticket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one client-side text filter, shared by the Backlog and Board tabs, that narrows
tickets by key or summary.

**Architecture:** A pure selector in a new `src/lib/ticket-search.ts` owns the matching rule; a
small presentational `TicketSearchInput` owns the control; each tab owns its own query state and
composes the selector into the filtering it already does. Nothing touches the data layer, the
schema, or any query.

**Tech Stack:** React 19 + TypeScript (strict), Vite, Tailwind v4, shadcn/ui over the unified
`radix-ui` package, Vitest + Testing Library (jsdom).

## Global Constraints

Read these before every task. They are project rules, not preferences, and each has drawn blood.

- **Verification is `npm run verify`.** Never `npx tsc --noEmit` — it checks **zero files** here
  (`files: []` + project references) and exits 0 regardless. `npm run build` is the type check.
- **Run the formatter.** `npm run format:check` is part of the gate. A previous story went red at
  the PR because plan-supplied code was pasted unformatted. If you add code, run
  `npx prettier --write` on the files you touched, or `npm run format`.
- **Lint thresholds are errors, not warnings** (T1–T5): 30-line functions, cyclomatic 10, cognitive
  15, 4 parameters, 400-line files. `npm run lint` is `eslint . --max-warnings 0`.
  **`BoardTab` is at cyclomatic exactly 10 with zero headroom — measured.** Adding any `if`,
  ternary, `||` or `&&` to `BoardTab`'s own function body turns the gate red. Never add an inline
  eslint-disable; a genuine misfit is an ADR.
- **Domain rules never live in components.** Status/type/column names live in `src/lib/domain.ts`;
  board rules in `src/lib/board.ts`; the backlog rule in `src/lib/backlog.ts`. A filter predicate
  is a domain rule (S7.3 precedent: `selectBlockedTickets`).
- **Never assert an exact accessible name in jsdom.** jsdom computes composed names differently
  from every browser. Use substring/regex role-name queries (`{ name: /search/i }`), or DOM text
  scoped with `within(...)`. An exact name is only safe for a single text node or an `aria-label`.
- **Use `!= null`, never a falsy check, for `story_points`** — `0` is a real estimate.
- **Native elements over radix in jsdom** for simple controls — a native `<input>` in a `<label>`
  gets an accessible name and tests cleanly.
- **Never run `git checkout <file>` to revert a mutation** — it also destroys uncommitted work.
  Copy to the scratchpad first.
- Commit messages: imperative summary. Never use a heredoc for a commit message (a global guard
  hook word-splits it) — use `git commit -m` with a single-line message.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/ticket-search.ts` (create) | The matching rule: `selectMatchingTickets`. Pure, no React. |
| `src/lib/ticket-search.test.ts` (create) | Unit tests for the rule. |
| `src/routes/TicketSearchInput.tsx` (create) | The labelled `<input type="search">`, controlled. |
| `src/routes/BacklogTab.tsx` (modify) | Query state; filter; filtered-empty message. |
| `src/routes/BacklogTab.test.tsx` (modify) | AC1, AC4, AC5 (backlog half). |
| `src/routes/BoardTab.tsx` (modify) | Query state; compose into `visibleTickets`; `BoardColumnEmpty`. |
| `src/routes/BoardTab.test.tsx` (modify) | AC2, AC3, AC5 (board half). |

---

### Task 1: The matching rule

**Files:**
- Create: `src/lib/ticket-search.ts`
- Test: `src/lib/ticket-search.test.ts`

**Interfaces:**
- Consumes: `Ticket` from `@/lib/domain` (fields used: `key: string`, `summary: string`).
- Produces: `selectMatchingTickets(tickets: readonly Ticket[], query: string): Ticket[]` — used by
  both `BacklogTab` (Task 3) and `BoardTab` (Task 4).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/ticket-search.test.ts`. Note the fixture style: this repo hand-builds partial
ticket fixtures and casts, because `Ticket` has many columns irrelevant to a selector. Copy the
`as never` / `as unknown as Ticket[]` idiom already used in `src/lib/board.test.ts` rather than
inventing a new one — **open `src/lib/board.test.ts` first and match whatever it actually does.**

```ts
import { describe, expect, it } from 'vitest'

import { selectMatchingTickets } from './ticket-search'
import type { Ticket } from './domain'

function ticket(fields: Partial<Ticket>): Ticket {
  return { key: 'MP-1', summary: 'Wire the board', ...fields } as Ticket
}

const TICKETS = [
  ticket({ key: 'MP-1', summary: 'Wire the board' }),
  ticket({ key: 'MP-2', summary: 'Fix the login redirect' }),
  ticket({ key: 'MP-13', summary: 'Add sprint burndown' }),
]

describe('selectMatchingTickets', () => {
  it('returns everything for an empty query', () => {
    expect(selectMatchingTickets(TICKETS, '')).toHaveLength(3)
  })

  it('returns everything for a whitespace-only query', () => {
    expect(selectMatchingTickets(TICKETS, '   ')).toHaveLength(3)
  })

  it('matches the summary case-insensitively', () => {
    const found = selectMatchingTickets(TICKETS, 'LOGIN')
    expect(found.map((t) => t.key)).toEqual(['MP-2'])
  })

  it('matches a full key', () => {
    const found = selectMatchingTickets(TICKETS, 'mp-2')
    expect(found.map((t) => t.key)).toEqual(['MP-2'])
  })

  it('matches a partial key, so MP-1 also matches MP-13', () => {
    const found = selectMatchingTickets(TICKETS, 'MP-1')
    expect(found.map((t) => t.key)).toEqual(['MP-1', 'MP-13'])
  })

  it('ignores surrounding whitespace in the query', () => {
    expect(selectMatchingTickets(TICKETS, '  burndown  ')).toHaveLength(1)
  })

  it('returns an empty array when nothing matches', () => {
    expect(selectMatchingTickets(TICKETS, 'zzz')).toEqual([])
  })

  it('preserves the given order and does not mutate the input', () => {
    const input = [...TICKETS]
    const found = selectMatchingTickets(input, 'MP')
    expect(found.map((t) => t.key)).toEqual(['MP-1', 'MP-2', 'MP-13'])
    expect(input).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/lib/ticket-search.test.ts`
Expected: FAIL — cannot resolve `./ticket-search`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/ticket-search.ts`:

```ts
import type { Ticket } from './domain'

/**
 * The ticket-search rule, in one place: **a ticket matches when its key or its summary
 * contains the query, case-insensitively.**
 *
 * It gets its own module rather than joining `board.ts` or `backlog.ts` because it belongs
 * to neither — the Board and the Backlog both use it, and putting it in one would make the
 * other import a rule from a module named after a surface it is not. Same reason
 * `selectSprintTickets` stays in `backlog.ts` and `board.ts` composes with it.
 *
 * **An empty or whitespace-only query returns the list unchanged, never `[]`.** Both tabs
 * mount with an empty query, so inverting this branch empties the whole product on first
 * render — it is the one line here worth a test of its own.
 *
 * Key and summary only. Description, acceptance criteria and labels are deliberately not
 * searched: neither the board card nor the backlog row renders them, so a match would be
 * invisible — the user types "auth", gets four rows, and none of them says "auth" anywhere.
 *
 * Substring rather than prefix, so `mp`, `MP-1` and a bare `1` all narrow usefully through
 * one code path. Note the consequence, which is intended: `MP-1` also matches `MP-13`.
 */
export function selectMatchingTickets(tickets: readonly Ticket[], query: string): Ticket[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...tickets]
  return tickets.filter(
    (t) =>
      t.key.toLowerCase().includes(needle) || t.summary.toLowerCase().includes(needle),
  )
}
```

Note `[...tickets]` rather than `tickets`: the parameter is `readonly Ticket[]` and the return type
is `Ticket[]`, so returning the argument directly would not type-check. It also keeps the function
honest — every path returns a new array, so no caller can mutate the shell's list through it.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/lib/ticket-search.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Prove the empty-query branch is load-bearing**

Change `if (needle === '') return [...tickets]` to `if (needle === '') return []`, re-run, and
confirm the two empty/whitespace tests go red. Restore it. **Report the test names that failed.**
If fewer than two fail, say so — that is a finding.

- [ ] **Step 6: Format, lint, commit**

```bash
npx prettier --write src/lib/ticket-search.ts src/lib/ticket-search.test.ts
npm run lint
git add src/lib/ticket-search.ts src/lib/ticket-search.test.ts
git commit -m "Add the ticket-search matching rule (SPRIN-68)"
```

---

### Task 2: The search input control

**Files:**
- Create: `src/routes/TicketSearchInput.tsx`

**Interfaces:**
- Consumes: `Input` from `@/components/ui/input`.
- Produces: `TicketSearchInput({ value, onChange }: { value: string; onChange: (next: string) =>
  void })` — used by `BacklogTab` (Task 3) and `BoardTab` (Task 4).

No test file of its own: it is presentational with no logic, and Tasks 3 and 4 both drive it
through the real tab. A test asserting "an input renders" would pin nothing.

- [ ] **Step 1: Write the component**

```tsx
import { Input } from '@/components/ui/input'

/**
 * The ticket search box, shared by the Board and the Backlog so the label, the accessible
 * name and the styling cannot drift between the two surfaces.
 *
 * Controlled: the query lives in each tab as local view state, never in
 * `ProjectShellContext`. Hoisting it would make the Backlog's query follow you to the Board —
 * a behaviour no AC asks for. Same call S7.3 made for the blocked-only checkbox, and filters
 * are not persisted to the URL or storage in Phase 1.
 *
 * A native `<input type="search">` wrapped in a `<label>`, not a radix control: the label
 * gives it an accessible name, `getByRole('searchbox', { name: /search/i })` then works in
 * jsdom, and there is no popover behaviour to want.
 *
 * The caller decides WHETHER to render this, and must decide it from the UNFILTERED list —
 * gating it on the filtered result strands the user, because a query that matches nothing
 * would remove the only control that could clear it.
 */
export function TicketSearchInput({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  return (
    <label className="flex w-full max-w-xs flex-col gap-1">
      <span className="text-muted-foreground text-sm">Search tickets</span>
      <Input
        type="search"
        value={value}
        placeholder="Key or summary"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}
```

- [ ] **Step 2: Confirm it compiles and formats**

```bash
npx prettier --write src/routes/TicketSearchInput.tsx
npm run build
npm run lint
```

Expected: build and lint clean. (`npm run build` is the type check — `tsc --noEmit` checks nothing
in this repo.)

- [ ] **Step 3: Commit**

```bash
git add src/routes/TicketSearchInput.tsx
git commit -m "Add the shared ticket search input (SPRIN-68)"
```

---

### Task 3: Wire the Backlog (AC1, AC4, AC5-backlog)

**Files:**
- Modify: `src/routes/BacklogTab.tsx`
- Test: `src/routes/BacklogTab.test.tsx`

**Interfaces:**
- Consumes: `selectMatchingTickets` (Task 1), `TicketSearchInput` (Task 2).
- Produces: nothing other tasks depend on.

`BacklogTab` measured at cyclomatic **4**, so it has headroom — unlike `BoardTab`. Do not
over-engineer this one.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `src/routes/BacklogTab.test.tsx`. **Read the top of that file first**
— it already has `ctxWith()` and `renderTab()` helpers and a single-ticket `TICKETS` fixture. You
need more than one ticket, so pass your own list via `ctxWith({ tickets: … })` rather than editing
the shared fixture: other tests in the file depend on it, and changing it under them is how a
fixture edit silently un-kills an existing test.

```tsx
const SEARCH_TICKETS = [
  { id: 't1', key: 'MP-1', number: 1, summary: 'Wire the board', type: 'story',
    status: 'todo', sprint_id: null, is_blocked: false, story_points: null,
    assignee_id: null, labels: [] },
  { id: 't2', key: 'MP-2', number: 2, summary: 'Fix the login redirect', type: 'bug',
    status: 'todo', sprint_id: null, is_blocked: false, story_points: null,
    assignee_id: null, labels: [] },
] as never

describe('BacklogTab search (SPRIN-68)', () => {
  it('filters rows by summary as you type', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'login')
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
  })

  it('filters rows by ticket key', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'MP-2')
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
  })

  it('shows everything again when the query is cleared (AC4)', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    const box = screen.getByRole('searchbox', { name: /search/i })
    await userEvent.type(box, 'login')
    await userEvent.clear(box)
    expect(screen.getByRole('button', { name: /wire the board/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
  })

  // AC5. The negative assertion is the point: a filtered-empty backlog must NOT claim the
  // project has no backlog. Asserting only the new message would stay green if both rendered.
  it('says no matches, and does not claim the backlog is empty', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzz')
    expect(screen.getByText(/no tickets match your search/i)).toBeInTheDocument()
    expect(screen.queryByText(/nothing in the backlog/i)).not.toBeInTheDocument()
  })

  // The positive control for the test above: the real empty backlog still says the real thing.
  it('still says the backlog is empty when it genuinely is', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [] as never }))
    expect(screen.getByText(/nothing in the backlog/i)).toBeInTheDocument()
  })

  // The stranding guard: the box that got you here must still be there to get you out.
  it('keeps the search box rendered when the query matches nothing', async () => {
    renderTab(BacklogTab, ctxWith({ tickets: SEARCH_TICKETS }))
    const box = screen.getByRole('searchbox', { name: /search/i })
    await userEvent.type(box, 'zzz')
    expect(screen.getByRole('searchbox', { name: /search/i })).toBeInTheDocument()
    await userEvent.clear(box)
    expect(screen.getByRole('button', { name: /wire the board/i })).toBeInTheDocument()
  })

  // A search box over an empty backlog is furniture with nothing to do.
  it('does not render the search box when the backlog is genuinely empty', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [] as never }))
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
  })
})
```

If the fixture above fails to render because `Ticket` needs fields you have not supplied, add the
missing ones — do **not** delete assertions to make it pass, and report what you had to add.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/routes/BacklogTab.test.tsx`
Expected: FAIL — no `searchbox` role in the document.

- [ ] **Step 3: Implement**

In `src/routes/BacklogTab.tsx`: add `useState` and the two imports, then restructure only the final
return. The three early returns stay exactly as they are — **the order is the AC5 mechanism**:
`backlog.length === 0` must keep testing the UNFILTERED backlog.

```tsx
import { useState } from 'react'
// … existing imports …
import { selectMatchingTickets } from '@/lib/ticket-search'
import { TicketSearchInput } from './TicketSearchInput'
```

Inside the component, above the existing early returns:

```tsx
  const [query, setQuery] = useState('')
```

Then, after the existing `if (backlog.length === 0) { … }` block, replace the final `return` with:

```tsx
  // Filtered AFTER the empty check above, and that order is the whole of AC5: `backlog` is
  // the unfiltered list, so "Nothing in the backlog." can only be reached when the project
  // really has no unsprinted tickets. A filtered-empty result is a different fact and says so
  // below. Same lesson as the `failed` check above it — a distinct state must never wear
  // another state's face.
  const matches = selectMatchingTickets(backlog, query)

  return (
    <div className="flex flex-col gap-4">
      {/* Rendered here, inside the branch guarded by the UNFILTERED backlog, so it is on
          screen for every query — including one that matches nothing. Gating it on `matches`
          would strand the user: the box that hid the rows would itself disappear. */}
      <TicketSearchInput value={query} onChange={setQuery} />
      {matches.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed">
          <p className="text-muted-foreground text-sm">No tickets match your search.</p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {/* … the existing <li> map, unchanged, but mapping over `matches` … */}
        </ul>
      )}
    </div>
  )
```

Keep the existing `<li>` body byte-identical — only the array it maps over changes from `backlog`
to `matches`. Do not touch the row's assignee/points/blocked markup; SPRIN-67 pinned it.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run src/routes/BacklogTab.test.tsx`
Expected: PASS — the new block plus every pre-existing test in the file.

- [ ] **Step 5: Prove the AC5 ordering is load-bearing**

Move the `selectMatchingTickets` call ABOVE the `if (backlog.length === 0)` check and make that
check test `matches` instead. Re-run. **The "does not claim the backlog is empty" test must go
red.** Restore. Report the result — if it stays green, the test is not pinning the ordering and
that is a finding to report, not to paper over.

- [ ] **Step 6: Format, verify, commit**

```bash
npx prettier --write src/routes/BacklogTab.tsx src/routes/BacklogTab.test.tsx
npm run lint
npm run build
git add src/routes/BacklogTab.tsx src/routes/BacklogTab.test.tsx
git commit -m "Filter the backlog by key or summary (SPRIN-68)"
```

---

### Task 4: Wire the Board (AC2, AC3, AC5-board)

**Files:**
- Modify: `src/routes/BoardTab.tsx`
- Test: `src/routes/BoardTab.test.tsx`

**Interfaces:**
- Consumes: `selectMatchingTickets` (Task 1), `TicketSearchInput` (Task 2).
- Produces: nothing other tasks depend on.

**The complexity budget is the hard constraint here.** `BoardTab`'s function body is at cyclomatic
**exactly 10**, measured. Adding one `||`, `&&`, `if` or ternary to it turns `npm run lint` red and
blocks the merge. The design below is shaped around that and costs zero:

- the query filter reuses the existing `blockedOnly ? … : …` expression — a call, not a branch;
- the `||` that decides the empty-column sentence lives in a NEW component, not in `BoardTab`.

Do not write `const filterActive = blockedOnly || query.trim() !== ''` in `BoardTab`. It is the
obvious move and it is the one the budget cannot absorb.

- [ ] **Step 1: Write the failing tests**

Add a `describe` block to `src/routes/BoardTab.test.tsx`. **Read the file's existing helpers first**
(`ctxWith` / `renderTab` originate here) and reuse them; note the board needs an ACTIVE sprint and
tickets whose `sprint_id` matches it, or nothing renders at all.

```tsx
const S = { id: 's1', name: 'Sprint 1', status: 'active' }

const BOARD_TICKETS = [
  { id: 't1', key: 'MP-1', number: 1, summary: 'Wire the board', type: 'story',
    status: 'todo', sprint_id: 's1', is_blocked: false, story_points: 3,
    assignee_id: null, labels: [] },
  { id: 't2', key: 'MP-2', number: 2, summary: 'Fix the login redirect', type: 'bug',
    status: 'todo', sprint_id: 's1', is_blocked: true, story_points: 5,
    assignee_id: null, labels: [] },
] as never

function renderBoard(extra: Partial<ProjectShellContext> = {}) {
  return renderTab(
    BoardTab,
    ctxWith({ tickets: BOARD_TICKETS, sprints: [S] as never, ...extra }),
  )
}

describe('BoardTab search (SPRIN-68)', () => {
  it('narrows the cards to matches (AC2)', async () => {
    renderBoard()
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'login')
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
  })

  // AC2's second half, and the reason the totals are worth a test rather than an assertion in
  // the spec: they must describe what is on screen. `summariseColumn` is not changed by this
  // story, so this test guards the COMPOSITION — not WHERE the query is applied (filtering
  // commutes with the per-status split, so that is not test-catchable — see Step 6's
  // correction below) but that the cards on screen and the totals over them never disagree:
  // the filtered cards must never be paired with an unfiltered column.
  it('column totals describe only the visible cards (AC2)', async () => {
    renderBoard()
    expect(screen.getByText(/2 cards · 8 points/i)).toBeInTheDocument()
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'login')
    expect(screen.getByText(/1 card · 5 points/i)).toBeInTheDocument()
    expect(screen.queryByText(/8 points/i)).not.toBeInTheDocument()
  })

  // AC3: both filters narrow, ANDed. 'Wire the board' matches the query but is NOT blocked,
  // so with both on, nothing survives — which also exercises the AC5 message.
  it('composes with the blocked-only filter (AC3)', async () => {
    renderBoard()
    await userEvent.click(screen.getByRole('checkbox', { name: /blocked only/i }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'login')
    expect(screen.getByRole('button', { name: /fix the login redirect/i })).toBeInTheDocument()
    await userEvent.clear(screen.getByRole('searchbox', { name: /search/i }))
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'wire')
    expect(screen.queryByRole('button', { name: /wire the board/i })).not.toBeInTheDocument()
  })

  // AC5. Note this ALSO covers a defect that exists on main today, before this story: with
  // blocked-only on, a column with no blocked cards already says "No tickets yet." — a claim
  // about the sprint made by a filter.
  it('an emptied column says No matches, not No tickets yet (AC5)', async () => {
    renderBoard()
    await userEvent.type(screen.getByRole('searchbox', { name: /search/i }), 'zzz')
    expect(screen.getAllByText(/no matches/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/no tickets yet/i)).not.toBeInTheDocument()
  })

  // The pre-existing defect, pinned in its own right.
  it('an emptied column says No matches under the blocked filter alone (AC5)', async () => {
    renderBoard()
    await userEvent.click(screen.getByRole('checkbox', { name: /blocked only/i }))
    // 'In Progress'/'In Review'/'Done' hold nothing; To Do still holds the blocked bug.
    expect(screen.getAllByText(/no matches/i).length).toBeGreaterThan(0)
  })

  // The positive control: with no filter at all, the honest message is the original one.
  it('says No tickets yet when nothing is filtered', () => {
    renderBoard()
    expect(screen.getAllByText(/no tickets yet/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/no matches/i)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: FAIL — no `searchbox`.

- [ ] **Step 3: Add `BoardColumnEmpty`**

In `src/routes/BoardTab.tsx`, beside the existing `BoardColumnSummary`:

```tsx
/**
 * What an empty column says — and it is not always the same thing.
 *
 * "No tickets yet." is a claim about the SPRINT. When a filter is on, the column may be empty
 * only because the filter hid its cards, and that claim becomes false. This is the same
 * failure `BacklogTab` guards against ("a distinct state wearing another state's face"), and
 * the board already had it before this story: with blocked-only on, a column holding no
 * blocked cards has always said "No tickets yet."
 *
 * The `||` lives HERE rather than in `BoardTab` for a measured reason: `BoardTab`'s body sits
 * at the T2 cyclomatic limit of exactly 10, so computing a filter-active flag up there takes
 * it to 11 and reddens `npm run lint`. Deciding the sentence in its own component costs
 * `BoardTab` nothing.
 */
function BoardColumnEmpty({ blockedOnly, query }: { blockedOnly: boolean; query: string }) {
  const filtering = blockedOnly || query.trim() !== ''
  return (
    <p className="text-muted-foreground text-xs">
      {filtering ? 'No matches.' : 'No tickets yet.'}
    </p>
  )
}
```

- [ ] **Step 4: Wire the query into `BoardTab`**

Add the imports (`selectMatchingTickets`, `TicketSearchInput`) and the state next to the existing
`blockedOnly`:

```tsx
  // S7.3's blocked-only filter and this one are both local ephemeral view state — not
  // context, not the URL. See `TicketSearchInput` for why the query is not hoisted.
  const [query, setQuery] = useState('')
```

Change the `visibleTickets` line — **wrap the existing expression, do not add a branch**:

```tsx
  const visibleTickets = selectMatchingTickets(
    blockedOnly ? selectBlockedTickets(boardTickets) : boardTickets,
    query,
  )
```

Render the input beside the checkbox, INSIDE the existing `activeSprint !== null ?` fragment (that
gate is computed from the sprint, which no query can change, so it cannot strand the user):

```tsx
          <TicketSearchInput value={query} onChange={setQuery} />
```

Replace the column's empty paragraph:

```tsx
              {column.length === 0 ? (
                <BoardColumnEmpty blockedOnly={blockedOnly} query={query} />
              ) : (
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: PASS — the new block plus every pre-existing test in the file.

- [ ] **Step 6: Prove the complexity claim, then prove the composition**

First, measure and report the number:

```bash
npx eslint src/routes/BoardTab.tsx --rule '{"complexity":["error",1]}' 2>&1 | grep -i "BoardTab"
```

Expected: `BoardTab` still reports **10**. If it reports 11 or more, `npm run lint` is red — say so
and stop; do not add an eslint-disable.

Then confirm the trap is real, so the constraint is documented by evidence and not by assertion:
temporarily add `const filterActive = blockedOnly || query.trim() !== ''` to `BoardTab`'s body, re-run
the same command, and report the number it becomes. Remove it.

Finally, attempt to prove the totals test pins the composition: move the query filter from
`visibleTickets` into the per-column `.filter(...)` inside the `.map`, re-run, and report which
tests go red. Restore.

**Correction (SPRIN-68 final review):** this step's premise was wrong, and dispatch C's honest
negative plus two independent reviewers confirmed it — running the move above produces **zero**
red tests. Filtering commutes with splitting-by-status, so relocating the query filter into the
per-column `.filter` is behaviour-preserving; there is nothing for any test to catch, and expecting
red here was asking the mutation to prove something it structurally cannot. What the totals test
DOES pin, and the property actually worth guarding, is that the filtered cards and the column
totals never disagree — i.e. rendering filtered cards while still passing the *unfiltered* column
to `BoardColumnSummary`. That mutation IS caught, by this test and independently by the
pre-existing S7.3 recount test.

- [ ] **Step 7: Format, verify, commit**

```bash
npx prettier --write src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx
npm run lint
npm run build
git add src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx
git commit -m "Filter the board by key or summary (SPRIN-68)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `src/routes/BoardTab.tsx` (docblock only), `src/lib/board.ts` (docblock only)

- [ ] **Step 1: Update the two stale docblocks**

`BoardColumnSummary`'s docblock says "the blocked-only filter changes them" — now there are two
filters. `board.ts`'s `selectBlockedTickets` docblock describes itself as "the blocked-only board
filter" as though it is the only one. Update both to mention the search filter alongside, without
rewriting what they already say correctly.

Also check `BoardTab`'s own file-level docblock: it lists what the board does and does not mention
filtering by text. Add one sentence.

**Watch for the orphaned docblock** — this repo has been bitten three times by a comment
re-anchoring to the wrong symbol after an insertion. `BoardColumnEmpty` is being inserted near
`BoardColumnSummary`; confirm each docblock still sits directly above the function it describes.

- [ ] **Step 2: Verify and commit**

```bash
npx prettier --write src/routes/BoardTab.tsx src/lib/board.ts
npm run lint
git add src/routes/BoardTab.tsx src/lib/board.ts
git commit -m "Update board docblocks for the second filter (SPRIN-68)"
```

---

## What this plan does NOT do

Stated so an implementer does not helpfully add them:

- No debouncing. The list is in memory and already fetched.
- No "showing 3 of 12" count. Considered and declined in the spec.
- No match highlighting.
- No URL/localStorage persistence of the query (S7.3 set this precedent for `blockedOnly`).
- No live integration test. This story adds no query, no write and no RLS change, so a live test
  would re-cover an existing read and spend the auth-flake budget for nothing. Consequence: the
  test:unit ↔ full **gap stays constant**, which is correct, not a sign the live suites skipped.
- No E2E spec. `e2e.yml` is not the gate.

## Self-review

- **Spec coverage:** AC1 → Task 3. AC2 → Task 4 (both halves, incl. the totals test). AC3 → Task 4.
  AC4 → Tasks 1 and 3. AC5 → Tasks 3 and 4, plus the ordering/complexity mechanisms. AC6 → Task 1
  (the rule is a module) consumed by Tasks 3 and 4.
- **Placeholders:** none — every code step carries real code. The one `…` is an explicit
  "keep the existing markup byte-identical" instruction, not an omission.
- **Type consistency:** `selectMatchingTickets(readonly Ticket[], string): Ticket[]` is defined in
  Task 1 and called with that exact shape in Tasks 3 and 4. `TicketSearchInput({ value, onChange })`
  is defined in Task 2 and used with those exact props in Tasks 3 and 4.
