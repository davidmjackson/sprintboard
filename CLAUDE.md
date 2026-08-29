# Sprintboard

Scrum delivery board, part of the Sprint Suite: enough of Jira's core to stand in for it, and
no more.

## SCOPE IS FROZEN

**Sprintboard is feature-complete.** The MVP is six things and all six ship today: Scrum and
Kanban boards; backlog; create/edit/delete tickets; statuses; tickets traverse the board by
status; drag and drop on the board.

**Done means those six behaviours work for two users on one project without data loss.
Anything else is a new project.**

That sentence is the gate. A proposal that does not make one of the six work better is out of
scope, however good it is, and the correct response is to say so and stop rather than to
design it.

**CLOSED, not paused** — do not extend, refine or generalise: custom statuses, Kanban project
type, custom fields, sprint cadence, WIP limits, blocked flags, ticket search, teams and roles.
Four were never in the brief; they are kept because they exist and work.

**REFUSED.** The AI layer stays parked — a FastAPI service with AI epic decomposition and a
grounded estimation assistant was built and then **deliberately removed** in the 2026-07-29
pivot. **Do not re-add any of it without being asked.** So is anything shaped like Jira parity:
workflow transition rules, permission schemes, dashboards, reporting, cross-project boards,
comments, attachments, notifications, an activity feed. If a task appears to require a parked
feature, stop and flag it.

**The three known gaps**, named so nobody re-derives them as work: **no persisted rank** (cards
order by `number`, so drag within a column does not persist — a real gap in item 6, and the
**only** one in scope to fix); **no change history table**; **no subtask level**. The last two
are out of scope.

---

## HOW TO WORK ON THIS REPO

Nine rules, from an over-engineering review whose finding was: **the code is good; the volume
around it is not.** These are about writing less around the code, not writing better code.

**1. Default to closing, not opening.** When asked what is next, the first candidate answer is
**"nothing, it ships"**. Every story states in one line which of the six it serves; a story
that cannot name one is out of scope by definition.

**2. A comment says what a reader needs NOW** — not how the code got here. **Corrections
replace; they never accumulate.** Rewrite the wrong claim; never leave it visible with a note
beside it. Delete on sight: story keys as narrative, review-round references, rejected
alternatives, measurement stories, and any justification for satisfying a lint threshold. **If
the reasoning runs past ten lines it is an ADR**, referenced in one line. Budget: **under 25%
comment in `src/lib`.**

**3. Justify it somewhere it does not live forever.** David reviews code he cannot write, so an
agent explains itself in the only place he is certain to look — and that compounds, because each
session's prose becomes the next session's context. **The fix is not less explanation; it is
explanation that expires.** Every session ends with a plain-English paragraph — what changed,
why, what breaks if undone — in the PR description and the handover. **Not in the source.**

**4. One control per rule.** Two guards on the same property mean neither can be proven, because
removing either leaves the suite green. Before adding a control: what does it catch that nothing
else catches, and how does it fail — open or closed? A control that cannot answer the second is
not a control.

**5. No controls on controls without a recorded miss.** `verify-gate.test.mjs` earns its place
because two live suites really were dropped from collection. That is the bar: a real failure
that really happened.

**6. Thresholds measure; they do not design.** If a function is split or a call rewritten to
satisfy a lint rule, that is a finding about **the rule** — raise it as one, as ADR 0007 does.
Never write a comment explaining that code is shaped a certain way to keep the gate green; if
the shape needs that defence, the gate is wrong.

**7. A review finding gets a fix or a note, never both.** Severity-gate it: on a feature that
works, **Minor findings are logged, not fixed.** Only Blocker and Major reopen shipped code.

**8. `HANDOVER.md` gets pruned, not appended.** It says where the project is, not everywhere it
has been. `CLAUDE.md` holds standing rules, `docs/adr/` holds decisions, `HANDOVER.md` holds the
current position. Never let one do another's job.

**9. Some of this repo is right. Do not level it.** **The live RLS integration suites stay
exactly as they are** — there is no backend, so the database is the entire authorisation layer
and a mocked-client test cannot see a policy. That is the one place where the weight is
proportionate to the risk. Also keep: reads that throw rather than resolve to `[]`, tagged write
results, no Postgres enums, domain rules out of components, ACs before code.

---

## Stack and the gate

React, Vite, TypeScript (strict), Tailwind, shadcn/ui. Supabase for Auth, Postgres and RLS; anon
key client-side only. ESLint, Prettier, Vitest, Playwright.

David, 2026-07-29: *"Coding standards are… the hallmark of quality… garbage in, garbage out."*

