# Code quality standard — adoption baseline, 2026-07-25

Retrofit audit run with the `audit-standards` skill against
`/var/www/CodingStandards`. **No code was changed.** This is the baseline the
report is measured from; `npm run lint:standards` reproduces the JS/TS half.

The standard is adopted **warnings-only**. `npm run verify` and `verify.yml` are
untouched: `verify` is the required check on `main`, and a red `verify` blocks
every merge including the one that would fix it. Thresholds move into the gate
only when production code is clean — see "Sequencing" below.

## JS/TS (`src/`, `e2e/`)

Rules as shipped, before the ADR overrides:

| Threshold | Production | Tests |
|---|---|---|
| T1 function length (30) | **19** — 18 in `.tsx` | 59 |
| T2 cyclomatic complexity (10) | **3** | 1 |
| T4 parameters (4) | **0** | 0 |
| T5 file length (400) | **1** | 4 |

After ADR 0001 (T1 off for `.tsx`) and ADR 0002 (size rules off in tests),
`npm run lint:standards` reports **7 findings — 6 in `src/`, 1 in `e2e/`**:

```
src/lib/ai.ts:39                       decomposeEpic       T1 44 lines, T2 complexity 14
src/routes/ProjectShell.tsx:69         ProjectShell        T2 complexity 25
src/routes/TicketDetailDialog.tsx:223  TicketDetailDialog  T2 complexity 45
                                                           T3 cognitive complexity 44
src/routes/TicketDetailDialog.tsx:567                      T5 945 lines (limit 400)
e2e/happy-path.spec.ts:177             arrow fn            T2 complexity 11
```

T3 (cognitive complexity 15) had no pre-adoption number —
`eslint-plugin-sonarjs` is added by this change. Its first run finds exactly one
violation, and it is the same file as T2 and T5. The `e2e` hit is intentional:
ADR 0002 keeps T2 on in tests, and complexity 11 in a spec is worth seeing.

`TicketDetailDialog.tsx` is the outlier by a wide margin: 945 lines and
complexity 45, and it holds the optimistic-write race documented in its own
`// NOTE:`. It is the one file where the standard is telling us something we did
not already know.

## Python (`api/`)

`ruff check --config <standard>/profiles/python/ruff.toml` — **5 findings**,
`ruff format --check` clean (15 files):

```
app/auth.py:40    BLE001  blind `except Exception`
app/auth.py:41    B904    re-raise without `from err`
tests/test_auth.py:32,38  B017  assert on blind Exception  (x2)
tests/test_llm.py:1       I001  import block unsorted      (auto-fixable)
```

The two in `app/auth.py` are on the JWT verification path. Neither is a
vulnerability — the handler converts any verification failure into a 401, which
is the correct outcome — but the blind catch also swallows programming errors in
that function, and `raise ... from` would keep the cause. Worth a look on their
own merits, not as a formatting chore.

> **Separate finding: the Python tooling is unpinned.**
> `api/requirements-dev.txt` asks for `ruff>=0.6`, so CI resolves whatever is
> newest. On 2026-07-25 it resolved **0.16.0**, whose expanded default rule set
> flags 6 errors (2×RUF012, 2×B017, I001, BLE001) in `api/` — turning the `api`
> check red **on unchanged code**. The local venv is on 0.15.22 and passes, so
> the drift is invisible locally. It last passed on `4e5c701` (2026-07-21) with
> an older ruff.
>
> This is not caused by the standard, and not by this change — the diff contains
> zero Python files. Fix it by pinning (`ruff==0.15.22`) in its own commit, then
> take the findings deliberately. A floating linter is the opposite of what a
> standard is for: the same code must give the same verdict tomorrow. `api` is a
> non-required check, so this does not block a merge.

## Duplication (jscpd, whole repo)

**6.07% overall** (867 / 14,288 lines, 78 clones) against a 3% threshold — but
67 of the 78 clones involve a test file, where repeated arrange-blocks are
deliberate. **11 clones are production-to-production**, 171 lines:

```
33L  routes/LoginPage.tsx:52   <-> routes/SignupPage.tsx:93     auth form
21L  routes/CreateSprintDialog.tsx:7 <-> routes/CreateTicketDialog.tsx:8
18L  routes/ProjectShell.tsx:203 <-> routes/ProjectShell.tsx:221  (self)
16L  lib/database.types.ts:156 <-> lib/database.types.ts:179    generated
15L  routes/CreateProjectDialog.tsx:152 <-> routes/CreateTicketDialog.tsx:206
14L  routes/CreateProjectDialog.tsx:106 <-> routes/CreateSprintDialog.tsx:96
14L  routes/LoginPage.tsx:85   <-> routes/SignupPage.tsx:141
```

