# SPRIN-76 — Render the board from database statuses

**Date:** 2026-07-31
**Epic:** SPRIN-72 (Rung 3.1 — custom statuses and configurable board columns)
**Depends on:** SPRIN-79 (schema, shipped `a7d3f17`)
**Followed by:** SPRIN-77 (manage statuses — writes), SPRIN-80 (delete a status)

Behaviour-preserving. After this story every existing project's board looks exactly as it
does now, because every project still has exactly the four seeded statuses. What changes is
*where the four come from*: `project_statuses` rows instead of a TypeScript constant.

---

## 1. What this story is, and where its edges are

SPRIN-79 moved the **database** half: `tickets_status_check` is gone, `tickets.status` is
`text` with a composite fk to `project_statuses (project_id, slug)`, and a trigger seeds four
rows per project. It deliberately did **not** touch `src/routes/`. That left a seam — nothing
connected the database vocabulary to the board — so `domain.test.ts` gained two *temporary*
bridging assertions (seeded slugs equal `TICKET_STATUSES`, seeded names equal
`TICKET_STATUS_LABELS`).

**This story closes that seam and deletes those two assertions.** It is the last story in the
epic that changes nothing a user can see; SPRIN-77 is the first they can.

Out of scope, and owned elsewhere:

| Not here | Owner |
|---|---|
| Any write to `project_statuses` (add / rename / reorder) | SPRIN-77 |
| Deleting a status; orphan-ticket safety | SPRIN-80 |
| Moving `'done'` literals in `sprints.ts` / `ProjectShell.tsx` onto `category` | SPRIN-77 (both together) |
| Any migration | — none needed |

No schema change. No RLS change. `statuses_owner_read` already exists (SELECT-only) and
`rls.integration.test.ts` already covers cross-tenant reads of it. This story adds a *client
read* of an already-policed table.

---

## 2. Architecture

### 2.1 A third project-scoped read

`ProjectShell` gains a third `useTaggedRead`, alongside tickets and sprints:

```ts
const statusRead = useTaggedRead(activeProjectId, reloadNonce, listProjectStatuses)
```

and exposes `statuses: ProjectStatus[]` / `statusesPhase: ReadPhase` on
`ProjectShellContext`.

**Why the shell owns it, rather than the board fetching for itself.** Two surfaces need the
same list — the board's columns and the detail dialog's status picker — which is precisely
why the shell already owns tickets and sprints. A per-component fetch would issue the request
twice and let the two disagree. It also inherits the retry story for free: one `reloadNonce`
drives all three reads, so the existing Retry button reloads statuses with no new wiring.

`listProjectStatuses` lives in a new `src/lib/project-statuses.ts`, mirroring `tickets.ts` /
`sprints.ts`:

- filters on `project_id` (RLS scopes to the owner, but an owner has many projects),
- orders by `position` ascending — **that ordering IS the board column order**,
- **throws** on error rather than resolving to `[]`. `[]` is indistinguishable from "this
  project has no statuses", which is the S4.6 defect. Only a rejection carries failure.

### 2.2 The phase gate, and the cyclomatic wall

`BoardTab` sits at **cyclomatic exactly 10**, the T2 limit — measured, not assumed:

```
npx eslint src/routes/BoardTab.tsx --rule '{"complexity":["error",1]}'
  → Function 'BoardTab' has a complexity of 10
```

Its three-state gate today costs 4 of that budget (three `if`s plus one `||`). A third read
written the same way costs 2 more and turns `npm run lint` red. So the gate has to change
shape, and the right change is to name the rule rather than repeat it a third time.

`project-reads.ts` — which already owns the three-state read contract — gains:

```ts
export function firstUnready<R>(
  reads: readonly { resource: R; phase: ReadPhase }[],
): { resource: R; phase: 'failed' | 'loading' } | null
```

**Any `failed` beats any `loading`**, then source order within each kind. That is not a new
rule: it is exactly today's precedence (a failed sprints read wins over a loading tickets
read), and writing it as two passes rather than one `find` is what preserves it. A single
ordered scan would return "tickets loading" while sprints had already failed — a silent
behaviour change wearing a refactor's clothes.

`BoardTab` then spends 2 where it spent 4, ending at **8** with room for the story:

```tsx
const unready = firstUnready([
  { resource: 'tickets', phase: ticketsPhase },
  { resource: 'sprints', phase: sprintsPhase },
  { resource: 'statuses', phase: statusesPhase },
])
if (unready) {
  return unready.phase === 'failed' ? <LoadFailure … /> : <p>Loading…</p>
}
```

### 2.3 `LoadFailure` gains a third resource — deliberately

`LoadFailure`'s `resource` prop is a **closed union**, and its docblock says plainly that this
is a security control: `listTickets` rejects with `Could not load tickets: ${error.message}`,
a raw PostgREST string that can name columns and policies, and an open `message: string`
channel would render it into `role="alert"` and compile clean.

