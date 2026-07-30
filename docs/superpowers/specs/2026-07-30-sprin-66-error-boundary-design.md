# SPRIN-66 — Contain render crashes behind error boundaries

**Status:** approved (autopilot self-approval; none of the four stop-and-ask cases fired).
**Epic:** E1 Foundation and Infrastructure. **Date:** 2026-07-30.

## The problem

There is no error boundary anywhere in `src/`. React's default for an uncaught render throw is
to unmount the entire tree, so any one bad render blanks the whole application — no message, no
navigation, no way back except a manual reload.

The motivating case, found while shipping SPRIN-65: `formatSprintDate` calls
`new Date(v).toISOString()`, which throws `RangeError: Invalid time value` on a value `Date`
cannot parse. SPRIN-65 lifted `SprintDates` out of `SprintsTab` so the Board caption could reuse
it, which widened that call path from one tab to two.

**This is robustness, not a security fix.** `timestamptz` rejects an unparseable value at the
database edge, so the bad value is not attacker-reachable. The defect being fixed is the *blast
radius* of a render throw, not the throw itself.

## Scope

In: two boundaries, their fallback UI, and tests.
Out: changing `formatSprintDate` (a separate concern — and leaving it throwing keeps the
boundary's value real rather than hypothetical); migrating to a data router for `errorElement`
(the app uses the declarative `<Routes>` API, where `errorElement` does not exist).

## Design

### 1. `ErrorBoundary` — the mechanism (`src/routes/ErrorBoundary.tsx`)

A class component, because React has no function-component boundary API.

```tsx
type Props = { children: ReactNode; fallback: (reset: () => void) => ReactNode }
type State = { crashed: boolean }
```

**The state holds a boolean, not the error, and `fallback` receives only `reset`.** This is the
design's load-bearing decision and it exists to satisfy AC3 structurally.

The precedent is `LoadFailure`, whose docblock refuses a `message: string` prop and calls the
closed union "a security control, and a deliberate one": `listTickets`/`listSprints` reject with
`Could not load tickets: ${error.message}`, a raw PostgREST string that can name columns,
policies or schema internals. A boundary that passed `error` to its fallback would reopen exactly
that channel, and `<CrashFallback message={error.message} />` would compile clean.

By never putting the error in state, rendering it is not merely discouraged — there is nothing to
render. Same move as `SprintCreateInsert = Omit<SprintInsert, 'status'>`: make the wrong thing
untypeable.

`componentDidCatch` logs the error and the component stack to `console.error` (AC6). The console
is a developer channel, not the DOM; an uncaught throw would have printed there anyway.

### 2. `CrashFallback` — the copy (same file)

Mirrors `LoadFailure` exactly: a `Record` of copy keyed by a **closed union**, so adding a scope
is a review moment rather than a free-text call.

| scope | copy |
|---|---|
| `app` | Something went wrong. |
| `tab` | Something went wrong displaying this view. |

Both render `role="alert"` on the message (not the wrapper — same reasoning as `LoadFailure`: a
screen reader should announce the sentence and nothing else) plus a **Try again** button wired to
`reset`.

**No `window.location.reload()`, at either scope.** AC5 asks for recovery without a full reload;
jsdom does not implement navigation, so a reload button would also be untestable. If `reset`
re-renders into the same bad data the fallback simply returns — a discrete click, not a loop.

### 3. Placement — two boundaries

**App scope: `App.tsx`, wrapping `<Routes>`.**

The instinct is `main.tsx`, and it is wrong: `main.tsx` is a 16-line bootstrap that **no test
renders**, so a boundary there could never be verified. `App.tsx` is the highest point that is
both inside the tested composition (`App.test.tsx` renders the real `App`) and above every route.

*Known limitation, stated rather than papered over:* a throw inside `AuthProvider` or
`BrowserRouter` is above this boundary and still reaches the browser as a blank page. Accepted —
both are composition-only wrappers with no render-time logic, and buying that case costs an
untestable duplicate in `main.tsx`.

**Tab scope: `ProjectShell`, wrapping `<Outlet>` only.**

`ProjectShellHeader` is a sibling *outside* the boundary, so it survives by construction — that is
AC1. Keyed `key={location.pathname}` so navigation remounts it and clears a crash (AC4); without
the key the fallback would persist onto the next tab, because the boundary itself never unmounts
when only the Outlet's children change.

**`TicketDetailDialog` stays outside the boundary, deliberately.** Wrapping it too would give a
dialog crash the same containment, but the pathname key would then remount the dialog on every
tab switch, silently resetting shell UI state (an open ticket's inline-edit state). Minimal blast
radius wins: the dialog is still covered by the app boundary.

**Complexity budget:** `ProjectShell` is at cyclomatic **exactly 10**, measured before starting
(`npx eslint --rule '{"complexity":["error",1]}'`). `useLocation()` and a `key` add no branch, and
ESLint counts the fallback arrow as its own function, so the change is complexity-neutral. Verify
this rather than assume it — one added conditional reddens the gate.

## Testing

`ErrorBoundary.test.tsx` (mechanism): renders children when nothing throws; renders the fallback
and drops the children when one does; `reset` restores children once the child stops throwing;
`componentDidCatch` reaches `console.error`. React logs caught errors to `console.error` itself,
so the spy must assert on *our* call specifically, not on call count.

**The AC3 control is a canary**: throw an error whose message is a distinctive string and assert
that string is absent from the DOM — asserted at the real call sites, not only in the boundary's
own file, because that is where a bypass would happen (green-for-the-wrong-reason shape 7).
Stated honestly: this catches the channel being *used*; what makes it *unavailable* is `State`
holding no error. Neither claim is written as more than it is.

`ProjectShell.test.tsx` (composition — shape 9): AC1 and AC4 must be driven through the real
`ProjectShell`, real router and real tabs, never a stub. A stubbed harness cannot observe what
navigation does to the boundary's mount.

- Mechanics via a synthetic throwing route element.
- **One test drives the real motivating bug**: `listSprints` resolves a sprint whose
  `start_date` is unparseable, so the real `SprintDates` really throws and the real boundary
  really catches it. Proof the actual scenario is contained, not a re-enactment of it.

Every guard gets a mutation: remove the `key` → the navigation test must go red; remove the
boundary → the AC1 test must go red. A guard whose mutation was never watched is not verified.

## Not verified here

- A throw above `App` (`AuthProvider`, `BrowserRouter`) — see the limitation above.
- Errors in event handlers, effects, or async rejections. React boundaries catch **render**
  errors only. `formatSprintDate` is called during render, so the motivating case is covered; a
  rejected promise is not, and never was.
- Adding an `error` field to `State` is not itself prevented by any test — only its use is.
