# SPRIN-96 — Pre-fill the create-sprint dates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opening `CreateSprintDialog` offers start and end dates derived from the project's
sprint cadence, chained onto the project's latest sprint, and both remain editable.

**Architecture:** One new pure module, `src/lib/sprint-cadence.ts`, holds the whole rule and
reads no clock. `CreateDialog` gains an optional `onOpened` callback so the suggestion is
recomputed on every open rather than captured once at mount. `CreateSprintDialog` takes a new
required `cadence` prop and resets its form with the suggestion when the dialog opens.

**Tech Stack:** React 19, TypeScript strict, react-hook-form + zod, Vitest + Testing Library,
Tailwind/shadcn. No new dependency.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-08-09-sprin-96-prefill-sprint-dates-design.md`.
  Read it before writing code. The epic's spec is
  `docs/superpowers/specs/2026-08-09-sprin-74-sprint-cadence-design.md`.
- **No schema change, no migration, no grant, no policy, no new database read.** If a step seems
  to need one, stop and report — it means the plan is wrong.
- **Lint thresholds are errors, not warnings** (`npm run lint` = `eslint . --max-warnings 0`):
  T1 functions ≤ 30 lines, T2 cyclomatic ≤ 10, T3 cognitive ≤ 15, T4 ≤ 4 parameters, T5 files
  ≤ 400 lines (comments and blanks excluded). Write to them from the first line. **Never add an
  inline eslint-disable** — a genuine misfit is an ADR, and there is no misfit here.
- **Status/type/column vocabularies live in `src/lib/domain.ts` and nowhere else.** Import
  `SprintCadence` from there; never re-declare the two column names, and never write a weekday
  list of your own — `SPRINT_WEEKDAYS` exists.
- **All dates are ISO `YYYY-MM-DD` calendar days in UTC** at every boundary in this story. Never
  construct a `Date` from a bare `'YYYY-MM-DD'` string without the `T00:00:00.000Z` suffix, and
  never use a non-`getUTC*` accessor. A local-timezone read is the exact bug `sprint-dates.ts`
  was written to design out.
- **Test commands:** a single file is `npx vitest run <path>`. The fast local loop is
  `npm run test:unit`. **`npm test` runs the seven live integration suites, which CANNOT run on
  this machine** (placeholder Supabase config → `ENOTFOUND`, and they fail hard rather than
  skipping). Do not run `npm test`; do not "fix" those failures. The full gate is the
  orchestrator's job, not yours.
- **Formatting is gated** (`npm run format:check`). Run `npm run format` before committing.
- **Commit messages are imperative summaries.** Never pass a commit message via a heredoc —
  write it to a file and use `git commit -F <file>`.
- **The plan's code is a starting point, not gospel.** If an established repo pattern says
  otherwise, follow the repo and **report the deviation**. Prefer reporting BLOCKED over
  inventing a mechanism the plan does not describe.

---

### Task 1: The cadence arithmetic

**Files:**
- Create: `src/lib/sprint-cadence.ts`
- Create: `src/lib/sprint-cadence.test.ts`
- Modify: `src/lib/sprint-dates.ts` (append `todayUtc`)
- Modify: `src/lib/sprint-dates.test.ts` (append a `todayUtc` describe block)

**Interfaces:**
- Consumes: `formatSprintDate` from `./sprint-dates`; `Sprint` and `SprintCadence` types from
  `./domain`.
- Produces:
  - `latestSprintEnd(sprints: readonly Sprint[]): string | null`
  - `suggestSprintDates(input: { cadence: SprintCadence; latestEndDate: string | null; today: string }): { startDate: string; endDate: string }`
  - `todayUtc(): string` from `./sprint-dates`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/sprint-cadence.test.ts`. `sprint()` mirrors the fixture already in
`src/routes/CreateSprintDialog.test.tsx` — copy its shape so the two agree on `Sprint`.

