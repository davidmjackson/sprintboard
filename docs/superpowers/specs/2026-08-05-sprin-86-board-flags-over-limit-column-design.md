# SPRIN-86 — The board flags an over-limit column

Story 6 of 6 in epic **SPRIN-73** (Kanban project type), and the last. Depends on
SPRIN-83 (the board renders every ticket on a project without sprints) and SPRIN-85
(the `wip_limit` column, its grant, and `hasWipLimits`).

Epic design: `docs/superpowers/specs/2026-08-03-sprin-73-kanban-project-type-design.md`
(§2.2 is the soft-limit rationale). SPRIN-85's spec is
`docs/superpowers/specs/2026-08-05-sprin-85-wip-limit-per-status-design.md`. This spec
does not restate either; it records what was **measured**, what was **decided here**,
and why.

**No migration.** `wip_limit` already exists, is already writable from Settings, and is
inert until this story renders it.

---

## 1. What ships

A Kanban column whose status carries a WIP limit gains one more `·`-separated segment in
its summary line, under the column heading:

```
under:  2 cards · 3 points · limit 3
at:     3 cards · 8 points · limit 3
over:   5 cards · 8 points · over limit 3
no limit / Scrum / filtered:   5 cards · 8 points        (exactly today's line)
```

The over state additionally renders the summary span in `text-destructive` rather than
`text-muted-foreground`. **That colour is reinforcement and never the carrier** — AC2 is
satisfied by the word `over`, and the test that pins AC2 asserts the text, not the class.

Nothing else changes. No migration, no new write path, no new domain constant, no change
to `summariseColumn`'s arithmetic.

---

## 2. THE LIMIT IS SOFT — it warns, it never blocks

Dragging a card into a column already at or over its limit **succeeds and persists**.
Nothing in this story refuses a move; there is no confirmation, no disabled drop target,
no rollback.

The reasons are §2.2 of the epic design and are not relitigated here: a WIP limit is a
signal to the team rather than a lock (and is what Jira does); enforcing it at both edges
would need a trigger on `tickets` counting sibling rows in the target column — the exact
shape that broke the cascade in SPRIN-80 ([[row-trigger-counting-siblings-breaks-cascade]])
— and a hard limit strands work, because lowering a limit below a column's occupancy
would leave that column permanently unaddable with no in-app way out.

**AC3's test exists so that "improving" this into a block goes RED rather than shipping.**
It is the most important test in the story. See §6.

---

## 3. What was measured, not recalled

Read on 2026-08-05, before any code was written.

### 3.1 Complexity — the Jira issue's number is stale

`npx eslint src/routes/BoardTab.tsx src/lib/board.ts --rule '{"complexity":["error",1]}'`:

| function | cyclomatic | limit |
|---|---|---|
| `BoardTab` | **7** | 10 |
| `BoardColumnSummary` | 4 | 10 |
| `BoardColumnEmpty` | 3 | 10 |
| `BoardSprintCaption` | 3 | 10 |
| `moveTicket` | 5 | 10 |
| `summariseColumn` | 3 | 10 |
| `selectBoardScope` | 3 | 10 |

**The Jira issue says `BoardTab` is at 10/10 after SPRIN-83. It is not — it is at 7.**
The issue was written on 2026-08-03 from `BoardColumnSummary`'s docblock, which recorded
the pre-SPRIN-76 state; SPRIN-76's `firstUnready` refactor and SPRIN-83's two extractions
bought four branches back, and `BoardTab.tsx`'s own docblock already says 7. Re-measured
here rather than trusted, per the instruction in the issue itself.

So there **is** margin in `BoardTab`, and the design below does not need to avoid it out
of necessity. It avoids it anyway, because the issue's instruction is right for the
reason `BoardColumnSummary` exists at all: per-question rendering is what that component
is for, and spending margin to inline it would buy nothing.

### 3.2 Line budget

`max-lines` with the repo's T5 semantics (`skipBlankLines`, `skipComments`), against 400:

| file | counted | headroom |
|---|---|---|
| `src/routes/BoardTab.tsx` | 194 | 206 |
| `src/lib/board.ts` | 42 | 358 |
| `src/routes/BoardTab.test.tsx` | 974 | n/a — see below |

`eslint.config.js` turns `max-lines` and `max-lines-per-function` **off** for
`**/*.{test,spec}.{ts,tsx,mjs}`, `src/test/**` and `e2e/**` (T2 and T4 stay on). So
`BoardTab.test.tsx` at 974 counted lines is legal, and splitting the new tests into
their own file in §6 is a readability choice, not a budget one.

### 3.3 No import cycle

