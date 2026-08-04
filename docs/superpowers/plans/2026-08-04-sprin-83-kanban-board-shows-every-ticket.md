# SPRIN-83 — The Kanban board shows every ticket: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Kanban project's board renders every one of its tickets in the right status
column, with both filters, no sprint chrome — and a Scrum board behaves exactly as it does
today.

**Architecture:** One new selector in `src/lib/board.ts` (`selectBoardScope`) answers "which
sprint, which tickets, are there filters" in one place, so `BoardTab` composes instead of
branching. The sprint caption becomes a small sibling component. One new labels function in
`src/lib/domain.ts` (`ticketListLabels`) gives the Backlog tab its Kanban wording without any
component reading `project_type`.

**Tech Stack:** React 19, TypeScript strict, Vite, Vitest + Testing Library, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-04-sprin-83-kanban-board-shows-every-ticket-design.md`

---

## Global Constraints

These apply to **every** task. They are not optional and several of them are enforced by tests
that will go red.

- **`npm run verify` is the gate** — `lint && format:check && build && test`. Never a
  hand-assembled subset. **`npx tsc --noEmit` checks ZERO files in this repo and exits 0** —
  it is not a typecheck, do not use it as one.
- **Run `npx prettier --write` on every file you touch** before committing, or
  `format:check` reddens CI.
- **Lint thresholds are errors, not warnings**: 30-line functions, cyclomatic 10, cognitive
  15, 4 parameters, 400-line files. Write to them from the first line. **Never** an inline
  `eslint-disable`.
- **NEVER write `project_type === …` or read `.project_type` outside `src/lib/domain.ts`.**
  `src/test/project-type-single-expression.test.ts` runs three text scans over all of `src/`
  and will fail the build. Use `hasSprints(project)`. Do not add a file to any allowlist.
  This also means **no lower-case `kanban` anywhere outside `domain.ts`, including in
  comments** — the concept is `Kanban`, the value is `kanban`, and the scan is
  case-sensitive.
- **Never use a Postgres ENUM** and do not touch the schema — this story has **no migration**.
- **Do not change `selectBacklogTickets`.** Its rule stays `sprint_id === null`.
- **Every absence assertion needs a positive control in the same test.** "The sprint caption
  is not in the document" passes just as well if the whole component failed to render.
- Imperative commit summaries. Commit at the end of each task.
- Do not run `npm run e2e` (needs a live browser and Supabase creds) and do not run
  `npm test` twice in quick succession — the live suites hit a real auth endpoint and will
  rate-limit. **Use `npm run test:unit` while iterating**; the final full `npm run verify` is
  run once, by the orchestrator, not by you.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/board.ts` | **Modify** — add `BoardScope` + `selectBoardScope`. Owns "what does this board show". | 1 |
| `src/lib/board.test.ts` | **Modify** — unit tests for the new selector. | 1 |
| `src/lib/domain.ts` | **Modify** — add `TicketListLabels` + `ticketListLabels`. Owns the wording. | 2 |
| `src/lib/domain.test.ts` | **Modify** — unit tests for the labels. | 2 |
| `src/routes/BoardTab.tsx` | **Modify** — add `BoardSprintCaption`; compose the scope. | 3 |
| `src/routes/BoardTab.test.tsx` | **Modify** — harness default + AC1/AC2/AC3/AC5 tests. | 3 |
| `src/routes/BacklogTab.tsx` | **Modify** — empty-state copy from `ticketListLabels`. | 4 |
| `src/routes/BacklogTab.test.tsx` | **Modify** — harness default + AC4 empty-state tests. | 4 |
| `src/routes/ProjectShellHeader.tsx` | **Modify** — nav link text from `ticketListLabels`. | 4 |
| `src/routes/ProjectShell.test.tsx` | **Modify** — AC4 nav link tests. | 4 |

---

### Task 1: `selectBoardScope` — what a board shows

**Files:**

- Modify: `src/lib/board.ts`
- Test: `src/lib/board.test.ts`

**Interfaces:**

- Consumes: `hasSprints`, `Project`, `Sprint`, `Ticket` from `./domain`; `selectSprintTickets`
  from `./backlog`; `selectActiveSprint` (already in this file).
- Produces:

```ts
export type BoardScope = {
  sprint: Sprint | null
  sprintScoped: boolean
  tickets: Ticket[]
  offersFilters: boolean
}

export function selectBoardScope(
  project: Pick<Project, 'project_type'>,
  tickets: readonly Ticket[],
  sprints: readonly Sprint[],
): BoardScope
```

**Note on imports:** `board.ts` currently imports only from `./domain`. Adding
`import { selectSprintTickets } from './backlog'` is correct and creates no cycle —
`backlog.ts` imports only `./domain`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/board.test.ts`. Note the existing `sprint()` and `ticket()` fixture
helpers at the top of that file — reuse them, do not write new ones. Add a `project()` helper
beside them.

```ts
/** A project with only the field the board rule reads. */
function project(project_type: 'scrum' | 'kanban'): Pick<Project, 'project_type'> {
  return { project_type }
}

describe('selectBoardScope', () => {
  const active = sprint({ id: 's-active', status: 'active' })
  const inSprint = ticket({ id: 't1', is_blocked: false, sprint_id: 's-active' })
  const unsprinted = ticket({ id: 't2', is_blocked: false, sprint_id: null })

  describe('a project with sprints (Scrum)', () => {
    it("shows the active sprint's tickets and describes that sprint", () => {
      const scope = selectBoardScope(project('scrum'), [inSprint, unsprinted], [active])
      expect(scope.sprintScoped).toBe(true)
      expect(scope.sprint?.id).toBe('s-active')
      expect(scope.tickets.map((t) => t.id)).toEqual(['t1'])
      expect(scope.offersFilters).toBe(true)
    })

    // The board has nothing to show and nothing to filter until a sprint starts. This is
    // today's behaviour and the whole of AC5's second half.
    it('shows no tickets and offers no filters when no sprint is active', () => {
      const future = sprint({ id: 's-future', status: 'future' })
      const scope = selectBoardScope(project('scrum'), [inSprint, unsprinted], [future])
      expect(scope.sprint).toBeNull()
      expect(scope.tickets).toEqual([])
      expect(scope.offersFilters).toBe(false)
    })
  })

  describe('a project without sprints (Kanban)', () => {
    // AC1. `inSprint` carries a real sprint id and MUST still appear: the whole defect this
    // story fixes is a board that filtered it away.
    it('shows every ticket regardless of sprint_id', () => {
      const scope = selectBoardScope(project('kanban'), [inSprint, unsprinted], [])
      expect(scope.sprintScoped).toBe(false)
      expect(scope.tickets.map((t) => t.id)).toEqual(['t1', 't2'])
    })

    // AC3. Filters are offered unconditionally — there is no sprint to wait for.
    it('offers filters even with no sprints at all', () => {
      expect(selectBoardScope(project('kanban'), [], []).offersFilters).toBe(true)
    })

    // AC2, at the selector. A board whose users cannot see sprints must not describe one.
    // Unreachable today (project_type is immutable, and SPRIN-82 removed the create path),
    // so this pins the rule rather than defending against a live state.
    it('describes no sprint even when an active sprint row exists', () => {
      const scope = selectBoardScope(project('kanban'), [inSprint], [active])
      expect(scope.sprint).toBeNull()
      expect(scope.tickets.map((t) => t.id)).toEqual(['t1'])
    })
  })

  // Filtering only: the order `listTickets` returned is the order the columns render in.
  it('preserves the given ticket order and copies rather than aliases', () => {
    const input = [unsprinted, inSprint]
    const scope = selectBoardScope(project('kanban'), input, [])
    expect(scope.tickets.map((t) => t.id)).toEqual(['t2', 't1'])
    expect(scope.tickets).not.toBe(input)
  })
})
```

Update the import lines at the top of the file:

```ts
import type { Project, Sprint, Ticket } from './domain'
import { selectActiveSprint, selectBlockedTickets, selectBoardScope, summariseColumn } from './board'
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/board.test.ts`
Expected: FAIL — `selectBoardScope is not a function` / a TypeScript error that it is not
exported. A failure for any *other* reason means the fixtures are wrong; fix that first.

- [ ] **Step 3: Implement**

Add to `src/lib/board.ts`. Put it **below** `selectActiveSprint` (which it uses) and above
`selectBlockedTickets`. Add `import { selectSprintTickets } from './backlog'` and widen the
type import to `import type { Project, Sprint, Ticket } from './domain'`, plus
`import { hasSprints } from './domain'`.

```ts
/**
 * Everything the board needs to know about what it is showing, in one answer: which sprint
 * it describes, which tickets it renders, and whether there is anything to filter.
 *
 * One function rather than three for the same reason `summariseColumn` returns three numbers
 * — the caller always reads them together, they derive from one question, and one function
 * is one place for the rule to change. Splitting them would let "which sprint" and "which
 * tickets" drift apart, which is precisely the defect SPRIN-83 fixed: the board asked one
 * question (is there an active sprint?) and used the answer for three different decisions.
 *
 * `sprintScoped` comes from `hasSprints` — the single expression of the rule (SPRIN-82 AC5).
 * This module may not compare the project type itself, and a test says so.
 *
 * A project WITHOUT sprints shows every ticket, whatever its `sprint_id`, and describes no
 * sprint even if a sprint row exists. The second half is unreachable today — the type is
 * immutable and there is no way to create a sprint on such a project — and stated anyway,
 * because a board whose users cannot see sprints must never caption itself with one.
 *
 * A project WITH sprints shows the active sprint's tickets and nothing before one starts:
 * `offersFilters` is false there, so a row of empty columns is not topped with controls that
 * can only narrow nothing to nothing. That is unchanged behaviour, kept deliberately.
 */