```tsx
import { describe, expect, it } from 'vitest'

import { latestSprintEnd, suggestSprintDates } from './sprint-cadence'
import { SPRINT_LENGTH_WEEKS, SPRINT_WEEKDAYS, type Sprint } from './domain'

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    project_id: 'p1',
    name: 'Sprint 1',
    goal: null,
    status: 'future',
    start_date: null,
    end_date: null,
    created_at: '2026-07-16T00:00:00+00:00',
    ...overrides,
  }
}

/** 2026-07-13 is a Monday, so every weekday in July 2026 is one arithmetic step away. */
const MONDAY_CADENCE = { sprint_length_weeks: 2, sprint_start_weekday: 1 }

describe('latestSprintEnd', () => {
  it('is null for no sprints at all', () => {
    expect(latestSprintEnd([])).toBeNull()
  })

  it('is null when no sprint carries an end date', () => {
    expect(latestSprintEnd([sprint(), sprint({ id: 's2' })])).toBeNull()
  })

  it('takes the maximum across every status, not just the open ones', () => {
    // The completed sprint is the LATEST one. Skipping complete sprints would chain the
    // next sprint off the older future one and suggest a date in the past.
    const sprints = [
      sprint({ id: 's1', status: 'future', end_date: '2026-07-19T00:00:00+00:00' }),
      sprint({ id: 's2', status: 'complete', end_date: '2026-08-02T00:00:00+00:00' }),
      sprint({ id: 's3', status: 'active', end_date: null }),
    ]
    expect(latestSprintEnd(sprints)).toBe('2026-08-02')
  })

  it('compares UTC calendar days, not the raw timestamps', () => {
    // Same instant, two spellings, plus one late-evening timestamp: a lexical max over the
    // raw strings gets this wrong, a max over normalised days does not.
    const sprints = [
      sprint({ id: 's1', end_date: '2026-08-02T00:00:00Z' }),
      sprint({ id: 's2', end_date: '2026-08-01T23:30:00+00:00' }),
    ]
    expect(latestSprintEnd(sprints)).toBe('2026-08-02')
  })
})

describe('suggestSprintDates', () => {
  it('starts today when today is already the cadence weekday (AC2)', () => {
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2026-07-13' }),
    ).toEqual({ startDate: '2026-07-13', endDate: '2026-07-26' })
  })

  it('advances to the next cadence weekday after today (AC2)', () => {
    // Tuesday 14th -> the following Monday, six days on.
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2026-07-14' }),
    ).toEqual({ startDate: '2026-07-20', endDate: '2026-08-02' })
  })

  it('gives the FOLLOWING week when the latest end date is itself the cadence weekday (AC3)', () => {
    // Monday 13th ends the last sprint. Strictly after means Monday the 20th, never the 13th.
    expect(
      suggestSprintDates({
        cadence: MONDAY_CADENCE,
        latestEndDate: '2026-07-13',
        today: '2026-07-01',
      }),
    ).toEqual({ startDate: '2026-07-20', endDate: '2026-08-02' })
  })

  it('starts the very next day when the latest end date is the day before (AC3)', () => {
    expect(
      suggestSprintDates({
        cadence: MONDAY_CADENCE,
        latestEndDate: '2026-07-19',
        today: '2026-07-01',
      }),
    ).toEqual({ startDate: '2026-07-20', endDate: '2026-08-02' })
  })

  it('ignores today entirely once there is a latest end date', () => {
    // Today is far in the future; the chain still governs. Same answer as the case above.
    expect(
      suggestSprintDates({
        cadence: MONDAY_CADENCE,
        latestEndDate: '2026-07-19',
        today: '2027-01-01',
      }),
    ).toEqual({ startDate: '2026-07-20', endDate: '2026-08-02' })
  })

  it('chains with no gap and no overlap: the next start is the day after the last end', () => {
    // The product claim of the whole epic, asserted as a loop rather than believed.
    let latestEndDate: string | null = null
    const starts: string[] = []
    for (let i = 0; i < 4; i += 1) {
      const suggestion = suggestSprintDates({
        cadence: MONDAY_CADENCE,
        latestEndDate,
        today: '2026-07-13',
      })
      starts.push(suggestion.startDate)
      latestEndDate = suggestion.endDate
    }
    expect(starts).toEqual(['2026-07-13', '2026-07-27', '2026-08-10', '2026-08-24'])
  })

  it.each(SPRINT_WEEKDAYS.map((w) => w.iso))(
    'lands on ISO weekday %i whatever day it is asked on',
    (weekday) => {
      // Every day of one full week as "today", against every cadence weekday: the start is
      // always on the cadence weekday, and never in the past.
      for (const today of ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19']) {
        const { startDate } = suggestSprintDates({
          cadence: { sprint_length_weeks: 2, sprint_start_weekday: weekday },
          latestEndDate: null,
          today,
        })
        const day = new Date(`${startDate}T00:00:00.000Z`).getUTCDay()
        expect(day === 0 ? 7 : day).toBe(weekday)
        expect(startDate >= today).toBe(true)
      }
    },
  )

  it.each(SPRINT_LENGTH_WEEKS)('makes a %i-week sprint end inclusively (AC4)', (weeks) => {
    const { startDate, endDate } = suggestSprintDates({
      cadence: { sprint_length_weeks: weeks, sprint_start_weekday: 1 },
      latestEndDate: null,
      today: '2026-07-13',
    })
    expect(startDate).toBe('2026-07-13')
    const spanDays =
      (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000
    expect(spanDays).toBe(weeks * 7 - 1)
  })

  it('crosses a month boundary', () => {
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2026-07-27' }),
    ).toEqual({ startDate: '2026-07-27', endDate: '2026-08-09' })
  })

  it('crosses a year boundary', () => {
    // Monday 2026-12-28 + 13 days inclusive lands in 2027.
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2026-12-28' }),
    ).toEqual({ startDate: '2026-12-28', endDate: '2027-01-10' })
  })

  it('crosses 29 February in a leap year', () => {
    // 2028 is the next leap year. Monday 2028-02-21 + 13 days inclusive = 2028-03-05,
    // which is only right if 29 Feb exists.
    expect(
      suggestSprintDates({ cadence: MONDAY_CADENCE, latestEndDate: null, today: '2028-02-21' }),
    ).toEqual({ startDate: '2028-02-21', endDate: '2028-03-05' })
  })
})
```

