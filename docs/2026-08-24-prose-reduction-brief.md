# Brief: prose reduction and guard removal

**Raised:** 2026-08-24, from the over-engineering review.
**For:** Claude Code CLI, in the repo, on a branch, through `npm run verify`.
**Not for:** desktop. These are large mechanical diffs and the whole point is that
David can review them as a git diff and confirm the executable code did not move.

---

## The measurement this brief exists to fix

| File | Total lines | Code | Comment |
|---|---|---|---|
| `src/lib/domain.ts` | 819 | 222 | **526 (70%)** |
| `docs/sprintboard_phase1_schema.sql` | 2,414 | 718 | **1,519 (68%)** |
| `src/routes/ProjectShell.tsx` | 469 | 212 | 229 (52%) |
| `src/routes/BoardTab.tsx` | 413 | 214 | 184 (46%) |

Every future change to these files costs three lines of English per line of
TypeScript. That is the whole problem. The comments are not wrong, they are a
diary, and they preserve superseded claims on purpose.

---

## Task 0 — CLAUDE.md, and this now outranks everything below it

**Measured 2026-08-25: `CLAUDE.md` is 75,118 B.** The ceiling in
`/var/www/CodingStandards/core/MEMORY-BUDGET.md` is **12,288 B**. That is 6.3x
over, and it is paid **in full, at the start of every single session**, before
`MEMORY.md` even loads.

That file already recorded this exact failure on 2026-08-04, when `CLAUDE.md` was
34,257 B and it noted the file had "no cap protecting it". **It more than doubled
in the twenty-one days since**, because nothing measured it.

**The trigger is now wired, and it was not when this line first claimed it was.**
`hooks/dispatch.sh` held `check_claude_md_budget` but nothing in this repo invoked
it: there was no `.claude/settings.json` at all, and the dispatcher's only Stop
entry point ran the *full* gate — which would have re-imposed `jscpd` this repo
deliberately deleted and run the live suites on every Stop. A `budget` mode was
added to the dispatcher so the shared implementation is invoked rather than copied,
and `.claude/settings.json` now calls it on Stop. It warns; it never fails.

**Do this first.** It is cheaper than Task D, it is pure markdown with no
executable risk, and it is the single largest per-session cost in the repo.

### Target, and the outcome

**Target was under 12,288 B. Executed 2026-08-29: 75,118 B -> 14,945 B, an 80.1%
cut.** That stops 2,657 B short of the ceiling, **by David's decision on
2026-08-29, and the shortfall is closed — do not reopen it.**

Everything remaining is a standing rule rather than history: the scope freeze and
the nine ways-of-working rules are ~4,600 B by themselves, and both are on the
"what stays" list below. Closing the last 2,657 B means cutting normative rules,
which is rule 6 — *thresholds measure, they do not design* — applied to this file.
The Stop hook warns on every session and that warning is **accurate and expected**.

**So: a future session that sees `CLAUDE.md is 14,945 B, over the 12,288 B ceiling`
has found the known state, not a task.** Trimming the nine rules to silence it is
the specific mistake this paragraph exists to prevent. The two alternatives were
priced and rejected: raising the ceiling by ADR (weakens the budget's teeth for a
number nobody is enforcing), and pushing the data-model invariants out to ADR 0008
(makes `CLAUDE.md` stop stating the ENUM, ticket-key and blocked-flag rules
directly, so an agent must follow a pointer to find them).

### What stays (this is the short list, and it is genuinely short)

- The scope freeze and stop condition.
- The nine ways-of-working rules.
- **The current, true statement of each schema invariant**, one paragraph each:
  never use a Postgres `ENUM`; core ticket fields stay real columns; ticket keys
  are project-scoped and blocked is a flag; the four RLS policy shapes and which
  table has which; the `to authenticated` requirement on any policy calling
  `app_auth`; the `project_members` GRANT shape and its three RPCs; migrations
  are hand-applied; the advisor baseline is not zero.
