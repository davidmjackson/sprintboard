# SPRIN-74 — Configurable sprint cadence

**Epic:** SPRIN-74, the fourth of Rung 3's five and the smallest. **Designed 2026-08-09.**
**Next epic after this one is SPRIN-75 (teams, roles and permissions) — the security
boundary, deliberately last.**

Four stories, three migrations, all additive. Read this before planning any of them — and
**check every AC against the live schema before building it.** Epic SPRIN-71's design was
wrong about the migration needs of three of its six stories, and each time the story had to
override the paperwork. The facts in this file were re-derived from the database catalogue on
2026-08-09, not copied from `CLAUDE.md`.

---

## Goal

A project sets its own sprint length and start weekday. `CreateSprintDialog` pre-fills the
dates from that cadence instead of leaving them blank. **The pre-fill is a suggestion and
stays editable** — a team needing a one-off short sprint must not be blocked.

The epic also names a standing debt to clear: there is no database check on sprint date
ordering. `end_date < start_date` is rejected client-side only.

## What a cadence is

**Length in whole weeks, 1 to 4, plus a start weekday.** David's call, 2026-08-09.

That matches Jira's own duration picker and the project's north star — "enough of Jira's core
to stand in for it, and no more". The rejected alternative was a free integer day count
(1–60): more expressive, but more than Jira offers and it invites a 47-day sprint that then
needs its own validation at both edges. A team wanting a 10-day sprint expresses it as a
one-off manual edit, which the epic explicitly requires to keep working anyway.

## Where the cadence lives

**Two columns on `projects`.** David's call, 2026-08-09.

This mirrors the project's existing rule that core fields stay real columns rather than being
pushed into a flexible store — cadence is a core project setting, not a user-defined one. It
also pays down the SPRIN-82 wall rather than leaving it standing for the next story that
needs it (renaming a project is the obvious one).

Rejected: a 1:1 `project_cadence` table. It sidesteps the wall because a new table is born
with grants, but it is *more* migration work, not less — revoke `anon`, write an RLS policy,
add an fk index the advisor will lint anyway — and it splits one project's settings across
two tables for no product reason.

Also rejected: columns set at creation and never editable. It needs no grant at all
(`authenticated` already holds INSERT on `projects`), but a team that picks the wrong cadence
on day one could never change it, which fails the epic's own "must stay editable" spirit.

### The SPRIN-82 wall is real — verified live, 2026-08-09

```
projects.relacl → authenticated=ardDxtm     -- no `w`. No UPDATE.
                  anon=ardDxtm
information_schema.column_privileges for projects → no rows for anon/authenticated
```

So there are no column grants either. Story 2 is where this is paid down, and it owes
**three** things, not one. They are itemised under that story below.

## Schema and migrations

### Migration A — `docs/migrations/sprin-74-project-cadence.sql` (story 1)

```sql
alter table projects
  add column sprint_length_weeks int not null default 2
    constraint projects_sprint_length_weeks_range check (sprint_length_weeks between 1 and 4),
  add column sprint_start_weekday int not null default 1
    constraint projects_sprint_start_weekday_range check (sprint_start_weekday between 1 and 7);
```

**`not null` with defaults**, so every existing and future project has a cadence and the
pre-fill never needs a null branch. Defaults are two weeks starting Monday.

**Weekday is ISO: 1 = Monday … 7 = Sunday**, matching Postgres `isodow`, so any future SQL
agrees with the client for free.

`int` + `check`, never an enum — the same reasoning as the standing never-an-enum rule applied
to a numeric domain: widening 1–4 to 1–6 later is one line.

Kanban projects carry a cadence they never read. Deliberate: a nullable column would buy
nothing and cost a branch at every read site.

### Migration B — `docs/migrations/sprin-74-project-cadence-update.sql` (story 2)

```sql
grant update (sprint_length_weeks, sprint_start_weekday) on projects to authenticated;
```

Column-level UPDATE with **no table-level UPDATE**. That is what keeps `name`, `key` and
`project_type` immutable in the database rather than only in our code.