So `firstUnready` is **generic in `R`** rather than typed to `string`. `R` infers from the
call site, `LoadFailure` keeps its closed union, and adding `'statuses'` means adding a copy
line to `FAILURE_COPY` — which that docblock calls "exactly the review moment we want". The
union is widened to `'tickets' | 'sprints' | 'statuses'` and named once as
`LoadFailureResource`.

A `string`-typed helper would have quietly dissolved this control. It is the kind of thing a
refactor takes out by accident.

---

## 3. `domain.ts` stops owning the values

This is the rule CLAUDE.md wrote SPRIN-72 to cash in: *"Status, type and column definitions
live in `src/lib/domain.ts` and nowhere else."* It held — exactly five files referenced the
status constants, four of them UI — so the change is confined rather than scattered.

**Deleted:** `TICKET_STATUSES`, `TICKET_STATUS_LABELS`, `isTicketStatus`,
`AssertTicketStatusesExhaustive`, `AssertTicketStatusColumn`.

**Kept:** `DEFAULT_PROJECT_STATUSES` — it is the client half of the *seed* contract, not of
the board, and two tests hold it honest (`domain.test.ts` parses the trigger's VALUES list;
`rls.integration.test.ts` reads what the live database actually seeded). Deleting it would
remove the only assertion that a newly created project gets the four statuses at all.

### `TicketStatus` becomes `string`

```ts
export type TicketStatus = string
```

The union cannot express a per-project vocabulary, and AC2 requires a fifth status to produce
a fifth column **without a code change**. So the narrowing has to go.

The alias is kept rather than replaced with bare `string` at ~15 call sites, with a docblock
saying it is deliberately unnarrowed and why. That is the cheapest defence against a future
session "restoring" the union and re-breaking the epic.

What is lost, stated plainly: compile-time narrowing on `ticket.status`. What replaces it is
stronger and already shipped — the composite fk, which is enforced *per project* and by the
database rather than by a constant that only claimed to match it.

`StatusCategory` stays a union. It is still a `check` constraint on a column, so the existing
`Exact<>` / `Assignable<>` guards still bite.

---

## 4. Reading a status name — and the AC4 fallback

`src/lib/project-statuses.ts` also owns two selectors, because "which name does this slug
render as" is a domain rule and CLAUDE.md forbids inlining those in components:

```ts
statusName(statuses, slug)     // → the row's name, or the slug itself
statusOptions(statuses, current) // → picker options, with `current` guaranteed present
```

**AC4 says "an unknown status name still renders, with a defined fallback style", and its
scope bullet refers to "the badge/colour map keyed by status name". There is no colour map.**
Verified by grep: the only status-keyed map in the codebase is `TICKET_STATUS_LABELS`, and the
detail header's status dot is a fixed `bg-foreground/40` for every status. So the AC's premise
is half counterfactual, and inventing a colour table to satisfy it would be building UI for a
requirement nobody has. Recorded rather than papered over.

The AC as it can honestly be met: **the fallback is the slug itself.** It is never empty,
never `undefined`, always identifies the status, and needs no palette. The styling fallback is
the neutral styling every status already gets, unchanged.

`statusOptions` appending `current` when it is missing is the same rule applied to the picker.
A `<select value="x">` with no matching `<option>` renders **blank**, and the next change event
would move the ticket somewhere the user never chose — the status silently lost. Cheap to
prevent, so prevented.

### A ticket whose status matches no column does not render

Stated, tested, and deliberately not fixed. The composite fk makes an orphan impossible in the
database, and the phase gate means a partially-loaded status list never reaches the grid. Adding
an "Unknown" column would be inventing UI for a state the schema forbids, and SPRIN-80 explicitly
owns *"after deletion no ticket references a status that no longer exists"*.

The risk worth guarding is not the behaviour but its **silence** — a vanished ticket with nothing
red is the failure mode this epic's schema design was built to avoid. So it gets a named test and
a docblock pointing at SPRIN-80, rather than being left to be rediscovered.

---

## 5. The detail dialog follows the board

`TICKET_STATUSES` has two other consumers, and leaving them on constants would be incoherent:
a ticket could be dragged into a fifth column that the picker cannot name.

- **`TicketDetailSidebar`** takes `statuses` and `statusesPhase` and renders its options from
  the rows, exactly as it already does for the sprint picker.
- **`TicketDetailHeader`** takes a resolved `statusName: string`, not the list. It renders one
  label; handing it the whole array would give it a lookup responsibility it does not need and
  a second site where the fallback could drift.
- **`TicketDetailDialog`** gains `statuses?: ProjectStatus[]` (default `[]`) and
  `statusesPhase?: ReadPhase` (default `'loading'`), mirroring `sprints` / `sprintsPhase`
  including the defaults, so a standalone render stays honest.

