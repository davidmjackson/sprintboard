# Sprintboard

Scrum delivery board, part of the Sprint Suite. The goal is a credible Jira-style
board — enough of Jira's core to stand in for it, and no more. Parity with Jira is
not the goal, and neither is anything beyond it: a tight working slice is the point.

---

## Where the project is: Rung 3 is IN PROGRESS

**Rung 1 (Phase 1) shipped** — every epic and story Done, 2026-07-20. Scrum only, four
fixed board columns, fixed ticket schema, direct React-to-Supabase with owner-scoped RLS.
That is what exists today and it works.

**Rung 3 was un-parked by David on 2026-07-31**, with the epic order below. This section
used to say "Locked scope: Phase 1. Do not exceed" and to instruct any agent to refuse
Rung 3 work. That instruction is **withdrawn** — it would now block the agreed plan.

| Order | Epic | Key |
|---|---|---|
| 1 | Custom statuses and configurable board columns | **SPRIN-72** |
| 2 | Kanban project type | SPRIN-73 |
| 3 | Custom fields | SPRIN-71 |
| 4 | Configurable sprint cadence | SPRIN-74 |
| 5 | **Teams, roles and permissions — the security boundary** | **SPRIN-75** |

**The RLS rewrite is deliberately LAST.** Epics 1–4 all assume a single owner; each needs
re-auditing against the membership model when epic 5 lands. Budget for that rather than
discovering it.

## Still parked. Do not build.
- **The AI layer.** A FastAPI service with AI epic decomposition and a grounded
  estimation assistant was built (Rung 2) and then **deliberately removed** in the
  2026-07-29 pivot — it sat outside the Jira core this project exists to prove.
  Story-suggestion from a well-documented epic is the one piece worth reviving, and
  it is recoverable from git history rather than rebuilt. **Do not re-add any of it
  without being asked.** Un-parking Rung 3 did **not** un-park this.

If a task appears to require a parked feature, stop and flag it. Do not build it.

## The rules that OUTLIVE the doors being opened

These were written as forward-compatibility hedges — "keep the Rung 3 doors open, do not
walk through them". We are now walking through them, and that changes which rules are
spent and which still bind. **Every rule below still binds.** They are not scaffolding to
be cleared away now the feature is being built; several become *more* load-bearing, not
less, and each is easy to undo by accident while thinking you are tidying up.

- **Never use a Postgres `ENUM`.** `ticket.type`, `sprint.status` and `project_type` are
  `text` + a `check` constraint, deliberately. Widening a check is one line; altering an
  enum type is a painful migration. Converting these to a `create type … as enum` would
  look like an improvement. **It is the single most damaging change anyone could make to
  this schema.** `ticket.status` is `text` too, but SPRIN-79 replaced its check with a
  composite foreign key to `project_statuses (project_id, slug)` — because the vocabulary
  is now per-project, and a CHECK body may not contain a subquery. It stays `text`: the
  fk is keyed on the slug rather than a surrogate id precisely so no ticket row is ever
  rewritten when the vocabulary changes.
- **`projects.project_type` already exists** (`check (project_type in ('scrum'))`). Kanban
  is one line: add `'kanban'` to that check — that is epic **SPRIN-73**, and the one-line
  change is the *whole* schema part of it. The work there is behavioural.
- **Status, type and column definitions live in `src/lib/domain.ts` and nowhere else.**
  Never inline the four column names in a component, a filter, or a badge-colour map.
  This is the rule **SPRIN-72 is about to cash in**: because it held, columns becoming
  dynamic changes one module instead of fifteen. As the list moves to the database,
  `domain.ts` stops being the source of the *values* and becomes the client-side contract
  for the *shape* — it does not stop being the single place. Do not scatter the new types.
  **Verify the rule actually held before relying on it** — grep for the literal names
  rather than assuming. (Verified at SPRIN-79: exactly five files referenced the status
  constants, four of them UI. The rule held.) **SPRIN-79 moved the database half only.**
  `domain.ts` now holds both `TICKET_STATUSES` (what the board still renders) and
  `DEFAULT_PROJECT_STATUSES` (what the trigger seeds), and `domain.test.ts` asserts they
  are the same list — that assertion is the *only* thing left tying the board to the
  database now `tickets_status_check` is gone. **SPRIN-76 deletes `TICKET_STATUSES` and
  renders from the rows**, and takes that bridging test with it. Until then, do not let
  the two lists diverge.
- **Core ticket fields stay real columns.** `story_points`, `assignee_id`, `status` etc.
  are first-class and must remain so. Custom fields will be **additive** — new tables
  alongside, never a reshaping of `tickets`. This is what Jira itself does: system fields
  are columns, only custom ones go in a flexible store. It is the right end state, not a
  shortcut to undo.
- **Ticket keys are already project-scoped** (`unique (project_id, number)`) and **blocked
  is a flag, not a column.** Both survive custom workflows unchanged. Preserve them.