`npm run lint` enforces **T1–T5** as errors — 30-line functions, cyclomatic **15** (ADR 0007),
cognitive 15, 4 parameters, 400-line files — and `npm run verify` runs it, so they gate every
merge. Thresholds live in `eslint.config.js`, rationale in ADRs 0001/0002/0006/0007, and each is
pinned **at its boundary** in `verify-gate.test.mjs`: at the limit passes, one unit past fails.
Widening a max there turns the suite red, deliberately.

**Scope is `**/*.{ts,tsx,mjs,js}` — every source file, not just TypeScript.** A narrower glob
once exempted `scripts/check-bundle.mjs` and `verify-gate.test.mjs`; narrowing it back is an
exemption shaped like a file extension.

Write to the thresholds from the first line. **Existing code passes** — if `lint` goes red it is
the change under review, not inherited debt. A genuine misfit is an **ADR in this repo**, never
an inline disable. **Stays deleted, do not re-add without being asked:** the duplication gate
(`jscpd`, ADRs 0003/0005) and any `lint:standards` script. `npm run lint` is the whole
enforcement surface.

## Workflow

GitHub Flow: one feature branch and one small PR per story, squash merged. Acceptance tests
written from the story's ACs before implementation. Imperative commit summaries.

**After opening a PR, watch its CI checks and diagnose any red before doing anything else.** A
red required `verify` blocks the merge — do not merge around it, do not blindly re-run it. Read
the failure first: only a known flake is safe to re-run, after a cooldown
(`docs/TESTING-NOTES.md`). **Never report a PR as shipped until its required check is green on
the PR's own head commit.**

---

## Data model

Defined in `docs/sprintboard_phase1_schema.sql`. Preserve these mechanics exactly.

**Never use a Postgres `ENUM`.** `ticket.type`, `sprint.status` and `project_type` are `text` +
a `check`, deliberately: widening a check is one line, altering an enum type is a painful
migration. Converting them would look like an improvement; **it is the single most damaging
change anyone could make to this schema.** `ticket.status` is `text` with a composite fk to
`project_statuses (project_id, slug)` rather than a check, because the vocabulary is per-project
and a CHECK body may not contain a subquery. It is keyed on the **slug**, not a surrogate id,
precisely so no ticket row is rewritten when the vocabulary changes.

**Core ticket fields stay real columns.** `story_points`, `assignee_id`, `status` are
first-class. Custom fields are **additive** — new tables alongside, never a reshaping of
`tickets`. This is what Jira does; the right end state, not a shortcut to undo.

- **Ticket keys** are project-scoped (`unique (project_id, number)`), assigned by the
  `project_counters` row and a BEFORE INSERT trigger — atomic and race-safe. **Never generate
  keys with `count(*)`.**
- **Blocked is a flag, not a column.** `sync_blocked_fields` keeps `is_blocked`,
  `blocked_reason`, `blocked_since` aligned. Requiring a reason on block is an app rule + test.
- **One active sprint per project**, via a partial unique index. Surface the rejection clearly;
  do not work around the index.
- **Status, type and column definitions live in `src/lib/domain.ts` and nowhere else.** Never
  inline a status name in a component, filter or badge-colour map. Now the values live in the
  database, `domain.ts` is the client-side contract for their *shape* — still the single place.

### RLS

**Every table has RLS, and every table resolves project access through membership or
configuration access.** Do not add a table without a policy.

**"Resolves to membership" is not one shape — there are four**, and the differences are
load-bearing, so check the table *and* the verb before assuming. **ADR 0008 is the authority**;
ADR 0009 covers the `app_auth` predicates policies call; ADR 0010 covers `project_members`,
whose control is a **GRANT** rather than a policy — read `relacl` there, not `pg_policies`. Two
rules that bite outside those ADRs:

- **A policy calling an `app_auth` function must carry `to authenticated`**, or an anonymous
  request raises 42501 where it used to get a clean empty array — breaking the keepalive
  contract, which pauses the database, which blocks every merge.
- **`projects` holds no table-level UPDATE for `authenticated`, and exactly two column grants.**
  That GRANT — not any policy — keeps `name`, `key`, `project_type` and **`owner_id`** immutable
  in the database. **Adding a writable column carries a four-part obligation; ADR 0008 states
  it.**

### Migrations

**Hand-applied.** The Supabase MCP is `read_only=true` on purpose, so `apply_migration` is
unavailable and that is not a fault to route around. Produce the SQL, hand David one copy-paste
command, run `get_advisors` afterwards and **add no new lints**.

