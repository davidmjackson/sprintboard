# ADR 0006 — Restore the T1–T5 thresholds to the gate

**Status:** Accepted, 2026-07-29 (SPRIN-59)
**Reverses:** part of SPRIN-55, which removed these rules four hours earlier
**Supersedes:** the "the standard is deliberately not wired here" paragraph SPRIN-55
added to `CLAUDE.md`

## Context

SPRIN-55, the third slice of the 2026-07-29 pivot, removed the whole code-quality
apparatus: the T1–T5 rules from `eslint.config.js`, the duplication gate
(`lint:duplication`, `scripts/check-duplication.mjs` and its 1,085-line test),
`jscpd`, `eslint-plugin-sonarjs`, and ADRs 0001/0002/0003/0005. The stated goal was
to stop ordinary stories carrying heavyweight process.

That goal was right. The execution over-reached on one point and it is worth being
precise about which, because the two are easy to confuse:

- **The ceremony was genuinely heavy.** A 585-line duplication script with a
  1,085-line test, an ADR required per threshold override, standing audit documents,
  and — the worst of it — a deep multi-agent adversarial review applied to ordinary
  UI work. That last one accounted for most of the weight, and narrowing it to
  security-boundary diffs (auth, RLS, secrets, the CI gate) is the change that
  actually lightens a session.
- **The thresholds were not heavy at all.** They are six lines of ESLint
  configuration. They cost nothing per session, run in the lint pass that was always
  going to run anyway, and report at the moment code is written rather than in a
  review three steps later.

Removing them together treated a cheap control as if it were part of an expensive
one. Worse, the prose left behind (*"do not offer to scaffold or audit the standard
here"*) generalised a narrow tooling decision into an apparent statement that the
standard did not apply to this project. It does.

> **David, 2026-07-29:** *"Coding standards are very important across all development
> done in these projects. It is the hallmark of quality and a measure of the developer
> who codes. A phrase I like to use is… 'garbage in, garbage out'."*

## The measurement that made this free

Before proposing the reversal, the T1–T5 block was restored temporarily and measured
against the tree at `a812570`:

```
122 files linted, 0 errors, 0 warnings
```

Verified with a positive control in the same run — a planted complexity-15 function
was correctly reported — so this is a real zero and not an empty scan, which is a
distinction this repo has been burned on before (see
`jscpd zero means it matched nothing`).

The reason it is zero: SPRIN-50 drove violations to zero *before* gating them, and
nothing since has added any. The pivot only deleted code. So restoring the gate needs
**no production code change whatsoever**.

## Decision

Restore, inside `npm run lint` (already inside `npm run verify`):

| | Rule | Limit |
|---|---|---|
| T1 | `max-lines-per-function` | 30 |
| T2 | `complexity` | 10 |
| T3 | `sonarjs/cognitive-complexity` | 15 |
| T4 | `max-params` | 4 |
| T5 | `max-lines` | 400 |

With the override blocks and their justifying ADRs 0001 (T1 off for `.tsx`) and 0002
(size rules off in test files, T2/T4 left on), plus `eslint-plugin-sonarjs`.

**Do NOT restore**, and do not re-add without being asked: the duplication gate
(`lint:duplication`, `scripts/check-duplication.mjs`, `jscpd`, ADRs 0003 and 0005) or
any `lint:standards` script. `npm run lint` is the entire enforcement surface.

## Consequences

- **The gate and the bar now agree again.** Before this, `CLAUDE.md` asked for
  hand-held adherence to thresholds that nothing measured — and "lint is green"
  actively misled, because it said nothing about whether a function was within them.
- **Drift is caught at write time**, not at a retrospective sweep. SPRIN-58's sweep
  now has a floor: whatever it finds cannot get worse while this is on.
- **Every threshold is pinned at its boundary** in `verify-gate.test.mjs`: at the
  limit passes, one unit past fails. Single-sided assertions are not enough —
  widening T1 30→37, T2 10→13, T3 15→20 and T5 400→404 each survived the entire
  pre-existing suite before boundary pairs were added.
- **A demotion to `warn` fails the suite.** `eslint .` carries no `--max-warnings 0`,
  so a demoted rule exits 0 on a real violation; the probes assert severity 2.
- **A genuine misfit is an ADR, never an inline disable.** Unchanged from before.
- **Six functions sit at exactly cyclomatic 10.** One added branch reddens `lint`.
  That is the gate working, not a defect to route around.
