# Phase 1 status audit — all 31 stories (E1–E8)

**Date:** 2026-08-01
**Repo state:** `main` at `d913713`, tree clean.
**Sources:** the Jira board (project `SPRIN`, queried live) and the repo tree. The retired
phase-1 backlog (`git show 0f3ac5c:docs/sprintboard_phase1_backlog.md`) supplied the original
acceptance criteria.

**Method.** Every row's evidence is a file, table, trigger or index that exists in the tree
today. Completion is **not** inferred from an adjacent story, from a Jira status, or from a
commit message. Where the board and the code disagree, the disagreement is stated rather
than resolved in the board's favour.

The 31 stories are `SPRIN-9` … `SPRIN-39` — the original 30 plus **S4.6** (`SPRIN-39`), which
was added to E4 after the backlog was first written.

---

## E1 Foundation and Infrastructure

| Story | Key | Jira | Evidence |
|---|---|---|---|
| S1.1 Scaffold frontend stack | SPRIN-9 | Done | `vite.config.ts`; `components.json` (shadcn/ui wired); `tsconfig.app.json:19` `"strict": true`; `src/components/ui/*` |
| S1.2 Provision Supabase and apply Phase 1 schema | SPRIN-10 | Done | `docs/sprintboard_phase1_schema.sql` — tables, triggers, RLS. `src/lib/supabase.ts` uses the anon key only; `scripts/check-bundle.mjs` fails the build if a privileged key reaches `dist/` |
| S1.3 RLS two-user smoke test | SPRIN-11 | Done | `src/test/rls.integration.test.ts` — live, two real users, not a click-through |
| S1.4 Supabase keepalive heartbeat | SPRIN-12 | Done | `src/test/keepalive.integration.test.ts`; `package.json:16` `keepalive` script; cron endpoint and schedule documented in `CLAUDE.md` |
| S1.5 CI pipeline | SPRIN-13 | Done | `.github/workflows/verify.yml:70` runs `npm run verify`; required status check on `main`, no bypass actors |
| S1.6 CLAUDE.md conventions and scope guardrails | SPRIN-14 | Done | `CLAUDE.md` — scope, parked rungs, stack conventions, branch/PR workflow |

## E2 Authentication

| Story | Key | Jira | Evidence |
|---|---|---|---|
| S2.1 Email and password signup with auto profile | SPRIN-15 | Done | `src/routes/SignupPage.tsx`; `src/lib/auth-signup.ts:19` `isDuplicateSignup`; `on_auth_user_created` trigger in the schema; `src/test/signup.integration.test.ts` |
| S2.2 Login, logout, session persistence | SPRIN-16 | Done | `src/routes/LoginPage.tsx:26` `signInWithPassword`; `src/lib/auth.tsx`; `src/test/login.integration.test.ts` |
| S2.3 Protected routes and auth guard | SPRIN-17 | Done | `src/routes/RequireAuth.tsx:28` `<Navigate to="/login" replace />` |
| **S2.4 Magic link login (optional)** | **SPRIN-18** | **Done — descoped, not built** | **No code, by design.** See "The one discrepancy" below |

## E3 Projects

| Story | Key | Jira | Evidence |
|---|---|---|---|
| S3.1 Create project with derived key | SPRIN-19 | Done | `src/lib/project-key.ts:10` `PROJECT_KEY_PATTERN`, `:25` `deriveProjectKey`; `src/routes/CreateProjectDialog.tsx` |
| S3.2 Left-nav project list and switcher | SPRIN-20 | Done | `src/routes/AppLayout.tsx:6,24` — `listProjects` is RLS-scoped, so another user's projects cannot appear; selection is a navigation to `/projects/:id`, so it survives a refresh |
| S3.3 Project shell with Board and Backlog tabs | SPRIN-21 | Done | `src/routes/ProjectShell.tsx:33,78` — nested `<Outlet context>` feeding Board / Backlog / Sprints |

## E4 Tickets

