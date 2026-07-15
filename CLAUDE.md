# Sprintboard

AI-native Scrum delivery board, part of the Sprint Suite. This is a portfolio
showcase: a credible Jira-style board with a grounded-AI layer added at Rung 2.
Parity with Jira is not the goal. A clean working slice plus defensible AI is.

---

## Locked scope: Phase 1 (Rung 1). Do not exceed.
- Scrum only.
- Fixed four board columns: To Do, In Progress, In Review, Done.
- Fixed ticket schema. No custom-field editor.
- Direct React to Supabase with owner-scoped RLS. No backend API yet.
- Issue types: Epic, Story, Bug, Task. Epics carry a context field and a
  deliverables list.
- Blocked is a flag on the ticket, never a board column.

## Parked. Do not build in Phase 1.
- **Rung 2:** FastAPI service, AI epic decomposition (traceable, with coverage-gap
  and scope-creep detection), grounded estimation assistant.
- **Rung 3:** Kanban board type, editable columns and workflows, custom fields,
  teams, roles and permissions.

If a task appears to require a parked feature, stop and flag it. Do not build it.

## Forward compatibility: keep the Rung 3 doors open. Do not walk through them.

Rung 3 will want: Kanban *and* Scrum projects, a configurable sprint cadence, custom
fields, custom columns, and custom statuses mapped to those columns. **None of that is
built now.** The rules below exist so it stays *cheap* later — they are hedges already in
the code, and each one is easy to undo by accident while thinking you are tidying up.

- **Never use a Postgres `ENUM`.** `ticket.status`, `ticket.type`, `sprint.status` and
  `project_type` are all `text` + a `check` constraint, deliberately. Widening a check is
  one line; altering an enum type is a painful migration. Converting these to a
  `create type … as enum` would look like an improvement. **It is the single most damaging
  change anyone could make to this schema.**
- **`projects.project_type` already exists** (`check (project_type in ('scrum'))`). Kanban
  is one line: add `'kanban'` to that check. Do not add it until Rung 3.
- **Status, type and column definitions live in `src/lib/domain.ts` and nowhere else.**
  Never inline the four column names in a component, a filter, or a badge-colour map.
  When columns become dynamic, one module changes instead of fifteen.
- **Core ticket fields stay real columns.** `story_points`, `assignee_id`, `status` etc.
  are first-class and must remain so. Custom fields will be **additive** — new tables
  alongside, never a reshaping of `tickets`. This is what Jira itself does: system fields
  are columns, only custom ones go in a flexible store. It is the right end state, not a
  shortcut to undo.
- **Ticket keys are already project-scoped** (`unique (project_id, number)`) and **blocked
  is a flag, not a column.** Both survive custom workflows unchanged. Preserve them.

**The one genuinely deep door is RLS, and it is not on the feature list.** Every policy on
every table resolves to `owner_id = auth.uid()`. Teams, roles and permissions means
rewriting *all* of them to a membership check — the security boundary of the whole app.
The safety net is already built: the two-user isolation suite runs live against the real
database on every PR, so a mistake in that migration goes **red**. Do not weaken it.

**Why we are not hedging further.** There is no production data and no user base, so almost
every schema decision is reversible at near-zero cost. The real risk to this project is
premature generalisation, not a missing abstraction: a half-built workflow engine with no
AI on top is a *worse* portfolio piece than a tight Scrum board that works. Build the
slice. The doors are open; leave them that way and walk through them at Rung 3.

---

## Stack
- React, Vite, TypeScript (strict), Tailwind, shadcn/ui.
- Supabase: Auth, Postgres, RLS. Anon key client-side only.
- Tooling: ESLint, Prettier, Vitest, Playwright.

## Workflow
- GitHub Flow. One feature branch and one small PR per story. Squash merge.
- Acceptance tests are written from the story's ACs before implementation.
- Imperative commit summaries.

---

## Data model
Defined in `sprintboard_phase1_schema.sql`. Preserve these mechanics exactly:
- **Ticket keys:** PROJECTKEY-N via the `project_counters` row and the BEFORE
  INSERT trigger. Atomic and race-safe. Never generate keys with count(*).
- **Blocked:** the `sync_blocked_fields` trigger keeps is_blocked,
  blocked_reason, blocked_since aligned. Requiring a reason on block is an
  app-layer rule plus a test.
- **One active sprint per project:** enforced by a partial unique index. Surface
  the rejection as a clear message. Do not work around the index.
- **RLS is owner-scoped on every table.**

## Security rules (non-negotiable)
- Anon key only in the browser. The service-role key must never ship client-side.
  The S2.1 signup integration suite uses a service-role key, but **test-side only**:
  `SUPABASE_SERVICE_ROLE_KEY` is **not** `VITE_`-prefixed, so Vite never inlines it
  into the bundle; it lives in `.env.local` and the CI runner, never the browser.
  `adminClient()` in `src/test/supabase-clients.ts` is the only consumer and app code
  must never import it. `check-bundle.mjs` fails the build if any privileged key ever
  reaches `dist/`.
