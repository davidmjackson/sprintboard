# SPRIN-64 Sprint Lifecycle Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `startSprint` and `completeSprint` acting on a sprint whose status has moved under a stale view — most sharply, stop a `complete` sprint being flipped back to `active`.

**Architecture:** One private helper, `requireSprintStatus(id, expected)`, reads the sprint's current status through RLS and gates the transition **before any write**. Each transition additionally carries its precondition as a filter on the update it already performs (`.eq('status', …)`), a compare-and-swap that closes the window between the read and the write. The existing write order inside `completeSprint` — tickets first, status flip last as the commit marker — is preserved exactly.

**Tech Stack:** TypeScript (strict), React, supabase-js / PostgREST, Vitest, Testing Library.

## Global Constraints

- **`npm run lint` is `eslint . --max-warnings 0` over `**/*.{ts,tsx,mjs,js}` and it gates the merge.** T1-T5 as errors: 30-line functions, cyclomatic 10, cognitive 15, 4 parameters, 400-line files. Write to them from the first line. A genuine misfit is an ADR, **never an inline disable**.
- **Verify with `npm run verify`.** `npx tsc --noEmit` checks **zero files** in this repo and exits 0 — it is not a check. Never use it as evidence.
- **`npm test` must collect 7 more files than `npm run test:unit`.** Those seven are the live `*.integration.test.ts` suites. If the counts match, the live suites silently skipped and the run is a **failure**, however green.
- **Statuses come from `src/lib/domain.ts`.** `SprintStatus` is `'future' | 'active' | 'complete'`. Do not introduce a new status literal or a parallel list.
- **Never use a Postgres ENUM, and do not touch the schema at all in this story.** No migration, no constraint, no index. The guard is app-layer only.
- **Add no new `signIn()` calls to the integration suite.** Each one feeds a known GoTrue rate-limit flake. Extend the existing `describe`'s already-signed-in clients.
- **Never follow `signIn()` with `auth.getUser()`.** Use `userId(client)`.
- `status` writes keep `satisfies SprintStatusUpdate`; the ticket write keeps `satisfies TicketUpdate`.
- **A stale comment is a defect.** Where this change makes an existing doc comment false, correct it in the same task.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/lib/sprints.ts` | The data layer for sprints. Gains `requireSprintStatus` and the two guarded transitions. | Modify |
| `src/lib/sprints.test.ts` | Unit proof of the guard, including "the write never happened". | Modify |
| `src/routes/StartSprintButton.tsx` | Surfaces the new `stale` message for a start. | Modify |
| `src/routes/CompleteSprintButton.tsx` | Surfaces the new `stale` message for a complete. | Modify |
| `src/routes/StartSprintButton.test.tsx` | Pins the start message string. | Modify |
| `src/routes/CompleteSprintButton.test.tsx` | Pins the complete message string. | Modify |
| `src/test/sprints.integration.test.ts` | Live proof against the real database and the real partial index. | Modify |

No new files. The helper is private to `sprints.ts` — it has one caller pair and exporting it would invite use as a general-purpose read, which it is not (it returns a verdict, not a sprint).

---

### Task 1: The guard helper and `startSprint`

**Files:**
- Modify: `src/lib/sprints.ts:104-122` (the `StartSprintResult` type and `startSprint`)
- Test: `src/lib/sprints.test.ts` (outer mock harness + the `startSprint` describe at :186-213)

**Interfaces:**
- Produces, for Task 2: `requireSprintStatus(id: string, expected: SprintStatus): Promise<SprintStatusGuard>` where `type SprintStatusGuard = { ok: true } | { ok: false; error: 'stale' | 'unknown' }`. Both are module-private (not exported).
- Produces, for Task 3: `StartSprintResult` gains a fourth member, `{ ok: false; error: 'stale' }`.

**Read this before you start:** the outer mock harness at the top of `sprints.test.ts` is **shared with `createSprint` and `listSprints`**. Its `eq` mock currently returns `{ order }` only. You must widen it so the guard's read can chain `.single()`. Widening a shared fixture can silently un-kill assertions that already passed, so after every harness edit run the **whole file**, not just your new tests.

- [ ] **Step 1: Widen the shared mock harness so a guard read can be stubbed**

In `src/lib/sprints.test.ts`, add a `guardSingle` mock and make `eq` return it alongside `order`. Update the comment block that documents the chains.

```ts
// createSprint: from('sprints').insert(...).select().single()
// listSprints:  from('sprints').select().eq(...).order(...)
// guard read:   from('sprints').select('status').eq('id', ...).single()
// startSprint:  from('sprints').update(...).eq('id',...).eq('status',...).select().single()
const single = vi.fn()
const order = vi.fn()
const guardSingle = vi.fn()
const eq = vi.fn(() => ({ order, single: guardSingle }))
const select = vi.fn(() => ({ eq }))
```

and in the outer `beforeEach`, replace the `eq`/`select` resets and widen `updateEq` so the update can chain a second `.eq()`:

```ts
  guardSingle.mockReset()
  eq.mockReset()
  eq.mockReturnValue({ order, single: guardSingle })
  select.mockReset()
  select.mockReturnValue({ eq })
  ...
  updateSingle.mockReset()
  updateSelect.mockReset().mockReturnValue({ single: updateSingle })
  updateEq.mockReset().mockReturnValue({ eq: updateEq, select: updateSelect })
  update.mockReset().mockReturnValue({ eq: updateEq })
