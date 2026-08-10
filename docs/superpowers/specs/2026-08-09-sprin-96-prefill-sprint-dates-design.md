# SPRIN-96 — Pre-fill the create-sprint dates from the cadence

**Story 3 of 4 in epic SPRIN-74.** Designed 2026-08-09. **No schema change, no migration.**
Read `docs/superpowers/specs/2026-08-09-sprin-74-sprint-cadence-design.md` first; this file
records only what that one leaves open, plus the decisions taken while building.

Story 1 (SPRIN-94) added the two cadence columns and `SprintCadence`/`SPRINT_WEEKDAYS` to
`domain.ts`. Story 2 (SPRIN-97) made them editable. **This story is the epic's payload:** the
create-sprint dialog stops asking a user to work the dates out by hand.

---

## The acceptance criteria (from the tracker, unchanged)

- **AC1** Opening `CreateSprintDialog` pre-fills start and end dates from the project's cadence.
- **AC2** With no sprint having an end date, the start is the next occurrence of the cadence
  weekday **on or after today**.
- **AC3** With one, the start is the next occurrence of the cadence weekday **strictly after**
  the latest end date.
- **AC4** The end date is the start plus `length × 7 − 1` days.
- **AC5** **Both pre-filled dates remain editable**, and an edited value is what gets saved.
- **AC6** A Kanban project is unaffected — it has no sprints.

Every AC was checked against the live schema and the current code before this design was
written. `projects.sprint_length_weeks` (1–4) and `projects.sprint_start_weekday` (1–7, ISO,
1 = Monday) exist and are read by `ProjectShell`'s `.select()` (no column list, so all columns
arrive). `sprints.start_date` / `end_date` are nullable `timestamptz`. Nothing here needs a
column that does not exist, and no AC required reinterpretation.

---

## The rule, stated once and with no branch

AC2 and AC3 read as two cases. They are not, and collapsing them is the single most important
design decision in this story:

```
candidate = latestEndDate ? latestEndDate + 1 day : today
start     = the first day, candidate itself counting, whose ISO weekday is sprint_start_weekday
end       = start + (sprint_length_weeks × 7 − 1) days
```

Two `if`s become none. Check it against both ACs:

- **No latest end date, today is already the cadence weekday** → candidate is today, which
  matches → start is today. That is "on or after today". ✓
- **Latest end date falls ON the cadence weekday** → candidate is the next day, which does not
  match, so the search runs six more days → the **following week's** cadence weekday. That is
  "strictly after", and it is the case the epic's testing notes single out ("must give the
  following week, never the same day"). The `+1 day` is what makes *strictly* after fall out of
  the arithmetic rather than out of a comparison someone can get backwards. ✓

**The end date is INCLUSIVE**, which is why `− 1`. A 2-week sprint starting Monday the 1st ends
Sunday the 14th. This is load-bearing rather than cosmetic: it is exactly what makes the next
sprint's candidate (the 15th) land **on** the cadence weekday, so consecutive sprints chain with
no gap and no overlap. An exclusive end date would put every subsequent sprint a week later than
the cadence promises, and the defect would only appear on the *second* sprint a project creates.

### `latestEndDate` spans every sprint, whatever its status

The maximum `end_date` across **all** the project's sprints — future, active and complete alike
— with null end dates ignored.

Restricting it to non-complete sprints is the tempting reading and it is wrong: a project whose
only sprint has just completed would chain from nothing and pre-fill a date in the past, which
is precisely the manual arithmetic this story exists to remove.

The sprints are already in hand. `ProjectShell` loads them, `SprintsTab` renders them, and
`CreateSprintDialog` already receives them as `existing` for `defaultSprintName`. **No new
query.**

---

## Where the code goes

### `src/lib/sprint-cadence.ts` — new, pure, clock-free

Kept apart from `sprint-dates.ts`, whose one job is pinning a calendar day to UTC in both
directions (`toUtcMidnight`, `formatSprintDate`). That module is deliberately two lines of
conversion with no arithmetic in it; cadence arithmetic is a different concern and would be the
larger half of the file if merged.