- **`projects` holds NO TABLE-LEVEL UPDATE for `authenticated` or `anon`, and exactly TWO
  column grants** (SPRIN-82 revoked, SPRIN-97 granted back). Measured from `pg_class.relacl`
  and `pg_attribute.attacl` on 2026-08-09: table ACL `authenticated=ardDxtm` — no `w` — plus
  `authenticated=w` on `sprint_length_weeks` and `sprint_start_weekday` and nothing else.
  That is what keeps `name`, `key` and `project_type` immutable in the *database* rather than
  only in our code, now that `hasSprints(project)` decides whether sprints exist at all.
  Re-measured 2026-08-20 during SPRIN-101 and **unchanged** — that migration touches policies
  only. But it is now the **sole** control on `owner_id` as well: the old `for all` policy's
  `WITH CHECK` used to pin `owner_id = auth.uid()` on UPDATE too, and `projects_admin_update`
  deliberately does not. See the SPRIN-101 paragraphs below.

  **This bullet used to say `projects` holds no UPDATE privilege at all, and to tell the next
  story to run `grant update (name)` and restore the RLS assertion on `name`. Both halves are
  now wrong, and the second was wrong in a way that would have shipped a passing test proving
  nothing** — `name` is still revoked, so a cross-tenant `.update({ name })` is refused by the
  privilege layer with `42501` before RLS is consulted, and a row-count assertion on it would
  measure the grant instead of the policy. The rule, as a property rather than a column name:
  **a cross-tenant row-count assertion is only honest on a column the role may actually
  UPDATE.** SPRIN-97 restored it on `sprint_length_weeks`.

  **A story that needs another writable column still owes four things**, and only the first
  announces itself: `grant update (<column>) on projects to authenticated` in its migration;
  that column added to `SPRINT_CADENCE_COLUMNS` in `domain.ts` (which is
  `satisfies readonly (keyof SprintCadence)[]`, so a non-cadence column needs the type widened
  and the constant renamed); the doc-vs-migration matcher in `domain.test.ts` kept in step; and
  a live assertion that the column is genuinely writable. Deny by default, widen visibly.

**The one genuinely deep door is RLS, and it is now ON the feature list — last, as SPRIN-75.**
Most tables still resolve every policy to `owner_id = auth.uid()`, and rewriting *all* of those
to a membership check is still the security boundary of the whole app — that scope has not
shrunk. **Six tables are already rewritten**, ahead of the rest, as stories inside this same
epic: `project_members` (SPRIN-98, four policies resolving through
`app_auth.is_project_member`/`is_project_admin`); `profiles` (SPRIN-105, four verb-split
policies where SELECT resolves through `app_auth.shares_project_with` and the three write verbs
stay `id = (select auth.uid())`); the three board tables `project_counters`, `sprints` and
`tickets` (SPRIN-100, each still a single `for all` — see the next paragraph, that shape is
load-bearing — resolving through `app_auth.is_project_member(project_id)` and now carrying
`to authenticated`); and **`projects` itself (SPRIN-101, four verb-split policies)**. **What is
left is the four config tables (SPRIN-99), and nothing else.** Teams, roles and permissions
means rewriting those the same way.

**`projects` is verb-split ON PURPOSE, and the board tables are single `for all` ON PURPOSE.
Do not "harmonise" them.** The asymmetry is the model, not an inconsistency left to tidy: on
`sprints` and `tickets` read must stay co-extensive with write or `completeSprint`'s guard
silently stops holding; on `projects` read is *meant* to be broader than write, because every
member reads the project they work on and only an **admin** reconfigures it. SPRIN-101's four
are `projects_member_read` (SELECT, membership), `projects_bootstrap_insert` (INSERT, still
`owner_id = (select auth.uid())`, purely so creating a project does not require a membership
that does not exist yet), `projects_admin_update` and `projects_admin_delete` (both
`app_auth.is_project_admin(id)`).

**Two consequences of that split, both live:**
- **`owner_id` immutability now rests on the GRANT alone.** The old `for all` policy's
  `WITH CHECK` pinned `owner_id = auth.uid()` on UPDATE as well as INSERT; `projects_admin_update`
  says nothing about `owner_id`, because an admin who is not the owner must be able to change the
  cadence. The surviving control is the stronger one — a privilege check precedes RLS and cannot
  be filtered — but it is now the **only** one. The four-part obligation two paragraphs up binds
  harder because of it.
- **Admin-only DELETE is not a nicety.** Deleting a project cascades through every referencing fk
  and **RLS is not enforced on cascaded child rows**, so a membership-only DELETE would let a
  plain member destroy an entire board in one request. Reviewers killed this finding twice during
  SPRIN-100 as "the actor is the owner deleting their own project" — correct then, and made wrong
  by SPRIN-101 itself.

**SPRIN-100 added a rule that binds every remaining story in this epic:
a policy that calls an `app_auth` function must carry `to authenticated`.** Those three tables
grant `anon` full CRUD, and a policy with no `TO` clause covers `public`, anon included. Policy
expressions are evaluated as the *calling* role, and `anon` holds neither USAGE on `app_auth`
nor EXECUTE on its functions — so without the clause an anonymous request raises
`permission denied for schema app_auth` (42501) where it used to get a clean empty array. That
breaks the cron keepalive's `200 []` contract on `tickets`, which pauses the free-tier database,
which blocks **every** merge. SPRIN-98 never felt this because `anon` holds no grant at all on
`project_members`. Check the table's `relacl` before writing the policy, every time. The safety net is already built: the two-user isolation suite runs live against the real
database on every PR, so a mistake in that migration goes **red**. Do not weaken it — and
note that keeping it green is not enough. **Extend it.** Owner-vs-stranger stops being the
only case; member-vs-non-member, role-vs-role and removed-member each need coverage, or the
suite will pass while the new boundary leaks.