- Every table has RLS. Do not add a table without a policy.
- Validate at both edges: zod on the client, constraints and checks in the database.
- Guard hooks (SECRET FILE, DANGEROUS COMMAND, REMOTE WRITE, MCP WRITE) are
  active and authoritative. Prompt directives are requests; hooks are
  enforcement. Do not attempt to bypass or disable them.

## Definition of Done (per story)
- Acceptance criteria met and covered by a test.
- Lint and types clean. Tests pass in CI.
- RLS still holds (two-user isolation test green).
- One PR, squash merged. Jira issue moved to Done only after merge.

**CI runs `npm run verify`, and that is the gate.** It is a required status check on
`main`: a red run blocks the merge, and there are no bypass actors. `verify` includes
`npm test`, which includes the live RLS integration suite.

**Never wire CI to `npm run test:unit`.** It excludes the integration suites and
needs no secrets, so CI would stay green while the "RLS still holds" line above went
quietly unmet on every future PR. `test:unit` is a local fast-loop convenience, never
a gate. CI needs the `RLS_TEST_*` **and** `SUPABASE_SERVICE_ROLE_KEY` secrets/variables
configured for the suites to exercise isolation and signup rather than skip them — a
CI run reporting 94 tests instead of 117 means exactly that, and must be treated as a
failure. (94 is what `test:unit` yields: it excludes every `*.integration.test.ts`, so
the RLS, keepalive, signup, login **and** project-creation suites vanish.)

## Deep review for security-boundary changes

Every story gets the standard two-reviewer pass (peer + security) on PR open. **In
addition, run a deep multi-agent review** — many independent lenses, each finding
adversarially verified — for any change that touches a **security boundary**:
authentication, RLS / tenant isolation, secret handling, or the CI gate workflow
itself. These are the diffs where one missed defect is expensive, and the project has
form here: a 48-agent adversarial pass once caught a broken `check-bundle` control that
four conventional reviews missed. **Read the KILLED findings, not just the survivors** —
majority-vote has discarded a correct finding before. Skip the deep pass for low-risk
diffs (docs, copy, pure refactors already covered by tests); it is not free.

## Verification

Two "green" checks have been reported on this project that were not green. Both had
the same shape: the check that ran was not the check that was claimed.

- **Verification means `npm run verify`.** Never a hand-assembled subset, never a
  proxy. `tsc --noEmit` is not `npm run build` — it passed on a branch whose build was
  red. CI runs this same command, so local and CI cannot drift.
- **Compare against `origin/*`, and fetch first.** A stale local `main` made a correct
  squash-merge look like it had landed an empty tree.
- **Never truncate output you are using as evidence.** `git show --stat | head` hid the
  file list behind a long commit message and manufactured a false alarm.
- **A surprising result is a hypothesis, not a finding.** Before acting on or reporting
  something alarming, re-derive it a second, independent way.

---

## Jira tracking
Claude Code CLI owns the Jira board through the Atlassian connector.
- Create the 8 epics first, then stories linked to their epic. Source of truth
  is `sprintboard_phase1_backlog.md`.
- Confirm the Jira workflow columns map to the four fixed statuses. If they do
  not, adjust the Jira workflow, not the app scope.
- Move each issue as work progresses: In Progress on start, In Review on PR
  open, Done on merge. Done means the DoD is met, not just that code was written.

## Infrastructure
Supabase free tier pauses a project after ~7 days of inactivity. That is no longer
a nuisance: the live RLS suite is a required CI check, so **a paused database blocks
every merge** — including the PR that would fix it.

A cron-job.org job keeps it awake. Configured 2026-07-14, verified by test run:

| | |
|---|---|
| URL | `https://xcnmyhozmcopcpxlagrk.supabase.co/rest/v1/tickets?select=id&limit=1` |
| Method | `GET`, header `apikey: <VITE_SUPABASE_ANON_KEY>` |
| Schedule | Daily, 06:00 UTC |
| On failure | Email notification enabled — this is the only monitoring, do not disable it |
| Healthy response | `200` with body `[]` |

The empty array is RLS filtering an anonymous caller to zero rows. That is the
success signal, not an error: PostgREST returns a result set (an array) on success
and an error object on failure, so the array proves the anon contract this cron
depends on is intact, rather than a `401`/`404`. It does not by itself prove the
database is awake right now — a cached response would also be an array — that is
the external cron's job; the repo's job is keeping the contract from rotting
underneath it.

**Do not point the cron at `/rest/v1/`.** It returns 401 for the anon key ("Only the
`service_role` API key can be used"), and the only way to make it work is to ship the
service-role key to a third party. It is the endpoint you will instinctively reach
for. Don't.

`src/test/keepalive.integration.test.ts` asserts this exact contract on every PR, so
the endpoint cannot rot underneath the cron. `npm run keepalive` triggers it manually.

## Key files
- `sprintboard_phase1_schema.sql` — the database schema.
- `sprintboard_phase1_backlog.md` — epics and stories with acceptance criteria.
- `CLAUDE.md` — this file.
