# ADR 0011 — T7 (test coverage) is not gated in this repo

**Status:** PROPOSED, 2026-08-25. **David has not ruled on this.** Do not treat
either option below as decided.
**Concerns:** T7 in `/var/www/CodingStandards/core/THRESHOLDS.md`
**Numbering:** 0008 to 0010 are reserved by
`docs/2026-08-24-prose-reduction-brief.md` Task 0 for the RLS extractions.

## The finding

The shared standard requires **80 percent coverage**, and its Definition of Done
lists it as one of five gates. `npm run verify` in this repo is:

    npm run lint && npm run format:check && npm run build && npm test

**There is no coverage step.** There is no coverage tool in `devDependencies`, no
threshold configured in `vite.config.ts`, and `verify-gate.test.mjs` — which pins
every other part of the gate's composition, exactly and in order — does not
mention coverage either.

So T7 is not merely unmet. **It is invisible.** Nothing in this repo would report
coverage falling to 10 percent.

This matters more than the number does, because `STANDARD.md` principle 4 permits
a repo to deviate: *"Any override requires a written ADR."* T6 (duplication) was
dropped that way and ADR 0006 records it properly. T7 was never decided at all.
**Silent non-compliance is the one outcome the standard forbids**, and this ADR
exists to end it whichever way David rules.

## Option A — gate it

Add `@vitest/coverage-v8`, configure an 80 percent threshold on `src/lib/**`, and
add the step to `verify`, with the composition pin in `verify-gate.test.mjs`
updated in the same commit.

**For:** compliance with no argument needed. Real coverage is likely already well
above 80 given the test volume this repo carries, so the gate probably goes green
on the first run.

**Against:** it is a fifth gate on a repo whose scope is frozen and whose feature
work is finished. It measures a project that is not going to change much. And an
80 percent line-coverage number says little about a codebase whose most important
correctness properties live in RLS policies that unit coverage cannot see at all.

## Option B — record a deliberate exemption

Write this ADR as Accepted-with-exemption: T7 does not apply here because the
security-critical layer is the database, and coverage of client code is a poor
proxy for whether that layer holds. The live integration suites are the real
control and they already run on every PR.

**For:** honest about what actually protects this system. Adds no gate to a frozen
project. Consistent with ADR 0006's precedent of dropping a threshold on merit.

**Against:** two of seven thresholds now exempted in one repo. At some point a
standard with enough exemptions stops being a standard, and this would be the
second.

## Recommendation

**Option A, and measure before deciding.** Run coverage once, unreported:

    npx vitest run --coverage

If it is already above 80, Option A costs one dependency and one line and removes
an open question permanently. If it is well below, that is itself a finding worth
having before choosing, and Option B becomes the honest answer rather than a
convenient one.

**Do not adopt either option without that number.** Choosing an exemption to avoid
discovering a bad measurement is the failure mode this repo has already been
reviewed for once.

## What this ADR does NOT do

It does not reopen T6. ADR 0006 stands, the duplication gate stays gone, and
`verify-gate.test.mjs`'s negative assertions on `jscpd` remain correct.
