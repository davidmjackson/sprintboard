# SPRIN-64 — Guard the sprint lifecycle against stale-status transitions

**Date:** 2026-07-30
**Epic:** SPRIN-6 (E6 Sprints)
**Decided under autopilot.** No exception applied: no migration, no RLS/auth/secret/CI-gate
change, nothing parked, and the ACs were checked against the code and schema before design.

---

## The defect

`startSprint` and `completeSprint` (`src/lib/sprints.ts`) filter on `id` alone.

`SprintsTab` gates the buttons by status — `Start` renders only for `future`, `Complete` only
for `active` (`SprintsTab.tsx:133-138`). That gate is a **render-time** check against a list
fetched once into `ProjectShell` and patched locally. Any stale render — a second tab, a second
window, a transition that landed elsewhere — still shows the old button, and the data layer
accepts the call.

**The sharp edge: `startSprint` on a `complete` sprint flips it back to `active`.** The
`sprints_one_active_per_project` partial unique index constrains `status = 'active'` only
(`schema.sql:117`), so with no other active sprint in the project nothing rejects it. A completed
sprint is resurrected to active having already returned its incomplete tickets to the backlog and
banked its Done tickets as history. There is no database constraint against this and no test.

**The second edge, which shapes the whole design: `completeSprint` writes twice, tickets first.**
The ticket move runs before the status flip *deliberately* — the flip is the commit marker, so a
sprint that reads `complete` is never one with incomplete tickets still attached (the reasoning is
in the function's doc comment and it is sound). Called on a `future` sprint that has tickets, it
strips their `sprint_id` and then marks the sprint complete.

## Acceptance criteria

- **AC1** — `startSprint` only starts a sprint currently `future`. `active` or `complete` is
  rejected and left unchanged.
- **AC2** — `completeSprint` only completes a sprint currently `active`. `future` or `complete` is
  rejected **and no tickets are moved.**
- **AC3** — The rejection surfaces a distinct, user-correctable message — the view is stale,
  refresh — not the generic "Something went wrong."
- **AC4** — Existing guarantees preserved: `23505` still tags `already_active`; the
  ticket-move-before-flip order still holds; a missing or cross-tenant id still collapses to
  `unknown` and confirms nothing about existence.

## Approach

**Chosen: a precondition read, then the existing writes with a compare-and-swap filter added to
the status flip.**

A small shared helper reads the sprint's current status and checks it against the transition's
precondition:

```ts
type StatusGuard = { ok: true } | { ok: false; error: 'stale' | 'unknown' }
async function requireSprintStatus(id: string, expected: SprintStatus): Promise<StatusGuard>
```

- Read errors, or zero rows (missing **or** cross-tenant, which RLS makes indistinguishable and
  must stay so) → `unknown`.
- Row present, status ≠ expected → `stale`, **before any write.**
- Row present, status = expected → proceed.

Then each transition adds its own status filter to the update it already performs —
`.eq('status', 'future')` on the start, `.eq('status', 'active')` on the complete's flip. The
precondition read is the gate; the filter closes the window between the read and the write. A
zero-row match on an update whose precondition just passed is a concurrent transition, so it
also maps to `stale`.

Why the guard is expressed the same way in both functions, at the cost of one extra round trip on
start: the read is what makes `stale` distinguishable from `unknown` **honestly**. A conditional
update alone yields zero rows for "wrong status", "deleted" and "another owner's" alike, so any
message it produced would be a guess. These are click-driven actions, not a hot path.

### Rejected alternatives

- **Schema-level enforcement** (a trigger or check encoding the transition graph). The correct
  long-term home, and it is a migration — a stop-and-ask case under autopilot, and the schema here
  is a document David applies by hand, not repo-managed migrations. Out of scope for this story;
  the app-layer guard is what the ACs ask for. Noted as a follow-up.
- **Conditional update only, no precondition read.** One round trip, and strictly *worse* than
  today for `completeSprint`: the ticket move has already run when the flip fails, so a `future`
  sprint's tickets are stripped and the call then reports failure. Fails AC2.
- **Invert `completeSprint`'s write order** so the conditional flip runs first and doubles as the
  compare-and-swap. Rejected: the existing order is deliberate. Flipping first fails unsafe — a
  `complete` sprint with incomplete tickets still attached, tickets that are then invisible in the
  backlog *and* owned by a closed sprint. That is the worse of the two partial states, which is
  exactly why the order is the way it is. Overturning it is a bigger call than this story needs.

## Error surface

```ts
export type StartSprintResult =
  | { ok: true; sprint: Sprint }
  | { ok: false; error: 'already_active' }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'unknown' }

export type CompleteSprintResult =
  | { ok: true; sprint: Sprint; returnedTickets: Ticket[] }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'unknown' }
```

Messages, both user-correctable and therefore distinct from the generic copy:

- `StartSprintButton`: "This sprint is no longer waiting to start. Refresh to see its current state."
- `CompleteSprintButton`: "This sprint is no longer active. Refresh to see its current state."

**Two doc comments become false and must be corrected in the same commit**, or they will mislead
the next reader into undoing this:

- `completeSprint`'s "No user-correctable failure exists here … so a single `'unknown'`" — no
  longer true; `stale` is user-correctable.
- `CompleteSprintButton`'s "Completing has no user-correctable failure (unlike Start's
  `already_active`), so there is a single generic message."