```

Also change the `updateEq` declaration so the self-referential chain type-checks:

```ts
const updateSingle = vi.fn()
const updateSelect = vi.fn(() => ({ single: updateSingle }))
const updateEq: ReturnType<typeof vi.fn> = vi.fn(() => ({
  eq: updateEq,
  select: updateSelect,
}))
```

- [ ] **Step 2: Run the whole file to confirm the harness widening broke nothing**

Run: `npx vitest run src/lib/sprints.test.ts`
Expected: PASS, same test count as before your edit. If any `listSprints` or `createSprint` test fails, the harness widening is wrong — fix it before adding a single new test.

- [ ] **Step 3: Write the failing tests for the guard on `startSprint`**

Add these to the `startSprint` describe. Every existing test in that describe now needs the guard read stubbed to `future`, or it will fail at the guard — that is expected and correct; update them.

```ts
describe('startSprint', () => {
  // Every start now passes a precondition read first: stub it to the status under test.
  function guardReturns(status: string | null, error: unknown = null) {
    guardSingle.mockResolvedValue({ data: status === null ? null : { status }, error })
  }

  it('sets status active and returns the updated sprint on success', async () => {
    guardReturns('future')
    const active = sprint({ status: 'active' })
    updateSingle.mockResolvedValue({ data: active, error: null })

    const result = await startSprint('s1')

    expect(update).toHaveBeenCalledWith({ status: 'active' })
    expect(updateEq).toHaveBeenCalledWith('id', 's1')
    // The compare-and-swap: the update itself refuses a sprint that left `future`
    // between the read and the write. Drop this filter and this assertion goes red.
    expect(updateEq).toHaveBeenCalledWith('status', 'future')
    expect(result).toEqual({ ok: true, sprint: active })
  })

  it('refuses to start an already-active sprint and writes nothing', async () => {
    guardReturns('active')

    const result = await startSprint('s1')

    expect(result).toEqual({ ok: false, error: 'stale' })
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses to start a completed sprint and writes nothing — no resurrection', async () => {
    // The headline defect. The partial unique index constrains `status = 'active'` only,
    // so with no other active sprint the database would happily flip this back to active.
    guardReturns('complete')

    const result = await startSprint('s1')

    expect(result).toEqual({ ok: false, error: 'stale' })
    expect(update).not.toHaveBeenCalled()
  })

  it('maps a failed precondition read to unknown and writes nothing', async () => {
    // Zero rows covers BOTH a deleted sprint and another owner's sprint — RLS makes them
    // indistinguishable and they must stay so. Never 'stale', which would confirm existence.
    guardReturns(null, { code: 'PGRST116' })

    const result = await startSprint('s1')

    expect(result).toEqual({ ok: false, error: 'unknown' })
    expect(update).not.toHaveBeenCalled()
  })

  it('maps the partial-unique-index violation (23505) to already_active', async () => {
    guardReturns('future')
    updateSingle.mockResolvedValue({ data: null, error: { code: '23505' } })

    const result = await startSprint('s2')

    expect(result).toEqual({ ok: false, error: 'already_active' })
  })

  it('maps any other error to unknown', async () => {
    guardReturns('future')
    updateSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116' } })

    const result = await startSprint('s3')

    expect(result).toEqual({ ok: false, error: 'unknown' })
  })
})
```

- [ ] **Step 4: Run the tests to verify the new ones fail**

Run: `npx vitest run src/lib/sprints.test.ts -t startSprint`
Expected: the three new guard tests FAIL (`startSprint` writes regardless of status, so `update` *is* called and the result is not `stale`).

- [ ] **Step 5: Implement the helper and the guarded `startSprint`**

In `src/lib/sprints.ts`, add the helper above `StartSprintResult` and rewrite `startSprint`. Import `SprintStatus` from `./domain`.

```ts
/**
 * A transition's precondition check. `stale` means the sprint exists and is in a DIFFERENT
 * status than the transition requires — the caller's view is out of date. `unknown` covers a
 * failed read and a zero-row match alike, and that conflation is deliberate: RLS makes
 * "deleted" and "another owner's" indistinguishable, and they must stay so. Returning `stale`
 * for a row we cannot see would turn this guard into an existence oracle.
 */