```ts
export function latestSprintEnd(sprints: readonly Sprint[]): string | null
export function suggestSprintDates(input: {
  cadence: SprintCadence
  latestEndDate: string | null
  today: string
}): { startDate: string; endDate: string }
```

Both speak ISO `YYYY-MM-DD` calendar days — the same vocabulary `<input type="date">` and
`CreateSprintSchema`'s lexical ordering check already use. No `Date` object crosses the
boundary, so no caller can hand this module a value whose timezone it must guess.

**`latestSprintEnd` maps each `end_date` through `formatSprintDate` BEFORE comparing.** A raw
`timestamptz` from PostgREST is not lexically comparable — `'…T00:00:00+00:00'` and `'…Z'` are
the same instant and different strings, and a row written by some other path could carry a
non-UTC offset. Reduced to a UTC calendar day first, lexical `>` is exactly date order. Taking
the max of the raw strings would be the kind of comparison that is right on today's data and
silently wrong later.

An options object, not three positional parameters: three positional strings-and-numbers at a
call site read as a puzzle, and T4 caps parameters at four in any case.

### The clock is injected, never read inside

`suggestSprintDates` takes `today` and never calls `new Date()`. `todayUtc()` joins
`sprint-dates.ts` beside the other two UTC conversions and is the only thing in this story that
reads a clock. Every rule in the epic's testing notes — all 7 weekdays × all 4 lengths, month,
year and leap-day boundaries — is then a plain table test with no fake timers and no dependence
on the machine's date.

### Date arithmetic

`addDays` and `isoWeekday` are private to `sprint-cadence.ts`. Both parse the day as midnight UTC
(the `T00:00:00.000Z` suffix `toUtcMidnight` already uses) and stay inside the `getUTC*` /
`setUTCDate` family, so month, year and leap-day rollover are the platform's problem, not ours,
and no local timezone enters. `getUTCDay`
returns 0 for Sunday, so it is mapped to ISO 7 at the single point it is read — the numbering
matches Postgres `isodow` everywhere else in this codebase and must not fork here.

The weekday step is `((target − dow) % 7 + 7) % 7` days. The double modulo is not superstition:
a bare `%` in JavaScript keeps the sign of the dividend, so a `target` below `dow` would yield a
negative offset and a start date in the past. Adding 1 to the candidate before the search is what
makes the zero case mean "candidate itself qualifies" rather than needing a second branch.

**No range guard on the two cadence values.** The database constrains them (`between 1 and 4`,
`between 1 and 7`), `Project` makes both fields non-optional, and story 2's form only offers
legal values — so the function is total for every value that can actually reach it: it never
throws and never loops forever for a real cadence, and an out-of-range-but-still-plausible value
produces a wrong-looking date rather than a crashed dialog. (It is not total for an arbitrary
integer — a `sprint_length_weeks` in the tens of millions overflows what `Date` can represent
and throws — but no path a real user can take supplies one.) That is a deliberate non-guard,
unlike `cadenceSummary`'s out-of-range fallback, which exists because there it has an *honest*
thing to render (the raw number). A date has no honest fallback, so inventing one would only
disguise the input.

---

## Wiring: the pre-fill is recomputed on every open

This is the part with a real trap in it, and it is not visible from the ACs.

`CreateDialog` calls a bare `form.reset()` when it closes, which restores the values `useForm`
captured **at mount**. `SprintsTab` mounts `CreateSprintDialog` once, for the lifetime of the
tab. So a pre-fill computed in `defaultValues` would be computed once, and the most ordinary
flow in the story breaks it: create a sprint, then create the next one. The second open would
re-offer the dates of the sprint just created — the exact stale-dates failure AC3 exists to
prevent. (This is the same class as the recorded `useForm`-defaults-survive-a-route-rerender
trap; here the stale input is a prop rather than a route param.)

