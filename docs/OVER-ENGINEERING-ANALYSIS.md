# Over-engineering analysis and safe-removal plan

**Measured 2026-08-25.** Supersedes the verbal "roughly 60 percent" figure from the
2026-08-24 desktop review. That number was an impression, not a measurement, and it
is corrected below.

---

## Verdict

**Sprintboard is over-engineered, but almost none of it can be safely removed by
deleting features.** The waste is sunk. What comes out cleanly is **prose, dead
guards and unshipped apparatus (~210 KB)**, not working functionality.

Deleting working features now to hit a scope number would cost more than it saves
and would risk data loss for zero user benefit. The plan below removes nothing a
user can see.

---

## Correcting the 60 percent claim

**What the data shows.** Every file in `src/lib` and `src/routes` classified
against your six-item brief:

| Epic (not in the brief) | Prod KB | Test KB | Total KB |
|---|---:|---:|---:|
| Custom fields | 127.1 | 208.7 | **335.8** |
| Teams and roles | 22.2 | 24.1 | 46.3 |
| Sprint cadence | 15.3 | 22.1 | 37.4 |
| WIP limits | 5.5 | 22.9 | 28.4 |
| Epics and deliverables | 10.1 | 6.2 | 16.2 |
| Search and blocked flags | 4.9 | 2.7 | 7.6 |
| **Out of brief** | **185.0** | **286.7** | **471.7** |
| **All of `src/lib` + `src/routes`** | 595.3 | 1029.4 | 1624.7 |

**Out-of-brief share of all code: 29 percent.** Production code 31 percent, test
code 28 percent.

A second, independent proxy agrees. Of 13 tables in the schema, **4 are
out-of-brief** (`project_fields`, `project_field_options`, `ticket_field_values`,
`project_members`): **31 percent**.

**Two measures, converging on ~30 percent. Not 60.**

### My judgement, stated separately

**True effort share is higher than 30 percent, but I cannot prove 60.** Three
reasons effort exceeds surviving code:

1. **A new table costs far more than its KB.** Each brought a migration, RLS
   policies, and live integration coverage. Custom fields added 3 of 13 tables.
2. **SPRIN-75 rewrote RLS across all 10 tables**, not just the one it added. That
   cost is spread through files I classified as in-brief, so it counts as zero here.
3. **The AI layer was built and then deleted.** It cost real weeks and leaves zero
   bytes, so this measurement cannot see it at all.

**Best honest estimate: 40 to 50 percent of elapsed effort.** Flagged as an
estimate. The only measured numbers on this page are the two ~30 percent figures.

**The correction matters more than the number.** I asserted 60 percent confidently
from an impression, and it was roughly double what the artefacts support. Treat any
effort-share figure not backed by story-level time data as an opinion.

---

## Detail: what each out-of-brief epic actually added

**Custom fields (SPRIN-71) — 336 KB, 3 tables, the single largest item.**
Five field types, an options table, a values table with a type-matching check
constraint, per-type draft parsers, a settings UI, and a create-ticket integration.
`CustomFieldSettings.test.tsx` alone is 48 KB. This is Jira *parity*, not Jira MVP,
and it is over 20 percent of the whole codebase.

**Teams and roles (SPRIN-75) — 46 KB visible, far more real.**
A membership table, admin/member roles, three `SECURITY DEFINER` RPCs, a
concurrency suite for a last-admin race, and a full RLS rewrite across every table.
The 46 KB badly understates it: the rewrite touched files counted as in-brief.

**Sprint cadence (SPRIN-74) — 37 KB, 3 migrations.**
Configurable sprint length and start weekday, with date prefill. Your brief says
"Scrum boards"; it does not say configurable cadence.

**WIP limits — 28 KB.** Per-status limits with board enforcement. Note the shape:
5.5 KB of production code carrying 22.9 KB of tests, a 4.2x ratio.

**Epics and deliverables — 16 KB.** Hierarchy above the ticket.

**Search and blocked flags — 7.6 KB.** Small, and the only two where the cost is
genuinely trivial.

**The AI layer — 0 KB, weeks of effort.** Built, then deliberately deleted on
strategic grounds. Invisible to every measurement on this page.

---

## Safe-removal plan

Three tiers by risk. **Only Tier 1 is recommended.**

### Tier 1 — remove now, no user-visible change (~210 KB)

Every item is a comment-only or test-only diff. Nothing a user can see changes, and
`npm run verify` must stay green throughout.

| # | Item | Size | Risk |
|---|---|---:|---|
| 1 | `CLAUDE.md` prune, 75 KB toward 12 KB | ~63 KB | None. Nothing executable reads it |
| 2 | `src/test/project-type-single-expression.test.ts` | 21 KB | None. Fails open; a planted mutation already survived it |
| 3 | Comment reduction in `domain.ts`, `project-statuses.ts`, `ticket-field-values.ts` | ~60 KB | None if the diff is comment-only |
| 4 | Comment reduction in `sprintboard_phase1_schema.sql` (68% comment) | ~65 KB | None. Documentation artefact |

**Sequence matters.** Do 1 first: it is the largest, the simplest, and it is paid on
every session. Full specs are in `docs/2026-08-24-prose-reduction-brief.md`.

**Load-bearing material does not get deleted, it moves.** The RLS reasoning goes to
`docs/adr/0008` through `0010`. The prose is in the wrong location, not worthless.

### Tier 2 — needs your ruling, do not act alone

| Item | Size | The question |
|---|---:|---|
| `src/test/project-type-immutability.test.ts` | 39 KB | Redundant: `project_type` is already immutable at the privilege layer, since `authenticated` holds no table-level UPDATE on `projects`. Belt-and-braces on a database-enforced property. Security-adjacent, so it is your call |
| T7 coverage gate | n/a | ADR 0011, status PROPOSED. Run `npx vitest run --coverage` before deciding |

### Tier 3 — DO NOT REMOVE

**All six out-of-brief features stay.** Custom fields, teams and roles, cadence, WIP
limits, epics, search. They work, they are tested, and they are shipped.

**The reasoning:** the cost is already paid. Removing them means new migrations,
data-loss risk, a fresh round of RLS changes and re-testing. That is *more* work
than leaving them, in service of a tidier scope statement nobody sees. **Deleting
working software to make a metric look better is the same failure in reverse.**

`CLAUDE.md`'s scope freeze already handles this correctly: they are marked CLOSED,
not paused. Kept because they exist and work, not because they were needed.

**The RLS integration suites also stay.** With no backend, the database is the
entire authorisation layer and a mocked-client test cannot see a policy. That is the
one place in this repo where the weight is proportionate to the risk.

---

## What this changes going forward

Nothing in Tier 1 prevents recurrence. The prevention lives in
`/var/www/CodingStandards/core/SCOPE-DISCIPLINE.md`, which is the checkable version
of this lesson, and in the scope freeze at the top of `CLAUDE.md`.

**The single most useful sentence to carry forward:** a project without a written
stop condition will not stop, because nothing in it ever says *enough*.
