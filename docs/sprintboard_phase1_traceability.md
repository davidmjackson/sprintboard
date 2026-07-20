# Phase 1 — E8 traceability (Definition of Done & RLS-in-CI)

_Epic **SPRIN-8 / E8 — Quality and Definition of Done.** Goal: the build is provably
correct, not just apparently working._

Two E8 stories describe standing properties of the repository rather than new features.
This record maps each acceptance criterion to the artefact that already satisfies it, so
the audit is itself auditable. Nothing here changes behaviour — it is the evidence trail
for closing S8.2 and S8.3.

> The third E8 story, **S8.1** (end-to-end happy-path suite), shipped as a build in PR
> #35 (`0415010`) and is not re-audited here.

---

## S8.2 — Definition of Done checklist (SPRIN-37)

**AC:** CLAUDE.md carries a DoD: tests pass, lint and types clean, RLS holds, one PR per
story, squash merged.

**Evidence:** [`CLAUDE.md`](../CLAUDE.md) → section **“Definition of Done (per story)”**.
Each required item is present verbatim:

| AC item | DoD line in CLAUDE.md |
|---|---|
| tests pass | “Tests pass in CI.” — and “**CI runs `npm run verify`, and that is the gate.**” |
| lint and types clean | “Lint and types clean.” (`npm run verify` runs `eslint .` and `tsc -b`) |
| RLS holds | “RLS still holds (two-user isolation test green).” |
| one PR per story | “One PR, squash merged.” + Workflow: “One feature branch and one small PR per story.” |
| squash merged | “One PR, **squash merged**.” + Workflow: “Squash merge.” |

The DoD also fixes the gate against a known failure mode — wiring CI to `npm run test:unit`
would drop every `*.integration.test.ts` (including the RLS suite) and leave the “RLS still
holds” line quietly unmet. That guidance lives alongside the checklist in CLAUDE.md.

**Status:** met by existing documentation. No code or docs change required to satisfy the AC.

---

## S8.3 — RLS regression in CI (SPRIN-38)

**AC:** the two-user isolation test from S1.3 runs on every PR.

**Evidence trail:**

1. **The test.** [`src/test/rls.integration.test.ts`](../src/test/rls.integration.test.ts)
   — `describe('RLS isolation between two users', …)`. Signs in as two distinct live users
   (A and B), has A create a project/sprint/ticket, and asserts B cannot read or write A’s
   rows. RLS filters (it does not raise), so the suite counts rows and pairs every negative
   with a positive control.

2. **It runs on every PR.** [`.github/workflows/verify.yml`](../.github/workflows/verify.yml)
   fires on `pull_request: branches: [main]` (and `push` to `main`). The job runs
   `npm run verify` → `… && npm test` → `vitest run`, which collects
   `*.integration.test.ts`. CI supplies `RLS_TEST_A/B_*`, so the suite’s
   `skipIf(!hasRlsCredentials)` guard is inactive and the isolation cases execute rather
   than skip.

3. **It is the gate.** The `verify` job is the required status check on the `main` ruleset
   (a GitHub server-side setting, not visible in the repo files), with no bypass actors — a
   red run blocks the merge. The workflow header documents why an
   `if:`, a `strategy.matrix`, or a `paths:` filter must never be added to this job: each is
   a way for the gate to report success without having verified anything.

**Status:** met by existing CI. No workflow change required to satisfy the AC.

---

## How to re-verify

```
npm run verify        # lint + format:check + build + full test suite (incl. RLS isolation)
```

CI runs this exact command on every PR. Local and CI cannot drift: there is one definition
of `verify`, in `package.json`, and both sides call it.