type SprintStatusGuard = { ok: true } | { ok: false; error: 'stale' | 'unknown' }

/**
 * Read a sprint's CURRENT status and check it against a transition's precondition.
 *
 * Why a read rather than only a filter on the update: `completeSprint` writes TWICE and the
 * destructive write (returning tickets to the backlog) comes FIRST, so a filter on its status
 * flip would fire only after the tickets had already moved. The gate has to precede the first
 * write. `startSprint` uses the same helper for the same error vocabulary — and because only a
 * read can tell `stale` from `unknown` honestly. These are click-driven actions, so the extra
 * round trip costs nothing that matters.
 *
 * This is NOT a general-purpose sprint read and is deliberately unexported: it returns a
 * verdict, not a sprint.
 */
async function requireSprintStatus(
  id: string,
  expected: SprintStatus,
): Promise<SprintStatusGuard> {
  const { data, error } = await supabase.from('sprints').select('status').eq('id', id).single()

  if (error || !data) return { ok: false, error: 'unknown' }
  return data.status === expected ? { ok: true } : { ok: false, error: 'stale' }
}
```

Then replace the `StartSprintResult` type and `startSprint`. Extend the existing doc comment rather than replacing it — the `23505` and RLS reasoning it carries is still true.

```ts
export type StartSprintResult =
  | { ok: true; sprint: Sprint }
  | { ok: false; error: 'already_active' }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'unknown' }