- The four-part obligation for adding a writable `projects` column.
- The pointer to `HANDOVER.md` and `docs/adr/` for everything else.

### What goes

**Every account of how a rule came to be true.** This file is currently a
changelog. Specifically, delete:

- The epic-by-epic Rung 3 history and story tables. `HANDOVER.md` owns position.
- Every "this paragraph has now been wrong twice", "an earlier draft claimed",
  "this bullet used to say", "reviewers killed this finding twice". **Rule 2:
  corrections replace, they never accumulate.** State the rule that is true now.
- Every SPRIN key used as narrative rather than as a reference.
- The measurement stories behind each invariant. Keep the invariant, drop the
  archaeology.
- Rejected alternatives and their pricing. These are ADR material.

### Where the good material goes

The RLS reasoning is genuinely valuable and must not simply be deleted. Three
new ADRs, each short, each referenced from `CLAUDE.md` in one line:

- `docs/adr/0008-rls-resolves-through-membership.md` — the four policy shapes,
  why the board tables stay single `for all`, and the `completeSprint` guard that
  depends on read and write staying co-extensive.
- `docs/adr/0009-app-auth-definer-predicates.md` — why `app_auth` exists, why a
  foreign-id parameter is dangerous, and the narrower argument that makes
  `shares_project_with` affordable anyway.
- `docs/adr/0010-member-writes-go-through-rpcs.md` — the GRANT-shaped control,
  the three RPCs, the last-admin guard, and SPRIN-107's lesson that deciding
  whether to lock from an unlocked read is not a lock.

**All three are written.** Task 0 landed them, along with `docs/TESTING-NOTES.md`
for the operational material that is read on demand rather than every session:
live-suite flake signatures, the concurrency harness, jsdom accessible names, the
E2E suite, the keepalive contract, the Jira board, and review depth.

### Constraint

Same as Task D: **this is a documentation-only diff.** No source file, no test,
no migration changes. `npm run verify` must stay green, which it will, because
nothing executable reads `CLAUDE.md`.

---

## Task A — delete one guard

**Delete `src/test/project-type-single-expression.test.ts` (21 KB).**

It is a text scan asserting that source code is *spelled* a particular way. Its
own docblock records that a reviewer planted a mutation which survived it:

```
const kind: string = project.project_type
const showsSprintFilters = kind === 'scrum'
```

and concludes the honest claim is narrower than the one the file was built on.
The positive half of SPRIN-82 AC5 is already pinned by behaviour, in
`ProjectShell.test.tsx`, `SprintsTab.test.tsx` and `TicketSprintField.test.tsx`.
Those stay.

Check nothing else imports `SRC_ROOT` or `sourceFiles` from `src/test/source-ast.ts`
before removing it. If `project-type-immutability.test.ts` still uses it, keep
`source-ast.ts`.

```bash
git rm src/test/project-type-single-expression.test.ts
```

## Task B — do NOT delete `verify-gate.test.mjs`

**The 2026-08-24 review recommended deleting this file. That recommendation was
wrong and is withdrawn.** Recorded here rather than quietly dropped.

Reading it in full shows it is not ceremony. It carries the `LIVE_SUITES`
registry, which is the only executable control stopping a live integration suite
being silently uncollected by one line in `vite.config.ts`. That failure has
already happened twice, at SPRIN-98 and SPRIN-105, and the file's own notes record
both. It also catches preset deletion, lint-glob narrowing and severity demotion,
each mutation-proven. Its docblock is honest about the one hole it cannot close
(a file cannot observe that it was not collected), which is tracked on SPRIN-106.

**Keep it whole.** The T2 boundary pin in it was already updated by ADR 0007.

## Task C — `src/test/project-type-immutability.test.ts` is a decision, not an action

39 KB of AST scanning to prevent a client-side write to `project_type`. That
column is already immutable at the privilege layer: `authenticated` holds no
table-level UPDATE on `projects` and only two column grants, neither of them
`project_type` (CLAUDE.md, measured 2026-08-09, re-measured 2026-08-20).

