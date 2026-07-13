# Sprintboard Phase 1 (Rung 1) Delivery Backlog

**Purpose:** the build backlog for Sprintboard Phase 1. Claude Code CLI creates
these as issues in Jira via the Atlassian connector and moves each through
To Do, In Progress, In Review, Done as it delivers.

**Scope lock (do not exceed in Phase 1):** Scrum only. Fixed four columns
(To Do, In Progress, In Review, Done). Fixed ticket schema, no custom-field
editor. Direct React to Supabase with owner-scoped RLS. FastAPI and all AI
features are Rung 2. Kanban, editable columns/workflows, custom fields, and
teams/roles are Rung 3.

**Acceptance criteria are the tests.** Every story below is written so its ACs
can be lifted straight into Playwright or Vitest before implementation begins.

**Dogfooding exit criterion:** once Phase 1 is usable, migrate the Rung 2
backlog into Sprintboard itself. The tool then tracks its own development.

**Stack:** React, Vite, TypeScript (strict), Tailwind, shadcn/ui, Supabase
(Auth, Postgres, RLS). GitHub Flow, one small PR per story, squash merge.

**Suggested labels:** foundation, auth, projects, tickets, backlog, sprints,
board, quality. Points use a light Fibonacci scale.

---

## E1 Foundation and Infrastructure
*Goal: a running, secured, testable skeleton before any feature work.*

### S1.1 Scaffold frontend stack
- **Points:** 3 | **Labels:** foundation
- Vite + React + TypeScript strict, Tailwind, shadcn/ui, ESLint, Prettier.
- **AC:** app builds and runs locally with no type or lint errors.
- **AC:** shadcn/ui is wired and one sample component renders.
- **AC:** TypeScript strict mode is on in tsconfig.

### S1.2 Provision Supabase and apply Phase 1 schema
- **Points:** 3 | **Labels:** foundation
- Apply `sprintboard_phase1_schema.sql` (profiles, projects, project_counters,
  sprints, tickets, triggers, RLS).
- **AC:** all tables, triggers, and the one-active-sprint index exist.
- **AC:** the signup trigger `on_auth_user_created` is present and not
  duplicated (check for a pre-wired Supabase trigger first).
- **AC:** anon key is used client-side, service-role key never ships to the browser.

### S1.3 RLS two-user smoke test
- **Points:** 2 | **Labels:** foundation, quality
- **AC:** user A cannot read, update, or delete user B's projects, sprints, or tickets.
- **AC:** the check is an automated test, not a manual click-through.

### S1.4 Supabase keepalive heartbeat
- **Points:** 1 | **Labels:** foundation
- A scheduled job (cron-job.org) hits the Supabase REST API every 2 to 3 days.
- **AC:** the job is documented in CLAUDE.md with its schedule and endpoint.
- **AC:** a manual trigger returns 200.

### S1.5 CI pipeline
- **Points:** 2 | **Labels:** foundation, quality
- **AC:** every PR runs lint, typecheck, and tests.
- **AC:** a failing test blocks merge.

### S1.6 CLAUDE.md conventions and scope guardrails
- **Points:** 2 | **Labels:** foundation
- **AC:** CLAUDE.md at repo root states the locked Phase 1 scope, the parked
  rungs, stack conventions, and the branch/PR workflow.
- **AC:** it names the fixed columns and fixed ticket schema explicitly so the
  build does not drift into Rung 3 features.

---

## E2 Authentication
*Goal: a user can sign up, log in, and only reach the app when authenticated.*

### S2.1 Email and password signup with auto profile
- **Points:** 3 | **Labels:** auth
- **AC:** a new signup creates an auth user and a matching `profiles` row.
- **AC:** display name defaults to email when none is provided.
- **AC:** duplicate email is rejected with a clear message.

### S2.2 Login, logout, session persistence
- **Points:** 2 | **Labels:** auth
- **AC:** valid credentials log in, invalid ones show an error.
- **AC:** the session survives a page refresh.
- **AC:** logout clears the session and returns to the login screen.

### S2.3 Protected routes and auth guard
- **Points:** 2 | **Labels:** auth
- **AC:** an unauthenticated user hitting any app route is redirected to login.
- **AC:** an authenticated user is not redirected.

### S2.4 Magic link login (optional)
- **Points:** 2 | **Labels:** auth
- Park if time is tight. **AC:** requesting a link emails it and the link logs the user in.

---

## E3 Projects
*Goal: create and switch between projects from the left nav.*

### S3.1 Create project with derived key
- **Points:** 3 | **Labels:** projects
- Key auto-derived from name (uppercase, 2 to 4 chars), editable before save.
- **AC:** entering "Sprintboard" suggests a key like SPB.
- **AC:** key is validated against the format rule and must be unique per owner.
- **AC:** an invalid or duplicate key is rejected before save.

### S3.2 Left-nav project list and switcher
- **Points:** 2 | **Labels:** projects
- **AC:** the current user's projects list in the left nav.
- **AC:** selecting a project loads it, and the choice survives a refresh.
- **AC:** another user's projects never appear (RLS).