export function selectBoardScope(
  project: Pick<Project, 'project_type'>,
  tickets: readonly Ticket[],
  sprints: readonly Sprint[],
): BoardScope {
  const sprintScoped = hasSprints(project)
  if (!sprintScoped) {
    return { sprint: null, sprintScoped, tickets: [...tickets], offersFilters: true }
  }
  const sprint = selectActiveSprint(sprints)
  return {
    sprint,
    sprintScoped,
    tickets: sprint ? selectSprintTickets(tickets, sprint.id) : [],
    offersFilters: sprint !== null,
  }
}
```

With this type declared immediately above it:

```ts
/**
 * What a board is showing. Exported because it is the named return type of the public
 * `selectBoardScope` selector below — the same reason `ColumnSummary` is exported.
 */
export type BoardScope = {
  /** The sprint this board describes, or null: no active sprint, or no sprints at all. */
  sprint: Sprint | null
  /** Whether this board is sprint-scoped. False for a continuously-delivered project. */
  sprintScoped: boolean
  /** The tickets this board shows, in the order given. Filtered only, never sorted. */
  tickets: Ticket[]
  /** Whether the board has a ticket source, so filters are worth offering. */
  offersFilters: boolean
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/board.test.ts src/lib/backlog.test.ts`
Expected: PASS, and `backlog.test.ts` still green (nothing there changed).

- [ ] **Step 5: Lint and format**

```bash
npx eslint src/lib/board.ts src/lib/board.test.ts --max-warnings 0
npx prettier --write src/lib/board.ts src/lib/board.test.ts
```

Expected: no output from eslint.

- [ ] **Step 6: Commit**

```bash
git add src/lib/board.ts src/lib/board.test.ts
git commit -m "Add selectBoardScope for what a board shows (SPRIN-83)"
```

---

### Task 2: `ticketListLabels` — what the flat ticket list is called

**Files:**

- Modify: `src/lib/domain.ts`
- Test: `src/lib/domain.test.ts`

**Interfaces:**

- Consumes: `hasSprints`, `Project` (both already in this file).
- Produces:

```ts
export type TicketListLabels = { tab: string; empty: string }
export function ticketListLabels(project: Pick<Project, 'project_type'>): TicketListLabels
```

| | Scrum | Kanban |
|---|---|---|
| `tab` | `Backlog` | `All tickets` |
| `empty` | `Nothing in the backlog.` | `This project has no tickets.` |

**Why a function and not a `Record<ProjectType, …>` map like its neighbours:** a map has to be
indexed at the call site, and indexing it means a component reading `.project_type` — which
`src/test/project-type-single-expression.test.ts` forbids (it permits exactly one such read in
the whole tree, the header's `PROJECT_TYPE_LABELS` index, and asserts the count is 1). Taking
the project keeps the read inside `domain.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/domain.test.ts`, near the `hasSprints` describe block.

```ts
/**
 * The wording of the flat ticket-list tab lives in one place so the nav link and the tab's
 * own empty state cannot word the same thing two ways (SPRIN-83 AC4).
 */
describe('ticketListLabels', () => {
  it('calls it the backlog on a project with sprints', () => {
    expect(ticketListLabels({ project_type: 'scrum' })).toEqual({
      tab: 'Backlog',
      empty: 'Nothing in the backlog.',
    })
  })

  it('calls it all tickets on a project without sprints', () => {
    expect(ticketListLabels({ project_type: 'kanban' })).toEqual({
      tab: 'All tickets',
      empty: 'This project has no tickets.',
    })
  })

  // The control. A stub returning one object for every project passes both tests above only
  // if they are read in isolation; this one says the two types actually disagree, on BOTH
  // fields. Derived from PROJECT_TYPES so a third type cannot quietly share a neighbour's
  // wording.
  it('gives every project type a non-empty label, and the two types differ on both', () => {
    for (const type of PROJECT_TYPES) {
      const labels = ticketListLabels({ project_type: type })
      expect(labels.tab).toBeTruthy()
      expect(labels.empty).toBeTruthy()
    }
    const scrum = ticketListLabels({ project_type: 'scrum' })
    const kanban = ticketListLabels({ project_type: 'kanban' })
    expect(scrum.tab).not.toBe(kanban.tab)
    expect(scrum.empty).not.toBe(kanban.empty)
  })
})
```

Add `PROJECT_TYPES` and `ticketListLabels` to the existing import block at the top of
`domain.test.ts` (it already imports `PROJECT_TYPE_LABELS`, `hasSprints`, `type ProjectType`
and others — keep the list alphabetical as it currently is).

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/domain.test.ts`
Expected: FAIL — `ticketListLabels is not a function`.

- [ ] **Step 3: Implement**

Add to `src/lib/domain.ts`, immediately after `hasSprints` (it is the caller, and the two
belong together).

```ts
/** What the flat ticket-list tab is called, and what it says when it is empty. */
export type TicketListLabels = { tab: string; empty: string }

/**
 * The wording for the project's flat ticket list — the nav link and the tab's own empty
 * state — decided in one place so the two cannot drift.
 *
 * A project WITH sprints has a backlog in the Scrum sense: the tickets waiting outside a
 * sprint. A project WITHOUT sprints has no such distinction — `selectBacklogTickets`'
 * `sprint_id is null` rule is true of every one of its tickets — so the tab is an honest
 * flat list of everything and says so. The rule itself is unchanged; only the label is.
 *
 * A FUNCTION, not a `Record<ProjectType, …>` like the label maps above, and the reason is
 * structural rather than stylistic: a map must be indexed at the call site, and indexing it
 * means a component reading the project's type — which `project-type-single-expression.test.ts`
 * permits in exactly one place in the tree. Taking the project keeps the read in here, where
 * `hasSprints` already lives.
 *
 * The empty copy deliberately does NOT reuse `BoardColumnEmpty`'s "No tickets yet.": there
 * that sentence is a claim about a COLUMN, here it would be a claim about the PROJECT. Same
 * words, two scopes — and a distinct state must never wear another state's face.
 */
export function ticketListLabels(project: Pick<Project, 'project_type'>): TicketListLabels {
  return hasSprints(project)
    ? { tab: 'Backlog', empty: 'Nothing in the backlog.' }
    : { tab: 'All tickets', empty: 'This project has no tickets.' }
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and format**

```bash
npx eslint src/lib/domain.ts src/lib/domain.test.ts --max-warnings 0
npx prettier --write src/lib/domain.ts src/lib/domain.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/domain.ts src/lib/domain.test.ts
git commit -m "Add ticketListLabels for the flat ticket-list wording (SPRIN-83)"
```

---

### Task 3: `BoardTab` renders a Kanban board (AC1, AC2, AC3, AC5)

**Files:**

- Modify: `src/routes/BoardTab.tsx`
- Test: `src/routes/BoardTab.test.tsx`

**Interfaces:**

- Consumes: `selectBoardScope` from `@/lib/board` (Task 1).
- Produces: nothing other tasks depend on.

**READ THIS FIRST — the trap that makes this task look broken:**
`src/routes/BoardTab.test.tsx:61` builds its outlet context with **`project: {} as never`**.
`hasSprints({})` is `undefined === 'scrum'` → **false**, so the moment `BoardTab` starts
asking, every existing board test silently becomes a Kanban test and the sprint-scoped ones
fail. **That is not a bug in your implementation.** Fix the harness default in Step 1, before
anything else.

- [ ] **Step 1: Fix the harness default and run the suite unchanged**

In `src/routes/BoardTab.test.tsx`, change the `ctxWith` default (around line 61) from
`project: {} as never` to:

```ts
    // Explicitly Scrum, which is what every test in this file assumed while the board did
    // not ask. `hasSprints({})` is false, so an empty object would silently make the whole
    // file a Kanban suite the moment BoardTab consults the project (SPRIN-83). Stating it
    // also turns every sprint-scoped test below into AC5's positive control: they pass only
    // because this says 'scrum'.
    project: { project_type: 'scrum' } as never,
```

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: PASS — unchanged behaviour, since nothing reads `project` yet. If this goes red,
stop and report: something else already depends on the empty object.

- [ ] **Step 2: Write the failing tests**

Add a new `describe` block to `src/routes/BoardTab.test.tsx`. Put it after the existing
board describes. `KANBAN_CTX` deliberately gives one ticket a real `sprint_id` — that is the
ticket the old board filtered away.

```tsx
/**
 * SPRIN-83 — a project without sprints shows every ticket on its board.
 *
 * Before this story a Kanban board was permanently empty under a caption telling the user to
 * start a sprint from a tab SPRIN-82 had already removed. Each absence assertion below is
 * paired with a positive control in the same test, because "the caption is not in the
 * document" passes just as well when nothing rendered at all.
 */
describe('BoardTab on a project without sprints (SPRIN-83)', () => {
  // One unsprinted ticket and one still carrying a sprint id. AC1 is that BOTH appear.
  const KANBAN_TICKETS = [
    {
      id: 't1',
      key: 'MP-1',
      number: 1,
      summary: 'Do the todo',
      type: 'story',
      status: 'todo',
      sprint_id: null,
      is_blocked: false,
    },
    {
      id: 't2',
      key: 'MP-2',
      number: 2,
      summary: 'Ship it',
      type: 'bug',
      status: 'done',
      sprint_id: 's-old',
      is_blocked: true,
    },
  ] as never

  function kanbanCtx(fields: Partial<ProjectShellContext> = {}) {
    return ctxWith({
      project: { project_type: 'kanban' } as never,
      tickets: KANBAN_TICKETS,
      ...fields,
    })
  }

  // AC1.
  it('renders every ticket in its status column, including one with a sprint_id', () => {
    renderTab(BoardTab, kanbanCtx())
    const todo = screen.getByRole('heading', { name: 'To Do' }).closest('section')!
    const done = screen.getByRole('heading', { name: 'Done' }).closest('section')!
    expect(within(todo).getByRole('button', { name: /Do the todo/ })).toBeInTheDocument()
    expect(within(done).getByRole('button', { name: /Ship it/ })).toBeInTheDocument()
  })

  // AC2. The positive control is the card: the board really rendered, it just says nothing
  // about sprints.
  it('shows no sprint caption and no "No active sprint" message', () => {
    renderTab(BoardTab, kanbanCtx({ sprints: [ACTIVE_SPRINT] }))
    expect(screen.getByRole('button', { name: /Do the todo/ })).toBeInTheDocument()
    expect(screen.queryByText(/No active sprint/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Sprint 1')).not.toBeInTheDocument()
  })

  // AC3, and the non-obvious half of the story: both filters used to hang off the same
  // `activeSprint !== null` test as the caption, so removing the caption would have removed
  // them too.
  it('offers the blocked-only filter, and it narrows the board', async () => {
    const user = userEvent.setup()
    renderTab(BoardTab, kanbanCtx())
    const blockedOnly = screen.getByRole('checkbox', { name: /blocked only/i })
    expect(screen.getByRole('button', { name: /Do the todo/ })).toBeInTheDocument()
    await user.click(blockedOnly)
    expect(screen.getByRole('button', { name: /Ship it/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Do the todo/ })).not.toBeInTheDocument()
  })

  it('offers the search box, and it narrows the board', async () => {
    const user = userEvent.setup()
    renderTab(BoardTab, kanbanCtx())
    await user.type(screen.getByLabelText(/search tickets/i), 'Ship')
    expect(screen.getByRole('button', { name: /Ship it/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Do the todo/ })).not.toBeInTheDocument()
  })
})

/**
 * AC5 — the Scrum board is unchanged. The whole describe block above this one already
 * exercises that, because `ctxWith` now says 'scrum' explicitly. This test names the
 * distinction so a regression reads as "Scrum stopped being sprint-scoped" rather than as an
 * unrelated failure.
 */
describe('BoardTab on a project with sprints (SPRIN-83 AC5)', () => {
  it('still shows only the active sprint\'s tickets, and still captions them', () => {
    renderTab(
      BoardTab,
      ctxWith({ tickets: SPRINT_TICKETS, sprints: [ACTIVE_SPRINT] }),
    )
    expect(screen.getByText('Sprint 1')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Do the todo/ })).toBeInTheDocument()
  })

  it('still says so when no sprint is active, and offers no filters then', () => {
    renderTab(BoardTab, ctxWith({ tickets: SPRINT_TICKETS, sprints: [] }))
    expect(screen.getByText(/No active sprint/i)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /blocked only/i })).not.toBeInTheDocument()
    // The positive control: the columns rendered, so the absence above is about the filter.
    expect(screen.getByRole('heading', { name: 'To Do' })).toBeInTheDocument()
  })
})
```

**Before writing these, check the existing file** for the exact names of `ACTIVE_SPRINT` and
`SPRINT_TICKETS` (they are defined around line 95) and for how existing tests query the
search box and the blocked-only checkbox — reuse those queries verbatim rather than inventing
new ones. If `SPRINT_TICKETS` fixtures lack `is_blocked`, leave them as they are.

- [ ] **Step 3: Run the tests and confirm they fail for the right reason**

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: the four Kanban tests FAIL (empty board, caption present, no filters). The two AC5
tests PASS already — they describe today's behaviour, and that is the point of writing them
now.

- [ ] **Step 4: Implement**

In `src/routes/BoardTab.tsx`:

1. Change the imports — drop `selectSprintTickets` (`@/lib/backlog`) and `selectActiveSprint`,
   add `selectBoardScope`:

```ts
import { selectBlockedTickets, selectBoardScope, summariseColumn } from '@/lib/board'
```

   Add `import type { Sprint } from '@/lib/domain'` to the existing type import.

2. Add this component beside `BoardColumnEmpty`:

```tsx
/**
 * What the board says about the sprint it is showing — and on a project without sprints, that
 * is nothing at all.
 *
 * Three states, three returns, in its own component rather than as branches in `BoardTab`,
 * which is where this file already puts per-question rendering (`BoardColumnSummary`,
 * `BoardColumnEmpty`). Before SPRIN-83 the name/dates and the "No active sprint" message hung
 * off a single `activeSprint !== null` test that ALSO gated both filters — one test answering
 * three questions, which is exactly why a Kanban board could not be given cards without
 * losing its filters.
 */