| Story | Key | Jira | Evidence |
|---|---|---|---|
| S4.1 Create ticket with atomic key generation | SPRIN-22 | Done | `assign_ticket_key()` BEFORE INSERT trigger, schema `:343-367`; `project_counters` table `:78`; `src/lib/tickets.ts` |
| S4.2 Ticket detail and edit modal | SPRIN-23 | Done | `src/routes/TicketDetailDialog.tsx`; `src/lib/ticket-commit.ts:157` `useTicketCommit` |
| S4.3 Delete ticket | SPRIN-24 | Done | `src/lib/ticket-actions.ts:189` `useDeleteFlow`; confirm step in `src/routes/TicketActionDialogs.tsx` |
| S4.4 Block and unblock a ticket | SPRIN-25 | Done | `sync_blocked_fields()` trigger, schema `:402-419`; `src/lib/ticket-actions.ts:170` `useBlockFlow` (reason required at the app layer) |
| S4.5 Epic type with context and deliverables | SPRIN-26 | Done | `src/lib/deliverables.ts:13` `parseDeliverables`; `src/routes/TicketEpicSection.tsx`; `parent_epic_id` + composite fk `tickets_epic_fk` in the schema |
| S4.6 Surface a failed ticket read, with retry | SPRIN-39 | Done | `src/routes/LoadFailure.tsx:55` `onRetry`; the `phase` state in `src/routes/ProjectShell.tsx:21-23` makes "failed" distinguishable from "genuinely empty" |

## E5 Backlog

| Story | Key | Jira | Evidence |
|---|---|---|---|
| S5.1 Backlog list view | SPRIN-27 | Done | `src/lib/backlog.ts:18` — the rule is `sprint_id === null`, strict, in one place; `src/routes/BacklogTab.tsx` renders key, summary, type, points, assignee, blocked marker |
| S5.2 Create ticket directly into backlog | SPRIN-28 | Done | `tickets.sprint_id` is nullable with no default, schema `:259` ("null = backlog"); `createTicket` never sends it |

## E6 Sprints

| Story | Key | Jira | Evidence |
|---|---|---|---|
| S6.1 Create sprint | SPRIN-29 | Done | `src/lib/sprints.ts:41` `createSprint`; `src/routes/CreateSprintDialog.tsx:13` — status is never sent, the column defaults to `future` |
| S6.2 Add and remove tickets to and from a sprint | SPRIN-30 | Done | Sprint picker at `src/routes/TicketDetailSidebar.tsx:137` ("Backlog" and "no sprint" are the same fact); `tickets_sprint_fk` keeps the sprint in the same project |
| S6.3 Start sprint (enforce one active) | SPRIN-31 | Done | `sprints_one_active_per_project` partial unique index, schema `:227`; `src/lib/sprints.ts:152` `startSprint` surfaces the rejection |
| S6.4 Complete sprint | SPRIN-32 | Done | `src/lib/sprints.ts:222` `completeSprint` — detaches incomplete tickets first, then flips the status, so a failure mid-way fails safe |

## E7 Board

| Story | Key | Jira | Evidence |
|---|---|---|---|
| S7.1 Render the four fixed columns | SPRIN-33 | Done — **AC superseded** | `src/routes/BoardTab.tsx:85-93`. Since SPRIN-76 the board renders **one column per `project_statuses` row**, not four fixed constants. The AC as written ("shows To Do, In Progress, In Review, Done") holds only because the seed produces exactly those four |
| S7.2 Drag a card to change status | SPRIN-34 | Done | `BoardTab.tsx:186` `dataTransfer.setData`, `:289-305` `onDragOver` / `onDrop` / `onDragStart`; optimistic write with rollback at `:159`; the real gesture is exercised in `e2e/happy-path.spec.ts` |
| S7.3 Blocked marker and blocked-only filter | SPRIN-35 | Done | `src/routes/BlockedBadge.tsx:12` — reason on `title`; `BoardTab.tsx:149,243` `blockedOnly` filter |

## E8 Quality and Definition of Done

| Story | Key | Jira | Evidence |
|---|---|---|---|
| S8.1 End-to-end happy path suite | SPRIN-36 | Done | `e2e/happy-path.spec.ts:62` — signup → project → ticket → sprint → start → keyboard status change → drag to Done → complete |
| S8.2 Definition of Done checklist | SPRIN-37 | Done | `CLAUDE.md:199` "Definition of Done (per story)" |
| S8.3 RLS regression in CI | SPRIN-38 | Done | `package.json:19` `verify` → `npm test` → `vitest run`, which collects `src/test/rls.integration.test.ts`; `verify.yml` is the required check |

---

## The one discrepancy — S2.4 (SPRIN-18)

Magic-link was **rejected from scope** in an earlier session. That decision stands and there is
no delivery gap. The problem is the record of it, which contradicts itself:

- **2026-07-20**, comment on the issue: *"S2.4 Magic link login — **PARKED** for Phase 1… Left
  open (**To Do**) as a deliberately deferred item — **not built**, and **not `Won't Do`**; it
  may be revisited at a later rung."*
- **2026-07-26**: transitioned to Done with `resolution: Done` — *"Work has been completed on
  this issue."*

So the only written explanation on the issue asserts it stays open and unbuilt, and the field
that overrode it asserts work was completed. Both cannot be true, and the second is false.

Verified absent from the tree:

```
git grep -niE "signInWithOtp|magiclink|magic link|resetPasswordForEmail"
  → zero matches in tracked files
grep -niE "magic|S2.4|otp" CLAUDE.md
  → none
git log --all -i --grep="magic" --grep="S2.4"
  → none
```

Login is password-only (`src/routes/LoginPage.tsx:26`). **Recommended fix:** a short comment on
SPRIN-18 recording the rejection and its reason, so the descope has a stated cause rather than
a resolution field claiming delivery. No code change.

---

## Built, but not among the 31

### Later stories hung off the Phase 1 epics (9)

| Key | Summary | Status |
|---|---|---|
| SPRIN-46 | Send the service-role secret in the `apikey` header only (ES256 live-suite flake) | Done |
| SPRIN-51 | Guard the Create dialogs against a stale submit resolving over a reopened draft | Done |
| SPRIN-56 | `check-bundle` cannot tell a full-content scan from a truncated one | Done |
| SPRIN-61 | S7.4 Keyboard and touch path for board status change | Done |
| SPRIN-64 | Guard the sprint lifecycle against stale-status transitions | Done |
| SPRIN-65 | Sprint progress on the board: point badges, column totals, sprint caption | Done |
| SPRIN-66 | Contain render crashes behind error boundaries | Done |
| SPRIN-67 | Label the backlog row's assignee for screen readers | Done |
| SPRIN-68 | Find a ticket: filter the backlog and board by key or summary | Done |

### Epics outside Phase 1

| Epic | Children | Status | Evidence |
|---|---|---|---|
| SPRIN-40 Rung 2 — Grounded AI layer | 41, 42, 43 | All Done | **Built, then deliberately deleted** in the 2026-07-29 pivot. Jira says Done; there is no code in the tree. Recoverable from git history only |
| SPRIN-44 E9 Code quality standard | 45, 47, 48, 49, 50 | All Done | `eslint.config.js` (T1–T5 as errors), `verify-gate.test.mjs`, `docs/adr/0001`, `docs/adr/0002` |
| SPRIN-52 Pivot: strip back to a Jira core | 53, 54, 55 | All Done | Absence of the FastAPI service and the AI feature; `docs/adr/0006` |
| SPRIN-57 Pivot phase 2 | 58, 59, 60, 62, 63, 69, 70 | **Epic To Do**, all children Done | `docs/adr/0006`; `docs/standards-audit-2026-07-25.md` (kept deliberately). The only Phase-1-era epic still open; its candidate list is exhausted |
| SPRIN-71 – 75 Rung 3 | see below | All To Do | Un-parked 2026-07-31; order recorded in `CLAUDE.md` |

### Rung 3 progress (epic SPRIN-72, custom statuses)

| Key | Summary | Status | Evidence |
|---|---|---|---|
| SPRIN-78 | Un-park Rung 3 in CLAUDE.md, record the agreed ordering | Done | `CLAUDE.md` — the "refuse Rung 3 work" instruction is withdrawn |
| SPRIN-79 | Schema: per-project statuses and board columns | Done | `docs/migrations/sprin-79-project-statuses.sql`; `project_statuses` table; `tickets_status_check` removed in favour of a composite fk |
| SPRIN-76 | Render the board from database statuses | Done | `src/lib/project-statuses.ts`; `src/routes/BoardTab.tsx:85-93` |
| SPRIN-77 | Manage a project's statuses: add, rename, reorder | To Do | — |
| SPRIN-80 | Delete a status without stranding the tickets on it | To Do | — |

---

## Summary

- **30 of 31** Phase 1 stories are Done with code in the tree to point at.
- **1 of 31** (S2.4, magic link) is Done in Jira as a **descope** — correctly decided, wrongly
  recorded.
- **0** are Not Started for want of a decision.
- **1 AC is superseded** rather than unmet: S7.1's "four fixed columns", overtaken by SPRIN-76.