### S3.3 Project shell with Board and Backlog tabs
- **Points:** 2 | **Labels:** projects
- **AC:** an open project shows a Board tab and a Backlog tab.
- **AC:** the shell renders even when the project has no tickets yet.

---

## E4 Tickets
*Goal: full ticket lifecycle on the fixed schema, with correct keys and blocking.*

### S4.1 Create ticket with atomic key generation
- **Points:** 3 | **Labels:** tickets
- Fields: summary, description, type, status, assignee, story points,
  acceptance criteria, labels.
- **AC:** a new ticket receives key PROJECTKEY-N with N from the atomic counter.
- **AC:** two tickets created in quick succession get consecutive, unique numbers
  (no gaps from count-based logic, no collisions).
- **AC:** new tickets default to status To Do.

### S4.2 Ticket detail and edit modal
- **Points:** 3 | **Labels:** tickets
- **AC:** opening a ticket shows all fields and allows editing summary,
  description, type, assignee, points, acceptance criteria, labels.
- **AC:** saving updates the record and refreshes `updated_at`.

### S4.3 Delete ticket
- **Points:** 1 | **Labels:** tickets
- **AC:** deleting removes the ticket after a confirm step.
- **AC:** a deleted ticket disappears from board and backlog.

### S4.4 Block and unblock a ticket
- **Points:** 2 | **Labels:** tickets
- **AC:** blocking requires a reason and stamps `blocked_since`.
- **AC:** unblocking clears both `blocked_since` and `blocked_reason`.
- **AC:** the three blocked fields never drift out of sync (trigger-enforced).
- **AC:** a blocked ticket stays in its real column, it does not move.

### S4.5 Epic type with context and deliverables
- **Points:** 3 | **Labels:** tickets
- **AC:** an epic can hold a context field and a structured deliverables list.
- **AC:** deliverables persist as a list and can be edited (add, remove).
- **AC:** stories, bugs, and tasks can reference a parent epic.

---

## E5 Backlog
*Goal: see and create work that is not in the active sprint.*

### S5.1 Backlog list view
- **Points:** 2 | **Labels:** backlog
- **AC:** the backlog shows tickets with no sprint or not in the active sprint.
- **AC:** each row shows key, summary, type, points, assignee, blocked marker.

### S5.2 Create ticket directly into backlog
- **Points:** 1 | **Labels:** backlog
- **AC:** creating from the backlog leaves `sprint_id` null.
- **AC:** the new ticket appears in the backlog immediately.

---

## E6 Sprints
*Goal: the Scrum sprint lifecycle, lean, one active sprint at a time.*

### S6.1 Create sprint
- **Points:** 2 | **Labels:** sprints
- **AC:** a sprint is created with status future, optional name, goal, dates.

### S6.2 Add and remove tickets to and from a sprint
- **Points:** 2 | **Labels:** sprints
- **AC:** a backlog ticket can be added to a sprint and removed back to backlog.
- **AC:** `sprint_id` updates correctly in both directions.

### S6.3 Start sprint (enforce one active)
- **Points:** 3 | **Labels:** sprints
- **AC:** starting sets status active.
- **AC:** attempting to start a second sprint while one is active is rejected
  by the partial unique index and surfaced with a clear message.

### S6.4 Complete sprint
- **Points:** 2 | **Labels:** sprints
- **AC:** completing sets status complete.
- **AC:** incomplete tickets return to the backlog (`sprint_id` null).
- **AC:** completed tickets retain their Done status and sprint history.

---

## E7 Board
*Goal: the visible flow, four fixed columns, drag to progress.*

### S7.1 Render the four fixed columns
- **Points:** 2 | **Labels:** board
- **AC:** the board shows To Do, In Progress, In Review, Done.
- **AC:** it renders the active sprint's tickets in the right columns.
- **AC:** an empty column renders cleanly.

### S7.2 Drag a card to change status
- **Points:** 3 | **Labels:** board
- **AC:** dragging a card to a new column updates its status in the database.
- **AC:** the change survives a refresh.
- **AC:** an optimistic UI update reverts if the write fails.

### S7.3 Blocked marker and blocked-only filter
- **Points:** 2 | **Labels:** board
- **AC:** blocked cards show a clear marker and their reason on hover or open.
- **AC:** a filter toggles the board to show blocked cards only.

---

## E8 Quality and Definition of Done
*Goal: the build is provably correct, not just apparently working.*

### S8.1 End-to-end happy path suite
- **Points:** 3 | **Labels:** quality
- **AC:** an E2E test covers signup, create project, create ticket, add to
  sprint, start sprint, drag to Done, complete sprint.

### S8.2 Definition of Done checklist
- **Points:** 1 | **Labels:** quality
- **AC:** CLAUDE.md carries a DoD: tests pass, lint and types clean, RLS holds,
  one PR per story, squash merged.

### S8.3 RLS regression in CI
- **Points:** 2 | **Labels:** quality
- **AC:** the two-user isolation test from S1.3 runs on every PR.

---

## Delivery order (dependency-safe)
E1 → E2 → E3 → E4 → E5 → E6 → E7, with E8 running alongside from S1.3 onward.

## Rough size
31 stories, roughly 68 points. Expect the board to move fastest through E5 and
E7 once E4 (tickets) is solid, since those reuse the ticket work.
