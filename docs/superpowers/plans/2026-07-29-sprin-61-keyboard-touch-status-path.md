# SPRIN-61 Keyboard and Touch Status Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give keyboard, screen-reader and touch users a way to change a ticket's status, which today is possible only by native HTML5 drag on the board.

**Architecture:** Add a native `<select>` for status as the first field of the ticket detail dialog's Details sidebar, writing through the existing `commit()` from `useTicketCommit`. No control is added to the board card: the keyboard/touch route to the dialog already exists because a card is a real `<button>`, and the dialog is shared with the Backlog, which has no status path at all. No schema, query, RLS or CI-gate change.

**Tech Stack:** React 19 + TypeScript (strict), Tailwind, shadcn/ui over the unified `radix-ui` package, Vitest + Testing Library (jsdom), Playwright (chromium).

**Spec:** `docs/superpowers/specs/2026-07-29-sprin-61-keyboard-touch-status-path-design.md`. Read it before Task 1.

## Global Constraints

These apply to **every** task. They are project rules, not preferences.

- **Never inline the four column names.** Status labels come from `TICKET_STATUS_LABELS` and the option order from `TICKET_STATUSES`, both in `src/lib/domain.ts`. This is a `CLAUDE.md` rule; inlining `'To Do'` in a component is a review rejection.
- **Never convert `status`/`type`/`project_type` to a Postgres `ENUM`.** They are `text` + `check` deliberately. This task touches no SQL at all, but do not "tidy" the domain unions toward one.
- **Native `<select>`, never radix `Select`,** for a fixed enum. Radix `Select` is flaky in jsdom; native tests cleanly with `userEvent.selectOptions`.
- **Verify with the project's own scripts.** `npx tsc --noEmit` checks **zero files** here (`files: []` + project references) and exits 0 — it proves nothing. Use `npm run build` for the type check and `npm run lint` for lint. Never report a type check based on `tsc --noEmit`.
- **Do not run `npm test` or `npm run verify`** in these tasks. They include live Supabase integration suites that sign in real users against GoTrue and can trip its auth rate limiter. Run only the single test file named in your task, via `npx vitest run <path>`. The controller runs the full gate once, at the end.
- **Do not run `npm run e2e`.** It signs up a real user against the live database.
- **Thresholds T1–T5 are ESLint errors** for `**/*.{ts,tsx}`: 30-line functions, cyclomatic 10, cognitive 15, 4 parameters, 400-line files. `max-lines-per-function` is **off for `.tsx`** and off for test files, so component size is not a concern here; `max-lines: 400` still applies to `.tsx`. Never add an inline `eslint-disable` — a genuine misfit is an ADR, not a disable.
- **Never use a heredoc for a commit message.** A global guard hook word-splits it. Use a plain single-line `git commit -m "..."`.
- **`rm -rf` is blocked by a guard hook.** You will not need it.
- **Commit messages use an imperative summary.**
- The dev server does not need to be running for any task.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/routes/TicketDetailSidebar.tsx` | Modify | Gains the Status `<select>` as the first field in the Details panel |
| `src/routes/TicketDetailDialog.test.tsx` | Modify | Structure, wiring, optimistic paint and rollback for the new control |
| `src/routes/TicketCard.test.tsx` | Modify | Pins the keyboard route *to* the dialog (Enter on a focused card) |
| `e2e/happy-path.spec.ts` | Modify | Proves the keyboard *gesture*, which jsdom structurally cannot |

No new files. No new dependencies.

---

## Task 1: The Status select

**Files:**
- Modify: `src/routes/TicketDetailSidebar.tsx` (imports at `:1-15`; insert the new field immediately after the opening `<h3>Details</h3>` at `:42-44`, **before** the Type `<label>` at `:46`)
- Test: `src/routes/TicketDetailDialog.test.tsx`

**Interfaces:**
- Consumes: `commit: (patch: TicketUpdate) => Promise<boolean>` — already a prop of `TicketDetailSidebar` (`:33`). `TICKET_STATUSES` and `TICKET_STATUS_LABELS` from `@/lib/domain`. `selectClass` from `./form-primitives`, `FieldLabel` from `./EditableText` — all three already imported or trivially added.
- Produces: a `combobox` with accessible name `status`. Later tasks and the E2E locate it by that name (`getByLabel('status')` in Playwright, `getByRole('combobox', { name: /status/i })` in Vitest). Do not rename it.

**Context you need:** `status` is already writable — it is absent from the `Omit` list of `TicketUpdate` in `src/lib/domain.ts`, and `updateTicket` already sends it for drag. There is no new data-layer work. Mirror the **Type** `<select>` directly above your insertion point (`:46-67`); yours is simpler because status has no "clears another field" rule.

- [ ] **Step 1: Write the failing tests**

Add this block to `src/routes/TicketDetailDialog.test.tsx`, inside the top-level `describe('TicketDetailDialog', ...)`. It uses the file's existing `base`, `user`, `updateTicket`, `deferred` and `UpdateTicketResult` — all already defined at the top of the file; add no new imports except `TICKET_STATUS_LABELS`, and only if you use it.

```tsx
  it('renders a status picker showing the ticket current status', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.getByRole('combobox', { name: /status/i })).toHaveValue('todo')
  })

  it('offers all four board columns as status options, in board order', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    const options = screen.getAllByRole('option').filter((o) =>
      (o as HTMLOptionElement)
        .closest('select')
        ?.getAttribute('aria-label')
        ?.match(/status/i),
    )
    expect(options.map((o) => o.textContent)).toEqual([
      'To Do',
      'In Progress',
      'In Review',
      'Done',
    ])
    expect(options.map((o) => (o as HTMLOptionElement).value)).toEqual([
      'todo',
      'in_progress',
      'in_review',
      'done',
    ])
  })

  it('keeps the status picker in the tab order and enabled, so a keyboard user can reach it', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    const select = screen.getByRole('combobox', { name: /status/i })
    expect(select).toBeEnabled()
    // A negative tabindex would remove it from sequential navigation while leaving it
    // clickable — the exact regression this story exists to prevent.
    expect(select).not.toHaveAttribute('tabindex')
  })

  it('commits a status change, sending status and nothing else', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, status: 'in_progress' } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /status/i }),
      'in_progress',
    )
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { status: 'in_progress' }))
  })

  it('applies the status change optimistically, before the write resolves', async () => {
    const pending = deferred<UpdateTicketResult>()
    updateTicket.mockReturnValue(pending.promise)
    const onUpdated = vi.fn()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: /status/i }),
      'in_review',
    )
    // The write has NOT resolved, yet the parent already has the new status.
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: 'in_review' }))
    await act(async () => {
      pending.resolve({ ok: true, ticket: { ...base, status: 'in_review' } })
    })
  })

  it('reverts only the status field and shows an error when the status write fails', async () => {
    // `error` is the literal type 'unknown', not a free string — any other value is a
    // compile error. See `UpdateTicketResult` in src/lib/tickets.ts.
    updateTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const onUpdated = vi.fn()
    function Harness() {
      const [t, setT] = useState({ ...base, summary: 'Original summary' })
      return (
        <TicketDetailDialog
          ticket={t}
          currentUser={user}
          onOpenChange={() => {}}
          onUpdated={(next) => {
            setT(next)
            onUpdated(next)
          }}
          onDeleted={() => {}}
        />
      )
    }
    render(<Harness />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /status/i }), 'done')

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    // Rolled back to the original status...
    expect(screen.getByRole('combobox', { name: /status/i })).toHaveValue('todo')
    // ...and the rollback did NOT revert the whole ticket to a stale snapshot.
    expect(onUpdated.mock.calls.at(-1)![0]).toMatchObject({
      status: 'todo',
      summary: 'Original summary',
    })
  })
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/routes/TicketDetailDialog.test.tsx`

Expected: the new tests FAIL. The first ones fail with `Unable to find an accessible element with the role "combobox" and name "/status/i"`. **Read the failure text.** If any new test passes before you have written the component change, that test is vacuous — stop and report it rather than proceeding.

- [ ] **Step 3: Add the Status select**

In `src/routes/TicketDetailSidebar.tsx`, extend the existing `@/lib/domain` import (`:3-11`) to include `TICKET_STATUSES`, `TICKET_STATUS_LABELS` and the `TicketStatus` type, keeping the existing members and the file's alphabetical-ish ordering:

```tsx
import {
  SPRINT_STATUS_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  type Sprint,
  type Ticket,
  type TicketStatus,
  type TicketType,
  type TicketUpdate,
} from '@/lib/domain'
```

Then insert this immediately after the `<h3>` "Details" heading and **before** the Type `<label>`:

```tsx
      {/* Status. First in the panel: it is the field the board is organised by, and the
          only one that had no keyboard or touch path at all before SPRIN-61 — drag was
          the sole way to change it, which excluded keyboard, screen-reader and touch
          users entirely. Unlike the Sprint picker below this is never disabled: the
          option list is a compile-time constant, so there is no loading state to be
          honest about. Options and labels both come from the domain module, so the
          picker and the board's four columns cannot drift apart. */}
      <label className="flex flex-col gap-1">
        <FieldLabel>Status</FieldLabel>
        <select
          aria-label="status"
          className={selectClass}
          value={ticket.status}
          onChange={(e) => commit({ status: e.target.value as TicketStatus })}
        >
          {TICKET_STATUSES.map((s) => (
            <option key={s} value={s}>
              {TICKET_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>
```

Note: `commit` is called without `void`/`await`, matching the Type and Assignee selects immediately below — the promise is deliberately unawaited because the write is optimistic and reports through the shared error banner.

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/routes/TicketDetailDialog.test.tsx`
Expected: PASS, with **no** test in the file newly failing. If an existing test broke, say so — do not "fix" an existing assertion to accommodate your change without reporting it.

- [ ] **Step 5: Lint and type-check**

Run: `npm run lint`
Expected: 0 errors, 0 warnings.

Run: `npm run build`
Expected: succeeds. (This is the real type check — `tsc --noEmit` checks nothing here.)

- [ ] **Step 6: Commit**

```bash
git add src/routes/TicketDetailSidebar.tsx src/routes/TicketDetailDialog.test.tsx
git commit -m "Add a status picker to the ticket detail sidebar (SPRIN-61)"
```

---

## Task 2: Pin the keyboard route to the dialog

**Files:**
- Test: `src/routes/TicketCard.test.tsx` (modify only)

**Interfaces:**
- Consumes: `TicketCard`'s existing `onOpen?: () => void` prop. Nothing from Task 1.
- Produces: nothing consumed by later tasks.

**Why this task exists:** the spec's argument is that the keyboard and touch route to the dialog *already works* because a board card is a real `<button>`. That claim is currently unpinned — every existing `TicketCard` test drives it with `userEvent.click`. If someone later changed the card to a `<div onClick=...>`, click-to-open would still pass and the whole keyboard path would silently break. This test makes that regression red. **No production code changes in this task.**

- [ ] **Step 1: Write the failing test**

Add to `src/routes/TicketCard.test.tsx`, inside the existing `describe('TicketCard', ...)`:

```tsx
  it('opens via the keyboard: Enter on the focused card (the keyboard route to the dialog)', async () => {
    const onOpen = vi.fn()
    render(<TicketCard ticket={ticket} onOpen={onOpen} />)
    const card = screen.getByRole('button', { name: /wire the board/i })
    card.focus()
    expect(card).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('is reachable by Tab (the card is a real button, not a clickable div)', async () => {
    render(<TicketCard ticket={ticket} onOpen={vi.fn()} />)
    await userEvent.tab()
    expect(screen.getByRole('button', { name: /wire the board/i })).toHaveFocus()
  })
```

- [ ] **Step 2: Run it and check it fails for the RIGHT reason**

Run: `npx vitest run src/routes/TicketCard.test.tsx`

These two tests are expected to **PASS immediately**, because the card is already a `<button>`. That is fine and expected — but a test that has never been seen to fail proves nothing, so you **must** now prove it can fail.

Temporarily change `src/routes/TicketCard.tsx`'s root element from `<button type="button" ...>` to `<div ...>` (removing `type="button"`), re-run the file, and confirm **both** new tests go RED. Then **revert the file with `git checkout src/routes/TicketCard.tsx`** — it has no uncommitted changes of yours, so this is safe here.

Record in your report: which tests went red, and their failure messages.

- [ ] **Step 3: Confirm the revert and re-run**

Run: `git diff --stat src/routes/TicketCard.tsx`
Expected: empty output (no changes).

Run: `npx vitest run src/routes/TicketCard.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: 0 errors, 0 warnings.

- [ ] **Step 5: Commit**

```bash
git add src/routes/TicketCard.test.tsx
git commit -m "Pin the keyboard route from a board card to the ticket dialog (SPRIN-61)"
```

---

## Task 3: Prove the keyboard gesture in Playwright

**Files:**
- Modify: `e2e/happy-path.spec.ts` (insert into step **4b**, between the sprint-assign `expect(assignResponse.ok()).toBeTruthy()` at `:128` and the `page.keyboard.press('Escape')` at `:129`)

**Interfaces:**
- Consumes: the already-open `detailDialog` locator (`:118`) and the `page` fixture. Nothing from Tasks 1–2 at the code level; it exercises Task 1's control.
- Produces: nothing consumed by later tasks.

**Why here:** the detail dialog is already open at step 4b to assign the sprint, so this leg reuses the existing fixture and adds **no** new signup. Adding a signup would spend the live-suite auth-rate-limit budget for nothing.

**Read first:** the two E2E rules this leg depends on. (1) Assert **persistence, not the optimistic paint** — wrap the action in `Promise.all([page.waitForResponse(...PATCH...), action()])` and assert `.ok()`; `updateTicket` uses `.select().single()`, so a zero-row update returns HTTP 406 and `.ok()` cannot be fooled. (2) Do **not** navigate away before the PATCH lands — a navigation cancels the in-flight request.

**Do not** give `e2e.yml` its own concurrency group, mark the `e2e` check required, or fold it into `npm run verify`. None of those are part of this task; they are named because they are the tempting adjacent "improvements" and all three are forbidden by `CLAUDE.md`.

- [ ] **Step 1: Write the new leg**

Insert after `expect(assignResponse.ok()).toBeTruthy()` (`:128`) and before `await page.keyboard.press('Escape')` (`:129`):

```ts
    // 4c. SPRIN-61: change the status with the KEYBOARD ALONE, no pointer at any step.
    //     This is the gesture the jsdom suite structurally cannot perform — it can assert
    //     the control's shape and wiring, never that a keyboard actually drives it.
    //     Tab from wherever focus currently sits until it lands on the status select.
    //     Radix traps focus inside the dialog, so this terminates; the cap turns a broken
    //     tab order into a clear failure instead of a hang.
    const statusSelect = detailDialog.getByLabel('status')
    let reachedStatus = false
    for (let i = 0; i < 40 && !reachedStatus; i++) {
      await page.keyboard.press('Tab')
      reachedStatus = await statusSelect.evaluate((el) => el === document.activeElement)
    }
    expect(reachedStatus).toBeTruthy()

    // The ticket is To Do (index 0), so one ArrowDown selects In Progress and fires
    // `change`. NOTE: on a focused closed <select>, ArrowDown changes the value directly
    // on Linux and Windows Chromium; on macOS it opens the popup instead. CI and this
    // project's dev environment are both Linux, so this is deterministic here.
    const [keyboardStatusResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/rest/v1/tickets') && r.request().method() === 'PATCH',
      ),
      page.keyboard.press('ArrowDown'),
    ])
    expect(keyboardStatusResponse.ok()).toBeTruthy()
    await expect(statusSelect).toHaveValue('in_progress')
```

- [ ] **Step 2: Type-check and lint**

Run: `npm run lint`
Expected: 0 errors, 0 warnings.

Run: `npm run build`
Expected: succeeds.

**Do NOT run `npm run e2e`** — it signs up a real user against the live database. The controller decides whether and when to run it.

- [ ] **Step 3: Confirm Vitest still ignores `e2e/**`**

Run: `npx vitest list --filesOnly | grep -c "e2e/"`
Expected: `0`. `vite.config.ts` excludes `e2e/**` because Playwright's `*.spec.ts` matches Vitest's default include glob. If this is not 0, **stop and report** — do not rename the spec; restore the exclude.

- [ ] **Step 4: Commit**

```bash
git add e2e/happy-path.spec.ts
git commit -m "Prove the keyboard status change end to end in a real browser (SPRIN-61)"
```

---

## Self-review notes (controller)

**Spec coverage.** AC1 keyboard → Task 1 (tab-order/enabled structure) + Task 2 (route to dialog) + Task 3 (the gesture). AC2 touch → rests on the native `<select>`, explicitly untested and stated as such in the spec; no task claims otherwise. AC3 labels from the domain module → Task 1 step 1, test 2, which asserts both the labels and the underlying values in `TICKET_STATUSES` order. AC4 optimistic + field-scoped rollback + error → Task 1 step 1, tests 5 and 6. AC5 drag unchanged → no production file that drag touches is modified; `BoardTab.tsx` and `TicketCard.tsx` are untouched, and the existing drag tests plus the E2E drag leg run unchanged. AC6 works from the backlog → the E2E leg in Task 3 runs from `/backlog`, which is where step 4b sits.

**Placeholders.** None. Every code step carries the literal code.

**Type consistency.** `aria-label="status"` in Task 1 matches `getByRole('combobox', { name: /status/i })` in Task 1's tests and `getByLabel('status')` in Task 3. `TicketStatus`, `TICKET_STATUSES`, `TICKET_STATUS_LABELS` are the real exports of `src/lib/domain.ts`. `UpdateTicketResult`, `deferred`, `base`, `user` and `act` are all already present in `TicketDetailDialog.test.tsx`.