`src/lib/ticket-search.ts` imports `./domain` and nothing else, so `board.ts` may import
`isSearchActive` from it. Checked, because §4.1 introduces exactly that edge.

### 3.4 `hasWipLimits` already exists

SPRIN-85 added it to `src/lib/domain.ts` as a **second predicate** rather than
`!hasSprints(project)`, deliberately, and its docblock says so. This story is its first
consumer. Nothing new is needed in `domain.ts`.

---

## 4. Where each rule lives

Board rules live in `src/lib/board.ts`; components render answers. Two new selectors.

### 4.1 `isBoardFiltered(blockedOnly, query)`

Returns `blockedOnly || isSearchActive(query)`.

This `||` exists today **inside `BoardColumnEmpty`**, whose docblock records that its
location was once forced by complexity pressure and is now "a preference, not a forced
move". Two components need the same answer as of this story, so it becomes one named,
tested rule and `BoardColumnEmpty` reads it instead of recomputing it. That is a targeted
improvement to code this story is already working in — not unrelated refactoring — and it
leaves `BoardColumnEmpty` at 2.

### 4.2 `selectColumnLimit(project, status, filtered)`

Returns `number | null` — the limit this column should display, or `null` for "display
none".

```ts
// Illustrative. Not run, not a patch — see [[plan-code-is-an-unrun-draft]].
export function selectColumnLimit(
  project: Pick<Project, 'project_type'>,
  status: Pick<ProjectStatus, 'wip_limit'>,
  filtered: boolean,
): number | null
```

Three parameters, under T4. It returns `status.wip_limit` when **both** gates open —
`hasWipLimits(project)` is true and `filtered` is false — and `null` otherwise. One unit
holds the entire "should this column show a limit" rule, so one unit test can attack it.

`BoardTab` calls it inside its existing `statuses.map` arrow and passes the result down.
It calls functions rather than branching, so `BoardTab` stays at **7**.

### 4.3 The Kanban gate is load-bearing, not decoration

SPRIN-85 §3.4 recorded an accepted gap: a CHECK body may not contain a subquery, so it
cannot reach `projects.project_type`, and **the database will happily store a `wip_limit`
on a Scrum project's status row.** It is inert only because nothing reads it.

This story is the thing that reads it. `hasWipLimits` inside `selectColumnLimit` is
therefore the *only* mechanism making AC5 true, which decides how AC5 is tested: with a
**Scrum project whose status rows carry non-null limits**. A test built on a Scrum project
with null limits would pass with the gate deleted, and would be [[green-for-the-wrong-reason]].

### 4.4 `BoardColumnSummary` gains one prop

`limit: number | null`, alongside `tickets`. It keeps its `count === 0` early return, and
decides under-vs-over from its own `count` — the count it already computes and already
renders, so the number the word `over` refers to is provably the number on screen.

Expected complexity after the change is 6–7 of 10 (the null check, the over check, and
the class selection reusing the over test). **Re-measure before opening the PR** rather
than trusting this estimate.

---

## 5. Decisions taken here

### 5.1 A filtered board makes no WIP claim at all

`BoardColumnSummary` receives the **already-filtered** column, and its docblock is
emphatic that its numbers describe the cards actually on screen, because "a total that
disagreed with the cards under it would be a distinct state wearing another state's face".

A WIP limit is a claim about the column's **real occupancy**. On a Kanban board both
filters are live (`offersFilters` is true whenever there are no sprints), so a column
holding five cards against a limit of three renders as "1 card" the moment *Blocked only*
is ticked. Three options were considered:

1. **Drop the segment while filtering** — chosen. The limit is shown only when the column
   is showing all its cards; under any filter the line reverts to exactly today's.
2. Always judge against true occupancy, labelling the second number (`5 in column, over
   limit 3`) so it cannot be read as the on-screen count.
3. Judge against the visible count.

Option 3 was rejected outright: filtered counts are always ≤ real occupancy, so an
over-limit column would quietly stop warning with nothing indicating the number was
partial — the silent version of the same blind spot. Between 1 and 2, **1 keeps the
existing invariant whole**: nothing on the summary line ever disagrees with the cards
below it, and the board declines to make a claim it cannot presently support. It also
mirrors `BoardColumnEmpty`, which already changes its sentence rather than repeat a claim
a filter has falsified.

**The accepted cost, stated so nobody rediscovers it as a bug:** a user who ticks a filter
sees the over-limit warning disappear, and could read that as the filter having fixed
something. The board is no longer showing them the column, and the whole line is filtered
context when that happens.

### 5.2 An empty column renders exactly as today