A known trap, recorded from SPRIN-64: `completeSprint`'s guard relies on `sprints_owner`
being `for all`. Under a membership model where **read is broader than write**, that guard
silently stops holding **and the isolation suite would not flag it.** Re-audit every
app-layer guard that leans on a policy's breadth, not only the policies themselves.

**SPRIN-100 was that migration, and it PRESERVED the property rather than discharging the
warning.** `sprints_owner` is still one `for all` policy with one predicate in both clauses, so
read and write stay co-extensive and the guard holds for the reason it always did.
`board-membership.integration.test.ts` now pins the equivalence directly, as set equality over
the project's rows on both `sprints` and `tickets`, so a verb-split goes red there instead of
silently disarming the guard. The warning is therefore narrowed, not spent: it now belongs to
whoever splits one of these policies by verb — and SPRIN-99's four config tables are *already*
verb-split, which is exactly why that story owes the zero-row-write audit that SPRIN-104 holds.

**And a second, unadvertised dependency this trap did not cover: a SECURITY INVOKER trigger
depends on every table it READS, not only the ones it writes.** `assign_ticket_key` updates
`project_counters` — which the story planned for — and also reads `projects`, which nobody had
written down. Membership on the first plus ownership on the second made every member's ticket
creation fail with a `NOT NULL` violation on `key`. Before changing a policy, grep the trigger
functions on that table for what else they touch.

**The `profiles` half of that, in detail.** Read is
`id = (select auth.uid()) or app_auth.shares_project_with(profiles.id)`,
so visibility is co-membership: mine, plus anyone I share a project with. Writes did not
widen — insert/update/delete are still each self-only, split from the old single `for all`
policy into four verb-scoped ones so the widened read could not smuggle a widened write in
alongside it. `anon` holds **nothing** on `profiles`: SPRIN-105 revoked the table-wide grant
the table was *born* with (nobody had ever revoked it; anon previously read zero rows only
because RLS filtered `id = auth.uid()` down to nothing for a null caller — the failure shape
changes from an RLS-filtered empty result to a `42501` privilege refusal, and a test must
pick the right one). `app_auth` now holds a **third** predicate, `shares_project_with(uuid)`,
alongside SPRIN-98's `is_project_member`/`is_project_admin`. Those two are affordable as
`security definer` only because they take **no** other-user parameter — SPRIN-98's migration
warns that adding one "would turn a harmless self-query into an oracle about other people. Do
not." `shares_project_with` **does** take another user's id and is still affordable, but for a
narrower, different reason, not a relaxation of that rule: one side of its join is pinned to
`(select auth.uid())`, so it can only answer "do I share a project with X", never "do X and Y
share a project" — read the full three-point argument in
`docs/migrations/sprin-105-profiles-email-and-co-member-reads.sql` §3 before adding a fourth
`app_auth` function with a foreign-id parameter. It is not a precedent that "parameters are
fine now."

**Migrations are hand-applied.** The Supabase MCP is wired `read_only=true` on purpose, so
`apply_migration` is unavailable and that is not a fault to route around. Produce the SQL,
hand David one copy-paste command, and let him run it in the SQL editor. Run `get_advisors`
afterwards and **add no new lints**. Rung 3 is migration-heavy, so this now applies to
most stories rather than a rare one.

**The advisor baseline is NOT zero, and this file used to say it was.** That wording was
aspirational when written and has been false for some time — a story that took it literally
would either chase pre-existing lints it did not cause or, worse, read a red result as its own
regression. Re-measured **2026-08-20, after SPRIN-101 and SPRIN-101b applied**: **1 security
WARN** (leaked-password protection disabled) and **11 performance lints** (the same 8
`unindexed_foreign_keys` INFOs — 4 on `ticket_field_values`, 3 on `tickets`, 1 on
`project_field_options` — and **3** `auth_rls_initplan` WARNs on **one** table,
`project_statuses`). It read **12**, with **4** WARNs across **two** tables, from SPRIN-100
until SPRIN-101 cleared `projects`.

**SPRIN-100 took three of those WARNs off the board for free**, and the mechanism is worth
copying rather than rediscovering: replacing a bare `auth.uid()` predicate with a call to a
`STABLE SECURITY DEFINER` function takes the uid read out of the per-row path just as
`(select auth.uid())` does. `counters_owner`, `sprints_owner` and `tickets_owner` all cleared
when they moved to `app_auth.is_project_member`. **SPRIN-101 took a fourth the same way** —
`projects_owner` became four policies whose predicates are `app_auth` calls, and `projects`
cleared entirely. The remaining three are all on `project_statuses` (`statuses_owner_read`,
`_insert`, `_update`), and they are SPRIN-99's to clear.

It read **15** and **7 across five tables** until that re-measurement. This paragraph said
**14** and **6 / 3+3** until
SPRIN-97 re-derived it: the extra two arrived with SPRIN-92/93's tables (`pfo_field_fk` and
`tfv_option_fk`) and nobody updated the line, which is the decay this file warns about two
paragraphs down happening to the warning itself. It said **16 / 8** until SPRIN-105 re-derived
it again: `profiles_self`'s `auth_rls_initplan` WARN cleared on its own, because SPRIN-105
rewrote that policy (now split into four, verb by verb) in the `(select auth.uid())` form —
the same rewrite the sweep below still owes the other five tables. Net delta minus one, for
free, as a side effect of an unrelated story.

