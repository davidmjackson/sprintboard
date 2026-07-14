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

**Never wire CI to `npm run test:unit`.** It excludes the RLS suite and needs no
secrets, so CI would stay green while the "RLS still holds" line above went quietly
unmet on every future PR. `test:unit` is a local fast-loop convenience, never a gate.
CI needs the `RLS_TEST_*` secrets and variables configured for the suite to exercise
isolation rather than skip it — a CI run reporting 37 tests instead of 51 means
exactly that, and must be treated as a failure. (37 is what `test:unit` yields: it
excludes every `*.integration.test.ts`, so both the RLS and keepalive suites vanish.)

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