function BoardSprintCaption({
  sprintScoped,
  sprint,
}: {
  sprintScoped: boolean
  sprint: Sprint | null
}) {
  if (!sprintScoped) return null
  if (sprint === null) {
    return (
      <p className="text-muted-foreground text-sm">
        No active sprint — start one from the Sprints tab.
      </p>
    )
  }
  return (
    <p className="flex flex-wrap items-baseline gap-2 text-sm">
      <span className="font-medium">{sprint.name}</span>
      <SprintDates sprint={sprint} />
    </p>
  )
}
```

3. In `BoardTab`, add `project` to the destructured outlet context, and replace the
   `activeSprint`/`boardTickets` block with:

```tsx
  const { sprint, sprintScoped, tickets: boardTickets, offersFilters } = selectBoardScope(
    project,
    tickets,
    sprints,
  )
  const visibleTickets = selectMatchingTickets(
    blockedOnly ? selectBlockedTickets(boardTickets) : boardTickets,
    query,
  )
```

4. Replace the two JSX branches (the `activeSprint === null` caption and the
   `activeSprint !== null` fragment) with:

```tsx
      <BoardSprintCaption sprintScoped={sprintScoped} sprint={sprint} />
      {moveError ? (
        <p role="alert" className="text-destructive text-sm">
          {moveError}
        </p>
      ) : null}
      {offersFilters ? (
        <>
          <label className="text-muted-foreground flex w-fit items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={blockedOnly}
              onChange={(e) => setBlockedOnly(e.target.checked)}
              className="size-4"
            />
            Blocked only
          </label>
          <TicketSearchInput value={query} onChange={setQuery} />
        </>
      ) : null}