export async function startSprint(id: string): Promise<StartSprintResult> {
  const guard = await requireSprintStatus(id, 'future')
  if (!guard.ok) return guard

  const { data, error } = await supabase
    .from('sprints')
    .update({ status: 'active' } satisfies SprintStatusUpdate)
    .eq('id', id)
    .eq('status', 'future')
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: 'already_active' }
    return { ok: false, error: 'unknown' }
  }
  return { ok: true, sprint: data as Sprint }
}
```

Add to `startSprint`'s doc comment, above the existing text:

```
 * A sprint can only be started from `future`. `requireSprintStatus` is the gate; the
 * `status = 'future'` filter on the update is a compare-and-swap that closes the window
 * between the read and the write. A lost race there surfaces as `unknown` rather than
 * `stale` — the filter's job is to prevent the wrong write, not to produce a nice message,
 * and a retry hits the guard and reports `stale` correctly.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/sprints.test.ts`
Expected: PASS, all tests in the file including `createSprint` and `listSprints`.

- [ ] **Step 7: Prove the compare-and-swap filter is actually pinned**

Temporarily delete the `.eq('status', 'future')` line from `startSprint`, run `npx vitest run src/lib/sprints.test.ts -t "sets status active"`, and confirm it goes **RED**. Then restore the line and confirm green again. A filter no test can miss is dead weight a future tidy-up will remove.
Expected: RED without the line, PASS with it.

- [ ] **Step 8: Lint and commit**

```bash
npm run lint
git add src/lib/sprints.ts src/lib/sprints.test.ts
git commit -m "Guard startSprint against a stale sprint status (SPRIN-64)"
```

---

### Task 2: `completeSprint`

**Files:**
- Modify: `src/lib/sprints.ts:124-172` (the `CompleteSprintResult` type, `completeSprint`, and its doc comment)
- Test: `src/lib/sprints.test.ts` (the `completeSprint` describe at :242-318)

**Interfaces:**
- Consumes from Task 1: `requireSprintStatus(id, expected)` and `SprintStatusGuard`, both module-private in `sprints.ts`.
- Produces, for Task 3: `CompleteSprintResult` gains `{ ok: false; error: 'stale' }`.

**Read this before you start:** the `completeSprint` describe has **its own** `beforeEach` whose `supabase.from` mock returns `{ update: … }` with **no `select`**. The guard's read will throw `select is not a function` in every existing test in that block until you add one. This is the harness change; do it first and confirm the existing tests still pass before adding new ones.

- [ ] **Step 1: Give the `completeSprint` harness a guard read, and let the flip chain two `.eq()`s**

In the `completeSprint` describe, add the guard mocks and widen `sprintEq`:

```ts
describe('completeSprint', () => {
  // tickets:    update({sprint_id:null}).eq('sprint_id',id).neq('status','done').select()
  // guard read: from('sprints').select('status').eq('id', id).single()
  // sprints:    update({status:'complete'}).eq('id',id).eq('status','active').select().single()
  const ticketsSelect = vi.fn()
  const ticketsNeq = vi.fn(() => ({ select: ticketsSelect }))
  const ticketsEq = vi.fn(() => ({ neq: ticketsNeq }))
  const ticketsUpdate = vi.fn(() => ({ eq: ticketsEq }))

  const guardSingleC = vi.fn()
  const guardEq = vi.fn(() => ({ single: guardSingleC }))
  const guardSelect = vi.fn(() => ({ eq: guardEq }))

  const sprintSingle = vi.fn()
  const sprintSelect = vi.fn(() => ({ single: sprintSingle }))
  const sprintEq: ReturnType<typeof vi.fn> = vi.fn(() => ({
    eq: sprintEq,
    select: sprintSelect,
  }))
  const sprintUpdate = vi.fn(() => ({ eq: sprintEq }))

  /** Stub the precondition read. `null` status means the row was not visible. */
  function guardReturns(status: string | null, error: unknown = null) {
    guardSingleC.mockResolvedValue({ data: status === null ? null : { status }, error })
  }

  beforeEach(() => {
    ticketsSelect.mockReset()
    ticketsNeq.mockReset().mockReturnValue({ select: ticketsSelect })
    ticketsEq.mockReset().mockReturnValue({ neq: ticketsNeq })
    ticketsUpdate.mockReset().mockReturnValue({ eq: ticketsEq })
    guardSingleC.mockReset()
    guardEq.mockReset().mockReturnValue({ single: guardSingleC })
    guardSelect.mockReset().mockReturnValue({ eq: guardEq })
    sprintSingle.mockReset()
    sprintSelect.mockReset().mockReturnValue({ single: sprintSingle })
    sprintEq.mockReset().mockReturnValue({ eq: sprintEq, select: sprintSelect })
    sprintUpdate.mockReset().mockReturnValue({ eq: sprintEq })
    vi.mocked(supabase.from).mockReset()
    vi.mocked(supabase.from).mockImplementation(
      (table: string) =>
        (table === 'tickets'
          ? { update: ticketsUpdate }
          : { update: sprintUpdate, select: guardSelect }) as unknown as ReturnType<
          typeof supabase.from
        >,
    )
  })
```

Then add `guardReturns('active')` as the first line of each of the four **existing** tests in this describe, since every complete now passes the guard.

- [ ] **Step 2: Run the describe to confirm the harness change kept the existing tests green**

Run: `npx vitest run src/lib/sprints.test.ts -t completeSprint`
Expected: PASS — the four original tests, unchanged in meaning.

- [ ] **Step 3: Write the failing tests for the guard**

Add to the `completeSprint` describe:

```ts
  it('refuses to complete a future sprint and moves NO tickets', async () => {
    // The assertion with teeth. The ticket move runs BEFORE the status flip, so a guard that
    // only filtered the flip would strip sprint_id from this sprint's tickets and *then*
    // report failure — worse than no guard at all.
    guardReturns('future')

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: false, error: 'stale' })
    expect(ticketsUpdate).not.toHaveBeenCalled()
    expect(sprintUpdate).not.toHaveBeenCalled()
  })

  it('refuses to re-complete an already-complete sprint and moves NO tickets', async () => {
    guardReturns('complete')

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: false, error: 'stale' })
    expect(ticketsUpdate).not.toHaveBeenCalled()
    expect(sprintUpdate).not.toHaveBeenCalled()
  })

  it('maps a failed precondition read to unknown and moves NO tickets', async () => {
    // Zero rows is a deleted sprint OR another owner's — never distinguished, never 'stale'.
    guardReturns(null, { code: 'PGRST116' })

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: false, error: 'unknown' })
    expect(ticketsUpdate).not.toHaveBeenCalled()
  })