So this is belt-and-braces on a property the database enforces. It is redundant,
not wrong. **Ask David before removing it.** Do not remove it on this brief alone.

---

## Task D — the prose reduction

**Files, in this order:** `src/lib/domain.ts`, `src/lib/project-statuses.ts`,
`src/lib/ticket-field-values.ts`. One file per commit.

### The hard constraint

**The diff must be comment-only. Not one character of executable code changes.**

That is what makes this reviewable by someone who does not write code: David reads
the diff and confirms every removed line starts with `*`, `//` or sits inside a
`/** */`. If a rewrite feels like it needs a code change, stop and raise it
separately.

`npm run verify` must be green before each commit. Prettier will reflow some
docblocks; that is fine and expected.

### What a comment is FOR

**A comment tells a reader what they need now, to change this code safely.**

### DELETE

- **Story archaeology.** "SPRIN-83 bought two more", "this used to live HERE",
  "an earlier draft of this paragraph claimed", "corrected 2026-08-07",
  "AN EARLIER DRAFT OF THIS PARAGRAPH ARGUED THAT A PARSER WOULD BUY NOTHING".
- **Retracted claims kept visible.** The correction is the comment. The thing it
  corrected is not.
- **Rejected alternatives and their pricing.** These belong in `docs/adr/`.
- **Review-round narrative.** "fix round 1, Minor", "a reviewer proved it by
  planting a mutation", "killed this finding twice during SPRIN-100".
- **Complexity-gate justifications.** ADR 0007 raised T2 to 15, so
  "a pure function rather than logic in the shell's reducer, because
  `ProjectShell` is at cyclomatic 10 of 10" is now describing a constraint that
  no longer exists. Delete every one of these.

### KEEP

- **Invariants a future change could break silently.** `doneSlugs` being the one
  derivation of "terminal". `sprints_owner` being a single `for all` policy, which
  is why `completeSprint`'s guard holds. `VALUE_COLUMN` pairing `text` and
  `paragraph` on the same column.
- **Non-obvious lines and why they exist.** `Object.hasOwn` in `parseFieldValues`.
  The `null` versus `0` distinction in `summariseColumn` and `parseFieldNumber`.
  The empty-set branch in `completeSprint` avoiding a malformed `in ()`.
- **Anything a reader would otherwise "tidy up" and break.** Keep it, but as one
  sentence saying what breaks, not five paragraphs on how it was discovered.

### Where the deleted material goes

Not the bin, for the genuinely load-bearing parts. Three new ADRs, each short:

**These numbers were 0008-0010 when the brief was written, colliding with Task 0's
three. Task 0 claimed those, so Task D takes the next free block:**

- `docs/adr/0012-read-failures-throw.md` — why reads reject rather than resolve
  to `[]`, and the S4.6 defect that caused it.
- `docs/adr/0013-no-postgres-enums.md` — text plus check, never enum, and the
  composite fk on `ticket.status`.
- `docs/adr/0014-writes-return-tagged-results.md` — the `{ ok, error }` shape, the
  `stale` versus `duplicate` versus `unknown` vocabulary, and why RLS filtering a
  write to zero rows must be checked explicitly rather than trusted.

Then each docblock references the ADR in one line instead of restating it.

### Target

**Under 25 percent comment in `src/lib`.** Measure before and after and put both
numbers in the commit message. Currently 70 percent in `domain.ts`.

---

## Task E — the schema file, separately

`docs/sprintboard_phase1_schema.sql` is 68 percent comment across 2,414 lines.
Same rules, same constraint (comment-only diff), but do it **last** and as its own
commit. It is a documentation artefact rather than executing code, and hand-applied
migrations mean a mistake there is quieter than one in `src/`.

---

## Out of scope for this brief

Do not touch the RLS integration suites. They are large because the database is
the entire authorisation layer, and that is the one place in this repo where the
rigour is proportionate to the risk.