**SOME LINTS HAVE A HALF-LIFE, and this paragraph is the proof — it briefly said 17.**
SPRIN-98 added `project_members`. Measured immediately after applying, performance went 16 → 17:
an `unused_index` INFO on `project_members_user_id_idx`, because a brand-new index that nothing
has scanned yet is by definition unused. Running that story's own live suite scanned it, and the
INFO **cleared on its own within the hour**. Net delta zero.

The story had already written the 17 into this file as a standing decision — *"accepted, no
change"* — about a lint that no longer existed, two paragraphs below the warning about exactly
that decay. So: **`unused_index` is a statement about TRAFFIC, not about schema.** Never record
one as a baseline from a single reading taken straight after a migration; re-measure once the
suite has run. `unindexed_foreign_keys` and `auth_rls_initplan` are structural and do not behave
this way.

What SPRIN-98 did *not* add is the interesting part, and it is durable: no new
`unindexed_foreign_keys`, because `project_members_user_id_idx` covers the one foreign key the
primary key does not; and no ninth `auth_rls_initplan`, because the four new policies call a
`STABLE` function instead of a bare `auth.uid()`. **Compare against that
baseline, not against zero** — the same discipline as the test-file tripwire above, where the
GAP is the invariant and the absolute counts move with every story. Re-derive the numbers with
`get_advisors` rather than trusting this paragraph; they are a timestamped observation.

Two of those are settled and must not be re-litigated. The three `ticket_field_values` INFOs
are **David's explicit call** — keep the `(field_id)` index, add nothing, accept them (the
advisor's prefix rule goes unsatisfied, not any query a cascade actually performs). The
`auth_rls_initplan` sweep belongs to **SPRIN-75**, not to whichever feature story next touches
a policy: it is now **three WARNs on one table** — `project_statuses` (`statuses_owner_read`,
`statuses_owner_insert`, `statuses_owner_update`), which is SPRIN-99's table.

It was eight across six tables until SPRIN-105 rewrote `profiles_self` in the wrapped form as a
side effect of an unrelated policy split, then **seven across five** until SPRIN-100 moved
`counters_owner`, `sprints_owner` and `tickets_owner` to a `STABLE` definer predicate and took
all three tables out of the list at once, and **four across two** until SPRIN-101 did the same
for `projects`. **All three reductions were side effects of doing the membership rewrite
properly, not of a sweep** — which is the argument, now with three worked examples, for letting
the last three fall out of SPRIN-99 (`project_statuses`) the same way rather than paying for a
separate mechanical pass. If that story does its job, the sweep has nothing left to do and this
bullet retires itself.