**This migration deliberately does NOT restate the whole grant state**, departing from
SPRIN-93's migration E precedent. `projects` also carries `anon=ardDxtm`, and a table-level
`revoke` to restate the ACL would cascade across privileges this epic has no business
touching. The full resulting ACL goes in the migration's header comment instead.

That comment is documentation and documentation is enforced by nothing — session 63's own
finding. **The enforcement here is behavioural**, in story 2's live tests: an owner can
update the two cadence columns; the same owner still gets `42501` updating `project_type`;
a cross-tenant update matches zero rows.

### Migration C — `docs/migrations/sprin-74-sprint-date-order.sql` (story 4)

```sql
alter table sprints
  add constraint sprints_end_not_before_start check (end_date >= start_date);
```

**No null guard, and adding one would be noise.** `end_date >= start_date` evaluates to
`null` when either side is null, and a `check` passes on `null`. A sprint with no dates, or
with only a start, stays legal — which matches `CreateSprintSchema`, where every field is
optional.

`>=` matches the client's `refine` exactly, so a same-day sprint is legal at both edges.

**Safe to apply, verified 2026-08-09:** the live `sprints` table holds 1 row, 0 of them with
`end_date < start_date`. Nothing to backfill.

## Code shape

### Types — `src/lib/domain.ts`

`Project` is `Omit<Tables<'projects'>, 'project_type'> & { project_type: ProjectType }`, so it
picks the new columns up the moment `database.types.ts` is regenerated. **That regeneration is
part of story 1**, not a follow-up.

```ts
export type SprintCadence = Pick<Project, 'sprint_length_weeks' | 'sprint_start_weekday'>

/** ISO weekdays, 1 = Monday … 7 = Sunday, in display order. */
export const SPRINT_WEEKDAYS = [
  { iso: 1, label: 'Monday' },
  { iso: 2, label: 'Tuesday' },
  { iso: 3, label: 'Wednesday' },
  { iso: 4, label: 'Thursday' },
  { iso: 5, label: 'Friday' },
  { iso: 6, label: 'Saturday' },
  { iso: 7, label: 'Sunday' },
] as const

export const SPRINT_LENGTH_WEEKS = [1, 2, 3, 4] as const
```

Weekday labels live in `domain.ts`, not in the `<select>`, for the same reason the four board
column names never lived in a component.

Functions take `SprintCadence`, the narrowest shape they read — following the established
`hasSprints(project: Pick<Project, 'project_type'>)` precedent.

### `src/lib/sprint-cadence.ts` — new (story 3)

Kept apart from `sprint-dates.ts`, whose one job is pinning calendar days to UTC. Cadence
arithmetic is a different concern and would blur it.

```ts
suggestSprintDates(input: {
  cadence: SprintCadence
  latestEndDate: string | null   // see below, ISO day, or null
  today: string                  // ISO day — injected, never an ambient clock
}): { startDate: string; endDate: string }
```

**`latestEndDate` is the maximum `end_date` across ALL of the project's sprints regardless of
status** — future, active and complete alike — with null end dates ignored, and `null` when no
sprint has one. Restricting it to non-complete sprints would be the wrong reading: the first
sprint created after a project's only sprint completed would then chain from nothing and
pre-fill a date in the past.

**The rule, with no branching between the two cases:** candidate = the day after
`latestEndDate`, or `today` when there is none; then advance forward — candidate itself
counting — to the first day whose ISO weekday matches `sprint_start_weekday`.

**End date is inclusive:** `start + lengthWeeks × 7 − 1 day`. A 2-week sprint starting Monday
the 1st ends Sunday the 14th.

That is load-bearing, not cosmetic. It makes the next sprint's candidate land exactly on the
cadence weekday, so consecutive sprints chain with no gap and no overlap. An exclusive end
would put every subsequent sprint one day late and the weekday rule would silently do the
correcting.

`latestEndDate` is derived from the sprints **already loaded in `ProjectShell`**, so the
pre-fill costs no new query.

Rejected alternatives for the pre-fill rule, both weaker:

- *Day after the latest end date, falling back to the weekday.* It silently abandons the
  weekday once anyone hand-edits one sprint's end date, and nothing tells you.