```

5. Update `BoardTab`'s docblock: the "It renders the ACTIVE sprint's tickets (S7.1)" paragraph
   and the "No active sprint" paragraph both now describe only a sprint-scoped project. Say
   that `selectBoardScope` owns which tickets are shown, and that a project without sprints
   shows all of them with no caption. Keep the existing paragraphs about the three-read gate,
   the empty-statuses guard and the optimistic move — none of them changes.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run src/routes/BoardTab.test.tsx`
Expected: PASS, all of them — the pre-existing tests included.

- [ ] **Step 6: Measure the lint budget and format**

```bash
npx eslint src/routes/BoardTab.tsx --rule '{"complexity":["error",1]}'
npx eslint src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx --max-warnings 0
npx prettier --write src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx
```

Expected: `BoardTab` reports a complexity of **7** (down from 9 — two ternaries moved out).
`--max-warnings 0` reports nothing. **Report the measured number in your deviation notes**;
the epic design predicted 10, so a number other than 7 is worth flagging either way.

- [ ] **Step 7: Commit**

```bash
git add src/routes/BoardTab.tsx src/routes/BoardTab.test.tsx
git commit -m "Show every ticket on a board without sprints (SPRIN-83)"
```

---

### Task 4: The flat ticket list is labelled for its project type (AC4)

