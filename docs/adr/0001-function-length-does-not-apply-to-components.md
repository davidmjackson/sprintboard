# ADR 0001 — T1 (function length) does not apply to `.tsx` components

**Status:** Accepted, 2026-07-25
**Overrides:** T1, `max-lines-per-function` max 30, from
`/var/www/CodingStandards/core/THRESHOLDS.md`

## Context

The standard caps a function at 30 lines. In `.tsx` files the returned JSX
counts toward that number, so an ordinary React component trips the rule on its
markup rather than on its logic.

Measured against the codebase on adoption day: **19 production violations of T1,
18 of them in `.tsx`** — `AppLayout`, `BacklogTab`, `BoardTab`,
`CreateTicketDialog`, `LoginPage`, `SignupPage`, `ProjectShell` and peers. Only
one was in a `.ts` file (`src/lib/ai.ts`).

Satisfying the rule in those 18 would mean extracting sub-components to move
lines across a file boundary — splitting for a metric, not for a design reason.
The threshold is doing its job on logic and misfiring on markup.

## Decision

`max-lines-per-function` is **off for `**/*.tsx`** and **on everywhere else**,
including all of `src/lib/**`, where it measures real logic and where the one
genuine violation lives.

The other four thresholds (T2 complexity 10, T3 cognitive 15, T4 params 4,
T5 file length 400) apply to `.tsx` unchanged. T2 and T5 are what actually catch
oversized components — `TicketDetailDialog.tsx` is flagged by both.

## Consequences

- A 200-line component passes T1 but is still caught by T5 at 400 lines and by
  T2/T3 if its logic is tangled. Component bloat is not unmeasured, it is
  measured by the rules that survive JSX.
- If component logic is later extracted into hooks (`.ts`), T1 applies to it
  automatically.
