# ADR 0002 — Size thresholds apply to production code, not test files

**Status:** Accepted, 2026-07-25
**Overrides:** T1, T3, T5 in test files, from
`/var/www/CodingStandards/core/THRESHOLDS.md`

## Context

In Vitest and Playwright specs, a `describe` block is a function. T1 (30 lines)
and T5 (400 lines) therefore measure how many cases a suite covers, and a suite
that grows because it tests more is penalised exactly like a God class.

Measured on adoption day: **64 violations in test files against 23 in
production** — 59 of them T1 on `describe` blocks. Left on, the report would be
73% noise on its first run, which is how a warnings-only report gets ignored.

## Decision

In `**/*.{test,spec}.{ts,tsx}`, `src/test/**` and `e2e/**`, T1, T5 and T3 are
off. **T2 (cyclomatic complexity 10) and T4 (parameters 4) stay on** — branchy
test code is a real smell and neither rule fires on suite size.

Coverage is unaffected by this ADR: the 80% threshold is measured on production
code and is currently met.

## Consequences

- A 1,200-line test file is not flagged. Accepted: splitting suites to satisfy a
  line count makes them harder to navigate, not easier.
- The report now speaks about production code only, so a non-zero count means
  something to act on.

## Addendum, 2026-07-28

SPRIN-50 extended this decision's principle from the size thresholds to
duplication. `scripts/check-duplication.mjs` scans production code only, on the
same reasoning: a naive scan of `src` reports 5.30% duplication (870 of 16,429
lines), almost all of it arrange blocks in the integration suites. Gating that
would force suites to be restructured to satisfy a duplication metric, exactly
as gating T1/T5 would have forced them to be split to satisfy a line count. The
decision above is unchanged; this records that its scope now covers a third
threshold. See docs/adr/0005-the-duplication-gate.md.

## Addendum, 2026-07-29 — the override glob gained `.mjs` (SPRIN-60)

The **Decision** above now reads `**/*.{test,spec}.{ts,tsx,mjs}`. Nothing about
the decision changed; the file list it was always meant to describe did.

Until SPRIN-60, `eslint.config.js` scoped every rule to `'**/*.{ts,tsx}'`, so no
`.mjs` file was linted at all and this override had nothing to say about them.
Widening that glob to `{ts,tsx,mjs,js}` brought `verify-gate.test.mjs` and
`scripts/check-bundle.test.mjs` into scope, and their `it` blocks are suite size
for exactly the reason argued above. Measured before widening: with `.mjs` in the
main scope but *not* in this override, the repo reported 7 T1 violations, 6 of
them `describe`/`it` blocks in those two files. With this override extended, 1 —
a genuine 43-line `main()` in `scripts/check-bundle.mjs`, since split.

**The extension list matters and a bare `'**/*.mjs'` would be wrong.** It reads as
the tidier glob and would silently re-exempt `scripts/check-bundle.mjs` — the
control that keeps a service-role key out of the browser bundle, and the whole
reason SPRIN-60 existed. `verify-gate.test.mjs` pins this: one test asserts T1 is
off in a `.mjs` test file, another that it stays on in a non-test `.mjs`.