**Files:**

- Modify: `src/routes/ProjectShellHeader.tsx`
- Modify: `src/routes/BacklogTab.tsx`
- Test: `src/routes/ProjectShell.test.tsx`
- Test: `src/routes/BacklogTab.test.tsx`

**Interfaces:**

- Consumes: `ticketListLabels` from `@/lib/domain` (Task 2).
- Produces: nothing other tasks depend on.

**The same harness trap as Task 3:** `src/routes/BacklogTab.test.tsx:47` also has
`project: {} as never`. Fix it in Step 1.

- [ ] **Step 1: Fix the BacklogTab harness default and run it unchanged**

In `src/routes/BacklogTab.test.tsx`, change the `ctxWith` default (around line 47) to:

```ts
    // Explicitly Scrum — see the same note in `BoardTab.test.tsx`. `hasSprints({})` is false,
    // so an empty object would make this a Kanban suite the moment the tab consults the
    // project (SPRIN-83).
    project: { project_type: 'scrum' } as never,
```

Run: `npx vitest run src/routes/BacklogTab.test.tsx`
Expected: PASS, unchanged.

- [ ] **Step 2: Write the failing tests**

Add to `src/routes/BacklogTab.test.tsx`:

```tsx
/**
 * SPRIN-83 AC4 — on a project without sprints the tab is a flat list of every ticket, and
 * its empty state must say so. The two copies are a pair: a test that only asserted the
 * Kanban wording would pass just as well if the Scrum wording had been overwritten too.
 */
describe('the empty state names what the list is (SPRIN-83 AC4)', () => {
  it('speaks of the backlog on a project with sprints', () => {
    renderTab(BacklogTab, ctxWith({ tickets: [] as never }))
    expect(screen.getByText('Nothing in the backlog.')).toBeInTheDocument()
  })

  it('speaks of the project on a project without sprints', () => {
    renderTab(
      BacklogTab,
      ctxWith({ tickets: [] as never, project: { project_type: 'kanban' } as never }),
    )
    expect(screen.getByText('This project has no tickets.')).toBeInTheDocument()
    expect(screen.queryByText('Nothing in the backlog.')).not.toBeInTheDocument()
  })

  // AC4's second half: the rule `sprint_id is null` is unchanged, and on this project type it
  // is true of every ticket — so the list really is everything.
  it('lists the project\'s tickets on a project without sprints', () => {
    renderTab(BacklogTab, ctxWith({ project: { project_type: 'kanban' } as never }))
    expect(screen.getByRole('button', { name: /Do the todo/ })).toBeInTheDocument()
  })
})
```

