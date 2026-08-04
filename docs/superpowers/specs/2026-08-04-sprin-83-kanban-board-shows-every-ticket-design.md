# SPRIN-83 — The Kanban board shows every ticket

Story 3 of epic SPRIN-73 (Kanban project type). Depends on SPRIN-81 (`project_type` is
`'scrum' | 'kanban'`) and SPRIN-82 (`hasSprints(project)` is the single expression of the
rule). Epic design: `docs/superpowers/specs/2026-08-03-sprin-73-kanban-project-type-design.md`.

**No migration.** Nothing in this story touches the schema, a policy, a grant or the CI gate.

## The problem, verified in a browser before designing

A Kanban project's board is permanently empty. `BoardTab` selects the active sprint's
tickets, SPRIN-82 removed the Sprints tab from Kanban projects, and the empty board's caption
tells the user to "start one from the Sprints tab" — a tab that no longer exists for them.
Measured live on 2026-08-04 against a seeded Kanban project (`PLAT`, three tickets): three
tickets in the database, four empty columns on screen, and the only instruction on the page
points at a route that redirects away. That is AC1 and AC2 in one screenshot.

## Acceptance criteria

1. A Kanban board renders every ticket in its status column, regardless of `sprint_id`.
2. No sprint caption and no "No active sprint" message on a Kanban board.
3. Both filters (blocked-only and search) are available on a Kanban board.
4. The Backlog nav link reads "All tickets" on a Kanban project and "Backlog" on a Scrum
   one, and on Kanban the tab lists every ticket.
5. A Scrum board is unchanged: still sprint-scoped, still captioned.

## The shape of the change

### 1. One selector owns what a board shows — `selectBoardScope` in `src/lib/board.ts`

CLAUDE.md forbids inlining domain rules in components, and "which tickets does this board
show" is the board's central rule — the one this story changes. It moves into `board.ts`
whole, rather than becoming three ternaries in `BoardTab`:

```ts
export type BoardScope = {
  /** The sprint this board describes: the active one, or null — no active sprint, or a
   *  project that has no sprints at all. */
  sprint: Sprint | null
  /** Whether this board is sprint-scoped. False for Kanban. */
  sprintScoped: boolean
  /** The tickets this board shows, in the order given. */
  tickets: Ticket[]
  /** Whether the board has a ticket source at all, so filters are worth offering. */
  offersFilters: boolean
}

export function selectBoardScope(
  project: Pick<Project, 'project_type'>,
  tickets: readonly Ticket[],
  sprints: readonly Sprint[],
): BoardScope
```

Four values, one function, for the same reason `summariseColumn` returns three: they are
always read together by the same caller, they derive from one question, and one function is
one mutation target. Splitting them would let "which sprint" and "which tickets" drift.

`sprintScoped` comes from `hasSprints(project)` — never a comparison written here. SPRIN-82's
three-scan guard (`src/test/project-type-single-expression.test.ts`) makes that mechanical
rather than a matter of discipline: `board.ts` may not read `.project_type` at all.

**`sprint` is null for Kanban even if a sprint row somehow existed.** The board must not
describe a sprint on a project whose users cannot see sprints. Today that is unreachable —
`project_type` is immutable and SPRIN-82 removed the create path — so this is a rule stated
where it can be tested, not a defence against a live state.

**`offersFilters` is the separation the epic design demanded**: "is there a sprint to
describe" (`sprint`) and "are there filters to offer" (`offersFilters`) stop being the same
test. Kanban always offers filters; a Scrum board offers them only once a sprint is active,
which is exactly today's behaviour and the whole of AC5's second half. Left alone, a Kanban
board would render cards with no filters at all — the epic design named this as the
non-obvious part, and it is the one place a lazy implementation ships green and wrong.

### 2. The caption becomes its own component — `BoardSprintCaption`

`BoardTab` currently answers three questions with one `activeSprint !== null` test spread
across two JSX branches. The caption — sprint name and dates, or "No active sprint", or
nothing at all on Kanban — moves into a small component beside `BoardColumnSummary` and
`BoardColumnEmpty`, which is where this file already puts per-question rendering:

```tsx
function BoardSprintCaption({ sprintScoped, sprint }: { sprintScoped: boolean; sprint: Sprint | null })
```

Three states, three returns. `null` for a Kanban board is AC2.

### 3. `BoardTab` composes, and gets cheaper

```tsx
const { sprint, sprintScoped, tickets: boardTickets, offersFilters } =
  selectBoardScope(project, tickets, sprints)
```

The two ternaries that leave (`activeSprint ? selectSprintTickets(…) : []` and the caption
test) are not replaced. **Measured, not assumed:** `BoardTab` is at 9/10 cyclomatic on
`361f6ec` and this change takes it to **7/10** — the epic design predicted 10/10 and it was
wrong in the safe direction. Re-measure rather than trust this line:

```
npx eslint src/routes/BoardTab.tsx --rule '{"complexity":["error",1]}'
```

That does **not** license SPRIN-86 to add branches here. The epic's instruction — over-limit
rendering lives in `BoardColumnSummary` and arrives as a prop — stays right on its own merits:
it is the correct home for a per-column concern, whatever the budget says.

### 4. The tab's wording — `ticketListLabels` in `domain.ts`

AC4 needs the same wording decision in two components (the nav link in `ProjectShellHeader`,
the empty state in `BacklogTab`). Display names live in `domain.ts` and nowhere else, so:

```ts
export type TicketListLabels = { tab: string; empty: string }
export function ticketListLabels(project: Pick<Project, 'project_type'>): TicketListLabels
```