**The status picker becomes disabled while the list is loading.** Its docblock currently reads
*"this is never disabled: the option list is a compile-time constant, so there is no loading
state to be honest about"* — and that premise is exactly what this story removes. An enabled
picker over an empty list shows a blank value and offers nothing. It now follows the sprint
picker's pattern, and the docblock is rewritten rather than left contradicting the code.

`TicketDetailSidebar` measures at cyclomatic 9/10, so option-list assembly goes in
`statusOptions` rather than inline — one spare branch is not somewhere to spend a `??`.

---

## 6. Drag targets the slug, never the id

The story's scope bullet says drag "targets a status id rather than a hard-coded name". Taken
literally that is wrong and would corrupt data: `tickets.status` is `text`, fk'd to
`project_statuses.slug`, so writing `status.id` would write a uuid into it and the fk would
reject the write.

Keying on the slug was SPRIN-79's deliberate choice, *precisely* so no ticket row is rewritten
when the vocabulary changes. `handleDrop(status.slug)` honours that. The AC means "a value
derived from the row rather than a literal", and the slug is that value.

---

## 7. Testing

Every guard below gets a break-it step: mutate, watch the **named** test fail, quote the
output, revert. For early-return guards, run **both** mutations — delete and invert — because a
guard whose fallback path is a superset of its guarded path is green when deleted and red when
inverted, and only the deletion answers "does this line carry its own weight".

| Where | What it pins |
|---|---|
| `project-statuses.test.ts` (new) | `statusName` returns the row's name; falls back to the slug for an unknown one. `statusOptions` preserves position order and appends a missing `current`. |
| `project-reads.test.ts` | `firstUnready`: failed beats loading **even when the loading read comes first**; source order within a kind; all-loaded → `null`. |
| `BoardTab.test.tsx` | Columns come from the rows, in `position` order. **A five-row fixture renders five columns** (AC2). Statuses failed → `LoadFailure`; loading → `Loading…`. A ticket with an unmatched status appears in no column. |
| `TicketDetailDialog.test.tsx` | Picker options come from the rows; picker disabled while loading; header renders the row's name; an unknown slug falls back to the slug. |
| `domain.test.ts` | The two SPRIN-79 bridging assertions are **deleted**. `DEFAULT_PROJECT_STATUSES` ↔ seed trigger stays. |
| `e2e/happy-path.spec.ts` | Unchanged, and must stay passing — the seeded names are the same strings it drives. Not the gate. |

Two traps carried from this project's own history:

- The five-column test must assert **five columns**, not "a column named X exists" — the
  latter passes with the four constants still in place.
- After deleting the bridging assertions, re-confirm `DEFAULT_PROJECT_STATUSES` is still pinned
  to both the schema doc and the live database. That chain must survive; it just stops routing
  through the board.

Drag is asserted at the **wiring** level only. jsdom has no `dataTransfer`; the real gesture
lives in the Playwright suite, which is not the gate. Do not claim drag is covered by `verify`.

---

## 8. Acceptance criteria

1. **The board renders identically for an existing project.** Four seeded rows, same names,
   same order. The grid classes are unchanged verbatim (`grid-cols-1 sm:grid-cols-2
   lg:grid-cols-4`) so the layout is byte-identical at four columns — a horizontal-scroll board
   is the more Jira-like answer at N columns but changes what exists today, so it is SPRIN-77's
   call, when a fifth status first becomes reachable.
2. **A fifth status row in a fixture produces a fifth column, with no code change.**
3. **Dragging persists the new status**, proven by the e2e test waiting on the PATCH; the
   Vitest suite proves the wiring only.
4. **An unknown status name still renders**, falling back to the slug (§4).
5. **`npm run verify` green; test-file GAP still 7**, with 0 skipped.

---

## 9. Decisions taken without asking, so they can be vetoed

1. `TicketStatus` widened to `string` (§3) — forced by AC2; the fk is the real guard now.
2. `firstUnready` extracted to `project-reads.ts` and made generic (§2.2, §2.3) — required by
   the cyclomatic wall; generic to preserve `LoadFailure`'s closed union.
3. AC4's colour map does not exist; the fallback is the slug (§4).
4. An orphan-status ticket renders in no column — tested, not fixed; SPRIN-80's ground (§4).
5. Grid classes left alone; N-column layout deferred to SPRIN-77 (§8.1).
6. Drag targets `slug`, not `id`, contrary to the scope bullet's literal wording (§6).
7. The status picker becomes disabled while loading — a forced consequence of the list becoming
   a fetch (§5).
8. The detail dialog is in scope even though every AC names the board, because it is a
   `TICKET_STATUSES` consumer and the constant is being deleted (§5).