**`CreateDialog` gains an optional `onOpened?: () => void`**, symmetric with the `onClosed` it
already has, called on the open transition. `CreateSprintDialog` uses it to
`form.reset({ …, startDate, endDate })` with values computed from the props *as they are at that
moment*. Rejected alternatives, both of which look simpler and are wrong:

- **Recompute in `onClosed`.** The close fires inside the submit continuation, in the same
  handler as `onCreated`, so `existing` on that render is still the list *without* the sprint
  just created. It would reset to stale values with more ceremony.
- **`key={sprints.length}` on the dialog in `SprintsTab`.** Remounts to refresh the defaults, but
  also destroys a user's in-progress draft whenever the sprint list changes underneath them, and
  ties a component's identity to an unrelated number.

Resetting only on **open** — not on every render — is what keeps AC5 true: once the dialog is
open, the pre-filled values are ordinary form state and a user's edits survive until they close
it. The submitted value is whatever the field holds, which is already how the dialog works; AC5
needs a test, not a mechanism.

Deliberately **out of scope**: recomputing the end date when the user edits the start. The ACs
ask for a pre-fill, not a live calculator, and a field that rewrites itself under the cursor is a
different feature with its own surprises.

### How the dialog learns the cadence

A new **required** prop, `cadence: SprintCadence`, passed `cadence={project}` from `SprintsTab`
(a `Project` is assignable to the two-column `Pick`). Required rather than optional with a
default, so an unwired call site is a compile error instead of a silently unprefilled dialog —
the repo's existing "narrowest shape it reads" convention, matching `hasSprints`, `doneSlugs` and
`cadenceSummary`.

`SprintsTab`'s existing fixtures build a project with `as Project` and no cadence columns. They
gain real values, because a fixture that lies about its shape is how a test passes for the wrong
reason.

### AC6 needs no new code and no new test

`SprintsTab` already returns `<Navigate to="../board" replace />` for a project without sprints
(SPRIN-82 AC2), and `SprintsTab.test.tsx` already asserts it. A Kanban project never reaches the
dialog, so "unaffected" is a property of a guard that exists and is already pinned. Adding a
second test of the same redirect here would assert SPRIN-82's work, not this story's.

---

## Testing

**The pure function carries the weight**, and it is exhaustively testable because the clock is a
parameter:

- No latest end date: today on the cadence weekday (start is today), and today the day after it
  (start is six days later).
- A latest end date **on** the cadence weekday → the following week, never the same day.
- A latest end date the day before the cadence weekday → the next day.
- All 7 weekdays × all 4 lengths, generated as a table, asserting both the start's weekday and
  the inclusive end offset.
- Month, year and leap-day boundaries (2028 is the next leap year; February 2028 is the case).
- `latestSprintEnd`: empty list, all-null end dates, a mix, and rows carrying a non-`Z` UTC
  offset — the case that proves the `formatSprintDate` normalisation is doing something.
- **Chaining**, as one test that reads like the product claim: feed a suggestion's own end date
  back in as `latestEndDate` and assert the next start is exactly the day after.

**At the dialog**, the tests that matter are the wiring ones, and they must fail if the wiring is
cut:

- Opening pre-fills both inputs with the computed values (AC1–AC4 end to end, clock stubbed).
- **Editing a pre-filled date submits the edited value** (AC5) — the epic's own named test.
- **Reopening after a create recomputes**: the staleness case above, asserted with the second
  open showing dates derived from the newly created sprint. This is the test the `onOpened` prop
  exists for; without it the test goes red.

Per-field assertions read the input's `value`, not an accessible name, and the dialog tests stub
the clock at the module boundary rather than with fake timers, so nothing in the suite depends on
the day it runs.

---

## What this story does not touch

No migration, no grant, no policy, no change to `SPRINT_CADENCE_COLUMNS`, and no new read. The
only shared file it modifies is `CreateDialog`, additively, with one optional prop. The database
still has no check on sprint date ordering — that is **SPRIN-95**, story 4, deliberately separate.