- *Next weekday occurrence on or after today, ignoring other sprints.* Simplest, but creating
  the next sprint while one is running pre-fills a start date **inside** the running sprint —
  and grooming the next sprint mid-sprint is the common path, not an edge case.

### Write path — `src/lib/projects.ts`

`updateProjectCadence(projectId, cadence)`, returning the tagged-result shape its neighbours
use. **`42501` gets its own tag.** It is the one user-visible signal that migration B has not
been applied; collapsing it into `'unknown'` would make a mis-applied migration look like a
network blip.

### Validation — `src/lib/cadence-schemas.ts` — new

Matches the existing one-domain-per-file convention (`sprint-`, `status-`, `field-`).
Validates at the client edge; the `check` constraints validate at the database edge.

### UI — `src/routes/CadenceSettings.tsx` — new

A section in `SettingsTab` beside `StatusSettings` and `CustomFieldSettings`, following their
shape exactly. **Read-only in story 1, a form in story 2.** It renders nothing for Kanban
projects, gated on `hasSprints`.

## The stories

**Build in this order.** Stories 2 and 3 both depend on story 1; story 4 is independent and
could land at any point.

**THE JIRA KEYS ARE NOT IN STORY ORDER.** They were created in parallel on 2026-08-09 and the
board raced — the same thing that happened to epic SPRIN-71, where stories 3 and 4 drew the
lowest numbers. Reading build order off the key numbers gives the wrong answer. Story 2, the
heavy one, carries the *highest* key.

| # | Story | Key | Migration |
|---|---|---|---|
| 1 | See a project's sprint cadence | **SPRIN-94** | A |
| 2 | Change the cadence | **SPRIN-97** | B (grants) |
| 3 | Pre-fill the create-sprint dates from the cadence | **SPRIN-96** | — |
| 4 | Reject a sprint that ends before it starts, in the database | **SPRIN-95** | C |

All four verified as children of SPRIN-74 via `parent = SPRIN-74`, not assumed from the
create calls returning success.

### Story 1 — See a project's sprint cadence

Ships the schema behind something visible, exactly as SPRIN-90 did for `project_fields`.

- **AC1** A project has a sprint cadence: a length in whole weeks and a start weekday.
- **AC2** Existing projects and newly created projects both default to **2 weeks, starting
  Monday**, with no user action.
