# SPRIN-66 Error Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Contain a React render throw so it replaces the surface that failed instead of blanking the whole application.

**Architecture:** One reusable class boundary (`ErrorBoundary`) plus a copy-owning fallback (`CrashFallback`), mounted twice — once in `App.tsx` above every route, once in `ProjectShell` around the tab `<Outlet>`. The boundary's state holds a **boolean, not the error**, so no fallback can render raw error text.

**Tech Stack:** React 19, react-router-dom 7 (declarative `<Routes>`), TypeScript strict, Vitest + Testing Library, Tailwind, shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-07-30-sprin-66-error-boundary-design.md` — read it first.

## Global Constraints

Every task's requirements implicitly include this section.

- **Prettier is gated.** `semi: false`, `singleQuote: true`, `printWidth: 100`, `trailingComma: "all"`, plus `prettier-plugin-tailwindcss` (it **sorts Tailwind classes** — do not hand-order them). Run `npm run format` before committing. `npm run format:check` is part of `npm run verify` and a long line in a fixture has already turned this red once.
- **Lint is `eslint . --max-warnings 0` — warnings are fatal.** In particular `react-refresh/only-export-components` is a *warning*: a `.tsx` file must export components only (exporting `type`s is fine).
- **T2 cyclomatic complexity max 10 applies to `.tsx`.** `max-lines-per-function` is off for `.tsx` (ADR 0001), so component length is not the constraint — branching is.
- **`ProjectShell` is at cyclomatic EXACTLY 10.** Adding one conditional to that function reddens the gate. Measure with
  `npx eslint src/routes/ProjectShell.tsx --rule '{"complexity":["error",1]}'` — it must still report `complexity of 10` when you are done.
- **Never render a caught error's message or stack into the DOM.** `listTickets`/`listSprints` reject with raw PostgREST strings that can name columns and policies. `console.error` is fine; the DOM is not.
- **Status/type/column display names live only in `src/lib/domain.ts`.** Not relevant to this diff — do not add any there.

### Per-task verification recipe (run ALL of these — not just the tests)

```bash
npx vitest run <the test files you touched>
npm run lint
npm run format:check
npm run build
```

**Do NOT run `npm test` or `npm run verify`.** They execute live integration suites against a shared
Supabase project and repeated sign-ins trip GoTrue's auth rate limiter, turning CI red on unrelated
branches. The controller runs the full gate once at the end.

`npm run build` is **required, not optional**: `npx tsc --noEmit` checks zero files in this repo, and
a branch has already shipped a type error because an agent ran only vitest and eslint.

### How to treat this plan's code

The code below **has never been run.** It is a starting point, not gospel. Deviating to match an
established repo pattern is correct — but **report every deviation** in your final message. Prefer
reporting BLOCKED over inventing an interface. This plan's test assertions have contained real
defects on past stories: after writing each test, ask whether it would actually fail if the
behaviour it names regressed, and if not, fix the test and say so.

---

### Task 1: The `ErrorBoundary` mechanism and its fallback

**Files:**
- Create: `src/routes/ErrorBoundary.tsx`
- Test: `src/routes/ErrorBoundary.test.tsx`

**Interfaces:**
- Consumes: `Button` from `@/components/ui/button`.
- Produces — later tasks rely on these exact names:
  - `ErrorBoundary` — props `{ children: ReactNode; fallback: (reset: () => void) => ReactNode }`
  - `CrashFallback` — props `{ scope: 'app' | 'tab'; onRetry: () => void }`

- [ ] **Step 1: Write the failing tests**

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CrashFallback, ErrorBoundary } from './ErrorBoundary'

// A string no copy in this app would ever contain, standing in for the raw PostgREST
// text a rejection can carry ("... violates row-level security policy for table ...").
const CANARY = 'canary-rls-policy-detail'

function Boom({ throws }: { throws: boolean }) {
  if (throws) throw new Error(CANARY)
  return <p>child content</p>
}

function renderBoundary(throws: boolean) {
  return render(
    <ErrorBoundary fallback={(reset) => <CrashFallback scope="tab" onRetry={reset} />}>
      <Boom throws={throws} />
    </ErrorBoundary>,
  )
}

// React itself logs every caught error via console.error, so this spy is required to keep
// the run readable — and it is also how the AC6 assertion reads our own call.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    renderBoundary(false)
    expect(screen.getByText('child content')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('replaces the children with the fallback when a child throws', () => {
    renderBoundary(true)
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong displaying this view.')
    expect(screen.queryByText('child content')).not.toBeInTheDocument()
  })

  it('never renders the thrown error text', () => {
    renderBoundary(true)
    expect(screen.queryByText(new RegExp(CANARY))).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(CANARY)
  })

  it('reports the caught error to the console', () => {
    renderBoundary(true)
    const reported = vi
      .mocked(console.error)
      .mock.calls.some((args) => String(args[0]).includes('contained by an ErrorBoundary'))
    expect(reported).toBe(true)
  })

  it('restores the children when Try again is clicked and the child no longer throws', async () => {
    const user = userEvent.setup()
    let throws = true
    function Flaky() {
      if (throws) throw new Error(CANARY)
      return <p>child content</p>
    }
    render(
      <ErrorBoundary fallback={(reset) => <CrashFallback scope="tab" onRetry={reset} />}>
        <Flaky />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    throws = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('child content')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('uses the app-scope copy for the app scope', () => {
    render(<CrashFallback scope="app" onRetry={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong.')
  })
})
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npx vitest run src/routes/ErrorBoundary.test.tsx`
Expected: FAIL — cannot resolve `./ErrorBoundary`.

