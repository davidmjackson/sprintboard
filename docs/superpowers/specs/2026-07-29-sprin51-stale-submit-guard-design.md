# SPRIN-51 — Guard the Create dialogs against a stale submit resolving over a reopened draft

**Date:** 2026-07-29
**Tracker:** [SPRIN-51](https://david-jackson.atlassian.net/browse/SPRIN-51) (Bug, under E8 Quality and Definition of Done)
**Branch:** `fix/create-dialog-stale-submit`

---

## The defect, reproduced

`src/routes/CreateDialog.tsx` hands `onSubmit` a `close` callback that is an
unconditional closure over `handleOpenChange(false)`. Nothing ties that callback to the
dialog instance that was open when the submit began, so the continuation of an
in-flight submit runs against whatever dialog exists when the promise resolves.

Reproduced against unmodified `main` (`350ce2a`) with a throwaway spec before any design
work, not taken on trust from the standing-debt note:

1. Open, type `first`, submit — the create is in flight, button shows `Creating…`.
2. Close the dialog manually while it is still in flight.
3. Reopen, type `second draft`.
4. Release the original promise.

**Observed:** the dialog closes and `second draft` is gone. The DOM shows
`data-state="closed"` and no `role="dialog"`. The record is created regardless, so the
user's typing vanishes with no explanation and no error.

An earlier note of mine described this as "idempotent". It is not, and that was already
disproven on review; this reproduction settles it by observation.

All three call sites inherit it through the shared shell: `CreateProjectDialog`,
`CreateTicketDialog`, `CreateSprintDialog`.

## The finding that shapes the design

The obvious fix — bail out of the continuation when it is stale — is **wrong**. The
continuation has three effects and they do not share an owner:

| Effect | Scope | Stale on reopen? |
| --- | --- | --- |
| `close()` | the dialog instance | **Yes.** Closes a dialog the user just opened. |
| `form.setError('root' \| 'key', …)` | the form instance | **Yes.** Paints an abandoned submit's error onto an unrelated new draft. |
| `onCreated?.(row)` | the **parent** list | **No.** The row genuinely exists server-side. |

An `if (stale) return` at the top of the continuation drops `onCreated`, and the created
project/ticket/sprint stays invisible until something refetches. The guard therefore has
to be per-effect, not per-continuation.

A fourth effect is worth naming: `CreateProjectDialog` passes
`onClosed={() => setKeyEdited(false)}`, which runs inside `handleOpenChange`. A stale
close resets the key-suggestion flag too, so a reopened draft silently resumes
auto-deriving the key over whatever the user typed. Guarding `close` covers it.

## Decision

Add a monotonic **open generation** to the shell. `handleOpenChange` bumps it on every
transition, in both directions. The submit handler captures the generation at submit
time; the callbacks it hands to `onSubmit` compare captured against current and no-op
when they differ.

Bumping on *both* directions rather than only on open is deliberate: any close or reopen
between submit and resolve invalidates the continuation. It also removes a second, milder
pre-existing bug — a manual close mid-flight followed by a normal resolve currently fires
`onClosed` twice. `CreateProjectDialog`'s call site carries a comment saying that double
fire is safe; it stays safe, and now it also stops happening.

### API shape — the second parameter becomes an object

`onSubmit(values, close)` becomes `onSubmit(values, { close, setError })`, where both are
generation-guarded by the shell.

**Considered and rejected:**

- **Keep `close`, add a separate `stale()` predicate for call sites to consult before
  `setError`.** Rejected. That is a prose-only invariant — a documented rule a call site
  can forget with no compiler or test to catch it. This repo has already been bitten by
  exactly that shape (a JSDoc "the caller must pass a stable reference" that measured at
  ~1.2M fetch calls in five seconds).
- **Let the shell own closing: `onSubmit` returns a result and the shell decides.**
  Rejected. `CreateDialog`'s own JSDoc records a deliberate decision that the shell must
  *not* close itself, so each call site states in as many words that a successful create
  closes the dialog. Reversing a recorded decision as a side effect of a bug fix is the
  wrong move; the decision is still sound.

**Why the object wins:** call sites stop reaching for `form.setError` directly, so the
guard sits on the path of least resistance rather than in a comment. It also collapses
the `'Something went wrong. Please try again.'` literal that S9.4 left triplicated across
the three dialogs.

**Honest limit of the claim:** this is *not* airtight. Each call site still closes over
its own `form` and could call `form.setError` directly; TypeScript will not stop it.

> **Corrected after review.** This section originally claimed the behavioural test in
> `CreateDialog.test.tsx` "goes red if a call site reverts". **It does not**, and both
> reviewers proved it independently. That test drives the shell's own harness, which by
> construction uses the shell-supplied `setError`; a production call site bypassing the
> guard is invisible to it. Reverting all three call sites left the entire suite green,
> caught only incidentally by `no-unused-vars`. Reverting just *one* branch —
> `CreateProjectDialog`'s `setError('key', …)` — kept `setError` bound, so **lint passed
> and all tests passed** while the stale duplicate-key error painted onto an unrelated
> reopened draft.
>
> The control now exists as a **call-site** test:
> `CreateProjectDialog.test.tsx`'s "paints no stale duplicate-key error onto a draft
> opened after the submit was abandoned", verified to fail under exactly that partial
> revert. This was a documented control that did not exist — the precise trap of "a
> comment is not a control".

`setError`'s signature reuses react-hook-form's own `UseFormSetError<T>` so field errors
(`CreateProjectDialog`'s `key`) work unchanged and the call sites read identically.

### Mechanism

A `useRef`, not state: bumping it must not trigger a render, and the guard must read the
newest value rather than a value captured in a stale closure.

```tsx
const openGeneration = useRef(0)

function handleOpenChange(next: boolean) {
  openGeneration.current += 1
  setOpen(next)
  if (!next) {
    form.reset()
    onClosed?.()
  }
}
```

and at submit time:

```tsx
function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
  const generation = openGeneration.current            // sampled HERE — see below
  return form.handleSubmit((values) => onSubmit(values, submitActions(generation)))(event)
}
```

> **Corrected after review.** The generation was originally sampled *inside* the callback
> handed to `form.handleSubmit`. That callback runs only once the resolver settles, so the
> sample happened **after validation**, not at submit. With the synchronous zod resolvers
> all three dialogs use today the window is a single microtask and unreachable — but with
> an async resolver it is the entire original bug, reproduced: dialog closed, reopened
> draft wiped, `onClosed` fired twice. An async resolver is not hypothetical here; the
> duplicate-key path is exactly the shape that invites an async uniqueness check on the
> key. Sampling before `form.handleSubmit` fixes it, and
> `CreateDialog.test.tsx`'s async-resolver test now distinguishes the two — no test that
> existed before could.

Sequence check:

- open (gen 1) → submit captures 1 → resolve → `1 === 1` → closes. Unchanged.
- open (1) → submit captures 1 → manual close (2) → reopen (3) → resolve → `1 ≠ 3` →
  no-op. Draft survives.
- open (1) → submit captures 1 → manual close (2) → resolve, never reopened → `1 ≠ 2` →
  no-op. No double `onClosed`.
- `onSubmit` calling `close()` twice: first runs (gen → 2), second no-ops. Strictly
  better than today, and the existing `toHaveBeenCalledTimes(1)` assertion still holds.

## Scope

In scope: `CreateDialog.tsx` and the three call sites, plus tests.

**Folded in deliberately, and why it is not scope creep:** this change rewrites the
`onSubmit` body of all three dialogs, and two of the eight pre-existing coverage gaps
recorded by S9.4's mutation sweep sit exactly in those bodies — `description` and
`acceptanceCriteria` are swappable in `CreateTicketDialog`'s create call with no test
noticing, and blank story points reaching `createTicket` as `0` instead of `undefined`
likewise goes unseen. Those are the regressions *this* edit is most able to introduce.
Pinning the create-call arguments is the safety net for the refactor, not extra work
smuggled in beside it.

Out of scope: the remaining six S9.4 coverage gaps, T7 coverage gating, and the
`patchLoaded` nonce debt (a different component with the same underlying shape).

## Acceptance criteria

1. Submit → close mid-flight → reopen → type: when the original create resolves, the
   reopened dialog stays open with its draft intact.
2. Same on the failure path: no stale root or field error is painted onto the reopened
   draft.
3. `onCreated` still receives the created record even when the submit resolved stale.
4. Normal behaviour unchanged for all three dialogs: success closes and resets, failure
   shows the error and keeps the dialog open.
5. Every behaviour above is covered by a test **observed to fail** against the unfixed
   code, not merely written alongside the fix.

## Standards

`npm run lint` (T1–T5) and `npm run lint:duplication` (T6, 3%) both gate inside
`npm run verify`. ADR 0001 exempts `.tsx` components from T1, which is what keeps the
shell's function length a non-issue. The `setError` consolidation removes duplicated
literals rather than adding any.