| | Scrum | Kanban |
|---|---|---|
| `tab` | `Backlog` | `All tickets` |
| `empty` | `Nothing in the backlog.` | `This project has no tickets.` |

**A function, not a `Record<ProjectType, …>` map**, and the constraint that forces it is worth
recording: a map would have to be indexed by `project.project_type` at the call site, and the
read scan in `project-type-single-expression.test.ts` permits exactly one `.project_type` read
outside `domain.ts` — the header's `PROJECT_TYPE_LABELS` index — and asserts the count is 1. A
function taking the project keeps the read inside `domain.ts` where the rule lives. The guard
shaped the design rather than being worked around, which is what a good guard does.

**Why the Kanban empty copy is not "No tickets yet."** That sentence already exists in
`BoardColumnEmpty`, where it is a claim about a *column*. Here it would be a claim about the
*project*. Same words, two scopes, and this codebase has a standing rule against a distinct
state wearing another state's face. "This project has no tickets." cannot be misread.

### 5. `selectBacklogTickets` is NOT changed — but the tab no longer calls it directly

The backlog rule stays `sprint_id is null`, untouched. On a Kanban project that is true of
every ticket, so the tab is an honest flat list beside the column view. The route path stays
`backlog` — the link text changes, not the URL, so no redirect and no router change.

**Review found the asymmetry that leaves, and it is fixed with a sibling selector rather than
by touching the rule.** `selectBoardScope` deliberately ignores `sprint_id` on a Kanban project
and says so in its own docblock; `selectBacklogTickets` cannot, because the backlog rule is
shared with the Scrum board, the sprint planner and `tickets_sprint_idx`. So a Kanban ticket
carrying a `sprint_id` would be **shown by the board and hidden by the list**, under a nav link
reading "All tickets" — two tabs disagreeing about the same ticket. `BoardTab.test.tsx`'s own
fixture holds exactly that ticket and asserts it renders, so the two suites were pinning
contradictory behaviour and both were green.

```ts
export function selectTicketList(
  project: Pick<Project, 'project_type'>,
  tickets: readonly Ticket[],
): Ticket[]
```

`BacklogTab` calls this instead. Two rules, two functions, one caller: `selectBacklogTickets`
still answers "what is in the backlog", and `selectTicketList` answers "which question does
this tab ask". Same shape as the caption decision in §2 — the component composes, it does not
decide.

The divergent state is unreachable today for the same two reasons `selectBoardScope`'s half is
(the type is immutable; SPRIN-82 removed the sprint-create path), and is defended anyway for the
same reason: an asymmetric defence is worse than either choice made consistently, and a rule
stated in only one of the two places it governs is how the next reader learns the wrong one.

## The trap that would have shipped this green and wrong

Both component test harnesses build their context with **`project: {} as never`**
(`BoardTab.test.tsx:61`, `BacklogTab.test.tsx:47`). `hasSprints({})` is
`undefined === 'scrum'` → `false`, so the moment `BoardTab` starts asking, **every existing
board test silently becomes a Kanban test** — and the sprint-scoping tests would fail for a
reason that looks like a bug in the feature.

Both harnesses take an explicit `project: { project_type: 'scrum' }` default. That is not
bookkeeping: it turns all ~40 existing board tests into AC5's positive control, and every new
Kanban test overrides the one field it is actually varying.

## Testing

Written from the ACs before implementation. Every absence assertion carries a positive control
in the same test — SPRIN-82's testing note, and the likeliest way this epic ships broken and
green.

**`src/lib/board.test.ts`** — `selectBoardScope` directly: Kanban returns every ticket
including one carrying a `sprint_id`, `sprint: null`, `offersFilters: true`; Scrum with an
active sprint returns that sprint's tickets only; Scrum with no active sprint returns `[]` and
`offersFilters: false`; Kanban with a stray active sprint row still reports `sprint: null`.

**`src/lib/domain.test.ts`** — `ticketListLabels` for both types; both fields non-empty; the
two types disagree on both fields (a stub returning one object for everything is the failure
this catches).

**`src/routes/BoardTab.test.tsx`** — AC1: a Kanban board renders a ticket whose `sprint_id` is
a real sprint id, in its status column. AC2: no "No active sprint" text and no sprint name,
paired with a positive control that the columns *did* render. AC3: both filters present, and
each one actually narrows the cards. AC5: the existing sprint-scoped suite, now explicitly
Scrum.

**`src/routes/BacklogTab.test.tsx`** — AC4: a Kanban project's empty state reads "This project
has no tickets."; a Scrum project's reads "Nothing in the backlog."

**`src/routes/ProjectShell.test.tsx`** — AC4: the nav link reads "All tickets" for Kanban and
"Backlog" for Scrum, each paired with the Board link as a positive control (a header that
failed to render entirely would otherwise pass an absence assertion).

## Decisions made without asking

Recorded so they can be vetoed. None touches the schema, a security boundary, locked scope, or
an AC that could not be implemented as written — the four cases that would have stopped work.

1. **One `selectBoardScope` rather than three selectors.** They are read together and derive
   from one question; `summariseColumn` is the precedent.
2. **`offersFilters` lives in `board.ts`, not in the component.** It is a rule about what the
   board is showing, and the epic design explicitly asked for it to be separated from the
   caption test.
3. **Kanban's `sprint` is forced to null** rather than left to `selectActiveSprint`.
4. **"This project has no tickets."** rather than reusing the column's "No tickets yet.".
5. **`ticketListLabels` returns both strings together** so the tab name and the empty state
   cannot drift apart.
6. **The harness default is Scrum**, making the existing suite AC5's control.
