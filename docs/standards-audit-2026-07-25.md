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