Append to `src/lib/sprint-dates.test.ts`:

```tsx
describe('todayUtc', () => {
  it('is the UTC calendar day, in the same shape an <input type="date"> holds', () => {
    expect(todayUtc()).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(todayUtc()).toBe(new Date().toISOString().slice(0, 10))
  })
})
```

…and widen that file's import to `import { formatSprintDate, todayUtc, toUtcMidnight } from './sprint-dates'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/sprint-cadence.test.ts src/lib/sprint-dates.test.ts`
Expected: FAIL — `Failed to resolve import "./sprint-cadence"`, and `todayUtc is not a function`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/sprint-cadence.ts`:

```tsx
import { formatSprintDate } from './sprint-dates'
import type { Sprint, SprintCadence } from './domain'

/**
 * The suggested dates for a project's next sprint: ISO calendar days, in the shape an
 * `<input type="date">` holds.
 *
 * Pure and clock-free by construction — `today` is a parameter — so every rule below is a
 * table test rather than something that depends on the day the suite runs.
 */
export type SprintDateSuggestion = { startDate: string; endDate: string }

/** A calendar day plus `days`, via UTC so month, year and leap-day rollover are the
 *  platform's problem. Never a local-timezone accessor: that is the bug `sprint-dates.ts`
 *  exists to design out. */
function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** 1 = Monday … 7 = Sunday, matching Postgres `isodow` and `SPRINT_WEEKDAYS`. `getUTCDay`
 *  returns 0 for Sunday, and this is the single place that difference is reconciled. */
function isoWeekday(isoDate: string): number {
  const day = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay()
  return day === 0 ? 7 : day
}

/**
 * The latest `end_date` across ALL of a project's sprints — future, active and complete
 * alike — as a UTC calendar day, or null if none has one.
 *
 * Every status counts. Skipping complete sprints would chain the next sprint off an older
 * one and suggest a date in the past, which is the manual arithmetic this story removes.
 *
 * Each value goes through `formatSprintDate` BEFORE comparison. A raw `timestamptz` is not
 * lexically comparable — `'…T00:00:00+00:00'` and `'…Z'` are the same instant and different
 * strings — but a UTC calendar day is, exactly.
 */
export function latestSprintEnd(sprints: readonly Sprint[]): string | null {
  return sprints.reduce<string | null>((latest, sprint) => {
    if (!sprint.end_date) return latest
    const day = formatSprintDate(sprint.end_date)
    return latest === null || day > latest ? day : latest
  }, null)
}

