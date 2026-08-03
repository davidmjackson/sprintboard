# SPRIN-73 — Kanban project type

**Epic:** SPRIN-73 (Rung 3.2)
**Depends on:** SPRIN-72 (per-project statuses and configurable board columns) — complete
**Blocks:** nothing structurally. SPRIN-75 must re-audit everything here against the
membership model, as it must for every Rung 3 epic.
**Date:** 2026-08-03

This is an **epic-level** design covering six stories, not a single story's spec. Each
story below is one branch and one small PR. Where a story has an open measurement to take
before writing code, this document says so rather than guessing the answer.

---

## 1. What this epic is

A project can be **Kanban** as well as Scrum. A Kanban project has a board and a backlog
but **no sprints**, and — because they are what people actually expect from a Kanban board
— **per-column WIP limits**, which are hidden entirely for Scrum projects.

The schema part is as cheap as CLAUDE.md has promised since Phase 1: `projects.project_type`
already exists as `text` with `check (project_type in ('scrum'))`, so Kanban is one widened
check. **Never an ENUM.** The work is behavioural.

## 2. The two decisions the epic demanded, and their reasons

### 2.1 The project type is IMMUTABLE after creation

Chosen at creation, never changeable. There is no conversion UI and no conversion story in
this epic.

The reason is that conversion is not a toggle, it is a set of data rules that have to be
invented and tested: converting Scrum → Kanban must decide what happens to existing `sprints`
rows and to every ticket holding a `sprint_id`; Kanban → Scrum must decide where unsprinted
work lands and how the partial unique index on the active sprint is satisfied. That is a
story's worth of rules serving a need nobody has expressed. Jira itself treats board type as
effectively a setup-time decision.

**If conversion is ever built, it inherits two obligations recorded here:** the sprint/ticket
rules above, and the `wip_limit` gap in §3.3.

### 2.2 WIP limits are SOFT — they warn, they never block

Dragging a card into a column already at its limit **succeeds**. The column renders
over-limit; nothing is refused.

Two reasons. First, this is what a WIP limit *is* — a signal to the team, not a lock, and it
is what Jira does. Second, a hard limit would have to be enforced in the database too
("validate at both edges"), and the only way to do that is a trigger on `tickets` that counts
sibling rows in the target column. That is the exact shape that broke the cascade in SPRIN-80
(see [[row-trigger-counting-siblings-breaks-cascade]]) — a fresh SPI snapshot hides rows the
same statement is removing. A hard limit also strands work: lower a limit below a column's
current occupancy and that column can never be added to again, with no in-app way out.

**This decision is pinned by a test in story 6** (a drag into an at-limit column succeeds and
persists), so that "improving" it into a block goes red rather than shipping.

## 3. Schema

Two migrations, one per story that needs one. **Hand-applied** — the Supabase MCP is
`read_only=true` on purpose. Produce the SQL, hand David one copy-paste command, run
`get_advisors` afterwards. Files go in `docs/migrations/` as `sprin-73-*.sql`.

Per [[ship-the-migration-with-its-tests]], each migration is applied as part of its own
story, not early to "unblock" later work.

### 3.1 Migration A (story 1) — widen the project-type check

```sql
alter table projects drop constraint projects_project_type_check;
alter table projects add constraint projects_project_type_check
  check (project_type in ('scrum', 'kanban'));
```

That is the entire schema change the epic promised. The column stays `text`. The existing
`default 'scrum'` is unchanged, which is what keeps every fixture insert across the
integration suites and the Playwright E2E creating Scrum projects without edit.

### 3.2 Migration B (story 5) — `wip_limit`, plus the grant rewrite

```sql
alter table project_statuses add column wip_limit int
  check (wip_limit is null or wip_limit > 0);
```

`null` means **no limit**. Additive: `project_statuses` is not reshaped, matching the rule
that core fields stay real columns.

The grant change is the part with teeth. `project_statuses` UPDATE is currently
column-restricted to `name`, `category`, `position`. Per
[[column-revoke-cannot-hole-a-table-grant]], `revoke update (col)` against a table-wide grant
is a **silent no-op** — the fix is to revoke the table's UPDATE and re-grant the columns:

```sql
revoke update on project_statuses from authenticated;
grant update (name, category, position, wip_limit) on project_statuses to authenticated;
```

`slug` and `is_initial` must remain unwritable, and a live test asserts that they still are.

### 3.3 The gap we are accepting, and why it is not a deferred bug

`wip_limit` lives on `project_statuses`, which Scrum projects also have rows in. A `CHECK`
body may not contain a subquery, so it cannot reach across to `projects.project_type`: the
database will store a `wip_limit` on a Scrum project's status row.

