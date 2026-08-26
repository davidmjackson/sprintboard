# Session record, 2026-08-25 (desktop planning session)

**Purpose: rollback and verification, not narrative.** If something here is wrong,
this file tells you what changed, what it breaks, and how to undo it. Delete it
once the changes are committed and green.

Written by Claude desktop, which **cannot execute anything on this machine**.
Everything below was edited via the filesystem connector and **has never been run**.

---

## UNVERIFIED. Run this before anything else.

    npm run verify

**Two files were changed together and they are coupled.** If `verify` is red, the
cause is almost certainly here.

---

## Change 1 — T2 raised from 10 to 15 (COUPLED, highest risk)

| File | Change |
|---|---|
| `eslint.config.js` | `complexity: ['error', { max: 10 }]` becomes `max: 15` |
| `verify-gate.test.mjs` | T2 boundary test now 14 passes / 15 fails, was 9 / 10 |
| `verify-gate.test.mjs` | `OVER_COMPLEX` and `OVER_COMPLEX_JS` probes raised 14 to 20 branches |
| `docs/adr/0007-t2-is-raised-to-15.md` | New. Records the decision and what reverses it |

**Why coupled:** `verify-gate.test.mjs` pins every threshold at its boundary in
both directions. Change the config without the test and the suite goes red. The
two `OVER_COMPLEX` probes were sized at 14 branches (complexity 15) to exceed the
old limit of 10; at a limit of 15 they now PASS, so the override tests that assert
`toContain('complexity')` would fail. Raising them to 20 fixes that.

**If `verify` is red on `complexity` or `verify-gate`:** revert all four together.
Do not revert only the config.

    git checkout eslint.config.js verify-gate.test.mjs

**Rationale, if you need it:** the codebase carried three docblocks explicitly
saying a function was split to stay under cyclomatic 10 (`BoardColumnSummary`,
`BoardColumnEmpty`, `removeStatus`). A permanently saturated ceiling is a design
constraint nobody agreed to. Full argument in ADR 0007.

**Note:** this repo does not import the shared profile at
`/var/www/CodingStandards/profiles/typescript/eslint.config.js`. It restates the
numbers inline, so this change diverges from a copy rather than overriding an
import. See "still open" below.

---

## Change 2 — documentation only, zero executable risk

| File | Change |
|---|---|
| `CLAUDE.md` | Two new sections at the TOP: scope freeze / stop condition, and nine ways-of-working rules |
| `README.md` | New. Root-level, one page. Did not exist before |
| `docs/2026-08-24-prose-reduction-brief.md` | New. Tasks 0 and A to E for a Claude Code pass |
| `docs/adr/0011-test-coverage-is-not-gated.md` | New. **Status PROPOSED. David has not ruled.** |

Nothing executable reads any of these. `domain.test.ts` parses
`docs/sprintboard_phase1_schema.sql`, which was **not touched**.

**`CLAUDE.md` grew by roughly 9 KB and is now 75,118 B**, against a 12,288 B
ceiling. That is the subject of Task 0 in the brief and is the largest single
per-session cost in this repo.

---

## Still open, needing David rather than code

1. **ADR 0011, coverage.** T7 requires 80% and `verify` has no coverage step at
   all, with no ADR recording why. Run `npx vitest run --coverage` BEFORE choosing
   between gating it and writing the exemption. The ADR says do not decide without
   that number.
2. **`src/test/project-type-immutability.test.ts` (39 KB).** Redundant, not wrong:
   `project_type` is already immutable at the privilege layer, since
   `authenticated` holds no table-level UPDATE on `projects`. Ask before removing.
3. **Whether T2 becomes 15 globally** in `CodingStandards/core/THRESHOLDS.md`, or
   stays a per-repo ADR override. Evidence is one repo, so probably stays for now.
4. **Consume the shared ESLint profile** rather than copying it. `npm pack` in
   `/var/www/CodingStandards/profiles/typescript`, vendor the tarball as
   `sample-repos/typescript-sample` already does, then ADR 0007 becomes a real
   one-line override.

---

## Changes in OTHER repos, same session

- **`~/.claude`** — committed and pushed as `fc3e6c8`. Ultracode cost table split
  to `~/.claude/docs/ultracode-costs.md`; shell-command rule widened to every
  command with a one-at-a-time stop-and-wait contract. Nothing to verify.
- **`/var/www/CodingStandards`** — **uncommitted, and one file is executable.**
  See `docs/2026-08-25-session-record.md` in that repo.