- [ ] **Step 3: Write the implementation**

The `className` on the wrapper is **copied verbatim from `src/routes/LoadFailure.tsx`** so the two
failure surfaces look identical and the Tailwind class order already satisfies the sorting plugin.

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'

/** Crash copy, keyed by a CLOSED union — same shape and same reason as `LoadFailure`'s
 *  `FAILURE_COPY`. Adding a scope means adding a case here, which is the review moment
 *  we want. Kept above the docblock below so that block anchors to `CrashFallback`. */
const CRASH_COPY: Record<'app' | 'tab', string> = {
  app: 'Something went wrong.',
  tab: 'Something went wrong displaying this view.',
}

/**
 * What a contained crash looks like. Deliberately takes a `scope`, NOT a message — it has
 * no way to receive the error, because `ErrorBoundary` never puts one in state. See that
 * component's docblock for why that is a security decision rather than a stylistic one.
 *
 * `role="alert"` sits on the message, not the wrapper, so a screen reader announces the
 * sentence and nothing else in the block. Mirrors `LoadFailure`.
 */
export function CrashFallback({ scope, onRetry }: { scope: 'app' | 'tab'; onRetry: () => void }) {
  return (
    <div className="border-destructive/50 flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed">
      <p role="alert" className="text-destructive text-sm">
        {CRASH_COPY[scope]}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}

type Props = { children: ReactNode; fallback: (reset: () => void) => ReactNode }
type State = { crashed: boolean }

/**
 * Catches a render throw in its subtree and swaps in `fallback` instead of letting React
 * unmount the whole tree. A class component because React has no hook equivalent.
 *
 * **State holds a boolean, never the error, and `fallback` receives only `reset`.** That is
 * load-bearing: `listTickets`/`listSprints` reject with `Could not load tickets:
 * ${error.message}` — raw PostgREST text that can name columns, policies or schema
 * internals. Passing the error to `fallback` would reopen the channel `LoadFailure` closed
 * by refusing a `message: string` prop, and `<CrashFallback message={err.message} />` would
 * compile clean. With no error in state there is nothing to render. Do not "improve" this by
 * surfacing the message.
 *
 * Catches **render** errors only — not event handlers, effects, or promise rejections.
 * That covers the case this was built for (`formatSprintDate` throws during render) and is
 * not a general safety net.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false }

  // Note the discarded parameter: React passes the error, and we deliberately drop it.
  static getDerivedStateFromError(): State {
    return { crashed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Render error contained by an ErrorBoundary:', error, info.componentStack)
  }

  render() {
    if (this.state.crashed) {
      return this.props.fallback(() => this.setState({ crashed: false }))
    }
    return this.props.children
  }
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `npx vitest run src/routes/ErrorBoundary.test.tsx`
Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the tests can fail (mandatory — do not skip)**

Make `getDerivedStateFromError` return `{ crashed: false }`, re-run, and **quote the actual
failure output** in your report. Expected: the fallback tests go red. Revert.

Then delete the `role="alert"` attribute, re-run, quote the output, revert.

If either mutation leaves the suite green, the test is wrong — fix the test, not the code, and say
so in your report.

- [ ] **Step 6: Run the full per-task recipe**

```bash
npx vitest run src/routes/ErrorBoundary.test.tsx
npm run lint
npm run format:check
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/ErrorBoundary.tsx src/routes/ErrorBoundary.test.tsx
git commit -m "Add an ErrorBoundary that cannot render the error it caught (SPRIN-66)"
```

---

### Task 2: Mount the app-scope boundary above every route

**Files:**
- Modify: `src/App.tsx`
- Test: `src/App.crash.test.tsx` (new file)

**Interfaces:**
- Consumes: `ErrorBoundary`, `CrashFallback` from `./routes/ErrorBoundary` (Task 1).
- Produces: nothing new.

A separate test file rather than additions to `App.test.tsx`, because this test needs a
module mock that must not leak into the routing tests. The repo already does this —
`LoginPage.security.test.tsx`, `CreateProjectDialog.reopen.test.tsx`.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import App from './App'
import { AuthProvider } from '@/lib/auth'

// `vi.mock` factories are hoisted ABOVE plain `const` declarations, so anything they
// close over must come from `vi.hoisted` or the factory hits a TDZ error at run time.
// `App.test.tsx` uses the same device for the same reason.
const h = vi.hoisted(() => ({
  canary: 'canary-rls-policy-detail',
  session: { access_token: 't', user: { id: 'u1', email: 'a@example.com' } },
}))

// The landing page is the simplest authed route to crash on purpose.
vi.mock('@/routes/ProjectsHome', () => ({
  ProjectsHome: () => {
    throw new Error(h.canary)
  },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
    auth: {
      getSession: vi.fn(async () => ({ data: { session: h.session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  },
}))

describe('the app-scope error boundary', () => {
  it('contains a crash in a route instead of blanking the page, and hides the error text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    expect(document.body.textContent).not.toContain(h.canary)
    vi.restoreAllMocks()
  })
})
```

- [ ] **Step 2: Run it and verify it fails**

Run: `npx vitest run src/App.crash.test.tsx`
Expected: FAIL — with no boundary the tree unmounts and no `alert` is found.

- [ ] **Step 3: Wrap `<Routes>` in `src/App.tsx`**

Add the import, wrap the existing `<Routes>` element, and change nothing inside it:

```tsx
import { CrashFallback, ErrorBoundary } from '@/routes/ErrorBoundary'

export default function App() {
  return (
    <ErrorBoundary fallback={(reset) => <CrashFallback scope="app" onRetry={reset} />}>
      <Routes>{/* unchanged */}</Routes>
    </ErrorBoundary>
  )
}
```

Also extend `App.tsx`'s existing docblock with one sentence: the boundary lives here rather than
in `main.tsx` because `main.tsx` is an untested bootstrap, so a boundary there could never be
verified — and note that a throw inside `AuthProvider` or `BrowserRouter` is still above it.

- [ ] **Step 4: Run it and verify it passes**

Run: `npx vitest run src/App.crash.test.tsx src/App.test.tsx`
Expected: PASS. `App.test.tsx` must still pass unchanged — if it does not, say so rather than editing it.

- [ ] **Step 5: Prove it can fail (mandatory)**

Remove the `<ErrorBoundary>` wrapper, re-run, **quote the failure output**, restore it.

- [ ] **Step 6: Run the full per-task recipe** (see Global Constraints)

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/App.crash.test.tsx
git commit -m "Contain route crashes with an app-scope boundary (SPRIN-66)"
```