/**
 * Where the project's next sprint should start and end, given its cadence.
 *
 * ONE rule, with no branch between "no sprints yet" and "chained onto the last one":
 *
 *   candidate = latestEndDate + 1 day, or today when there is none
 *   start     = the first day, candidate included, on the cadence weekday
 *   end       = start + length × 7 − 1 days
 *
 * The `+ 1 day` is what makes AC3's *strictly after* fall out of the arithmetic rather than
 * out of a comparison someone can get backwards: a latest end date that is itself the cadence
 * weekday yields the FOLLOWING week, never the same day.
 *
 * The end date is INCLUSIVE, hence `− 1`. That is load-bearing rather than cosmetic: it is
 * what makes the next sprint's candidate land exactly on the cadence weekday, so consecutive
 * sprints chain with no gap and no overlap. An exclusive end would push every sprint after
 * the first a week late, and only the SECOND sprint a project creates would show it.
 *
 * The double modulo is not superstition: `%` in JavaScript keeps the sign of the dividend, so
 * a cadence weekday below the candidate's would otherwise give a negative offset and a start
 * date in the past.
 *
 * No range guard on the cadence: the database constrains 1–4 and 1–7 and the settings form
 * offers nothing else. This stays total for any integer — it cannot throw or loop — so a bad
 * value shows as a visibly wrong date rather than a dialog that will not open. Unlike
 * `cadenceSummary`, there is no honest fallback to render here; inventing one would only
 * disguise the input.
 */
export function suggestSprintDates(input: {
  cadence: SprintCadence
  latestEndDate: string | null
  today: string
}): SprintDateSuggestion {
  const candidate = input.latestEndDate ? addDays(input.latestEndDate, 1) : input.today
  const offset = (((input.cadence.sprint_start_weekday - isoWeekday(candidate)) % 7) + 7) % 7
  const startDate = addDays(candidate, offset)
  return { startDate, endDate: addDays(startDate, input.cadence.sprint_length_weeks * 7 - 1) }
}
```

Append to `src/lib/sprint-dates.ts`:

```tsx
/** Today as a UTC calendar day. The ONLY clock read in the cadence pre-fill — everything
 *  downstream takes the day as a parameter, so it is testable without fake timers. */
export function todayUtc(): string {
  return formatSprintDate(new Date().toISOString())
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/sprint-cadence.test.ts src/lib/sprint-dates.test.ts`
Expected: PASS, all tests.

Then `npm run lint` — expected: clean, 0 errors.

- [ ] **Step 5: Prove the tests are not vacuous**

Do all four, one at a time, reverting each before the next. Record what went red for each:

1. Change `addDays(input.latestEndDate, 1)` to `addDays(input.latestEndDate, 0)` — the
   "FOLLOWING week" test must fail.
2. Change `− 1` in the end-date expression to `+ 0` — the inclusive-end and chaining tests
   must fail.
3. Drop the outer `+ 7) % 7` (leaving a bare `%`) — at least one weekday case must fail.
4. In `latestSprintEnd`, compare `sprint.end_date` directly instead of `formatSprintDate(...)`
   — the "UTC calendar days, not raw timestamps" test must fail.

If any mutation leaves the suite green, the test is wrong — fix the test, not the mutation.

- [ ] **Step 6: Format and commit**

```bash
npm run format
git add src/lib/sprint-cadence.ts src/lib/sprint-cadence.test.ts src/lib/sprint-dates.ts src/lib/sprint-dates.test.ts
git commit -F <message file>
```

Message summary: `Add the sprint cadence date arithmetic (SPRIN-96)`

---

### Task 2: `CreateDialog` gains `onOpened`

**Files:**
- Modify: `src/routes/CreateDialog.tsx`
- Modify: `src/routes/CreateDialog.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `CreateDialog` accepts `onOpened?: () => void`, called on each open transition,
  before the dialog's content mounts. `onClosed` behaviour is unchanged.

- [ ] **Step 1: Write the failing test**

In `src/routes/CreateDialog.test.tsx`, add `onOpened` to the `Harness` props (type
`onOpened?: () => void`, passed straight through to `CreateDialog`), then add:

```tsx
it('fires onOpened on every open, so a caller can recompute defaults it captured at mount', async () => {
  const onOpened = vi.fn()
  render(<Harness onOpened={onOpened} onSubmit={(_values, { close }) => close()} />)

  const user = await open()
  expect(onOpened).toHaveBeenCalledTimes(1)

  // Close it the way a successful create does, then open it again.
  await user.click(screen.getByRole('button', { name: 'Create thing' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await open()

  // Twice, not once: a caller whose defaults depend on props that changed between the two
  // opens has no other moment to recompute them.
  expect(onOpened).toHaveBeenCalledTimes(2)
})

it('does not fire onOpened when the dialog closes', async () => {
  const onOpened = vi.fn()
  const onClosed = vi.fn()
  render(<Harness onOpened={onOpened} onClosed={onClosed} onSubmit={(_v, { close }) => close()} />)

  const user = await open()
  await user.click(screen.getByRole('button', { name: 'Create thing' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

  expect(onClosed).toHaveBeenCalledTimes(1)
  expect(onOpened).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/routes/CreateDialog.test.tsx`
Expected: FAIL — `onOpened` is not a prop of `CreateDialog`, so it is never called
(`expected 1, received 0`), plus a TypeScript error on the harness prop.

- [ ] **Step 3: Write the implementation**

In `src/routes/CreateDialog.tsx`, add `onOpened` to the destructured props and to the prop
type, immediately before `onClosed` in both:

```tsx
  onOpened,
  onClosed,
```

```tsx
  onOpened?: () => void
  onClosed?: () => void
```

Then restructure `handleOpenChange`:

```tsx
  function handleOpenChange(next: boolean) {
    openGeneration.current += 1
    setOpen(next)
    if (next) {
      onOpened?.()
      return
    }
    form.reset()
    // The latch is per-attempt, not permanent: a close/reopen clears it alongside the draft,
    // with no call site needing to remember to.
    setLatched(false)
    onClosed?.()
  }
```

Add to the component's docblock, beside the existing `onClosed` sentence:

```
 * `onOpened` runs on the open transition, for a caller whose form defaults depend on props
 * that may have changed since mount. `useForm` captures `defaultValues` once and this shell's
 * `form.reset()` restores exactly those, so a caller computing a default from live props has
 * no other moment to recompute it — see `CreateSprintDialog`'s cadence pre-fill, where the
 * second sprint a user creates is the case that goes wrong without it.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/routes/CreateDialog.test.tsx src/routes/CreateProjectDialog.reopen.test.tsx src/routes/CreateTicketDialog.test.tsx src/routes/CreateProjectDialog.test.tsx`
Expected: PASS — including every existing `CreateDialog` test, unchanged. The other two call
sites pass no `onOpened` and must behave exactly as before.

Then `npm run lint` — expected: clean.

- [ ] **Step 5: Prove the test is not vacuous**

Delete the `onOpened?.()` line and re-run: the two new tests must fail. Restore it. Then move
`onOpened?.()` into the `else` branch and re-run: the "does not fire on close" test must fail.
Restore.

- [ ] **Step 6: Format and commit**

```bash
npm run format
git add src/routes/CreateDialog.tsx src/routes/CreateDialog.test.tsx
git commit -F <message file>
```

Message summary: `Let a create dialog recompute its defaults on open (SPRIN-96)`

---

### Task 3: Wire the pre-fill into the create-sprint dialog

**Files:**
- Modify: `src/routes/CreateSprintDialog.tsx`
- Modify: `src/routes/CreateSprintDialog.test.tsx`
- Modify: `src/routes/SprintsTab.tsx` (the `<CreateSprintDialog>` call site)
- Modify: `src/routes/SprintsTab.test.tsx` (fixture only)

**Interfaces:**
- Consumes: `latestSprintEnd`, `suggestSprintDates` (Task 1); `todayUtc` (Task 1);
  `CreateDialog`'s `onOpened` (Task 2); `SprintCadence` from `@/lib/domain`.
- Produces: `CreateSprintDialog` takes a new **required** prop
  `cadence: SprintCadence`. Nothing later depends on this task.

- [ ] **Step 1: Write the failing tests**

In `src/routes/CreateSprintDialog.test.tsx`:

Add the clock stub beside the existing `@/lib/sprints` mock — a partial mock, so
`formatSprintDate` and `toUtcMidnight` stay real:

```tsx
vi.mock('@/lib/sprint-dates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sprint-dates')>()),
  // 2026-07-14 is a Tuesday, so a Monday cadence must move the suggestion forward.
  todayUtc: vi.fn(() => '2026-07-14'),
}))
```

Add a cadence fixture and pass it on **every** `render(<CreateSprintDialog … />)` in the file:

```tsx
const cadence = { sprint_length_weeks: 2, sprint_start_weekday: 1 }
```

Then add:

```tsx
it('pre-fills both dates from the cadence when there are no sprints yet (AC1, AC2, AC4)', async () => {
  render(<CreateSprintDialog projectId="p1" cadence={cadence} existing={[]} />)
  await open()

  // Tuesday the 14th -> the next Monday, and a 2-week sprint ends inclusively 13 days later.
  expect(screen.getByLabelText('Start date')).toHaveValue('2026-07-20')
  expect(screen.getByLabelText('End date')).toHaveValue('2026-08-02')
})

it('chains the pre-fill onto the latest sprint end date (AC3)', async () => {
  const existing = [sprint({ end_date: '2026-08-02T00:00:00+00:00' })]
  render(<CreateSprintDialog projectId="p1" cadence={cadence} existing={existing} />)
  await open()

  // The 2nd is a Sunday; the day after is the cadence Monday, so no week is skipped.
  expect(screen.getByLabelText('Start date')).toHaveValue('2026-08-03')
  expect(screen.getByLabelText('End date')).toHaveValue('2026-08-16')
})

it('saves an edited date rather than the suggested one (AC5)', async () => {
  render(<CreateSprintDialog projectId="p1" cadence={cadence} existing={[]} />)
  const user = await open()

  await user.clear(screen.getByLabelText('End date'))
  await user.type(screen.getByLabelText('End date'), '2026-07-26')
  await user.click(screen.getByRole('button', { name: 'Create sprint' }))

  await waitFor(() =>
    expect(createSprint).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-07-20', endDate: '2026-07-26' }),
    ),
  )
})

it('recomputes the pre-fill on a REOPEN, against the sprint just created', async () => {
  // The staleness case: `useForm` captures defaults once, so a pre-fill computed at mount
  // would re-offer the dates of the sprint the user just made.
  const created = sprint({ id: 's9', end_date: '2026-08-02T00:00:00+00:00' })
  vi.mocked(createSprint).mockResolvedValue({ ok: true, sprint: created })

  function Host() {
    const [existing, setExisting] = useState<Sprint[]>([])
    return (
      <CreateSprintDialog
        projectId="p1"
        cadence={cadence}
        existing={existing}
        onCreated={(s) => setExisting((prev) => [...prev, s])}
      />
    )
  }

  render(<Host />)
  const user = await open()
  expect(screen.getByLabelText('Start date')).toHaveValue('2026-07-20')

  await user.click(screen.getByRole('button', { name: 'Create sprint' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  await open()

  expect(screen.getByLabelText('Start date')).toHaveValue('2026-08-03')
  expect(screen.getByLabelText('End date')).toHaveValue('2026-08-16')
})
```

`useState` and `Sprint` need importing in that file (`import { useState } from 'react'`,
and `Sprint` is already imported as a type).

**Two existing tests in this file now assert a false premise and must be updated honestly,
not deleted:**

- `'creates a sprint with a typed name, goal and dates'` — the date inputs are no longer
  empty, so `user.type` would append to the suggestion. Add `await user.clear(...)` before
  each of the two `user.type` calls on the date fields. The assertion is otherwise unchanged.