**CORRECTION, made explicit because this file's own ethos forbids a silent one:** the
"six tables" figure just above replaces a **five-tables** figure this file previously stated
for that same eight-WARN count (see the paragraph above measuring "8 `auth_rls_initplan`
WARNs across five tables" before SPRIN-105 applied). Five was wrong — it undercounted by
one, omitting `profiles` (`profiles_self`) from the table list while still counting its WARN
in the total of eight. Six is the correct historical figure. That fix landed in the same
commit as the "seven WARNs across five tables" re-measurement above and was not flagged as a
correction at the time; it is flagged here instead of being left as silent drift.

`project_fields`, `ticket_field_values`,
`statuses_owner_delete` and now all four of `profiles`'s split policies already use the
`(select auth.uid())` form, so the fix has working precedent in this schema — re-derive the
list with `get_advisors` rather than trusting this paragraph, the same as the count above it.

**Why we still are not hedging further.** There is no production data and no user base, so
almost every schema decision is reversible at near-zero cost. The real risk remains premature
generalisation: build the slice in front of you, not the framework behind it. The difference
now is only *which* slice — the doors above are being walked through in a stated order, one
epic at a time, rather than all at once.

---

## Stack
- React, Vite, TypeScript (strict), Tailwind, shadcn/ui.
- Supabase: Auth, Postgres, RLS. Anon key client-side only.
- Tooling: ESLint, Prettier, Vitest, Playwright.

**The coding standard is part of the gate, and it is not negotiable.** David,
2026-07-29: *"Coding standards are very important across all development done in
these projects. It is the hallmark of quality and a measure of the developer who
codes. A phrase I like to use is… 'garbage in, garbage out'."*

`npm run lint` enforces **T1-T5** as errors — 30-line functions, cyclomatic 10,
cognitive 15, 4 parameters, 400-line files — and `npm run verify` runs
`npm run lint`, so they gate every merge. Thresholds live in `eslint.config.js`,
override rationale in `docs/adr/0001` and `0002`, and each one is pinned **at its
boundary** in `verify-gate.test.mjs`: at the limit passes, one unit past fails.
Widening a max there turns the suite red, which is deliberate.

**Scope: `**/*.{ts,tsx,mjs,js}` — every source file in the repo, not just TypeScript.**
Until SPRIN-60 the glob read `{ts,tsx}`, which quietly exempted all four `.mjs`/`.js`
files, including `scripts/check-bundle.mjs` (a security control) and
`verify-gate.test.mjs` (the guard on this gate). Narrowing it back is an exemption
shaped like a file extension, and `verify-gate.test.mjs` now probes a `scripts/*.mjs`
path, a root `*.mjs` path and a `.js` path so it cannot happen silently again. ADR
0002's test-file override is `{ts,tsx,mjs}` for the same reason — **not** a bare
`**/*.mjs`, which would hand `check-bundle.mjs` its exemption straight back.

Write to the thresholds from the first line rather than retrofitting. A genuine
misfit is an **ADR in this repo**, never an inline disable.

**The history matters, because it is easy to half-remember.** SPRIN-55 removed all
of this during the pivot; SPRIN-59 put the thresholds back the same day, once
measuring showed they were free — the tree reported **122 files, 0 errors, 0
warnings**, because SPRIN-50 had driven violations to zero before gating them and
the pivot only deleted code. Read that 122 as what it was: `.ts`/`.tsx` only, which
is how the `.mjs` gap survived it. SPRIN-60 widened the scope and re-measured — one
violation repo-wide, `check-bundle.mjs`'s 43-line `main()`, since split. The session weight the pivot targeted was never T1-T5;
it was the ceremony around them, and the deep-review policy below is where that
saving actually came from. See `docs/adr/0006`.

**What stays deleted — do not re-add without being asked:** the duplication gate
(`lint:duplication`, `scripts/check-duplication.mjs`, `jscpd`, ADRs 0003 and 0005)
and any `lint:standards` script. `npm run lint` is the entire enforcement surface.

**Existing code already passes.** There is no accepted-violation backlog to work
around — if `lint` goes red, it is the change under review, not inherited debt. Six
functions sit at exactly cyclomatic 10, so one added branch reddens the gate: that
is it working. A broader retrospective tidy is planned as SPRIN-58, but it starts
from zero violations.

## Workflow
- GitHub Flow. One feature branch and one small PR per story. Squash merge.
- Acceptance tests are written from the story's ACs before implementation.
- Imperative commit summaries.
- **After opening a PR, watch its CI checks and diagnose any red before doing anything
  else.** A red required `verify` blocks the merge — do not merge around it, and do not
  blindly re-run it. First read the failure: is it the one known transient (the auth
  rate-limit flake below) or a real regression? Only the former is safe to re-run, and
  only after a short cooldown. Never report a PR as shipped until its required check is
  green on the PR's own head commit.

---

## Data model
Defined in `docs/sprintboard_phase1_schema.sql`. Preserve these mechanics exactly:
- **Ticket keys:** PROJECTKEY-N via the `project_counters` row and the BEFORE
  INSERT trigger. Atomic and race-safe. Never generate keys with count(*).
- **Blocked:** the `sync_blocked_fields` trigger keeps is_blocked,
  blocked_reason, blocked_since aligned. Requiring a reason on block is an
  app-layer rule plus a test.
- **One active sprint per project:** enforced by a partial unique index. Surface
  the rejection as a clear message. Do not work around the index.
- **RLS is on every table, but it is no longer owner-scoped on every table.** This line said
  "owner-scoped on every table" until SPRIN-100. **Six** tables now resolve to membership —
  `project_members`, `profiles`, `project_counters`, `sprints`, `tickets` and, since SPRIN-101,
  `projects` — and only the four config tables still resolve to `owner_id = auth.uid()`, pending
  SPRIN-99. Do not describe the schema as uniformly one or the other; check the policy. And note
  that "resolves to membership" is not one shape: the board tables ask **member**, `projects`
  asks **member to read and admin to write**. Check the verb too.

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
configured for the suites to exercise isolation and signup rather than skip them — a CI
run that collects only the unit-test file count means exactly that, and must be treated
as a failure.

**The tripwire is the GAP, not the absolute counts.** `npm test` collects exactly
**eleven more files** than `test:unit` — the eleven `*.integration.test.ts` suites: RLS,
keepalive, signup, login, project, project-members, profiles, board-membership,
projects-membership, and the cross-tenant write paths. That difference is what stays put. The
absolute numbers do not:
every story that adds
a unit-test file moves both, and they have been wrong in this file twice in a single session
(44/37 → 45/38 → 46/39). At SPRIN-55 it was **50 vs 43** — down from 51/44, because that
story deleted two threshold-test files and added one gate test. Re-measured **2026-08-16**,
after SPRIN-105 added `profiles.integration.test.ts`: **81 vs 72**. Re-measured
**2026-08-17**, after SPRIN-100 added `board-membership.integration.test.ts`: **82 vs 72**.
Re-measured **2026-08-20**, after SPRIN-101 added
`projects-membership.integration.test.ts`: **83 vs 72**.
Treat every one of these
as a timestamped observation, not a constant, and re-derive it with
`npx vitest list --filesOnly | wc -l` (all files) and the same command with
`--exclude '**/*.integration.test.ts'` (unit only) rather than trusting this line.

**The GAP itself moves when a story adds an integration suite** — SPRIN-98 took it from
seven to eight, SPRIN-105 took it from eight to nine with
`profiles.integration.test.ts`, SPRIN-100 took it to ten with
`board-membership.integration.test.ts` for the board-table membership boundary, and SPRIN-101
has just taken it to **eleven** with `projects-membership.integration.test.ts` for the
`projects` table itself. That is not a
contradiction of the rule above: the invariant is that the gap equals the number of live
suites, so a story adding one owes this line an update in the same commit — this is that
update. A gap that has silently *shrunk* is the failure this tripwire exists for.

**AND THE PROSE IS ONLY HALF THE CONTROL.** `verify-gate.test.mjs`'s `LIVE_SUITES` array is
the executable half, and SPRIN-105 updated this paragraph while leaving that array at eight —
so its own suite was collectable-but-unregistered for a whole story, which is precisely the
state the array exists to make impossible. SPRIN-100 registered both, and SPRIN-101 registered
both in the same commit that created the suite. Update the array in the same commit as this
line, every time.

If a CI run's file count equals the `test:unit` count — i.e. the gap is **zero** — the
live suites silently skipped and the run is a failure however green it looks.

## The live-suite auth rate-limit flake

The live integration suites sign in the real `RLS_TEST_{A,B}` users against GoTrue. A
single `npm test` run signs in across several suites; fired back-to-back (a local run and
a CI run, or two CI runs close together) they can trip GoTrue's auth rate limiter. The
symptom is a **bare `TypeError: Cannot read properties of null (reading 'id')` in a
suite's `beforeAll`** — not an assertion failure — turning the required `verify` check red
on a branch whose code is fine.

Two defences, both load-bearing — do not undo either while "tidying up":

- **Never follow `signIn()` with `auth.getUser()` to fetch the user id.** `signIn()`
  already established and validated the session, so read the id with `userId(client)` in
  `src/test/supabase-clients.ts`, which reads the **in-memory** session — no network call,
  nothing to rate-limit. Reintroducing a `getUser()` per `beforeAll` (there were ~14 of
  them) is exactly what caused this flake; a green suite would tempt you to add one back.
- **There is a THIRD signature, and it is not auth at all.** `AuthRetryableFetchError: fetch
  failed` with **`status: 0`** and `[cause]: Error: read ECONNRESET`, arriving as an assertion
  failure **inside a test body** rather than a `beforeAll` crash. `status: 0` means no HTTP
  response ever came back, so it is neither the credential (which returns a *named* GoTrue
  error) nor the rate limiter (a **429**, or the bare null-`id` `TypeError`). Remedy is the
  same cool-down-and-rerun. Classify on the *shape* — status, error class, setup-vs-body,
  blast radius — before reaching for a remedy, and never let "neither documented flake
  matches" become "therefore it is my diff". That inference is backwards. Seen 2026-07-29.
- **A FOURTH signature is not auth at all: a bare `Test timed out in 5000ms` on a live
  suite, whose VICTIM MOVES between runs.** Vitest's 5s default is reporting a *slow*
  database, not a broken one. SPRIN-83 saw `keepalive` die on one run and `rls` ×2 +
  `sprints` die on the next — same SHA, disjoint tests. **A defect does not move target on
  an unchanged commit; a starved backend does**, so re-read the second failure's file list
  before concluding anything. Confirm with `npm run keepalive` — one anon GET, no sign-in,
  so it cannot rate-limit; it answered in **426 ms** against the 5000 ms budget, settling
  that the endpoint was healthy and CI was merely starved. The cause is usually the
  session's own traffic: the `verify` concurrency group serialises CI against itself and
  does nothing about a local pile-up of seeding, browser sessions, an E2E and a local
  `verify`. Remedy is a **7-minute** quiet window — longer than the two below — then one
  rerun.
- **When it still bites, it is transient — never "fix" it by weakening a suite.** Confirm
  the failing test matches **one of the four signatures above** — the null-`id` setup
  crash, the ES256 `unrecognized JWT kid`, the `status: 0`/`ECONNRESET` transport reset, or
  the moving 5s timeout.
  Anything else is real. (This clause used to read "the null-`id` setup crash, any other
  failure is real", which contradicted the third signature the moment it was added: that
  one arrives in a test *body*. Naming all four is what keeps this from being read as a
  general licence to re-run body-level failures — and note the fourth was found by a
  session that had to resist exactly the "no signature matches, so it is my diff"
  inference.) Then wait ~2–5
  minutes with no sign-ins, then re-run the failed job (`gh run rerun <id> --failed`).
  Confirm the rerun's `headSha` equals the PR head, and trust the CI result over a local
  run. Serialising CI against the shared database (the `verify` concurrency group) already
  keeps two CI runs apart; the remaining risk is a local run overlapping a CI run.

## The service-role key travels in `apikey`, never `Authorization` (SPRIN-46)

A **second, different** live-suite flake, fixed by removing its cause. Match the signature
before reaching for the rate-limit playbook above — this one is a **named error thrown by
the suite's own guard**, not a bare `TypeError`:

```
createUser failed: invalid JWT: unable to parse or verify signature, token is
unverifiable: error while executing keyfunc: unrecognized JWT kid <nil> for algorithm ES256
```

This project's API keys are the **new opaque format** (`sb_publishable_…` / `sb_secret_…`),
not legacy HS256 JWTs, and its JWKS holds exactly one key (ES256, no HS256 entry).
supabase-js still copies the key into `Authorization: Bearer` as well as `apikey` — a
leftover from when service-role keys really were JWTs. Supabase documents that opaque keys
must **not** be sent as a bearer token. GoTrue tries to verify that copy anyway, finds no
`kid`, and — intermittently, when it does not fall back to the `apikey` header — fails the
request. Both CI occurrences hit the **first** `createUser` of the run while later,
identical calls on the same client succeeded: the tell that the *request* failed, not the
credential.

- **`adminClient()` passes `global: { fetch: apikeyOnlyFetch }`**, which deletes the
  `Authorization` header. `e2e/support/admin.ts` sends `apikey` alone for the same reason —
  there, a rejected teardown strands a signed-up user and everything cascading from it.
  Both are pinned by `src/test/supabase-clients.test.ts`.
- **Never apply that wrapper to `anonClient()` or a `signIn()` client.** For those,
  `Authorization` carries the **user's** access token; stripping it silently downgrades
  every request to the anon role, and RLS then *hides rows* rather than raising — a suite
  that passes for the wrong reason. A test goes red if anyone shares the wrapper.
- **It was never a key-rotation problem.** The standing remedy used to be "re-issue
  `SUPABASE_SERVICE_ROLE_KEY`". That was wrong and would not have fixed it: the key was
  healthy throughout. No dashboard change is required.

## End-to-end suite (Playwright)

`e2e/` holds the S8.1 happy-path browser test: one real user's whole journey (signup →
create project → create ticket → add to sprint → start sprint → drag to Done → complete
sprint), driven by Playwright against the live Supabase project. `npm run e2e` runs it.
It needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
(the last for teardown only) and skips loudly without them. Each run signs up a fresh,
unique user and deletes it in teardown — which cascades away the project, sprint and
tickets, since every owned table is `on delete cascade` from `auth.users`.