```

And extend the existing happy-path test to pin the compare-and-swap filter. Add this line beside the existing `expect(sprintEq).toHaveBeenCalledWith('id', 's1')`:

```ts
    // Compare-and-swap on the flip: closes the window between the guard read and the write.
    expect(sprintEq).toHaveBeenCalledWith('status', 'active')
```

- [ ] **Step 4: Run the tests to verify the new ones fail**

Run: `npx vitest run src/lib/sprints.test.ts -t completeSprint`
Expected: the three new tests FAIL (tickets are moved regardless of status), and the happy-path test FAILS on the new `('status','active')` assertion.

- [ ] **Step 5: Implement the guarded `completeSprint`**

Replace the type and function in `src/lib/sprints.ts`:

```ts
export type CompleteSprintResult =
  | { ok: true; sprint: Sprint; returnedTickets: Ticket[] }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'unknown' }

export async function completeSprint(id: string): Promise<CompleteSprintResult> {
  const guard = await requireSprintStatus(id, 'active')
  if (!guard.ok) return guard

  const { data: moved, error: ticketsError } = await supabase
    .from('tickets')
    .update({ sprint_id: null } satisfies TicketUpdate)
    .eq('sprint_id', id)
    .neq('status', 'done')
    .select()

  if (ticketsError) return { ok: false, error: 'unknown' }

  const { data, error } = await supabase
    .from('sprints')
    .update({ status: 'complete' } satisfies SprintStatusUpdate)
    .eq('id', id)
    .eq('status', 'active')
    .select()
    .single()

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, sprint: data as Sprint, returnedTickets: (moved ?? []) as Ticket[] }
}
```

- [ ] **Step 6: Correct the now-false doc comment**

`completeSprint`'s doc comment currently says:

> No user-correctable failure exists here (no unique index on `complete`; a re-complete and a re-null are both legal), so a single `'unknown'` like `createSprint`.

That is no longer true, and leaving it invites the next reader to delete the `stale` branch as redundant. Replace that sentence with:

```
 * A sprint can only be completed from `active`, and the gate has to precede the ticket move:
 * `requireSprintStatus` runs FIRST so a `future` or already-`complete` sprint is rejected
 * having moved nothing. A re-complete used to be silently legal and is now `stale` — a
 * user-correctable failure, so it gets its own tag and its own message. The
 * `status = 'active'` filter on the flip is a compare-and-swap for the window between the
 * read and the write; a lost race there is `unknown` and self-corrects on retry.