- `'creates with every field blank — the name is optional'` — the dates are no longer blank.
  Change its expectation to the suggested values (`startDate: '2026-07-20'`,
  `endDate: '2026-08-02'`), and rename it to
  `'creates with the name and goal blank, sending the suggested dates'`. **Do not** make it
  assert `undefined` dates by clearing the fields — that would delete the AC1 evidence.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/routes/CreateSprintDialog.test.tsx`
Expected: FAIL — a TypeScript error for the unknown `cadence` prop, and the pre-fill
assertions receiving `''`.

- [ ] **Step 3: Write the implementation**

In `src/routes/CreateSprintDialog.tsx`, add the imports:

```tsx
import { latestSprintEnd, suggestSprintDates } from '@/lib/sprint-cadence'
import { todayUtc } from '@/lib/sprint-dates'
import type { Sprint, SprintCadence } from '@/lib/domain'
```

Add the prop (required — an unwired call site must be a compile error, not a silently
unprefilled dialog):

```tsx
export function CreateSprintDialog({
  projectId,
  cadence,
  existing,
  onCreated,
}: {
  projectId: string
  cadence: SprintCadence
  existing: readonly Sprint[]
  onCreated?: (sprint: Sprint) => void
}) {
```

Add the handler beside `onSubmit`:

```tsx
  /**
   * The suggestion is computed on every OPEN, never once at mount.
   *
   * `useForm` captures `defaultValues` a single time and `CreateDialog`'s close resets to
   * exactly those, so a pre-fill living in `defaultValues` goes stale the moment `existing`
   * changes — and the most ordinary flow in this story changes it: create a sprint, then
   * create the next one. The second open would re-offer the dates of the first.
   *
   * `reset` rather than two `setValue` calls: it replaces the whole draft, so a reopen after
   * a cancelled attempt starts clean instead of keeping a half-typed name beside fresh dates.
   */
  function prefillDates() {
    const { startDate, endDate } = suggestSprintDates({
      cadence,
      latestEndDate: latestSprintEnd(existing),
      today: todayUtc(),
    })
    form.reset({ name: '', goal: '', startDate, endDate })
  }
```

And pass it: `onOpened={prefillDates}` on the `<CreateDialog>` element.

Extend the component docblock with a sentence naming the suggestion and pointing at
`sprint-cadence.ts` for the rule — the rule itself must not be re-stated here.

In `src/routes/SprintsTab.tsx`, pass the project through:

```tsx
          <CreateSprintDialog
            projectId={project.id}
            cadence={project}
            existing={sprints}
            onCreated={onSprintCreated}
          />
```

In `src/routes/SprintsTab.test.tsx`, give the project fixture real cadence columns (a fixture
that lies about its shape is how a test passes for the wrong reason):

```tsx
const project = {
  id: 'p1',
  name: 'Sprintboard',
  key: 'SPB',
  project_type: 'scrum',
  sprint_length_weeks: 2,
  sprint_start_weekday: 1,
} as Project
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/routes/CreateSprintDialog.test.tsx src/routes/SprintsTab.test.tsx`
Expected: PASS.

Then the whole unit suite and the linter:

Run: `npm run test:unit` — expected: PASS, no failures anywhere else.
Run: `npm run lint` — expected: clean.
Run: `npx tsc -b --noEmit` — expected: clean.

- [ ] **Step 5: Prove the wiring is not vacuous**

One at a time, reverting each:

1. Change `onOpened={prefillDates}` to `onClosed={prefillDates}` — the reopen test must fail.
   (This is the crossed-wire case a deletion mutation cannot find.)
2. Replace `latestSprintEnd(existing)` with `null` — the chaining test must fail.
3. Delete `cadence={project}` from `SprintsTab.tsx` — this must be a **compile** error, not a
   silent pass. If it compiles, the prop was made optional somewhere; fix that.

- [ ] **Step 6: Format and commit**

```bash
npm run format
git add src/routes/CreateSprintDialog.tsx src/routes/CreateSprintDialog.test.tsx src/routes/SprintsTab.tsx src/routes/SprintsTab.test.tsx
git commit -F <message file>
```

Message summary: `Pre-fill the create-sprint dates from the cadence (SPRIN-96)`

---

## Coverage against the spec

| AC | Where |
|---|---|
| AC1 pre-fills on open | Task 3, first new dialog test |
| AC2 next weekday on/after today | Task 1, two `latestEndDate: null` tests + the weekday table |
| AC3 strictly after the latest end | Task 1, the "FOLLOWING week" and "day before" tests; Task 3 chaining test |
| AC4 end = start + length × 7 − 1 | Task 1, the `SPRINT_LENGTH_WEEKS` table |
| AC5 editable, saved as edited | Task 3, the edited-date test |
| AC6 Kanban unaffected | Already pinned by `SprintsTab.test.tsx`'s redirect test (SPRIN-82). No new code, no new test — see the spec. |
| Recompute on reopen | Task 2's `onOpened` tests + Task 3's reopen test |