The signal: the auth pages share a form, and the three `Create*Dialog`
components share their submit/error scaffolding. `database.types.ts` is
generated and should be excluded from any future duplication gate.

> Measurement note: `jscpd --threshold 100 --format ...` reported `0 / 0 lines`
> — it matched no files at all. That is a tool misconfiguration, not a clean
> result. The numbers above come from a plain `jscpd src api e2e` run that
> detects 78 clones. If a future run reports 0, check the file count first.

## Coverage

**88.74% statements / 90.57% lines / 83.4% branches**, against the standard's
80%. Already met.

Measured with `test:unit` only (integration suites excluded, to avoid the live
GoTrue sign-ins and the known auth rate-limit flake). The full-suite number can
only be higher, since the live suites add covered paths without adding source.
Coverage is **not** currently gated in `verify`, and this change does not add it.

## Sequencing

1. **Now (this change):** report exists, non-gating. New code is held to the
   thresholds per story; the count must not grow.
2. **Pass A** (formatting / safe auto-fixes): near-empty here. Prettier stays as
   it is (ADR 0004) and `ruff format` is already clean. The one auto-fixable
   item is `I001` in `tests/test_llm.py`.
3. **Pass B** (extraction, complexity, duplication): judgement work, one concern
   per PR. `TicketDetailDialog.tsx` is the main target and is **not** a
   tidy-up-at-the-end job — it sits on the ticket write path and carries a known
   optimistic-write race, so it wants its own slice and the deep review.
4. **Only then**, per stack, fold the rules into `lint` and let `verify` gate
   them.

> **Status, 2026-07-27 (`5f6edcc` + this record): Pass B is COMPLETE.** The
> complexity arc was 7 → 4 (S9.1) → 3 (S9.2) → 0 (S9.3); the duplication arc
> (below) went 11 prod-to-prod clones → 3, all three inside the two files any
> future gate must exclude. `npm run lint:standards` reports 0 and a fresh
> `jscpd` run finds no remaining production clone outside `lib/database.types.ts`
> and `index.css`. **The only remaining E9 work is Step 4: fold the rules into
> `lint`/`verify` so the standard gates instead of advises.**

### Pass B, first slice: `TicketDetailDialog.tsx` split (2026-07-25)

Landed on `refactor/split-ticket-detail-dialog`. `TicketDetailDialog.tsx` went from
945 countable lines / cyclomatic 45 / cognitive 44 (3 findings) to **181 raw lines,
~112 countable, 0 findings** — complexity and cognitive no longer apply to a file
this shape. Repo-wide: **7 findings → 4**. The 4 remaining are unchanged from the
baseline above and out of this slice's scope: `e2e/happy-path.spec.ts` (complexity
11), `src/lib/ai.ts` (`decomposeEpic`, 44 lines + complexity 14), and
`src/routes/ProjectShell.tsx` (complexity 25).

