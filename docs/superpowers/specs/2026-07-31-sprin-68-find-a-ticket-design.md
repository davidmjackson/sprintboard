# SPRIN-68 — Find a ticket: filter the backlog and board by key or summary

**Date:** 2026-07-31 · **Epic:** E5 Backlog (SPRIN-5) · **Status:** design approved (autopilot)

## Why

The app has no search affordance anywhere. `grep -rin "search"` over `src/routes` and `src/lib`
returns no user-facing search: the only filter in the product is the board's `blockedOnly`
checkbox. The backlog is unbounded — it grows for the life of the project and is ordered by ticket
number, never by relevance — so "which ticket was that?" is answered today by scrolling.

A quick text filter is Jira core. It is not JQL, not saved filters, not custom fields; it is the
box at the top of a Jira board and backlog that narrows what you can see as you type. That is the
slice.

## Scope

In scope: one client-side text filter, shared by the Backlog and Board tabs, matching on ticket
**key or summary**.

Out of scope and deliberately so: server-side filtering, JQL, saved filters, sort/rank, fuzzy
matching, highlighting matched substrings, search across projects, and searching description /
acceptance criteria / labels.

No schema change. No new query. No security boundary: the filter runs over the ticket list the
shell has already fetched, which RLS has already scoped to the owner. Narrowing a list the user is
already entitled to see cannot widen access.

## Acceptance criteria

- **AC1** The Backlog has a search field. Typing filters the list to tickets whose key or summary
  contains the query, case-insensitively.
- **AC2** The Board has the same search field. It narrows the cards in every column, and each
  column's count / points / unestimated totals describe the cards actually on screen.
- **AC3** The query composes with the blocked-only board filter — both narrow, ANDed.
- **AC4** An empty or whitespace-only query is not a filter: everything is shown.
- **AC5** When a filter hides everything, the empty state says so rather than claiming there is
  nothing there. The Backlog must not say "Nothing in the backlog." and a Board column must not say
  "No tickets yet." when tickets exist but are filtered out.
- **AC6** The matching rule lives in one module and is used by both tabs — no domain rule inlined
  in a component.

## Design

### The rule: `src/lib/ticket-search.ts`

A new module, following the one-module-per-rule convention already established by `backlog.ts`
(the `sprint_id is null` rule), `board.ts` (active sprint, blocked filter, column summary),
`labels.ts` and `deliverables.ts`. It exports one function:

```ts
export function selectMatchingTickets(tickets: readonly Ticket[], query: string): Ticket[]
```

It gets its own module rather than joining `backlog.ts` or `board.ts` **because it belongs to
neither** — it is used by both, and putting it in one would make the other import a rule from a
module named after a surface it is not. That is the same reasoning that keeps `selectSprintTickets`
in `backlog.ts` and has `board.ts` compose with it rather than duplicate it.

Behaviour:

- Trim the query. A trimmed-empty query returns the input list (AC4) — identity, not `[]`. This is
  the single most important branch in the module: getting it backwards would empty both tabs on
  first render, since both start with an empty query.
- Compare case-insensitively by lowercasing both sides.
- A ticket matches when its **key** contains the query, or its **summary** does.

**Why key and summary, and nothing else.** Both are visible on every board card and backlog row, so
a match is always something the user can see. Matching `description` or `acceptance_criteria` would
return rows whose relevance is invisible until you open them — the user types "auth", gets four
rows, and none of them says "auth" anywhere. Labels were considered and declined for the same
reason on the board (the card does not render them) and because `parseLabels` already gives labels
their own vocabulary; a labels filter is a different feature.

Matching the **key** matters more than it looks: `MP-1` is how people refer to tickets to each
other. Substring rather than prefix means typing `mp`, `MP-1`, or bare `1` all narrow usefully, and
one substring test covers all three without a second code path.

### The control: `src/routes/TicketSearchInput.tsx`

One small presentational component — a labelled `<input type="search">` — used by both tabs. It is
a component rather than two inlined inputs so the label text, the accessible name and the styling
cannot drift between the two surfaces. It is controlled: `value` and `onChange` come from the tab.