`BoardColumnSummary` returns `null` at `count === 0` and continues to. An empty column
cannot be over its limit, `BoardColumnEmpty` already says "No tickets yet." (or "No
matches."), and either says it better than `0 cards · 0 points · limit 3` would. This is
the existing rationale in that component's docblock, unchanged.

### 5.3 No live region

The summary stays a plain `<span>`. Giving it `role="status"` would announce on every
drag, every filter keystroke and every optimistic update — noise in exchange for a
signal already present in the text. AC2 asks for the state to be conveyed in text, and it
is.

### 5.4 No third "at limit" state

`3 cards · 8 points · limit 3` already says a column is full. AC2 asks only for over, and
a distinct at-limit phrasing is a third state to test, translate and reason about for no
stated need.

---

## 6. Tests, one per acceptance criterion

New file `src/routes/BoardTab.wipLimit.test.tsx`. Repo precedent for a focused second
suite beside a large one: `LoginPage.security.test.tsx`,
`CreateProjectDialog.reopen.test.tsx`, `AuthCredentialFields.wiring.test.tsx`.
`BoardTab.test.tsx` is at 974 counted lines and the new cases are a coherent group.

| AC | What the test does |
|---|---|
| **1** — a column with a limit shows its count against that limit | Kanban project, a status with `wip_limit: 3` holding 2 cards. Asserts the text `limit 3` **`within(section)`** for that column — never an unscoped `getByText`, which would say the text exists and nothing about where ([[green-for-the-wrong-reason]], SPRIN-65). |
| **2** — over-limit conveyed IN TEXT, not colour alone | Over-limit column asserts the **words** `over limit 3` in the column's text. A **separate** test asserts `text-destructive`. Deleting the words in favour of colour reddens the first; dropping the colour reddens only the second. The two must not be one test, or "colour alone" passes. |
| **3** — dragging into an at-limit column succeeds and persists | **The pinned one.** Fire the board's drag/drop wiring onto a column already at its limit. Asserts `updateTicket` was called with that ticket id and the target slug, that the card renders in the target column afterwards, and that **no `role="alert"` appears**. Turning the soft limit into a block — a guard, a disabled drop target, a rollback — fails this. |
| **4** — a status with no limit renders exactly as today | Kanban project, `wip_limit: null`. Asserts the column's text still reads `N cards · P points` and that the string `limit` appears nowhere within that column. |
| **5** — a Scrum board is unchanged | **Scrum** project whose status rows carry **non-null** `wip_limit` values (§4.3). Asserts no limit text on any column. This is the test that pins `hasWipLimits`; with null limits it would pass against a deleted gate. |

Plus, in `src/lib/board.test.ts`:

- `selectColumnLimit` — the Kanban gate, the filter gate, and a null `wip_limit`, each
  attacked independently so no one case masks another.
- `isBoardFiltered` — blocked-only alone, a query alone, both, neither. `BoardColumnEmpty`'s
  existing tests continue to pass unchanged; they are the evidence the extraction preserved
  behaviour ([[refactor-under-an-unedited-test-file]]).

And one test for §5.1: with *Blocked only* on, an over-limit column shows no limit segment.

**Tripwire.** `npx vitest list --filesOnly | wc -l` moves **64 → 65**, and `test:unit`
**57 → 58**. The **gap stays 7**. A CI run whose gap is 0 means the live suites silently
skipped and is a failure however green it looks. Re-derive with that command — never a
grep pattern, which drops the `.mjs` test files.

---

## 7. Not built

- **No E2E addition.** `e2e.yml` is not the gate and must never become it. The drag
  gesture is already covered there for the board generally; AC3 is pinned in Vitest, which
  is what runs on every PR.
- **No migration, no schema change, no grant change.** `wip_limit` and its column-level
  UPDATE grant shipped in SPRIN-85 and are untouched here.
- **No Settings-tab change.** `StatusWipLimitField` is the write path and is done.
- **No hard limit, in the app or the database.** §2.

---

## 8. Review depth and Definition of Done

**One reviewer on PR open.** No migration, no privilege change, no authentication, no RLS,
no secret handling, no change to the CI workflow — this is board rendering. CLAUDE.md is
explicit that review depth is chosen by the diff and never applied by category, and that
"an ordinary story gets ONE reviewer". SPRIN-85's fleet was right for a grant rewrite and
would be the wrong instrument here.

Ask the reviewer to **mutate, not to read**: delete the `hasWipLimits` gate, delete the
`filtered` gate, invert the `count > limit` comparison, and turn the drop handler into a
block. Each should redden a named test above. A review that reports nothing without having
planted a mutation has established very little.

DoD is the project's: ACs met and covered, `npm run verify` green locally and on the PR's
own head commit, RLS suite still green, one squash-merged PR, Jira moved to Done only
after merge.
