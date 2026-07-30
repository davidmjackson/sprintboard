# SPRIN-65 — Sprint progress on the board

**Date:** 2026-07-30
**Epic:** E7 Board (SPRIN-7)
**Jira:** [SPRIN-65](https://david-jackson.atlassian.net/browse/SPRIN-65)

## Why

The board renders the active sprint's cards and then tells you almost nothing about them. It
never names the sprint it is showing, never shows an estimate, and offers no sense of how the
sprint is distributed across the four columns. The backlog row has carried a story-points badge
since S5.1; the board has not. On a tool whose whole claim is "a credible Jira-style Scrum
board", the board is the screen that most needs to read as Scrum, and it currently reads as a
generic four-column kanban.

Everything here is a **pure read over data already in `ProjectShellContext`**. No schema change,
no new query, no new write path, no parked feature. That is deliberate: it is the highest
product value available for the lowest risk surface.

## Scope

Three pieces of Jira Scrum-board furniture:

1. A story-points badge on each board card.
2. A count and points total in each of the four column headings.
3. A caption naming the active sprint and its dates.

**Explicitly not in scope (YAGNI):** burndown, days-remaining countdown, sprint goal display,
status-category rollup pills, velocity, persisting the filter, or any change to what the board
loads. None of these are needed to close the gap the story names, and each would widen the diff
into territory the ACs do not cover.

## Acceptance criteria

| AC | Statement |
|---|---|
| AC1 | A board card shows its story points when the ticket is estimated, **including 0**, and shows no badge when `story_points` is `null`. The number carries screen-reader text giving its unit. |
| AC2 | When a sprint is active, the board shows a caption naming that sprint and its date range. The existing "No active sprint" caption is unchanged. |
| AC3 | Each of the four fixed column headings shows the number of cards in that column and the sum of their story points. Column labels still come from `src/lib/domain.ts`. |
| AC4 | Counts and totals reflect the cards actually visible, so they follow the blocked-only filter. |
| AC5 | Unestimated tickets contribute 0 to a column total, and a column containing any unestimated ticket says so. |
| AC6 | The summing and counting rules are named, unit-tested selectors in `src/lib`, never inlined in a component. |

## The hard constraint this design is built around

`BoardTab` is **already at cyclomatic complexity exactly 10**, which is the T2 limit. Measured,
not assumed:

```
$ npx eslint src/routes/BoardTab.tsx --rule 'complexity: ["error", 1]'
  33:8  error  Function 'BoardTab' has a complexity of 10. Maximum allowed is 1
```

Cognitive complexity is 8 of 15, so that is not binding. **One added branch inside the
`BoardTab` function body reddens `npm run lint`, and therefore CI.** CLAUDE.md names this
exact situation ("six functions sit at exactly cyclomatic 10, so one added branch reddens the
gate: that is it working"), so the answer is to add no branch to `BoardTab`, not to widen the
threshold — widening it is an ADR, and there is no misfit here to justify one.

Two consequences drive the whole structure below:

- **The sprint caption goes inside the existing `activeSprint !== null` block**, joining the
  blocked-only checkbox rather than adding a second conditional. Net new branches in
  `BoardTab`: zero.
- **The column summary is its own component function**, so its "hide when the column is empty"
  and "mention unestimated tickets" conditionals count against *its* budget, not `BoardTab`'s.
  Rendering it unconditionally from the `.map` callback adds no branch there either.

`TicketCard` measures 2 of 10 and `SprintDates` 5 of 10, so neither has a headroom problem.

## Design decisions

### D1 — One aggregate selector, in `board.ts`, returning all three numbers

`src/lib/board.ts` already owns the board's rules (`selectActiveSprint`, `selectBlockedTickets`)
and CLAUDE.md requires board rules to live there rather than be inlined in a component. The new
rule joins it; no new module, and `board.ts` stays around 60 lines.

```ts
export type ColumnSummary = { count: number; points: number; unestimated: number }
export function summariseColumn(tickets: readonly Ticket[]): ColumnSummary
```

**Why one function returning three fields rather than three functions.** The three numbers are
read together, always, by the same caller, and they are three views of one pass over one list.
Splitting them would mean three iterations, three test files' worth of setup, and a component
doing arithmetic assembly — which is the thing AC6 exists to prevent. A single call site per
column is also a single mutation target: change the `?? 0` and exactly one selector test should
go red.

`points` sums `story_points ?? 0`. `unestimated` counts `story_points == null`. Both use
`!= null` / `== null`, **never a falsy check** — `0` is a real estimate on a Scrum board, not
"unestimated", and treating it as absent is the exact defect S5.1 already guarded against in the
backlog row.

### D2 — The summary follows the visible set (AC4)

It is computed from `column`, the per-status array that has already had the blocked-only filter
applied. This is free — no extra plumbing — and it is the honest choice: a total that disagreed
with the cards under it would be a distinct state wearing another state's face, which is the
failure mode this codebase has repeatedly designed against (S4.6's `[]`-means-two-things rule,
S6.2's false zero). Jira behaves the same way: filtering a board updates its column counts.

The alternative — always total the whole sprint regardless of filter — was rejected. It answers
a question ("how big is the sprint") that the user did not ask by ticking a filter, and it makes
the two numbers on screen contradict each other.

### D3 — An empty column shows no summary

The column already says "No tickets yet." Rendering "0 · 0 pts" beside it is duplicate
information in the tightest space on the screen. The rule is a single `count === 0` early return
inside the summary component.

### D4 — The unestimated marker is spelled out, not a glyph

`· 2 unestimated` rather than a `?` badge or a `title` tooltip. A glyph needs a legend nobody
reads. A `title` is pointer-only and this project already carries that as an accepted a11y debt
on `BlockedBadge` — adding a second instance would deepen a debt rather than pay it. Spelled-out
text is also real DOM text, so the assertion and its positive control are both trivially
available in jsdom.

It renders only when `unestimated > 0`, so the common case stays quiet.

### D5 — The card badge mirrors the backlog row exactly

Same markup, same `!= null` guard, same `sr-only` unit text:

```tsx
{ticket.story_points != null ? (
  <span className="…tabular-nums">
    {ticket.story_points}
    <span className="sr-only"> story points</span>
  </span>
) : null}
```

`sr-only` text rather than `aria-label` for the reason recorded in S5.1: a `<span>` maps to
`role="generic"`, on which ARIA 1.2 *prohibits* `aria-label`. Browsers honour it, so it looks
fine and axe-core flags it as serious. The card is a `<button>`, so the text joins its
accessible name — and, as a bonus, a negative assertion ("this card has no points") gets a real
positive control from a sibling test.

**Placement: the existing top-row right-hand group, after the type badge.** Jira puts the
estimate bottom-right, but that would mean restructuring the card's layout for a cosmetic
match; the existing flex group already holds the blocked marker and the type badge, and the
backlog row likewise places points before the trailing cell. Consistency with our own card wins
over pixel-parity with Jira's.

### D6 — `SprintDates` is extracted, not duplicated

The caption needs the sprint's date range, and the exact rules for rendering it — "No dates set"
when both are absent, `—` for one missing end, UTC-sliced ISO via `formatSprintDate` — already
exist as a local component inside `SprintsTab.tsx`. Duplicating those three rules into `BoardTab`
would create two places for a timezone decision that took a whole spec to get right.

So `SprintDates` moves to `src/routes/SprintDates.tsx` and both tabs import it. This is the
targeted improvement to code the story is already working in, not an unrelated refactor: it is
required by AC2, and it is the smaller diff of the two options.

`SprintsTab.test.tsx` must stay green **without being edited**. That is the whole proof the
extraction was behaviour-preserving, so the plan forbids touching it.

**The trap to check on the way out:** this repo has been bitten three times by an orphaned
docblock — deleting a top-level symbol silently re-anchors the comment above it to whatever now
follows. Here `SprintDates` sits *above* `SprintsTab`'s file docblock rather than below it, so
removing it should be safe; the implementer must confirm that by reading the result rather than
assuming it.

### D7 — Where the new component is placed in the file

`BoardColumnSummary` is a **local component in `BoardTab.tsx`**, not a new file: only `BoardTab`
uses it, and `SprintsTab` held `SprintDates` locally on exactly that logic until this story gave
it a second consumer.

It is placed **above `BoardTab`'s docblock**, between the imports and that comment. Placing it
below the docblock would insert a symbol between the comment and the function it describes —
the D6 trap, in the other direction, and the precise shape of the S4.6 defect where `FAILURE_COPY`
landed between `LoadFailure`'s docblock and its function.

## Components and data flow

```
ProjectShellContext { tickets, sprints, … }
        │
        ▼
   BoardTab
        ├─ selectActiveSprint(sprints) ────────────► activeSprint
        │        └─ caption: <SprintDates sprint={activeSprint}/>   (AC2, inside the
        │                                                            existing branch)
        ├─ selectSprintTickets(tickets, id) ───────► boardTickets
        ├─ selectBlockedTickets(…) if blockedOnly ─► visibleTickets   (AC4)
        └─ per status: column = visibleTickets.filter(…)
                 ├─ <BoardColumnSummary tickets={column}/>
                 │        └─ summariseColumn(column) → {count, points, unestimated}
                 └─ <TicketCard/> × n
                          └─ points badge   (AC1)
```

## Error handling

Nothing new. Every value is derived from already-loaded, already-validated state; there is no
new fetch, no new write, and therefore no new failure mode. The existing three-state gates
(`ticketsPhase` / `sprintsPhase` `'failed'` → `LoadFailure`, `'loading'` → "Loading…") run
*before* any of this renders, so a count is never computed from the `[]` that both non-loaded
phases produce. That ordering is load-bearing and must not be disturbed: it is what stops a
confident "0 · 0 pts" being drawn for a list we do not have.

## Testing

| Level | File | What it pins |
|---|---|---|
| Unit | `src/lib/board.test.ts` | `summariseColumn`: empty list; all estimated; mixed with nulls; a **0-point ticket counts as estimated and contributes 0**; unestimated tally. |
| Component | `src/routes/TicketCard.test.tsx` | Badge for 5; badge for **0**; no badge for `null`, with a sibling positive control proving the sr-only text exists to be missing. |
| Component | `src/routes/BoardTab.test.tsx` | Caption names the sprint and its dates; headings show count and points; **totals change when the blocked-only filter is ticked** (AC4); empty column shows no summary; "unestimated" appears only when one is present. |
| Regression | `src/routes/SprintsTab.test.tsx` | **Unedited.** Green proves the `SprintDates` extraction preserved behaviour. |

**No live integration test, deliberately.** This story reads only columns already selected and
covered (`story_points`, `name`, `start_date`, `end_date`) and adds no query, write, or RLS
change. A live test here would re-cover an existing read and spend the auth-rate-limit budget for
nothing. The consequence for the tripwire is recorded so it is not misread later: a client-only
story raises the `npm test` and `test:unit` file counts **by the same amount**, so the
live-suite GAP stays at **7**. A constant gap after this story is correct, not evidence the live
suites skipped.

## Verification

- `npm run verify` in full, run by the controller, not a subagent.
- `npx eslint src/routes/BoardTab.tsx --rule 'complexity: ["error", 1]'` must still report
  **10**, not 11 — the direct check on the constraint this design is built around.
- `npx vitest list --filesOnly | wc -l` versus the `test:unit` count: GAP must be 7.