**State lives in each tab, not in the shell.** `blockedOnly` is already local to `BoardTab`, and
hoisting a filter into `ProjectShellContext` would be a behaviour decision no AC asks for: it
would make the Backlog's query follow you to the Board. Local state also means the query resets on
tab switch, because the tab unmounts (the shell's `ErrorBoundary` is keyed on `location.pathname`).
That is the honest default — a filter you cannot see the box for is a filter that will confuse
someone.

### AC5, and a pre-existing defect it fixes

`BacklogTab` renders "Nothing in the backlog." whenever `backlog.length === 0`. With a query
active, that is a false claim about the project — exactly the S4.6 failure this codebase has
already paid for twice ("a distinct state wearing another state's face", per `BacklogTab.tsx:37`
and `BoardTab.tsx:52`). The empty state must therefore branch on whether a filter is active.

The Board has the **same defect already, today, without this story**: when `blockedOnly` is on and
a column contains no blocked cards, that column says "No tickets yet." — a claim about the sprint,
made by a filter. This story fixes it because it must: it is adding a second filter to the same
sentence, and leaving it would mean shipping a known-false message on a path the new feature makes
much easier to reach. The fix is to make the column's empty text filter-aware, not to add a new
element.

Wording: filtered-empty says **"No matches."** on a board column and **"No tickets match your
search."** on the backlog. The backlog gets the longer sentence because it is the whole tab's empty
state, standing alone in a dashed box; a column has three siblings for context and a short line to
fit in.

### The cyclomatic budget on `BoardTab` — a real constraint, decided now

`BoardTab.tsx:20` records that the component **sits at the T2 cyclomatic limit of 10**, which is why
`BoardColumnSummary` was extracted at all and why the sprint name and the filter checkbox both hang
off a single `activeSprint !== null` test. Adding a query, a second filter application and a
filter-aware empty string is **predicted** to exceed 10 and redden `npm run lint`, which gates
every merge. That prediction is from the file's own comment, not from a measurement — the linter
reports complexity only when it is violated, so the number is unobservable until it breaks. Treat
it as a hypothesis to test, not a fact.

The design therefore extracts a **`BoardFilters`** component (the blocked-only checkbox plus the
search input), and puts the empty-column text in a `BoardColumnEmpty` component alongside
`BoardColumnSummary`, which was extracted for exactly this reason. This follows the precedent in
the file rather than inventing one. The
implementer must run `npm run lint` and report the actual number; if the extraction is not enough,
that is a finding, not something to work around with an inline disable — CLAUDE.md is explicit that
a genuine misfit is an ADR, never a disable.

### Composition, and why the totals come out right for free

`BoardTab` already computes `visibleTickets` from `boardTickets` and passes each **already-filtered**
column to `BoardColumnSummary`, whose docblock states that the numbers describe the cards actually
on screen. Applying the query in the same place — `selectMatchingTickets(selectBlockedTickets(...))`
or the reverse, both are pure filters so the order is irrelevant to the result — means the column
totals follow the query with no change to `summariseColumn` at all. AC2's "totals describe what is
on screen" is a property to **test**, not code to write, and a test that pins it is the guard
against someone later filtering at render time inside the `.map`.

## Testing

Unit tests for `selectMatchingTickets` in `src/lib/ticket-search.test.ts`: empty and
whitespace-only query returns everything (AC4); case-insensitive match on summary; match on key;
partial key; no match returns `[]`; input array not mutated.

Component tests extend the existing `BacklogTab.test.tsx` and `BoardTab.test.tsx`. Per the SPRIN-67
rules now in CLAUDE.md, assertions use DOM text scoped with `within(...)` plus substring role-name
queries, never an exact composed accessible name.

The tests that carry the story:

- Typing a query hides non-matching rows/cards and keeps matching ones.
- Clearing the query restores everything (AC4 from the other direction).
- A query that matches nothing shows the filtered-empty message and **not** "Nothing in the
  backlog." / "No tickets yet." (AC5). Asserting the absence of the false message is the point —
  asserting only the presence of the new one would stay green if both rendered.
- With `blockedOnly` on and a query set, only tickets satisfying both appear (AC3).
- A column's totals change when the query hides a pointed card (AC2) — the composition test.

## Decisions recorded (autopilot, decided without asking)

| Decision | Chosen | Why not the alternative |
|---|---|---|
| Fields matched | key + summary | description/AC/labels produce invisible matches |
| Match style | case-insensitive substring | fuzzy/prefix adds a code path and surprises; substring covers `mp`, `MP-1`, `1` |
| Rule location | new `src/lib/ticket-search.ts` | it belongs to neither `board.ts` nor `backlog.ts`; both use it |
| State owner | local to each tab | hoisting to the shell makes the query follow across tabs — unasked-for behaviour |
| Debounce | none | the list is in memory and already fetched; YAGNI |
| Result count ("3 of 12") | not built | new UI beyond the ask; the visible query is the state indicator and AC5 covers the confusing case. Noted as a follow-up, not a gap |
| Board empty-column text | made filter-aware | it is already false under `blockedOnly` today; this story doubles the ways to reach it |
| Highlighting matches | not built | presentation-only, and it would put a rendering rule in the row |

## Risks

- **The lint budget.** `BoardTab` is at cyclomatic 10 with no headroom. Mitigated by extracting
  `BoardFilters`; must be measured, not assumed.
- **Testing the absence of a message.** AC5's tests assert a string is *gone*. A typo in the
  asserted string makes such a test vacuously green. The tests must pair "new message present" with
  "old message absent", and the implementer must watch the absence assertion fail before the fix.