It is the **only** test that exercises the native HTML5 drag for real: jsdom has no
`dataTransfer`, so every Vitest board test can assert the drag *wiring* but never the
*gesture*. Playwright dispatches the DOM drag events directly (mouse-based `dragTo` does
not fire them reliably), and the test waits on the `tickets` PATCH so it proves the move
*persisted*, not just the optimistic paint.

- **It is NOT the gate, and must never become it.** `e2e.yml` is a separate, non-required
  check. A real browser plus a real signup against a remote database is inherently more
  flake-prone than `verify`; folding it into `npm run verify`, or marking the `e2e` check
  required, would put that flake in front of every merge. The required gate is `verify`,
  and only `verify`.
- **`e2e.yml` shares the global `verify` concurrency group on purpose** — so the E2E never
  runs concurrently with the RLS suite against the shared database (which would risk auth
  rate-limiting and write collisions). Do not give it its own group.
- **Vitest must never collect `e2e/**`.** Playwright specs are `*.spec.ts`, which matches
  Vitest's default include glob; `vite.config.ts` excludes `e2e/**` for exactly this
  reason. A Vitest run that tries to load a `*.spec.ts` from `e2e/` will error — restore
  the exclude, don't rename the specs.

## Accessible names under jsdom are not the names a browser computes (SPRIN-67)

