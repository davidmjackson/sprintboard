# ADR 0007 — T2 (cyclomatic complexity) is raised from 10 to 15

**Status:** Accepted, 2026-08-24
**Amends:** ADR 0006, and T2 in `/var/www/CodingStandards/core/THRESHOLDS.md`

## Context

ADR 0006 restored T1-T5 to the gate on the measurement that they cost nothing:
122 files, 0 errors, 0 warnings. That measurement was true and is not disputed.
What it could not see is the cost paid **before** the code reached the gate.

An over-engineering review on 2026-08-24 found that a limit of 10 had stopped
measuring design and started dictating it. The evidence is in the codebase's own
docblocks, which record the split rather than hiding it:

- `BoardColumnSummary` in `BoardTab.tsx`: "When it was written `BoardTab` measured
  exactly 10 ... so its three conditionals HAD to be somebody else's."
- `BoardColumnEmpty` in the same file: the `||` was placed there because
  computing the flag in `BoardTab` "took it to 11 and reddened `npm run lint`".
- `removeStatus` in `project-statuses.ts`: "A pure function rather than logic in
  the shell's reducer, because `ProjectShell` is at cyclomatic 10 of 10."

Two of the three splits turned out to be good shapes anyway, and the docblocks
say so. That is the problem rather than a defence of the limit: when a threshold
and good judgement agree, the threshold is invisible, and when they disagree the
threshold wins silently. `ProjectShell` sitting at exactly 10 of 10 for several
stories meant every subsequent change to it had to be routed elsewhere first.

A limit that is permanently saturated is not a ceiling. It is a design
constraint nobody agreed to.

## Decision

**T2 is 15.** The rule stays at `error`, stays on in test files (ADR 0002 is
unchanged), and stays off in `src/components/ui/**`.

15 is chosen because it is the same number T3 already carries, so the two
complexity measures now share a limit and neither is the one that bites first by
accident. It still refuses genuinely branchy code: a function with fourteen
independent branches is a real smell and is still flagged.

**The boundary pin in `verify-gate.test.mjs` moves with it, in the same commit.**
That file asserts T2 at its boundary in both directions (14 branches pass, 15
fail), and it also builds two shared `OVER_COMPLEX` probes that were sized to
exceed 10; both are raised to 20 so the override tests still measure the override
rather than the new limit. A change to the number here without that change turns
the suite red, which is the intended behaviour and not an obstacle to route
around.

## Consequences

- No existing file changes behaviour. The rule only relaxes, so nothing that
  passed now fails.
- The splits already made are **not** reverted. Several are good shapes on their
  own merits, and unpicking them would be churn for its own sake. What changes is
  that the next one has to be argued for rather than forced.
- T1 (30 lines), T4 (4 parameters) and T5 (400 lines) are untouched. This ADR is
  about one number and does not reopen the others.
- The duplication gate stays gone. ADR 0006's second half is unaffected.

## What would reverse this

Evidence that a function between 11 and 15 shipped a defect that a limit of 10
would have prevented. That is the measurement ADR 0006 made in the other
direction, and it is the one that should decide this.