Logic moved into four `src/lib` hooks — `ticket-commit.ts`, `ticket-decomposition.ts`,
`ticket-deliverables.ts`, `ticket-actions.ts` — and markup into eight `src/routes`
components — `EditableText.tsx`, `TicketDetailHeader.tsx`, `TicketActionDialogs.tsx`,
`TicketMainFields.tsx`, `TicketDetailSidebar.tsx`, `TicketReferenceSelect.tsx`,
`TicketEpicSection.tsx`, `TicketDecompositionPanel.tsx`. The reusable rule this
slice establishes: **logic goes in `src/lib` hooks, markup in `src/routes`
components; hook bodies stay under 30 lines by hoisting substantial async logic to
module-level functions with a named argument-object type.** This is not a new
exemption — ADR 0001 already anticipated it ("if component logic is later
extracted into hooks (`.ts`), T1 applies to it automatically"), and no new ADR or
`eslint-disable` was used to sidestep the threshold here; the code simply meets it.

The five new test files — the four hook modules plus the decomposition panel — hold
**46 tests**; repo-wide the slice adds **53 new tests**, the extra 7 being additions
to the existing `src/lib/tickets.test.ts`. (Two different measurements: the first is
the new files, the second the whole slice.) The full unit suite (`npm run test:unit`)
now runs **426 tests across 37 files**. All figures measured at the branch head,
2026-07-25 — a point-in-time count, not a running total.
`TicketDetailDialog.test.tsx` and `ProjectShell.test.tsx` were **not**
modified — which is what makes the behaviour-preservation claim checkable rather
than asserted.

### Pass B, second slice: `ProjectShell.tsx` (2026-07-26, `d9e1c83`)

Cyclomatic **25 → under threshold**; 348 → 206 raw lines. Repo-wide **4 findings → 3**.

The complexity was **repetition, not tangle**, so this slice consolidated where S9.1
split. Two causes: the guard
`prev && prev.projectId === project.id && prev.phase === 'loaded'` appeared **six
times** across the local-mutation reducers (three boolean operators each), and the
tickets/sprints reads were near-identical twins differing only in their fetch
function. Both now live in `src/lib/project-reads.ts` (`useTaggedRead`,
`patchLoaded`); header markup moved to `src/routes/ProjectShellHeader.tsx`.

The number was not the point. The S4.6 invariant — a failed read must never look
successful — was restated at **eight** separate sites, each free to drift. It is now
enforced once, on the path every read and every local mutation takes.

`ProjectShell.test.tsx`, `BoardTab.test.tsx` and `SprintsTab.test.tsx` were **not**
modified: 88 existing tests pass against rewritten internals.

**What the adversarial review caught, all in this slice's own new code:**

- Holding `read` as an effect dependency was a footgun guarded only by a JSDoc
  sentence. Nothing automated could catch a violation — `exhaustive-deps` *requires*
  the dependency and the type cannot express "stable reference". Measured at ~1.2M
  fetch invocations in five seconds with an inline arrow. Fixed with a latest-ref,
  which restores the pre-refactor dependency list exactly.
- The `active` guard on the **rejection** path was untested; removing it survived the
  whole suite. Its failure mode is a project pinned on `loading` forever with no
  Retry affordance.
- One test was vacuous: it asserted a React warning removed in 18.3, while this repo
  runs 19.2, so it passed with the cleanup deleted entirely.

### Pass B, third slice: `ai.ts` + the e2e spec (2026-07-26, `4334ace`)

Repo-wide **3 findings → 0**.

`decomposeEpic` (44 lines, complexity 14) split along its three sequential phases —
`accessToken`, `postDecompose`, `normaliseProposal`, `parseDecomposeBody` — leaving
the export as the sequence. Public signature unchanged. The `e2e` finding was inside
a `page.evaluate` callback, which runs in the **browser** and cannot reference module
scope, so its helper is declared inside the callback; ESLint scores each function
separately, which is sufficient.

`src/lib/ai.test.ts` was unmodified in the refactor commit. Mutation-testing against
it then showed it caught only **4 of 9** planted defects — pre-existing thinness, not
regression, but every survivor was on an **error path**, which for a client calling a
*local* service is the ordinary case. Two of them were tests that already existed and
**passed for the wrong reason**: the non-ok mock had no `json` method, so deleting the
status check still produced `request_failed` via a caught `TypeError`. Eight of nine
now die.

**The reusable rule from that:** a test whose expected value can be reached by two
different routes pins neither. Give the mock enough shape that only the guard under
test can produce the outcome.

### Pass B, fourth slice: duplication (2026-07-27, `5f6edcc`)

Prod-to-prod clones: **11 → 3**, all three inside the two files this doc already
flagged as generated/format noise, none of them a `routes/*.tsx` survivor:

```
7L  index.css:69 <-> index.css:104
16L lib/database.types.ts:156 <-> lib/database.types.ts:179
12L lib/database.types.ts:273 <-> lib/database.types.ts:297
```

Re-measured with the exact command this doc's earlier note warns about
(`npx jscpd src e2e --min-lines 5 --silent --reporters json`): **83 exact clones,
841 lines (5.08%), across 119 analysed files** — a non-trivial file count, so this
is a real result and not the `0 files` misconfiguration recorded above. Total
clone count moved (78 → 83) because this run scoped to `src e2e`, dropping `api`
from the earlier whole-repo `src api e2e` run and picking up a few more
test-to-test arrangements; the number that matters for this slice, prod-to-prod,
is the one that dropped. **The two exclusions any future duplication gate needs
are unchanged: `lib/database.types.ts`** (generated by the Supabase CLI — a hand
edit is undone by the next regeneration) **and `index.css`** (Tailwind theme
blocks, where the repetition is the format, not a defect).

Three modules replaced the eight-clone duplication between the auth pages and the
three `Create*Dialog` components:

- **`src/routes/form-primitives.tsx`** — `FormRootError` (the form-level error as
  a `<p role="alert">`) and `SubmitButton` (`label`/`pendingLabel`, disabled and
  swapped while `isSubmitting`), plus `selectClass`, moved out of
  `EditableText.tsx` so the native-`<select>` styling is defined once.
- **`src/routes/CreateDialog.tsx`** — the shared create-dialog shell: owns open
  state, chrome, the `<Form>` wrapper, `FormRootError`, footer and
  `SubmitButton`. It **never closes itself** — `onSubmit` receives an explicit
  `close` callback, so a create that should stay open on failure (the pattern
  every one of the three dialogs relies on) is the caller's decision, not the
  shell's.
- **`src/routes/AuthCredentialFields.tsx`** — the email + password field markup
  shared by `LoginPage` and `SignupPage`. Markup only; `passwordAutoComplete`
  (`'current-password'` vs `'new-password'`) is the one attribute that legitimately
  differs and is threaded through as a prop.

`CreateProjectDialog`, `CreateSprintDialog`, `CreateTicketDialog`, `LoginPage` and
`SignupPage` were rewritten onto these three modules: −465/+245 lines across the
five call sites. The five existing component test files —
**`LoginPage.test.tsx`, `SignupPage.test.tsx`, `CreateProjectDialog.test.tsx`,
`CreateSprintDialog.test.tsx`, `CreateTicketDialog.test.tsx`** — were **not**
modified; `git diff --stat main --` against all five is empty. That is what makes
the behaviour-preservation claim checkable rather than asserted, the same
constraint the first three slices ran under.

**A design claim was tested and found false, and the correction is the finding.**
The plan asserted that subscribing to form state via `useFormContext().formState`
instead of `useFormState()` would produce "a form-level error that is set but
never painted," and that `LoginPage.test.tsx`'s alert assertion would catch the
swap. An isolated experiment ran both implementations of both primitives across
four arrangements — a `React.memo` wrapper, a `useForm()` owner in a grandparent
with the direct parent proven by a render-count spy never to re-render, a
memoized sibling, and a lazy-mounted error region — and **every arrangement
painted every root-error and `isSubmitting` change identically**. The two
subscription styles are behaviourally indistinguishable to every test this repo
can write today; no existing or addable test catches the swap. The stated
*reason* was also wrong: the prediction was that `FormProvider` churns its
context value on every render, making `React.memo` a no-op barrier — in fact
`FormProvider` memoizes that value and `React.memo` **is** a working barrier, so
the fix both the implementer and the task reviewer independently proposed (add a
memo boundary to make the test bite) would not have worked either.
`useFormState()` was kept anyway, for a real but untestable reason — it is an
independent per-component subscription, so a large form does not re-render
wholesale when an unrelated field changes elsewhere — and
`src/routes/form-primitives.tsx` now carries a comment saying plainly that no
test can catch the swap, in the same spirit as "On guards that no test can
observe" below.

**The refactor created a hazard, and mutation testing caught it, not reading.**
`setKeyEdited(false)` used to live inside `CreateProjectDialog`'s own
`handleOpenChange`, in the same function as the close transition, where it could
not be omitted without deleting the close handler itself. Moving it out to an
optional `onClosed` prop on `<CreateDialog>` made it silently droppable: deleting
the prop left the whole suite green, including the existing
`CreateProjectDialog.test.tsx`. The implementer's first instinct was that that
file already covered it; it does not, because it renders a synthetic form and
never opens/closes the real dialog. Closed by a new
`src/routes/CreateProjectDialog.reopen.test.tsx` — proven red before the fix and
green after, with a positive control that first establishes `keyEdited` was
genuinely set (typing the name no longer overwrites a hand-edited key) before
asserting it resets across a close/reopen.

**What is still not covered, stated rather than omitted.**
`AuthCredentialFields.test.tsx` asserts only attributes (`type`, `autocomplete`,
`placeholder`) never a value/`onChange` round-trip, so deleting `{...field}` from
either input leaves that file's own suite green. It is caught only one layer up,
by `LoginPage.test.tsx`/`SignupPage.test.tsx` typing a password and asserting the
credential reaches `signInWithPassword`. A pre-existing gap relocated by this
slice, not introduced by it — the shared component is not self-certifying on its
own.

`npm run test:unit` (integration suites excluded, matching this doc's coverage
methodology) runs **467 tests across 43 files** at this slice's head, 2026-07-27
— a point-in-time count. `npm run lint:standards` remains **0 findings**.

### On guards that no test can observe

Two of these slices surfaced a guard whose removal is invisible to the whole suite —
`patchLoaded`'s phase check (redundant with the derivation's phase gate) and
`decomposeEpic`'s `Array.isArray(body.proposals)` (redundant with the surrounding
`try/catch`). Both were kept, and both now carry a comment saying **no test can prove
them**, verified by mutation.

That comment is the point. Without it the next reader either deletes a guard expecting
a red test, or writes a test that cannot fail and believes it is covered. Recording
"this is defence in depth and here is why nothing catches its removal" is more honest
than either.