It is **inert** — nothing reads it for a Scrum project — and because §2.1 makes the project
type immutable, it can never *stop* being inert. There is no path by which that row becomes a
Kanban row later. The absent constraint therefore costs nothing.

This is a real dependency between the two decisions, not a coincidence: **if conversion is
ever built, that story must decide what happens to `wip_limit` values sitting on a project
converting to Scrum, or those inert values silently become live.**

## 4. The client-side contract

### 4.1 `domain.ts` owns the values, as always

`ProjectType` is a bare single-member union today (`'scrum'`) with no runtime array. It grows
one, mirroring `TICKET_TYPES` exactly, because the create dialog needs the *values* to render
its choice and this project's rule is that they live in `domain.ts` and nowhere else:

- `PROJECT_TYPES = ['scrum', 'kanban'] as const`
- `ProjectType = (typeof PROJECT_TYPES)[number]`
- `isProjectType` guard
- `AssertProjectTypesExhaustive = Expect<Exact<ProjectType, (typeof PROJECT_TYPES)[number]>>`

`AssertProjectTypeColumn` stays as it is.

`ProjectStatusUpdate` gains `wip_limit` in story 5, and its `Exact<>` key-set assertion is
updated in the same commit. That assertion is not decoration: it makes forgetting the grant
rewrite a **compile error** rather than a silent re-widening.

### 4.2 Two named predicates, and no raw comparisons

**No component ever writes `project.project_type === 'kanban'`.** Two predicates in
`domain.ts` are the only derivations:

```ts
hasSprints(project)    // project_type === 'scrum'
hasWipLimits(project)  // project_type === 'kanban'
```

This is the same discipline as `doneSlugs()` being the single derivation of "terminal"
(SPRIN-77). Two call sites reading the raw string could drift; one predicate cannot. They are
deliberately two predicates rather than one negated everywhere, because "has sprints" and
"has WIP limits" are two different questions that happen to have the same answer today — a
third project type would separate them, and a single `isKanban` would not survive it.

### 4.3 No new plumbing

`project` is already in `ProjectShellContext`, so every tab and the detail dialog already
hold `project_type`. Nothing new is threaded through the shell.

### 4.4 "Absent, not merely hidden" is the router's job

Hiding the Sprints nav link leaves the URL live, which is exactly what the epic ruled out.
`SprintsTab` reads the outlet context, so a Kanban project's deep link to
`/projects/:id/sprints` returns `<Navigate to="../board" replace />`.

## 5. The lint budget, measured

Both numbers were measured on `33405cd`, not recalled. **Re-measure rather than trust this
section** — `npx eslint <file> --rule '{"complexity":["error",1]}'` and the `max-lines`
equivalent.

| Site | Now | After |
|---|---|---|
| `BoardTab` (main function) | 9 / 10 cyclomatic | **10 / 10** after story 3 |
| `StatusSettings.tsx` | **400 / 400 lines** | story 4 must split it before story 5 |
| `TicketDetailDialog` | 10 / 10 cyclomatic | must not grow in story 2 |

Consequences that shape the story order:

- Story 3 spends `BoardTab`'s last branch. Story 6's over-limit rendering therefore lives in
  `BoardColumnSummary` — a separate, small component — and receives the limit as a **prop**,
  not as another branch in `BoardTab`.
- Story 4 exists solely because `StatusSettings.tsx` is at exactly 400/400 and story 5 cannot
  add a line to it.
- Story 2 threads a flag to the ticket detail sidebar. Passing a prop is free; a *conditional*
  in `TicketDetailDialog` is not, because it is at 10/10. Measure before writing, and extract
  first if the conditional cannot live in the sidebar.

## 6. The six stories

Order: **1 → 2 → 3**; **4** independent but before **5**; **5 → 6**.

### Story 1 — Create a project as Scrum or Kanban

Migration A. `CreateProjectDialog` gains a type control — a native `<select>`, matching this
codebase's other pickers and jsdom's realities — defaulting to Scrum so the existing path is
unchanged. `createProject` passes it through; zod validates against `PROJECT_TYPES`. The type
shows as a badge in `ProjectShellHeader`, which is what makes the choice observable to a test.

**ACs**

1. The create dialog offers Scrum and Kanban, with Scrum preselected.
2. Creating as Kanban persists `project_type = 'kanban'`, and the shell shows a Kanban badge.
   The badge renders for **both** types — a Scrum project shows a Scrum badge — rather than
   appearing only for Kanban. That is deliberate: it makes the Scrum case a positive control
   for every Kanban assertion in stories 2 and 3, instead of another absence to prove.
3. Creating without touching the control still produces a Scrum project.
4. The database rejects any value outside `('scrum','kanban')` — live integration test.
5. **No code path anywhere writes `project_type` after insert.** This AC *is* §2.1.