**Never assert an *exact* accessible name for an element whose name is composed from several
children whose `display` comes from the stylesheet** — which, with Tailwind, is all of them. Under
jsdom that string is not what any browser produces. Substring/regex name queries
(`{ name: /assigned to/i }`) are fine and often the right tool; so is an exact name on an element
whose name comes from a single text node or an `aria-label` (`{ name: 'Log in' }` — there are 181
such queries across `src/` and `e2e/` and they are correct).

Two boundaries on that carve-out, both measured:

- **A `<div>`- or `<p>`-structured component is safe** — its parts are block-level without any
  stylesheet, so both engines separate them identically. The rule is about CSS-derived layout, not
  about having multiple children.
- **A single text node is NOT automatically safe if `text-transform` applies.** Chrome's AX tree
  uppercases (`Story` → `STORY`); Playwright's accname does not. Nothing in the suite currently
  exact-name-queries such an element — `TicketDetailSidebar.tsx:45`, `EditableText.tsx:11`,
  `BacklogTab.tsx:67` and `TicketCard.tsx:35` are the live candidates — but do not start.

**The mechanism, stated precisely, because the first version of this section got it wrong.**
`dom-accessibility-api` does *not* treat everything as inline — it reads `getComputedStyle(child)
.display` and inserts a separator for any non-inline child (`accessible-name-and-description.js`,
the `separator` line). The divergence has **two** causes, and both are needed:

1. **The test document loads no stylesheet.** Tailwind's `flex` never enters the cascade, so every
   `<span>` falls back to the UA default `inline` and gets no separator.
2. **jsdom does not blockify flex children.** Even with `style="display:flex"` set inline, jsdom
   returns the same fused name — measured. Chrome blockifies, and that is what actually separates
   the parts: **in Chrome** `getComputedStyle` on the row's six span children returns `block` for
   all but one (the `inline-flex` blocked badge), while **in jsdom** all six are `inline`.

So they do **not** "disagree completely". They agree wherever the parts are already block-level
(a `<div>`- or `<p>`-structured component reads the same in both) and diverge exactly where a
`<span>` is a flex item — which is every ticket card and backlog row:

| Same ticket, blocked, 5 points, assigned | jsdom | Chrome |
|---|---|---|
| Board card | `MP-1 BlockedStory5story points Wire the board` | `MP-1 BLOCKED STORY 5 story points Wire the board` |
| Backlog row | `MP-1StoryWire the boardBlocked5story pointsAssigned todev@example.com` | `MP-1 STORY Wire the board BLOCKED 5 story points Assigned to dev@example.com` |