Add to `src/routes/ProjectShell.test.tsx`, in the same area as the existing SPRIN-82 nav
tests (around line 330). Reuse the existing Scrum/Kanban project fixtures at lines 100 and
105 and whatever render helper those tests use — read them first rather than inventing a
harness.

```tsx
  // SPRIN-83 AC4. Each assertion is paired with the Board link as a positive control: a
  // header that failed to render at all would otherwise satisfy the absence half.
  it('names the ticket-list tab "Backlog" on a project with sprints (SPRIN-83 AC4)', () => {
    // …render with the SCRUM project fixture…
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Backlog' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'All tickets' })).not.toBeInTheDocument()
  })

  it('names it "All tickets" on a project without sprints (SPRIN-83 AC4)', () => {
    // …render with the KANBAN project fixture…
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'All tickets' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Backlog' })).not.toBeInTheDocument()
  })
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `npx vitest run src/routes/BacklogTab.test.tsx src/routes/ProjectShell.test.tsx`
Expected: the Kanban-wording tests FAIL (the link still reads "Backlog", the empty state still
reads "Nothing in the backlog."). The Scrum ones PASS already.

- [ ] **Step 4: Implement**

In `src/routes/ProjectShellHeader.tsx` — add `ticketListLabels` to the existing
`@/lib/domain` import, then above the `return`:

```tsx
  // The nav link and the tab's own empty state must word this the same way, so the wording
  // is decided once in `domain.ts` rather than twice here (SPRIN-83 AC4). `hasSprints` is
  // still what the Sprints link asks — this reads the label, not the rule.
  const listLabels = ticketListLabels(project)