---

### Task 3: Mount the tab-scope boundary in `ProjectShell`

**Files:**
- Modify: `src/routes/ProjectShell.tsx`
- Test: `src/routes/ProjectShell.test.tsx` (extend the existing file)

**Interfaces:**
- Consumes: `ErrorBoundary`, `CrashFallback` from `./ErrorBoundary` (Task 1).

This is the task the story exists for. AC1 and AC4 are **composition** properties: they depend on
what navigation does to the boundary's mount, which a stubbed harness cannot observe. Drive them
through the real `ProjectShell`, the real `MemoryRouter` and the real tabs — `renderShell` in this
file already does exactly that.

- [ ] **Step 1: Add a crash route to the existing `renderShell` harness**

`renderShell` (around line 157) already registers sibling probe routes. Add one more alongside
`probe` and `ticket-probe`, and define the component next to the other probes:

```tsx
const CRASH_CANARY = 'canary-rls-policy-detail'

function CrashProbe(): never {
  throw new Error(CRASH_CANARY)
}
```

```tsx
<Route path="crash" element={<CrashProbe />} />
```

- [ ] **Step 2: Write the failing tests**

Add a new `describe` block. The console spy is scoped to this block so it cannot hide React
warnings in the rest of the file.

```tsx
describe('the tab-scope error boundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('contains a tab crash and leaves the header and tab bar usable', async () => {
    renderShell('/projects/p1/crash')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong displaying this view.',
    )
    // AC1: the shell around the tab survives, so the user can navigate away.
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Backlog' })).toBeInTheDocument()
    expect(screen.getByText('Apple')).toBeInTheDocument()
  })

  it('does not render the thrown error text', async () => {
    renderShell('/projects/p1/crash')
    await screen.findByRole('alert')
    expect(document.body.textContent).not.toContain(CRASH_CANARY)
  })

  it('clears the crash when the user navigates to another tab', async () => {
    const user = userEvent.setup()
    renderShell('/projects/p1/crash')
    await screen.findByRole('alert')

    await user.click(screen.getByRole('link', { name: 'Backlog' }))

    // AC4: the fallback must not survive the navigation.
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('contains the real formatSprintDate crash, the case this story exists for', async () => {
    // `timestamptz` would reject this at the database edge; the point is that when a value
    // Date cannot parse does reach render, the tab degrades instead of the app dying.
    mockListSprints.mockResolvedValue([{ ...sprintBase, start_date: 'not-a-timestamp' }])
    renderShell('/projects/p1/sprints')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Something went wrong displaying this view.',
    )
    expect(screen.getByRole('link', { name: 'Board' })).toBeInTheDocument()
  })
})
```