- **AC3** The Settings tab shows the current cadence in plain language ("2 weeks, starting
  Monday"). Read-only in this story.
- **AC4** A Kanban project shows no cadence section at all.
- **AC5** The database rejects a length outside 1–4 and a weekday outside 1–7.

Also in scope: regenerate `database.types.ts`; add `SprintCadence`, `SPRINT_WEEKDAYS` and
`SPRINT_LENGTH_WEEKS` to `domain.ts`.

### Story 2 — Change the cadence

The heavy story. One migration, one feature, and the whole SPRIN-82 debt.

- **AC1** The Settings cadence section is a form: a length picker (1–4 weeks) and a weekday
  picker (Monday–Sunday).
- **AC2** Saving persists both values and the section reflects them after a reload.
- **AC3** A failure is reported to the user and the previous values remain shown. A `42501`
  is distinguished from a generic failure, because it means migration B is missing.
- **AC4** A user cannot change another user's project cadence.
- **AC5** `name`, `key` and `project_type` remain un-updatable by `authenticated` — the
  column grant must not widen to the table.

**The three debt items, each a concrete edit:**

1. **`src/test/project-type-immutability.test.ts:481`** — `'makes no update or upsert call
   against the projects table'` becomes an **allowlist**: an update to `projects` passes only
   if every key in its object literal is one of the two cadence columns. It **must fail
   closed** on an update whose keys it cannot read statically — that is the file's own stated
   doctrine ("an answer it cannot determine is a FAILURE, not a pass"), and it is what caught
   three type-valid `project_type` writes the earlier regex version let through. The
   docblock's asserted test count (line 541) moves with the change.
2. **`src/test/projects.integration.test.ts`** — the existing `"refuses the owner's own
   project_type UPDATE (revoked grant -> 42501)"` **stays green**. That is the proof the
   column grant did not widen to the table, and it is the disjoint-failure property that file
   already argues for. A new sibling asserts the owner *can* update both cadence columns and
   read them back.
3. **`src/test/rls.integration.test.ts`** — restore the cross-tenant UPDATE **row-count**
   assertion SPRIN-82 removed, now that there is finally a privilege for RLS to filter. It
   must count rows, not check for an error: RLS *filters* on `USING` and raises only on
   `WITH CHECK`, so B updating A's cadence returns `error === null` with **zero rows
   affected**, and A's values unchanged on re-read. An assertion expecting an error would
   pass on a successful cross-tenant write.

Where `42501` is asserted, **assert the message too**, not only the code. On this table it
already means two different controls — a revoked grant, and an RLS `WITH CHECK` violation on
a spoofed `owner_id` — and the existing tests discriminate on prose for exactly that reason.

### Story 3 — Pre-fill the create-sprint dates from the cadence

The epic's actual payload. No schema change.

- **AC1** Opening `CreateSprintDialog` pre-fills start and end dates from the project's
  cadence, per the rule above.
- **AC2** When the project has no sprint with an end date, the start is the next occurrence
  of the cadence weekday on or after today.
- **AC3** When it does, the start is the next occurrence of the cadence weekday strictly
  after the latest end date.
- **AC4** The end date is the start plus `length × 7 − 1` days.
- **AC5** **Both pre-filled dates remain editable**, and an edited value is what gets saved.
- **AC6** A Kanban project is unaffected — it has no sprints.

### Story 4 — Reject a sprint that ends before it starts, in the database

Clears the standing debt the epic names, closing the "validate at both edges" asymmetry that
`sprint-schemas.ts` admits to in its own docblock.

- **AC1** The database rejects a sprint whose `end_date` is before its `start_date`.
- **AC2** A sprint with equal start and end dates is accepted.
- **AC3** A sprint with either date null is accepted.
- **AC4** The client-side `refine` still rejects first, so a user never sees the database
  error.

## Testing notes

**Story 3's pure function carries the weight of the epic** and is exhaustively unit-testable
with the clock injected: no latest end date; a latest end date already *on* the cadence
weekday (must give the following week, never the same day); a latest end date the day before;
all 7 weekdays × all 4 lengths; month, year and leap-day boundaries. Plus the wiring test that
actually matters — the pre-filled dates are editable **and submit as edited**, since
"suggestion, not constraint" is the epic's explicit AC.

**Story 4** asserts a live insert of `end_date < start_date` earns `23514` **and** names
`sprints_end_not_before_start`. A bare SQLSTATE would pass if some other check fired.

**A watch item, not a task.** `src/lib/domain.ts` is already 654 lines. `max-lines` is
configured with comment skipping so it passes today, but story 1 adds to it. If it lands near
the 400 threshold, **split it — do not widen the max.** Widening reddens
`verify-gate.test.mjs` by design.

## Constraints carried from the epic and `CLAUDE.md`

- The `sprints_one_active_per_project` partial unique index is load-bearing and must not be
  worked around.
- **Migrations are hand-applied.** Produce the SQL, hand David one copy-paste command, run
  `get_advisors` afterwards and add no new lints. The baseline as of 2026-08-09 is **16
  performance / 1 security** — compare against that, never against zero, and re-derive it
  rather than trusting this line.
- One PR per story, squash merged. The Jira issue moves to Done only after merge, and **Jira
  does not close epics on its own** — SPRIN-74 needs a hand transition after its last story,
  checked with `parent = SPRIN-74`.
- Review depth is chosen by the diff. These are ordinary stories and get **one reviewer**.
  Story 2 touches grants and the RLS test suite, so it is the one to consider escalating —
  ask rather than assume, and note that a deep pass is not free.

## What this epic does NOT do

- It does not make `projects.name` editable. Story 2 grants UPDATE on **two columns only**.
  A rename story still owes its own grant, and story 2's allowlist guard will red on it —
  which is the guard working, not an obstacle.
- It does not touch the `auth_rls_initplan` advisor sweep. That belongs to SPRIN-75.
- It does not change sprint naming, the one-active-sprint rule, or `completeSprint`.
