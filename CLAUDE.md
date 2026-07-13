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

**CI must run `npm test`, never `npm run test:unit`.** `test:unit` excludes the
RLS integration suite and needs no secrets — it is a local fast-loop
convenience only. If CI is wired to `test:unit`, the RLS suite silently never
runs, CI stays green, and the "RLS still holds" line above is quietly unmet on
every future PR. CI needs the `RLS_TEST_{A,B}_{EMAIL,PASSWORD}` secrets
configured for `npm test` to actually exercise isolation rather than skip it.

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
Supabase free tier pauses on inactivity. A cron-job.org schedule hits the
Supabase REST API every 2 to 3 days. Keep it documented here and live.

## Key files
- `sprintboard_phase1_schema.sql` — the database schema.
- `sprintboard_phase1_backlog.md` — epics and stories with acceptance criteria.
- `CLAUDE.md` — this file.