### Story 2 — A Kanban project has no sprints

`ProjectShellHeader` renders the Sprints link only when `hasSprints(project)`. `SprintsTab`
redirects a deep link to `../board`. The detail dialog's sprint picker is absent. See §5 for
the `TicketDetailDialog` constraint.

**ACs**

1. A Kanban project shows no Sprints tab link.
2. Navigating directly to `/projects/:id/sprints` on a Kanban project redirects to the board,
   and no sprint UI renders.
3. A Kanban project's ticket detail has no sprint picker.
4. A Scrum project is unchanged on all three.
5. `hasSprints` is the only expression of the rule.

### Story 3 — The Kanban board shows every ticket

`BoardTab` selects `tickets` rather than the active sprint's. No sprint caption, no "No active
sprint" message.

**The non-obvious part:** the blocked-only checkbox and the search box currently hang off the
*same* `activeSprint !== null` test as the caption (`BoardTab.tsx:261-284`). Left alone, a
Kanban board would render cards with **no filters at all**. This story must separate "is there
a sprint to describe" from "are there filters to offer".

`BacklogTab` gets its Kanban reading. The rule `sprint_id is null` in `selectBacklogTickets`
is **not** changed — for a Kanban project it is true of every ticket, so the tab becomes an
honest flat list view alongside the column view, labelled to say so rather than claiming to be
a backlog.

**Precisely what "labelled" means**, so this is not read two ways: the nav link text is
**"All tickets"** for a Kanban project and stays **"Backlog"** for a Scrum project, and the
tab's own empty-state copy follows the same wording. The route path stays `backlog` — it is
the link text that changes, not the URL, so no redirect and no router change is involved.

**ACs**

1. A Kanban board renders every ticket in its status column, regardless of `sprint_id`.
2. No sprint caption and no "No active sprint" message on a Kanban board.
3. **Both filters are available on a Kanban board.**
4. The Backlog tab's nav link reads "All tickets" on a Kanban project and "Backlog" on a
   Scrum one, and on a Kanban project it lists every ticket.
5. A Scrum board is unchanged: still sprint-scoped, still captioned.

### Story 4 — Split `StatusSettings.tsx`

Pure refactor, no behaviour change. It is at exactly 400/400 and story 5 cannot add a line.

**ACs**

1. The file has real headroom afterwards, not one spare line.
2. **No test file is edited.** An unedited suite passing is the evidence the behaviour is
   unchanged — see [[refactor-under-an-unedited-test-file]].
3. `npm run verify` is green.

### Story 5 — Set a WIP limit per column (Kanban only)

Migration B and the grant rewrite. Settings shows a numeric input per status when
`hasWipLimits(project)`. Empty means no limit and clears to `null`. Validated at both edges.

**ACs**

1. The WIP control appears only on a Kanban project's Settings tab.
2. A limit persists across a reload.
3. Clearing the field writes `null`.
4. Zero, negative and non-integer are rejected client-side **and** by the database (live test).
5. **The widened grant still refuses `slug` and `is_initial`** — the regression that grant
   exists to prevent.

### Story 6 — The board flags an over-limit column

`BoardColumnSummary` renders the count against the limit.

**ACs**

1. A column with a limit shows its count against that limit.
2. Over-limit is conveyed **in text, not colour alone**.
3. **Dragging a card into an at-limit column succeeds and persists** — §2.2, pinned.
4. A status with no limit renders exactly as it does today.
5. A Scrum board is unchanged.

## 7. Testing

Every story is written test-first from its ACs.

Three live integration assertions, in the existing `*.integration.test.ts` suites so the CI
tripwire gap stays at **seven files**: the widened check accepts `kanban` (story 1), rejects a
third value (story 1), and the `wip_limit` check plus the grant's continued refusal of
`slug`/`is_initial` (story 5).

### The risk that would most likely ship this broken and green

**Vacuous absence tests.** "The Sprints link is not in the document" passes just as well if
the whole header failed to render — it is shape 4 of [[green-for-the-wrong-reason]], and this
epic is mostly made of absence assertions. **Every absence assertion carries a positive
control in the same test**: the Board link *is* present, the Kanban badge *is* present. An
absence with no positive control beside it proves nothing and must not pass review.

### Review depth

None of these six is a security-boundary diff — no authentication, no RLS rewrite, no secret
handling, no change to the CI gate. Each gets **one reviewer** on PR open, per the project's
review-depth rule. Story 5 touches a GRANT, which is the closest any of them comes; that is
covered by making the grant's refusal a live test rather than by a review fleet.

SPRIN-75 is where the fan-out comes out.