## Security property

The precondition read is an RLS-scoped `select`. For another owner's sprint it returns zero rows,
so the result is `unknown` and never `stale` — the guard cannot be used as an existence oracle.
This is the one property in the change worth attacking directly, so it gets both a unit test and a
live cross-tenant test, and the reviewer is briefed to try to break it. Under the new code a
cross-tenant `completeSprint` performs **no writes at all** (today its ticket move runs and is
filtered to zero rows by RLS) — a strict improvement, and asserted.

## Testing

Proof obligations, not a file list. Every rejection test must assert **the write did not happen**,
not merely that the error tag came back — a tag is a claim, an un-called mock is evidence.

**Unit (`src/lib/sprints.test.ts`)**
- `startSprint` on `active` and on `complete` → `stale`, **and `update` never called** (AC1).
- `startSprint` happy path still returns the sprint, and the update carries `('status','future')`.
- `startSprint` `23505` → `already_active` still (AC4).
- `startSprint` precondition read failure → `unknown`; zero-row update after a passing
  precondition → `stale`.
- `completeSprint` on `future` and on `complete` → `stale`, **and the tickets update never
  called** (AC2 — this is the assertion with teeth).
- `completeSprint` happy path: move still runs first, flip carries `('status','active')`.
- `completeSprint` precondition read failure → `unknown`, no ticket move.

**Component** — each button renders its distinct stale message, and it is not the generic copy
(AC3). Assert the specific string, so swapping it for the generic one goes red.

**Live (`src/test/sprints.integration.test.ts`)** — the headline defect proven against the real
database and the real partial index:
- Starting a `complete` sprint is rejected and the sprint stays `complete`. This is the
  resurrection bug; under the old code this test fails.
- Completing a `future` sprint **that has a ticket attached** is rejected and the ticket keeps its
  `sprint_id`. AC2 proven at the database, not at a mock.
- Cross-tenant: B completing A's active sprint → `unknown`, A's sprint still `active`, A's tickets
  untouched.

**Add no new sign-ins.** Extend the existing `describe`'s already-signed-in clients; each extra
sign-in feeds the known GoTrue rate-limit flake.

## Implementation hazards

- **The unit-test mock harness must change, and it is shared.** The `completeSprint` describe's
  `supabase.from` mock returns `{ update }` only, with no `select` — the precondition read breaks
  every existing test in that block until the harness provides one. The outer harness's `eq`
  returns `{ order }` only, which `listSprints` depends on; widening it to `{ order, single }`
  must not un-kill the existing `listSprints` assertions. Re-run the whole file after each harness
  edit, not just the new tests.
- **T1-T5 apply** — 30-line functions, cyclomatic 10, 4 parameters. The helper exists partly so
  neither transition function grows past the limit. `npm run lint` is `eslint . --max-warnings 0`
  and gates the merge.
- `status` writes stay `satisfies SprintStatusUpdate`; statuses come from `domain.ts`, never
  inlined as new literals beyond the filter values already named there.

## Out of scope

- **No schema migration.** Recorded as a follow-up: the transition graph belongs in a database
  trigger eventually.
- **The sprint picker still lists `complete` sprints** (`TicketDetailSidebar.tsx:120-122`). That is
  a documented deliberate decision — "barring a complete or active sprint is a rule no AC asks
  for" — and it is a *membership* rule, not a lifecycle one. Changing it is a separate story with
  its own argument. Left alone, deliberately, to keep this story one idea.