```

Leave the ORDER paragraph and the RLS paragraph exactly as they are — both are still true and both are load-bearing.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/lib/sprints.test.ts`
Expected: PASS, whole file.

- [ ] **Step 8: Prove the guard's placement is pinned, not just its existence**

Temporarily move the `requireSprintStatus` call to *after* the ticket move in `completeSprint`. Run `npx vitest run src/lib/sprints.test.ts -t "moves NO tickets"` and confirm it goes **RED** — this is the mutation that distinguishes a correct guard from a guard in the wrong place, which is the whole point of AC2. Restore the order and confirm green.
Expected: RED with the guard misplaced, PASS with it first.

- [ ] **Step 9: Lint and commit**

```bash
npm run lint
git add src/lib/sprints.ts src/lib/sprints.test.ts
git commit -m "Guard completeSprint against a stale sprint status (SPRIN-64)"
```

---

### Task 3: The two button messages

**Files:**
- Modify: `src/routes/StartSprintButton.tsx:36-40`
- Modify: `src/routes/CompleteSprintButton.tsx:7-14` (doc comment) and `:34`
- Test: `src/routes/StartSprintButton.test.tsx`, `src/routes/CompleteSprintButton.test.tsx`

**Interfaces:**
- Consumes from Tasks 1 and 2: `StartSprintResult` with `error: 'stale'`, `CompleteSprintResult` with `error: 'stale'`.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

In `src/routes/StartSprintButton.test.tsx`, add to the describe:

```ts
  it('shows a distinct refresh message when the sprint is no longer startable', async () => {
    mockStart.mockResolvedValue({ ok: false, error: 'stale' })
    const onStarted = vi.fn()

    render(<StartSprintButton sprint={sprint} onStarted={onStarted} />)
    await userEvent.click(screen.getByRole('button', { name: 'Start' }))

    // The exact string, so collapsing this back into the generic copy goes red.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sprint is no longer waiting to start. Refresh to see its current state.',
    )
    expect(onStarted).not.toHaveBeenCalled()
  })
```

In `src/routes/CompleteSprintButton.test.tsx`, add the mirror. Read the file first for its local mock and fixture names — it mocks `completeSprint` the same way `StartSprintButton.test.tsx` mocks `startSprint`, and its sprint fixture is `active`. Use the names already in that file rather than inventing new ones.

```ts
  it('shows a distinct refresh message when the sprint is no longer active', async () => {
    mockComplete.mockResolvedValue({ ok: false, error: 'stale' })
    const onCompleted = vi.fn()

    render(<CompleteSprintButton sprint={sprint} onCompleted={onCompleted} />)
    await userEvent.click(screen.getByRole('button', { name: 'Complete' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This sprint is no longer active. Refresh to see its current state.',
    )
    expect(onCompleted).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/routes/StartSprintButton.test.tsx src/routes/CompleteSprintButton.test.tsx`
Expected: both new tests FAIL — the generic "Something went wrong. Please try again." is rendered instead.

- [ ] **Step 3: Implement the start message**

In `src/routes/StartSprintButton.tsx`, replace the ternary in `handleStart` with a lookup keyed on the error tag. A third branch would push the ternary chain toward the cognitive-complexity limit, and a record is flatter and reads better:

```ts
const START_ERRORS: Record<'already_active' | 'stale' | 'unknown', string> = {
  already_active:
    'This project already has an active sprint. Complete it before starting another.',
  stale: 'This sprint is no longer waiting to start. Refresh to see its current state.',
  unknown: 'Something went wrong. Please try again.',
}
```

Declare it at module scope, above the component, and in `handleStart`:

```ts
    setError(START_ERRORS[result.error])
```

- [ ] **Step 4: Implement the complete message**

In `src/routes/CompleteSprintButton.tsx`, `handleComplete` currently ends with an unconditional `setError('Something went wrong. Please try again.')`. Replace it with:

```ts
    setError(
      result.error === 'stale'
        ? 'This sprint is no longer active. Refresh to see its current state.'
        : 'Something went wrong. Please try again.',
    )
```

Two branches, so a ternary is right here — do not add a record for two cases.

- [ ] **Step 5: Correct the now-false doc comment**

`CompleteSprintButton`'s doc comment says:

> Completing has no user-correctable failure (unlike Start's `already_active`), so there is a single generic message.

Replace that sentence with:

```
 * Completing has one user-correctable failure — `stale`, meaning the sprint left `active`
 * under a view this row was rendered from — so it gets its own message telling the user to
 * refresh. Everything else is the generic retry copy.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/routes/StartSprintButton.test.tsx src/routes/CompleteSprintButton.test.tsx`
Expected: PASS, both files whole — including the pre-existing `already_active` and `unknown` message tests, which the `START_ERRORS` refactor must not change.

- [ ] **Step 7: Lint and commit**

```bash
npm run lint
git add src/routes/StartSprintButton.tsx src/routes/StartSprintButton.test.tsx src/routes/CompleteSprintButton.tsx src/routes/CompleteSprintButton.test.tsx
git commit -m "Surface the stale-sprint rejection at the Start and Complete buttons (SPRIN-64)"
```

---

### Task 4: Live proof against the real database

**Files:**
- Modify: `src/test/sprints.integration.test.ts` — inside the existing `describe.skipIf(!hasRlsCredentials)('S6.3/S6.4 sprint lifecycle via startSprint/completeSprint', …)` block

**Interfaces:**
- Consumes: the block's existing helpers `newFutureSprint(name): Promise<string>` and `ticketInSprint(sprintId, status): Promise<string>`, its client `a`, and the real `startSprint` / `completeSprint` bound in its `beforeAll`.
- Produces: nothing downstream.

**Read this before you start:** this is a **live** suite against the shared Supabase project. Use the existing signed-in clients — **do not add a `signIn()` call, do not add a `beforeAll`, and never call `auth.getUser()`.** Extra sign-ins trip a known GoTrue rate limiter and turn CI red on healthy code. The block's `afterEach` already wipes tickets and sprints, so each test starts from zero.

- [ ] **Step 1: Write the failing live tests**

Add inside that describe, after the existing complete-sprint test:

```ts
    it('refuses to restart a completed sprint: no resurrection', async () => {
      // The headline defect, at the database. `sprints_one_active_per_project` constrains
      // `status = 'active'` ONLY, so with no other active sprint nothing here stops the flip —
      // before the guard this call returned ok:true and a completed sprint went live again,
      // having already returned its incomplete tickets to the backlog.
      const id = await newFutureSprint('Resurrect')
      expect((await startSprint(id)).ok).toBe(true)
      expect((await completeSprint(id)).ok).toBe(true) // positive control: really complete

      const result = await startSprint(id)
      expect(result).toEqual({ ok: false, error: 'stale' })

      const { data, error } = await a.from('sprints').select('status').eq('id', id).single()
      expect(error).toBeNull()
      expect(data!.status).toBe('complete')
    }, 30_000)

    it('refuses to complete a future sprint and leaves its tickets attached', async () => {
      // AC2 proven at the database, not at a mock. The ticket move runs before the status
      // flip, so a guard in the wrong place would strip this ticket's sprint_id and only
      // then fail — the assertion below is what catches that.
      const id = await newFutureSprint('Never started')
      const todoId = await ticketInSprint(id, 'todo')

      const result = await completeSprint(id)
      expect(result).toEqual({ ok: false, error: 'stale' })

      const { data: s } = await a.from('sprints').select('status').eq('id', id).single()
      expect(s!.status).toBe('future')
      const { data: t } = await a.from('tickets').select('sprint_id').eq('id', todoId).single()
      expect(t!.sprint_id).toBe(id)
    }, 30_000)
```

- [ ] **Step 2: Run the live suite to verify the new tests fail on the OLD behaviour**

You cannot see them fail against old code once Tasks 1-2 have landed, so instead verify they pass now and record that they are the tests that would have caught the defect. Run:

`npx vitest run src/test/sprints.integration.test.ts`

Expected: PASS, and **not skipped**. If the output says the file was skipped, the `RLS_TEST_*` env vars are missing — stop and report that, do not proceed. A skipped live suite is not a pass.

- [ ] **Step 3: Correct the two stale comments in the cross-tenant tests**

Both cross-tenant tests still pass, but their comments now describe the wrong mechanism — the precondition read is what fails first for user B, not the writes. Leaving them invites someone to conclude the guard is redundant.

In `"rejects starting another user's sprint…"`, replace the comment beginning "`sprints_owner` scopes the UPDATE through the owned project" with:

```ts
        // For B the precondition read matches ZERO rows (`sprints_owner` scopes it through the
        // owned project), so startSprint returns 'unknown' having written nothing at all —
        // never 'already_active' and never 'stale', either of which would confirm A's sprint
        // exists. The write path below it is never reached.
```

In `"rejects completing another user's sprint…"`, replace the comment beginning "Both statements filter to zero rows for B" with:

```ts
        // The precondition read matches zero rows for B, so completeSprint now returns
        // 'unknown' before ANY write — strictly better than before, when the ticket move ran
        // and was filtered to zero rows by RLS. 'unknown' never leaks existence.
```

- [ ] **Step 4: Re-run the live suite**

Run: `npx vitest run src/test/sprints.integration.test.ts`
Expected: PASS, not skipped, all tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/test/sprints.integration.test.ts
git commit -m "Prove the sprint lifecycle guard against the live database (SPRIN-64)"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| AC1 — start only from `future`, unchanged otherwise | Task 1 (unit) + Task 4 (live resurrection test) |
| AC2 — complete only from `active`, **no tickets moved** | Task 2 (unit, `ticketsUpdate` not called) + Task 4 (live, ticket keeps `sprint_id`) |
| AC3 — distinct user-correctable message | Task 3 |
| AC4 — `23505` still `already_active`; move-before-flip order held; cross-tenant still `unknown`, no leak | Task 1 (23505 test), Task 2 (happy path pins move-then-flip; guard-misplacement mutation), Task 4 (both existing cross-tenant tests, kept green, comments corrected) |
| `requireSprintStatus` helper, unexported | Task 1 |
| Both false doc comments corrected | Task 2 Step 6, Task 3 Step 5 |
| Security: guard is not an existence oracle | Task 1 Step 3 (`unknown` on zero rows), Task 2 Step 3, Task 4 Step 3 |
| No schema change | Enforced by Global Constraints; no task touches `docs/*.sql` |

**Type consistency:** `requireSprintStatus` / `SprintStatusGuard` are named identically in Tasks 1 and 2. `'stale'` is the tag everywhere — never `'not_startable'`, never `'conflict'`. `START_ERRORS` is keyed on exactly the three non-ok tags of `StartSprintResult`, so adding a tag later fails to compile rather than falling through to `undefined`.

**Placeholder scan:** none. Every code step carries the code.

**Known follow-up, not in scope:** the transition graph belongs in a database trigger eventually; the app-layer guard is what these ACs ask for and a migration is out of scope for this story.