```

and change the Backlog `NavLink`'s text to `{listLabels.tab}`. Note the route path stays
`backlog` — **only the text changes**.

In `src/routes/BacklogTab.tsx` — add `ticketListLabels` to the existing `@/lib/domain`
import, pull `project` out of the outlet context, and replace the hard-coded
`Nothing in the backlog.` with `{ticketListLabels(project).empty}`. Update the surrounding
comment: it currently says the sentence covers "no tickets at all" and "every ticket is in a
sprint" — on a project without sprints only the first can be true, which is why the wording
changes rather than the rule.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `npx vitest run src/routes/BacklogTab.test.tsx src/routes/ProjectShell.test.tsx`
Expected: PASS.

- [ ] **Step 6: Lint and format**

```bash
npx eslint src/routes/ProjectShellHeader.tsx src/routes/BacklogTab.tsx src/routes/BacklogTab.test.tsx src/routes/ProjectShell.test.tsx --max-warnings 0
npx prettier --write src/routes/ProjectShellHeader.tsx src/routes/BacklogTab.tsx src/routes/BacklogTab.test.tsx src/routes/ProjectShell.test.tsx
```

- [ ] **Step 7: Run the project-type guard, which is the one most likely to have caught you**

```bash
npx vitest run src/test/project-type-single-expression.test.ts
```

Expected: PASS. If it fails naming one of your files, you compared or read the project type
somewhere instead of calling `hasSprints` / `ticketListLabels`. Fix the call site — **do not**
widen the guard.

- [ ] **Step 8: Commit**

```bash
git add src/routes/ProjectShellHeader.tsx src/routes/BacklogTab.tsx src/routes/BacklogTab.test.tsx src/routes/ProjectShell.test.tsx
git commit -m "Label the ticket list for its project type (SPRIN-83)"
```

---

## Self-review

**Spec coverage.** AC1 → Task 1 (selector) + Task 3 (render). AC2 → Task 1 (`sprint: null`) +
Task 3 (`BoardSprintCaption`). AC3 → Task 1 (`offersFilters`) + Task 3. AC4 → Task 2 (labels)
+ Task 4 (both call sites). AC5 → Task 3's explicit Scrum harness plus its own describe block,
and Task 1's Scrum selector tests. The spec's "harness trap" section → Task 3 Step 1 and Task 4
Step 1. The spec's "`selectBacklogTickets` is NOT changed" → stated in the global constraints.

**Type consistency.** `selectBoardScope(project, tickets, sprints)` and the `BoardScope`
field names (`sprint`, `sprintScoped`, `tickets`, `offersFilters`) are spelled identically in
Tasks 1 and 3. `ticketListLabels(project) → { tab, empty }` is spelled identically in Tasks 2
and 4.

**Placeholders.** The two `// …render with the … fixture…` lines in Task 4 Step 2 are
deliberate: `ProjectShell.test.tsx` is 1451 lines with an established render helper and two
project fixtures already in it, and prescribing a call I have not read would be a plan-code
invention rather than a plan. The instruction is explicit about which fixtures to reuse and
where they are.