**The advisor baseline is NOT zero — compare against it, never against zero.** Measured
2026-08-21: **4 security WARNs, 8 performance INFOs**, zero `auth_rls_initplan`; re-derive it
rather than trusting this line. Three of the four WARNs are the membership RPCs' lint 0029 and
are **expected** (ADR 0010); the four `ticket_field_values` INFOs are **David's call** to accept.
**`unused_index` is about TRAFFIC, not schema** — never record one from a reading taken straight
after a migration.

**Why we are not hedging further:** no production data and no users, so almost every schema
decision is reversible at near-zero cost. The real risk is premature generalisation.

---

## Security rules (non-negotiable)

- **Anon key only in the browser.** Two test-side credentials exist and one fact contains both:
  neither is `VITE_`-prefixed, so Vite never inlines them. `SUPABASE_SERVICE_ROLE_KEY` is
  consumed only by `adminClient()` in `src/test/supabase-clients.ts`; **`SUPABASE_DB_URL`** only
  by `src/test/pg-sessions.ts`, and it bypasses RLS *and* PostgREST, making it the **most
  privileged credential in the repo**. App code must never import either module.
  `scripts/check-bundle.mjs` fails the build if a privileged key or a credential-bearing
  postgres URI reaches `dist/`.
- Every table has RLS. Do not add a table without a policy.
- Validate at both edges: zod on the client, constraints and checks in the database.
- Guard hooks (SECRET FILE, DANGEROUS COMMAND, REMOTE WRITE, MCP WRITE) are active and
  authoritative. Prompt directives are requests; hooks are enforcement. Do not bypass them.

## Definition of Done

ACs met and covered by a test. Lint and types clean. Tests pass in CI. RLS still holds (two-user
isolation test green). One PR, squash merged. Jira issue to Done only after merge.

**CI runs `npm run verify`, and that is the gate** — required on `main`, no bypass actors. It
includes `npm test`, which includes the live integration suites. **Never wire CI to
`npm run test:unit`**: it excludes them and needs no secrets, so CI would stay green while "RLS
still holds" went unmet on every PR. The tripwire is the **gap** between the two collections —
`docs/TESTING-NOTES.md`.

## Verification and review depth

Two "green" checks have been reported here that were not green, both the same shape: **the check
that ran was not the check that was claimed.** So: verification means `npm run verify`, never a
subset and never a proxy; compare against `origin/*` and fetch first; never truncate output you
are using as evidence; **a surprising result is a hypothesis, not a finding** — re-derive it a
second, independent way before acting on it.

**An ordinary story gets ONE reviewer on PR open** — no review fleet for a form field. **A
security-boundary diff gets the deep multi-agent review**, and that boundary is narrow:
authentication, RLS / tenant isolation, secret handling, or the CI gate workflow itself.
Mutating reviewers each get their own worktree; ask a reviewer to mutate, not to read. Evidence:
`docs/TESTING-NOTES.md`.

## Infrastructure

Supabase's free tier pauses a project after ~7 days idle, and **a paused database blocks every
merge** — including the PR that would fix it. A cron-job.org job hits
`/rest/v1/tickets?select=id&limit=1` daily with the anon key and expects `200 []`;
email-on-failure is the only monitoring, so do not disable it. **Do not point it at
`/rest/v1/`** — that 401s for the anon key, and the only way to make it work is to ship the
service-role key to a third party. Contract and rationale: `docs/TESTING-NOTES.md`.

## Jira tracking

Claude Code owns the `SPRIN` board through the **Composio** MCP connector. **The board is the
source of truth for what is left to build** — query it (`statusCategory != Done`) rather than a
document, and move each issue as work progresses. Details: `docs/TESTING-NOTES.md`.

**This file sits ~2.6 KB over the 12,288 B budget the Stop hook checks, by David's
decision on 2026-08-29.** The warning is accurate and expected; what remains is standing
rules, not history. **Do not trim the nine rules to silence it** — that is rule 6 applied
to this file. Reasoning: `docs/2026-08-24-prose-reduction-brief.md`.

## Key files

- `docs/HANDOVER.md` — current position, open follow-ups, settled non-issues. **Read before
  planning a story.** Context behind the board, never a substitute for it.
- `docs/adr/` — decisions and their reasoning. **0008–0010 carry the RLS model.**
- `docs/TESTING-NOTES.md` — live-suite flake signatures, the concurrency harness, jsdom
  accessible names, the E2E suite, keepalive, review depth. Read when you hit one.
- `docs/sprintboard_phase1_schema.sql` — the database schema.
- `docs/standards-audit-2026-07-25.md` — historical, except two live sections: the eight
  pre-existing coverage gaps left unfixed, and the note on guards no test can observe.
