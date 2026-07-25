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