- [ ] **Step 3: Run and verify they fail**

Run: `npx vitest run src/routes/ProjectShell.test.tsx`
Expected: FAIL — without a boundary the throw propagates and the render blows up.

- [ ] **Step 4: Wrap the `<Outlet>` in `src/routes/ProjectShell.tsx`**

Add `useLocation` to the existing `react-router-dom` import, call it with the other hooks **above
the early returns** (`if (loading)` / `if (!project)`) so hook order is unconditional, and wrap
only the `<Outlet>`:

```tsx
<ErrorBoundary
  key={location.pathname}
  fallback={(reset) => <CrashFallback scope="tab" onRetry={reset} />}
>
  <Outlet context={/* unchanged */} />
</ErrorBoundary>
```

**`TicketDetailDialog` stays OUTSIDE the boundary** — see the spec. Keying on `pathname` would
otherwise remount the dialog on every tab switch and silently reset its inline-edit state.

Add a short comment at the wrap site recording why the `key` is there: without it the boundary
never unmounts when only the Outlet's children change, so a crash on one tab would persist as a
fallback on the next.

- [ ] **Step 5: Run and verify they pass**

Run: `npx vitest run src/routes/ProjectShell.test.tsx`
Expected: PASS — the new tests plus every pre-existing test in the file, unchanged.

- [ ] **Step 6: Confirm the complexity budget is intact (mandatory)**

Run: `npx eslint src/routes/ProjectShell.tsx --rule '{"complexity":["error",1]}'`
Expected: `Function 'ProjectShell' has a complexity of 10`. **If it reports 11, stop and report
BLOCKED** — do not raise the threshold, and do not restructure without saying so.

- [ ] **Step 7: Prove the guards can fail (mandatory — two separate mutations)**

1. Delete `key={location.pathname}`, re-run. Expected: *"clears the crash when the user navigates
   to another tab"* goes red and the others stay green. **Quote the failure output.** Restore.
2. Delete the `<ErrorBoundary>` wrapper, re-run. Expected: the AC1 test goes red. Quote it. Restore.

A mutation that leaves everything green means the test does not pin what it names — fix the test
and report it.

- [ ] **Step 8: Run the full per-task recipe** (see Global Constraints)

- [ ] **Step 9: Commit**

```bash
git add src/routes/ProjectShell.tsx src/routes/ProjectShell.test.tsx
git commit -m "Contain tab crashes without losing the project header (SPRIN-66)"
```

---

## Test-count tripwire

This branch adds exactly **two** test files (`ErrorBoundary.test.tsx`, `App.crash.test.tsx`), both
unit tests. Baseline before the branch, re-derived with `npx vitest list --filesOnly`:

| | before | expected after |
|---|---|---|
| full (`npm test`) | 52 | 54 |
| `test:unit` | 45 | 47 |
| **gap (live suites)** | **7** | **7 — unchanged** |

A client-only story adds no live integration test, so the gap staying at 7 is correct, not a sign
the live suites skipped. A gap of **0** would mean they silently skipped, which is a failure
however green the run looks.