Chrome measured via CDP `Accessibility.getPartialAXTree`; jsdom via `computeAccessibleName`. Both
columns are the same ticket in the same state, post-SPRIN-67 — an earlier draft of this table paired
an unblocked jsdom name with a blocked Chrome one, which made the row meaningless. **Chromium only**
— Firefox and WebKit are not installed here.

SPRIN-67 was opened to fix that "fusion" and the fusion does not exist for users. It cost a story to
find out, so the rules are:

- **Assert DOM text and the container it sits in.** Both are true in every engine. Scope with
  `within(button)` — an unscoped `getByText` says the text exists and nothing about *where*.
  SPRIN-65's points badge was moved outside its button and all 12 tests stayed green.
- **But DOM text alone is not enough**, and this is the trap the story's own first draft fell into:
  `getByText` ignores only `<script>`/`<style>`, so it matches an `aria-hidden` subtree happily. An
  `aria-hidden="true"` on `sr-only` text reverts the fix entirely with every test green. Pair the
  text assertion with a **substring name query** (`getByRole('button', { name: /assigned to/i })`),
  which honours `aria-hidden` and is engine-independent because it is not an exact match.
- **`toHaveClass` is a subset check.** `sr-only hidden` passes `toHaveClass('sr-only')` while the
  element stops rendering. For a span whose entire job is to be `sr-only`, assert the exact class.
- **`sr-only` text still works and is still right** over `aria-label` on a `<span>` (`role="generic"`,
  where ARIA 1.2 prohibits it). Chrome renders `5 story points` from exactly that pattern.
- **A browser is the only place an accessible name is real.** Measure there before believing a name
  is broken — and note that `e2e.yml` is not the gate, so a Playwright assertion documents a name
  rather than protecting it.

Still open, deliberately, and **engine-specific**: Chrome's AX tree applies `text-transform:
uppercase` when computing the name, so on the same DOM it yields `STORY` while Playwright's own
accname implementation yields `Story`. What a screen reader then *does* with an all-caps name is
untested here — so whether the type and blocked badges are worth changing is a real question, and
its own story if wanted.

## Review depth is chosen by the diff, not applied by default

**An ordinary story gets ONE reviewer on PR open.** A board tweak, a dialog, a copy
change, a refactor already covered by tests — one pass, and move on. The weight of
earlier sessions came from applying a security-boundary rule to ordinary UI work, and
SPRIN-55 retired that. Do not spin up a review fleet for a form field.

**A security-boundary diff gets the deep multi-agent review** — many independent
lenses, each finding adversarially verified. The boundary is narrow and specific:
**authentication, RLS / tenant isolation, secret handling, or the CI gate workflow
itself.** These are the diffs where one missed defect is expensive, and the project has
form here: a 48-agent adversarial pass once caught a broken `check-bundle` control that
four conventional reviews missed. **Read the KILLED findings, not just the survivors** —
majority-vote has discarded a correct finding before.

If a diff sits on the line, the honest move is to ask rather than to guess upward: a
deep pass is not free, and neither is a missed RLS defect.

**Give every mutation-testing reviewer its own worktree** (`isolation: "worktree"`). A
serious review breaks the code deliberately to prove a test can fail, so two reviewers in
one working tree will observe each other's mutations and draw confident, wrong
conclusions. This has already happened: two reviewers of SPRIN-46 ran in the same tree and
one found a foreign edit mid-run — it recognised the edit as another agent's mutation and
worked around it, but nothing guaranteed that. The cost of isolation is a few hundred ms
of setup; the cost of not isolating is a review you cannot trust and cannot tell is
untrustworthy.

**Ask a reviewer to mutate, not to read.** Across three reviews in one session, every
finding that changed the code came from breaking something and watching what did *not* go
red — vacuous tests, unguarded rejection paths, a dependency footgun measured at ~1.2M
invocations in five seconds. None was found by reading. A review that reports no findings
without having planted a single mutation has established very little.

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
Claude Code CLI owns the Jira board (project key `SPRIN`) through the **Composio**
MCP connector — there is no native Atlassian connector on this machine. The Jira
connection persists across sessions; check `has_active_connection` before ever
asking for a re-auth. Transition ids are per-workflow: fetch them, never hardcode.
- **The board is the source of truth for what is left to build.** Phase 1's epics and
  stories are all created and Done, and **Rung 3's five epics and their stories now live
  there too**, so query it (`statusCategory != Done`) rather than a document — the phase-1
  backlog file that used to hold them was retired in SPRIN-69, and git history has it if
  the original ACs are ever needed.
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
- `docs/HANDOVER.md` — session narrative, open engineering follow-ups, what CI cannot pin, and
  settled non-issues that should not be re-raised. **Read it before planning a story.** It is the
  *context* behind the board, never a substitute for it.
- `docs/sprintboard_phase1_schema.sql` — the database schema.
- `docs/standards-audit-2026-07-25.md` — banner-marked HISTORICAL, and mostly is. Two
  sections are not: the **eight pre-existing coverage gaps** deliberately left unfixed, and
  the note on **guards no test can observe**. Both are live. SPRIN-69 kept this file for
  exactly that reason while retiring its three neighbours.
- `CLAUDE.md` — this file.
