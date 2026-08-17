# Handover

Session narrative and open engineering follow-ups. **The Jira board (`SPRIN`,
`statusCategory != Done`) is the source of truth for what is left to build** — this file is
the *context* behind it, not a substitute for it.

Kept here rather than in agent memory because agent memory is loaded into context at the start
of every session and this file only ever grows. Rules and conventions live in `CLAUDE.md`;
decisions live in `docs/adr/`; designs live in `docs/superpowers/specs/`.

---

## Where the project is

**Rung 1 (Phase 1) shipped** 2026-07-20. **Rung 3 in progress** since 2026-07-31, in this order:
custom statuses (**SPRIN-72, done**) → Kanban project type (**SPRIN-73, done** 2026-08-05) →
**custom fields (SPRIN-71, done** 2026-08-09**)** → **sprint cadence (SPRIN-74, done** 2026-08-10**)**
→ **teams, roles and permissions (75 — the security boundary, deliberately last)**.

**FOUR of five Rung 3 epics are complete. SPRIN-75 is the last, and as of 2026-08-16 it has
STORIES and its first one is shipped.**

### SPRIN-75 — the design David settled, 2026-08-16

Binding on all seven remaining stories. Taken in conversation before any code:

- **Two roles, `admin` and `member`, and BOTH read and write.** A read-only *viewer* was proposed
  and **rejected**: a viewer makes read broader than write on the board tables, which re-arms the
  SPRIN-64 trap where `completeSprint`'s guard is correct only because `sprints_owner` is a single
  `for all` policy. Keeping read ≡ write is the property that makes this rewrite verifiable.
- **Membership is granted by exact email**, which is why SPRIN-105 adds `profiles.email` and widens
  `profiles_self`.
- **`owner_id` stays** on `projects`, `not null`, as an audit record granting nothing. The `projects`
  INSERT policy keeps `owner_id = auth.uid()` **purely to bootstrap** — otherwise creating a project
  needs a membership that does not exist yet and every creation fails at insert time.
- **Admins configure, members do board work.** Claude's call and open to veto:
  `ticket_field_values` is board work, not configuration — setting a custom field's *value* is daily
  member work, defining the *field* is the admin act.

### The story keys are AGAIN not in build order

Same parallel-creation race as SPRIN-71 and SPRIN-74. **Build in this order, not key order:**

| # | Key | Story | State |
|---|---|---|---|
| 1 | **SPRIN-98** | Membership table, roles and admin seeding | **Done** 2026-08-16, migration applied |
| 2 | SPRIN-105 | Co-members can see each other (`profiles` widening + `profiles.email`) | **Done** 2026-08-16, two migrations applied |
| 3 | SPRIN-100 | Board tables governed by membership (`sprints`, `tickets`, `counters`) | **Done** 2026-08-17, two migrations applied |
| 4 | SPRIN-101 | Projects table governed by membership | To Do |
| 5 | SPRIN-99 | Config tables: admin-only writes, member reads | To Do |
| 6 | SPRIN-102 | Add and remove members by email | To Do |
| 7 | SPRIN-104 | Re-audit app-layer guards for zero-row-write blindness | To Do |
| 8 | SPRIN-103 | Extend the isolation suite: role-vs-role and removed-member | To Do |

Each Jira description carries its own traps. **SPRIN-102's has four concrete ones recorded as a
comment** — read them before designing it.

### What SPRIN-98 left in the schema

`app_auth`, a schema PostgREST does **not** expose, holding two `STABLE SECURITY DEFINER`
predicates (`is_project_member`, `is_project_admin`). They exist because a policy on
`project_members` cannot query `project_members` — Postgres raises `infinite recursion detected in
policy` — and routing through `projects` only defers that to SPRIN-101, where the two recurse
mutually. Both read `auth.uid()` and **nothing else**, so a caller can only learn about themselves;
**adding a `user_id` parameter to either signature destroys that property.**

⚠ **A new function added to `app_auth` is born `EXECUTE`-to-`PUBLIC`**, and `authenticated` holds
permanent `USAGE` there. `alter default privileges` was tried and would not stick — the editor
reported success and `pg_default_acl` stayed empty, root cause unestablished. **Revoke by hand in
the same migration.** The warning and its verification query are at the head of
`docs/migrations/sprin-98-project-members.sql`.

⚠ **Reachable since SPRIN-98 landed:** a sole admin can delete their own membership row, leaving a
project no one can administer — `members_admin_insert` then refuses everyone and `members_read`
returns nothing. SPRIN-102 owns the guard and must **repair** existing cases, not merely prevent new
ones. Do **not** implement it as a row trigger counting siblings; that breaks the delete cascade.

**THE SPRIN-74 STORY KEYS WERE NOT IN BUILD ORDER.** They were created in parallel and the board
raced — the same trap epic SPRIN-71 hit. Story 2, the heavy one, drew the *highest* key:

| Story | Key | State | Migration |
|---|---|---|---|
| 1 — see a project's sprint cadence | SPRIN-94 | **Done** | A, applied |
| 2 — change the cadence (pays the SPRIN-82 wall) | **SPRIN-97** | **Done** | B (grants), applied |
| 3 — pre-fill the create-sprint dates | SPRIN-96 | **Done** | — |
| 4 — reject end-before-start in the database | SPRIN-95 | **Done** | C, applied |

**The epic issue was transitioned by hand** after querying `parent = SPRIN-74 AND statusCategory
!= Done` and getting zero rows — Jira does not close epics on its own, and SPRIN-57 sat in To Do
for three sessions with every child Done because nobody did this.

The design is `docs/superpowers/specs/2026-08-09-sprin-74-sprint-cadence-design.md`. **Read it
before planning any of them** — it carries the rejected alternatives and the two corrections
below.

Epic 73 is complete: 81, 82, 83, 84, 85, **86** and 87 all done. `wip_limit` is no longer inert —
SPRIN-86 renders it on the board, and the limit is **soft**: it warns, it never blocks.

**Epic SPRIN-71 is designed and stories 1–5 have shipped.** The design is
`docs/superpowers/specs/2026-08-05-sprin-71-custom-fields-design.md` — six stories, three
migrations, all additive. Read it before planning any of them. **Only story 6 (SPRIN-93) is
left.**

**The design says story 2 needs no migration. It was wrong**, and the story overrode it: the
INSERT grant story 1 revoked is a migration, and widening a privilege with no file recording it
is what this project's rules exist to prevent. Expect the same of story 6 (DELETE).

**THE JIRA KEYS ARE NOT IN STORY ORDER.** They were created in parallel and the board raced, so
stories 3 and 4 carry the lowest numbers. Reading build order off the key numbers gives the wrong
answer:

| Story | Key | State | Migration |
|---|---|---|---|
| 1 — the `project_fields` table and the field list | SPRIN-90 | **Done** | A, applied |
| 2 — add and rename a custom field | SPRIN-91 | **Done** | B (grants), applied |
| 3 — values on the ticket detail sidebar | SPRIN-88 | **Done** | C, applied |
| 4 — values on the create-ticket dialog | SPRIN-89 | **Done** | — (none needed, verified) |
| 5 — single-select fields | SPRIN-92 | **Done** | D, applied |
| 6 — delete a field, with its value count | SPRIN-93 | **Done** | E (grants), applied |

**Epic SPRIN-71 is COMPLETE — six of six, closed 2026-08-09.** The epic issue was transitioned by
hand after checking `parent = SPRIN-71` rather than inferring from the last story: Jira does not
close epics on its own, and SPRIN-57 sat in To Do for three sessions with every child Done because
nobody did this. The order now moves to **SPRIN-74** (sprint cadence), then **SPRIN-75 (RLS) LAST**.

**Read this before planning SPRIN-74: it will hit the SPRIN-82 wall.** If cadence lives on
`projects`, editing it needs `grant update (...) on projects` — and `projects` currently holds **no
UPDATE privilege for `authenticated` at all**. Per `CLAUDE.md` that story owes three things, not
one: the grant, a narrowing of the AST guard in `src/test/project-type-immutability.test.ts`, and
restoring a cross-tenant UPDATE row-count assertion to `rls.integration.test.ts` (SPRIN-82 removed
it precisely because there was no privilege left for RLS to filter). Budget it as most of a story.

**The migration letters have shifted by one.** The design calls `ticket_field_values` "migration
B" and `project_field_options` "migration C"; SPRIN-91's grant file took the name
`sprin-91-project-fields-insert.sql` and the B slot, so story 3's table is **C** and story 5's is
**D**. Go by the filenames in `docs/migrations/`, not by the letters in the epic design.

## Session log

### Session 71 — SPRIN-100, the board tables resolve to membership (two migrations)

`counters_owner`, `sprints_owner` and `tickets_owner` moved from `owner_id = auth.uid()` to
`app_auth.is_project_member(project_id)`, each still a single `for all` with one predicate in
both clauses. Advisors 15 → 12 performance lints; the three `auth_rls_initplan` WARNs cleared
for free, because a `STABLE` definer predicate does what `(select auth.uid())` does.

**Two things bit that neither the story description nor this file predicted. Both were found
before writing code, by checking the ACs against the live catalogue rather than the prose.**

1. **The naive rewrite would have broken the production keepalive and therefore every future
   merge.** These three tables grant `anon` full CRUD and the old policies had no `TO` clause,
   so they covered `public`. Policy expressions are evaluated as the *calling* role, and `anon`
   has neither USAGE on `app_auth` nor EXECUTE on its functions — so an anonymous read would
   have raised `permission denied for schema app_auth` instead of returning `[]`. The cron
   keepalive does an anon `GET /rest/v1/tickets` and expects `200 []`; breaking it pauses the
   free-tier database, and a paused database blocks every merge including its own fix.
   **Fix: `to authenticated` on all three.** This is now a standing rule in `CLAUDE.md` for the
   rest of the epic. SPRIN-98 never felt it because `anon` holds no grant on `project_members`.
2. **The bootstrap problem arrived a story early.** `create_project_counter` is an `AFTER INSERT`
   trigger on `projects` that sorts *before* `on_project_created_admin` in name order, so under a
   membership-only `counters_owner` it ran before the membership row existed and every project
   creation would have failed. **Fix: SECURITY DEFINER**, matching its two sibling triggers,
   rather than reordering triggers — which would have made alphabetical fire order load-bearing
   and falsified SPRIN-98's own comment that nothing depends on it.

**A third was found only by the tests, and is the reason the positive control existed.**
Post-migration, members could read and update tickets but not CREATE them: `23502`, null `key`.
The counter is the obvious suspect and is innocent. `assign_ticket_key` also **reads
`projects`**, whose policy is still owner-scoped until SPRIN-101, so `v_key` was NULL for a
member. Proved two ways: `number` is column 3 and `key` is column 4, both `NOT NULL`, and
Postgres named `key` — so the counter write had succeeded. Fixed in `sprin-100b` by making
`assign_ticket_key` SECURITY DEFINER, which **knowingly deletes a tripwire** (the schema comment
said it was deliberately an invoker so a mistake in `counters_owner` would break ticket creation
loudly). The boundary is unchanged — `tickets_owner`'s `WITH CHECK` runs after BEFORE-triggers,
so a stranger is refused and the increment rolls back. **SPRIN-101 can revert it and get the
tripwire back once `projects` is membership-scoped; that should be a decision, not an
inheritance.** The generalised lesson is in `CLAUDE.md`: a SECURITY INVOKER trigger depends on
every table it READS, not only the ones it writes.

**The suite.** New file `board-membership.integration.test.ts`, 16 live tests on its own
throwaway users, taking the tripwire gap to **ten**. It adds only `member` rows, never a second
`admin`, because `project-members.integration.test.ts` asserts a whole-database invariant that
every project has exactly one. Committed **red** before the migration, and it failed 12 of 16 —
a real mutation result showing the suite dies when the policy is owner-scoped.

Its cross-project block was added in review and matters more than its size: every other negative
is written from a stranger who belongs to **no** project, so all of them are satisfied by a
predicate that merely asks "is this caller a member of anything?". Dropping the `project_id`
comparison from `is_project_member` would have left the rest of the file green while a member
could read every project in the database.

**Also fixed: `verify-gate.test.mjs`'s `LIVE_SUITES` had drifted to eight against nine real
suites.** SPRIN-105 updated the prose tripwire in `CLAUDE.md` and left the executable array, so
its own suite was collectable-but-unregistered for a whole story — precisely the state that
array exists to make impossible. Both halves are now registered and `CLAUDE.md` says they are
one control with two halves.

**Known intermediate state, not a defect:** until SPRIN-101, a member has board access to a
project that does not appear in their project list, because `listProjects` still resolves
through `projects_owner`. The feature is not user-visible end to end until story 4.

Newest first. One paragraph each — detail is in the linked PRs, specs and git history.

### Session 68 — SPRIN-95 **MERGED**, epic SPRIN-74 **CLOSED** (PR #110, `d3a8f5f`)

**Merged 2026-08-10.** `verify` green on the PR's own head `f26cd4a`: **79 test files, 1535 tests,
0 skipped**, gap **7** against `test:unit`'s 72. Migration C applied by hand and verified from
`pg_constraint`: `contype='c'`, `convalidated=true`, definition exactly
`CHECK ((end_date >= start_date))`. Advisors unchanged at **16 performance / 1 security**, whole
per-table breakdown matching. Epic SPRIN-74 transitioned by hand; **SPRIN-75 is now the only
open issue on the board.**

**The columns are `timestamptz`, which the epic design never said, and it changes the argument.**
The check compares *instants*; the client's `refine` compares `'YYYY-MM-DD'` *calendar days*.
Those are not the same comparison in general — they coincide for every value the app can produce
because `toUtcMidnight` pins both operands to UTC midnight and `createSprint` is the only writer.
And a `::date` variant is **impossible, not merely worse**: `pg_cast timestamptz → date` is
`provolatile='s'` (STABLE, because it reads the session `TimeZone`) and Postgres refuses a
non-IMMUTABLE expression in a `CHECK`.

**AC4 turned out to be covered already**, at `CreateSprintDialog.test.tsx:117` — so the story owed
*evidence* rather than a second test. Removing the `refine` reddened both covering tests; restored
green. Writing a duplicate would have proven nothing.

**THE SESSION'S REAL LESSON IS ABOUT THE GUARD I ADDED, NOT THE CONSTRAINT.** Review found that
inverting the constraint in the migration, or deleting it from `docs/sprintboard_phase1_schema.sql`,
both left the whole suite green — the live suite cannot see it, since the database is built from
the migrations and the doc is applied to nothing. I added a `checkConstraints` matcher to
`domain.test.ts`. **A second adversarial pass then found four Important defects in that matcher**,
and every one was a false *green*: a literal-space separator that made a line-wrapped `alter table`
invisible (the exact drift direction its own docblock called realistic); a `--` stripper that cut
through string literals, throwing on a correct pair of files *and* silently swallowing an `alter`
behind `comment on … is 'see -- note';`; a `create table` regex anchored on `\n);` that over-ran
into `create table tickets`; and no DROP semantics, so a legitimate future drop could never go
green. **A guard is code, and a guard with a false-green path is worse than no guard** — it
manufactures confidence. It now *replays* migrations in order and its vacuity guard counts
**operations** rather than survivors, because a replay that legitimately ends empty is otherwise
indistinguishable from a broken parser.

**Recorded, not fixed.** (1) The drift matcher is scoped to `sprints` only; the general case needs
a per-table decision, because `projects` and `project_statuses` spell checks *unnamed* in the doc
and *named* in the migrations, and `tickets` predates `docs/migrations/` entirely. (2)
`toUtcMidnight` throws `RangeError` on a 5-digit year, which `<input type="date">` can produce; it
throws before any request is issued, so it never reaches the constraint. (3) **`anon` holds
`arwdDxtm` on `sprints`** — full CRUD at the grant layer, RLS the only barrier. Pre-existing and
general to this schema, but SPRIN-75 must reckon with it.

**Two environment facts that cost time.** `~/.bashrc` exports placeholder Supabase config
(`VITE_SUPABASE_URL=https://example.supabase.co`), and Vite's `loadEnv` gives `process.env`
priority over `.env.local` — so local live suites **fail hard** in `beforeAll` with `ENOTFOUND`
rather than skipping, because `hasRlsCredentials` is true. Prefix with
`env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY`. And `clip.exe` transcodes using the calling
console's codepage: the migration's em-dashes reached the SQL editor as mojibake. Nothing durable
was affected — verified by reading the `comment on constraint` back — but `docs/migrations/` is a
replay log meant to be re-pasted, so migrations are now **ASCII-only**.

**Sessions 66 and 67 have no entry in this log** (it jumps 65 → 64) although SPRIN-96 merged in 67
at `e88b8eb`. Their narrative survives in the agent-memory index and PR #109; it was not
reconstructed here rather than guessed at.

### Session 65 — SPRIN-97 **MERGED**, the SPRIN-82 debt **PAID** (PR #107, `66647bf`)

**Merged 2026-08-09.** `verify` green on the PR's own head `3c03b31`: **78 test files, 1497 tests,
0 skipped**, gap **7** against `test:unit`'s 71. Migration B applied by hand and verified from
`pg_class.relacl` / `pg_attribute.attacl`: table ACL still `authenticated=ardDxtm` — **no `w`** —
plus `authenticated=w` on `sprint_length_weeks` and `sprint_start_weekday` and nothing else, and
nothing for `anon` or `PUBLIC`. Advisors unchanged at **16 performance / 1 security**.

**FOUR RECORDED INSTRUCTIONS WERE WRONG, AND FOLLOWING THEM WOULD HAVE SHIPPED A TEST THAT PROVED
NOTHING.** The guard docblock, the schema doc, the RLS deletion site and the SPRIN-82 banner all
said to restore the cross-tenant assertion as `.update({ name: 'pwned' })`. They were written
anticipating a *rename* story. This story granted only the two cadence columns, so `name` stayed
revoked: that update is refused by the **privilege layer** with `42501`/`data === null`, never the
`[]` the assertion expects — and asserting the error instead rebuilds the exact defect the deletion
site argues against, because the line would then pass off the GRANT and dropping `projects_owner`
would no longer redden it. **The rule, as a property rather than a column name: a cross-tenant
row-count assertion is only honest on a column the role may actually UPDATE.** Privileges are
checked before policies. Restored on `sprint_length_weeks`, writing a value the fixture does not
hold, paired with a re-read as A. A **fifth** copy lived in `CLAUDE.md` — the always-loaded file —
stating as fact that `projects` holds no UPDATE privilege at all. All five corrected.

**The review cost £20 of top-up credit in 30 minutes and is the most important process lesson
here.** Six mutation lenses in isolated worktrees, ~106 mutations planted, then three refuters per
finding: **84 agents, ~7.4M subagent tokens across two runs**, and it exhausted the session limit
twice. It found real defects — see below — so it was not wasted, but "warranted" was the wrong test
to apply on its own. **Price a fan-out in money before launching it, and size the verify phase to
the finding count** (26 findings × 3 refuters = 78 agents was the blow-up, not the 6 finders).

**My own workflow script scored a dead agent as a refutation.** The verdict test was
`cast.length > 0 && refuters < 2`, so when 43 verifiers died on the session limit their findings
fell into `killed` — which reads as "adversarially refuted" when it means "never looked at".
**Three states, never two.** Fixed to an explicit `unresolved` bucket; the 12 unresolved findings
were then read off disk rather than re-run, and one of them was a real user-facing bug.

**Five findings fixed, each proven by mutation:** (1) nothing tied the **applied SQL grant's column
list** to `SPRINT_CADENCE_COLUMNS` — widening the migration to `name` passed the *entire* gate,
because the AST guard polices what `src/` writes, not what the database permits; (2) the new
doc-vs-migration test **hardcoded two migration filenames**, which inverts the control against the
drift that actually happens (migration leads, doc lags) — it now globs the directory, so a third
migration cannot be invisible; (3) `grantStatements` matched the literal `on projects`, so
`on public.projects` in the doc was dropped before comparison; (4) the cadence **form** kept the
previous project's values across a project switch — the tab is a nested route element so it
re-renders rather than remounts, `useForm` captures `defaultValues` once, and the summary line
updated while the pickers did not, so Save wrote the old project's numbers onto the new project
(fixed with `key={project.id}`, pinned by a test that reds without it); (5) the `CLAUDE.md` false
fact above.

**Also found, in my own new test: a sorted comparison cannot see order, and here order is the
meaning.** `grantStatements` sorts, so it compares files as sets — but a table-level `revoke`
**cascades** to column privileges, so `grant`-then-`revoke` leaves the table with no update
privilege at all. Sorted order puts `grant` first, i.e. the broken sequence is the one a set
comparison blesses. A separate ordering assertion now covers it.

**Left open, deliberately.** No live assertion covers `name`/`key` immutability — the owner-side
pair only narrows `project_type`. Three of the five tables whose grants the schema doc states are
pinned by nothing (`project_statuses`, `ticket_field_values`, `project_field_options`) — same drift
class, other tables. And the AST guard's own fail-closed predicate is untested; that is a genuine
gap but also an infinite regress, so it is recorded rather than chased.

### Session 64 — epic SPRIN-74 **DECOMPOSED**, SPRIN-94 **MERGED** (PRs #104, #105, `1464227`)

**Merged 2026-08-09.** `verify` green on the PR's own head `29ba664`: **77 test files**, gap **7**
against `test:unit`'s 70, so the live suites really ran. Migration A applied by hand and verified
from `pg_catalog`: both columns `not null` with defaults 2 and 1, both named range checks present,
**0 table UPDATE grants and 0 column ACLs on `projects`** — nothing moved, which is the state
SPRIN-97 will widen. Advisors unchanged at **16 performance / 1 security**.

**TWO METHOD CORRECTIONS, both mine, both worth more than the feature.**

1. **`information_schema` cannot answer a question about grants here.** The epic design's first
   draft cited `information_schema.column_privileges` returning zero rows as proof that `projects`
   carries no column grants. **That proves nothing.** Both `column_privileges` and
   `role_table_grants` filter to grants the *querying* role is party to, and the read-only MCP user
   is party to none of them — they return zero rows whatever the ACL holds. Re-derived from
   `pg_attribute.attacl`, which is genuinely empty, so the conclusion survived and the method did
   not. **SPRIN-97 leans on this fact far harder than SPRIN-94 did.** SPRIN-85's migration banner
   records the same trap; this was its second sighting, found only because that banner was read.
2. **A green wait-loop that never waited.** `gh pr checks` prints `no checks reported` in the window
   before CI registers. A loop exiting on "output contains no `pending`" therefore exits instantly,
   and the absence of a verdict looks exactly like a passing one. It nearly produced a third
   "reported green, wasn't green" incident. **Require the check NAME present AND nothing pending.**

**The review: 13 mutations planted, 11 killed, 0 Critical or Important.** Killed the ISO-weekday
table shift, the pluralisation boundary, a `hasSprints`↔`hasWipLimits` gate swap, a gate hardcoded
to `true`, broken `aria-labelledby`, an ignored cadence prop and a stray edit button.

**The gap left open on purpose, and it is the third sighting of its class.** Nothing compares the
schema doc's `CHECK` bounds to the applied migration: a reviewer made
`docs/sprintboard_phase1_schema.sql` disagree with the live database and the whole gate stayed
green. `domain.test.ts`'s doc-vs-migration matcher covers `project_fields` **grant statements**
only — not DDL bounds, not this table. Not fixed here because a general doc-vs-DDL matcher is test
infrastructure rather than one story's scope, and a bad one would *look* like coverage while
providing none. Recorded in the epic spec, where SPRIN-97 will read it.

**An unchecked cast was hiding the new columns.** `SettingsTab.test.tsx`'s fixture is
`{ id, name, key, project_type } as Project`; the cast is why nothing complained when two columns
appeared. Left alone, every existing Scrum Settings test would have rendered *"undefined weeks,
starting day undefined"* and stayed green, since none assert on cadence text. The fixture now
carries a real cadence.

**Copy that promised an unbuilt feature was cut.** The section originally read *"New sprints are
suggested from this"* — false until SPRIN-96 ships the pre-fill. User-facing copy asserting
behaviour the app lacks is worse than a false comment, because users read it. No test broke when it
was removed, which is the incidental finding: the sentence was unpinned.

**Left undone:** `SPRINT_LENGTH_WEEKS` is exported with no consumer until SPRIN-97's picker, against
the convention `domain.ts`'s own `hasWipLimits` docblock states. David's call to leave it — the test
pinning it to `[1,2,3,4]` is what will stop the picker drifting from
`projects_sprint_length_weeks_range`, and `knip` is not wired into `package.json` anyway.

### Session 63 — SPRIN-93 **MERGED**, epic SPRIN-71 **CLOSED** (PR #102, `44c7440`)

**Merged 2026-08-09.** `verify` green on the PR's own head (`b93c785`): **76 test files / 1432
tests / 0 skipped**, tripwire gap **7** against `test:unit`'s 69 — so the live suites really ran.
Migration E applied by hand and verified from the catalogue. `main` and the database agree.

**The Jira issue said "no migration" and was wrong** — the third time this epic's paperwork has
mis-stated a story's migration needs. `sprin-90` revoked DELETE table-wide; `sprin-91`'s header
names story 6 as the one that grants it back. **Check the ACs against the actual schema before
designing**, every time; the epic design has now been wrong about stories 2, 4 and 6.

**Migration E restates the WHOLE grant state** (David's call, 2026-08-09) rather than adding one
statement. The rejected alternative — a bare `grant delete` — cannot cascade anything away and is
in that narrow sense safer; it lost because it leaves the complete privilege set stated in no
single file, which is exactly how the schema doc drifted. Verified after applying: table ACL
`authenticated=rdDxtm`, and all four column grants (`project_id=a`, `slug=a`, `name=aw`, `type=a`)
intact — **the revoke's cascade ate nothing.** Advisors unchanged at **16 performance / 1 security**.

**THE FINDING WORTH READING, and it was mine rather than an implementer's.** The schema doc's
`project_fields` grant block had never gained SPRIN-91's INSERT grant — a rebuild from it produced
a table `authenticated` could not insert into at all. I fixed that, then wrote *"the two cannot
drift again independently"* into both the doc and the design spec — **enforced by nothing.** An
adversarial reviewer deleted the story's own `grant delete` line from the doc and the entire gate
stayed green, because **nothing in this repo reads a grant line out of `sprintboard_phase1_schema.sql`,
and the doc is never applied**, so no live assertion can ever observe doc drift. That is a
prose-only invariant committed while fixing the third instance of the very drift it claimed to
prevent. `domain.test.ts` now compares the doc's `project_fields` grant statements to migration E's,
**with `--` comments stripped first** — both files argue about grants in prose, so a matcher that
read comments would compare documentation rather than SQL.

**The adversarial pass: 5 lenses, 132 mutations planted, 118 killed, 7 survivors, 1 killed finding.**
Every survivor was a *missing test*, not broken behaviour — no lens could make `f608785` misbehave.
Four guards were unpinned and now each have a test watched to fail:

- **The row `key` became load-bearing for the first time in this story.** `key={field.id}` → `key={i}`
  survived the whole gate. Before SPRIN-93 no row had ever been *removed* from the field list, so
  identity and index keys were behaviourally identical. Under an index key a survivor reuses the
  deleted row's component instance — a reviewer drove that to a real `deleteProjectField` call on a
  field the user never selected.
- **The count effect's `cancelled` flag is AC4's second half** and four of five lenses found it
  unobserved, in four shapes — including flipping the cleanup to `cancelled = false`, which also
  slips past ESLint since the variable stays read *and* assigned. The `onOpenChange` reset does
  **not** cover it (measured with the reset intact). **The identical guard in `CustomFieldOptions.tsx`
  (SPRIN-92's, which this story copied faithfully) was equally unpinned** — closed in both places,
  because fixing only the copy is the "closed at the leaves, still open one level up" failure.
- A refusal outlived its dialog: dropping `setError(null)` from `onOpenChange` left the suite green
  while a stale error rendered in a freshly reopened confirm.

**`onDeleted={onRetryOptions}` COMPILES.** TypeScript assigns a zero-parameter `() => void` to a
`(id: string) => void` slot, so requiredness does not cover that crossing — only an assertion does.
Worth remembering wherever this project leans on required props to catch unplugged wires.

**Open follow-ups from this session, none blocking:**

- `rls.integration.test.ts:~1756` — the pre-existing anon-delete assertion checks only the SQLSTATE,
  not the message, and is now the weaker of the two anon-delete assertions in the file. One line.
- **Settled non-issue, recorded so it is not re-raised:** two fields may share a name (SPRIN-91 AC2
  requires it), giving two `Remove <name>` buttons with identical accessible names. Adversarially
  refuted and I agree: the two rendered rows are **byte-identical for a sighted user**, so there is
  no AT-specific loss; removing the `aria-label` reddens 16 tests across 4 files, so the label is
  the mitigation rather than the cause; and clicking the second routes correctly to its own id. The
  residue is a *product* question — with two identically-named fields the only discriminator in the
  confirm is the ticket count — inherited from SPRIN-91 and shared with the rename control.

### Session 62 — SPRIN-92 reviewed, fixed and **MERGED** (PR #100, `532a5ec`)

**Merged 2026-08-08.** `verify` green on the PR's own head (`43eec91`) and again on the merge
commit itself: **75 test files, 0 skipped**, so the live suites really ran. `e2e` also passed.
`main` and the database now agree — migration D is no longer ahead of `main`, and the
drop-it-by-hand warning from session 61 is discharged.

**TWO THINGS ONLY CI COULD SEE, and this is the session's real lesson.** The branch had been red
for three sessions and every local signal said otherwise:

1. **`format:check` failed on six files — FOUR of them already dirty before this session started**
   (measured at `e54e302`). Twenty-three commits ran a local loop of `lint` + `typecheck` +
   `test:unit`. None of those three includes the formatter, and `verify` only fires on a pull
   request. A local subset that omits one step of the real gate reports green for a red branch.
2. **Two SPRIN-88 live tests, broken by THIS story's own migration.** `tfv_option_fk` retroactively
   re-judged fixtures written before it existed: they inserted `value_option: 'red'`/`'blue'`,
   slugs that named no option row, and earned `23503`. Fixed by seeding two options in that
   block's `beforeAll`. **A migration that ADDS a constraint invalidates every fixture written
   against the schema before it** — and the live suites cannot run locally at all here
   (placeholder Supabase URL → `ENOTFOUND`, which fails hard rather than skipping), so nothing
   local can say so. The migration had been hand-applied three sessions earlier. **Next time: grep
   the live suites for values the new constraint now judges, in the same commit as the migration,
   and open a draft PR early — it is the only thing that runs the full gate.**

### Session 62 (detail) — the unread review, read and acted on

The adversarial review session 61 left running was recovered from `journal.jsonl` and written up
as **`docs/sprin-92-review-findings.md`**, which is now committed. **Read its header before
trusting any of it:** four of five lenses journaled, the fifth (`wiring-and-seams`, 68 mutations)
was reconstructed from its transcript, and **the Verify and Synthesise phases never ran** — so
there is no KILLED list and not one finding was adversarially verified. Mutation counts were
12/9/13/14/54; no lens reported zero.

**All eleven findings are fixed.** Every behavioural one was confirmed the way this project asks
for — plant the mutation, watch the suite, restore — and each new test was checked to be the
*only* thing that kills its mutation:

| # | Fix | Mutation that now dies |
|---|---|---|
| 2 | `SettingsTab.test.tsx` | `optionsPhase={fieldsPhase}` — sixth instance of the class, second time one level ABOVE where it was closed |
| 3 | `CustomFieldOptions.test.tsx` | crossing `countTicketsHoldingOption`'s arguments (found by 4 of 5 lenses) |
| 4 | `ProjectShell.test.tsx` | either option reducer keyed on `slug` alone |
| 5 | both ticket-field test files | dropping the `optionsForField` slice at either `<select>` site |
| 6 | `project-field-options.ts` | narrowing the create's `.select()` — now **TS2739 at compile time**, which the `as ProjectFieldOption` cast had been suppressing |
| 11 | `CustomFieldOptions.test.tsx` | `key={option.slug}` → `key={fieldId}`, caught through React's own duplicate-key error |

**Finding #9 was right about the hole and WRONG about its extent, and that is worth recording.**
It said the schema doc was missing `project_field_options`' grant block while "every sibling
table's block is present". `ticket_field_values` had no block either — SPRIN-88 recorded its
policies here without its privileges. **Both blocks were added.** A rebuild from the doc had been
producing two tables with the full default CRUD grant for `authenticated`, which is not a smaller
schema but a different one: `slug` patchable, AC3 demoted from a database property back to a
convention. An unverified finding's *reasoning* is a hypothesis even when its *conclusion* holds.

**Finding #1 was the Tier-1 one and the migration file had already claimed it was covered.**
`sprin-92-project-field-options.sql` says of `options_owner_delete` "…and why a live test proves
it". No such test existed: all 8 references to the table in `rls.integration.test.ts` used client
`a`, so the table shipped with complete AC coverage and **empty isolation coverage** while all
three siblings carry B-side assertions. Five tests were added — B-select/insert/update/delete plus
anon — all on ROW COUNTS rather than `error === null`, because RLS filters rather than raising.
It matters most here: this is the only one of the four tables holding a table-wide `grant delete`,
and that delete cascades into ticket data through `tfv_option_fk`.

⚠ **Those five are LIVE tests and CANNOT run locally** (placeholder Supabase URL → `ENOTFOUND`).
They are unverified until CI runs them on the PR. Treat a green local `test:unit` as saying
nothing about them.

Local gate after the fixes: **68 files / 1251 tests** (`test:unit`), 75 collected by `npm test`,
tripwire gap still **7**; lint and typecheck clean. `renameProjectFieldOption` now counts its own
affected rows instead of leaning on `.single()`'s incidental zero-row error, which closes the
third instance of that class this file recorded — the entry is struck from the SPRIN-75 list below.

### Session 61 — SPRIN-92 BUILT AND PUSHED, NOT MERGED (branch `sprin-92-single-select-fields`, `79137b3`)

**Read this before touching anything.** 21 commits, pushed, `verify` has **never run** — CI only
fires on a pull request and there is no PR yet. Local `test:unit` is 68 files / 1244 tests, lint and
typecheck clean. The tripwire gap held at **7** throughout.

**THE DATABASE IS AHEAD OF `main`.** Migration D (`docs/migrations/sprin-92-project-field-options.sql`)
was hand-applied 2026-08-08 and verified from the catalogue: `project_field_options` live, RLS on,
four `options_owner_*` policies all using `(select auth.uid())`, exactly six column grants (INSERT on
five columns, UPDATE on `label` alone), plus `tfv_option_fk` on `ticket_field_values`. **If this
branch is abandoned the table must be DROPPED BY HAND** — nothing else will do it. Same shape as
session 57.

**Advisors moved 14 → 16 performance lints**, both new ones `unindexed_foreign_keys` INFOs
(`pfo_field_fk`, `tfv_option_fk`), accepted with no index — adding one is a further migration and
David's call. Security unchanged at 1 WARN. **No new `auth_rls_initplan`** — still 8.
**A prediction in the spec and plan was WRONG and is corrected in the migration file:** fk index
coverage needs the fk columns to be a **prefix of an index**, not merely to share a leading column.
`pfo_field_fk (field_id, project_id)` is flagged despite the PK `(field_id, slug)` leading with
`field_id`.

**ONE DEFECT CLASS ACCOUNTED FOR FIVE OF THE SIX FINDINGS.** A wire or guard that could be dropped,
crossed or defaulted with the entire suite green:
1. an untested `.trim()` (found by deleting it — nothing went red);
2. a **vacuous** live RLS test asserting `error === null`, where RLS FILTERS rather than raising, so
   a zero-row update looked like success — **CI would not have caught this either**;
3. six prop pass-throughs pinned by nothing;
4. two **same-signature callbacks that could be SWAPPED** with 1216 tests green, type-clean and
   lint-clean — found only because a reviewer invented that mutation unprompted;
5. a required-prop fix that closed the hole at the leaves and left it open one level up, proven by a
   probe that compiled clean and rendered an enabled empty select.
**It is now closed by construction, not vigilance**: `options` and `optionsPhase` are REQUIRED (no
defaults) at every component in both chains, so an unplugged wire is a `TS2741` compile error.
Removing those defaults also *lowered* complexity — a default parameter costs a cyclomatic point
here — taking `TicketCustomFields` 6→5, `CreateTicketCustomFields` 8→7 and restoring
`TicketDetailSidebar` from 10 back to **9**.

**Three times an implementer corrected a premise I handed it**, which is why the deviation-reporting
rule earns its keep: the plan told one to put `ALTER TABLE` in the schema doc (a guard forbids it);
plan test code violated `noUncheckedIndexedAccess` twice; and **twice** a dispatch claimed an earlier
task had already threaded `options`/`optionsPhase` to a dialog when it had not — Task 9 stopped at
the Outlet context. Unchecked, the controls would have passed every test and received no data in the
running app.

**A reviewer was also wrong once, and the implementer disproved it by mutation** rather than
argument: the claim that one test closed both wiring hops was false — with the second test skipped
and the swap applied, the whole suite ran green. Compare the mutation, never the verdict.

**Lint headroom, re-measure rather than recall:** `ProjectShell` and `TicketDetailDialog` are at
cyclomatic **10/10**, zero headroom. `TicketDetailSidebar` is back to 9. Measure with
`npx eslint <file> --rule '{"complexity":["error",1]}'`.

**Still open on this branch:** an adversarial ultracode review (5 lenses + skeptic verification) was
**still running when this session ended, and its report was never read.** It is pinned to SHA
`79137b3` (one commit before this handover commit, which touched only this file — so its findings
still apply). Recover it from disk before opening the PR:

```
Run ID:  wf_ffa450d8-7f8
Journal: ~/.claude/projects/-var-www-sprintboard/0219f420-4e14-4634-bdf8-f02c1e60e382/subagents/workflows/wf_ffa450d8-7f8/journal.jsonl
Script:  ~/.claude/projects/-var-www-sprintboard/0219f420-4e14-4634-bdf8-f02c1e60e382/workflows/scripts/sprin-92-adversarial-review-wf_ffa450d8-7f8.js
```

Read `journal.jsonl` for each agent's actual return value — **do not assume a cached or empty result
means there was nothing to find.** The final agent is labelled `synthesise` and produces five
sections; read section 3, "KILLED BUT WORTH A SECOND LOOK", not only the survivors, because majority
vote has discarded a correct finding on this project before. Also check each finder's
`mutationsPlanted` count: **a lens reporting zero established nothing**, however confident its
conclusion reads. No whole-branch or security pass has been
accepted yet. **`TicketDetailSidebar` and `TicketDetailDialog` still lack an independent hop test for
the options list**; compile-time requiredness partly compensates. And `renameProjectFieldOption`
leans on `.single()`'s incidental zero-row error rather than an explicit row count — a **third**
instance of the class this file already records for `renameProjectStatus`.

### Session 60 — housekeeping: SPRIN-57 closed, the advisor baseline corrected

**No feature work.** Two items, both from reading the board against this file.

**SPRIN-57 ("Pivot phase 2 — remove redundant files and code") was Done and nobody had closed
it.** All three slices had merged — SPRIN-63, SPRIN-69 and SPRIN-58 — leaving an epic sitting in
To Do that made the board look like it held work it did not. Every candidate target in its
description was checked against the tree before transitioning rather than inferred from the
children: `docs/sprintboard.md`, `sprintboard_phase1_backlog.md` and
`sprintboard_phase1_traceability.md` are gone, and `.env.example` has no stale entries — all five
variables still have live consumers. `docs/standards-audit-2026-07-25.md` is **still present on
purpose** (SPRIN-69 kept it for its two non-historical sections), so its presence is not
outstanding scope. The evidence is on the Jira issue, not only here. Transition id fetched (51),
never hardcoded.

**`CLAUDE.md` told every migration story to keep `get_advisors` at "zero lints", and that has
been false for some time.** The rule is now "add no new lints", with the measured baseline stated
inline. This mattered in both directions: a story taking it literally would either chase
pre-existing lints it did not cause, or read a non-zero result as its own regression — the same
inversion session 59 recorded, where "no signature matches, so it must be my diff" is backwards.

**The follow-up entry recording that problem was itself stale, which is worth more than the fix.**
It said 11 performance lints from 2026-08-05; the real figure on 2026-08-08 is **14** (6
`unindexed_foreign_keys` INFOs + 8 `auth_rls_initplan` WARNs). SPRIN-88 added
`ticket_field_values` and its three accepted INFOs, and nothing updated the line that tracked the
count — a clean instance of [[a-written-record-decays]]. The numbers are now labelled as a
timestamped observation with an instruction to re-derive, the same treatment the test-file
tripwire already gets. Also corrected: the sweep has **three** `(select auth.uid())` precedents,
not one — `project_fields` and `ticket_field_values` were written correctly by SPRIN-90 and -88,
so neither is flagged.

**Nothing on the board moved except SPRIN-57.** Next is still **SPRIN-92**.

### Session 59 — SPRIN-89, values on the create-ticket dialog, MERGED (PR #97, `5e8fbe1`)

**Shipped.** Squash-merged to `main` as `5e8fbe1`; `verify` green **on the merge commit itself**
(72 files / 1295 tests), branch deleted, Jira Done by re-query. No migration — verified twice, once
against `sprin-88-ticket-field-values.sql` and once against the **live catalogue**.
65 unit files / 1158 tests locally; tripwire gap still **7**.

**Epic SPRIN-71 is now four of six. Next is SPRIN-92** (single-select fields, migration D), then
SPRIN-93. Nothing in this story blocks either.

**CI caught a wrong belief of mine, and that is the part worth reading.** The design claimed the
bulk insert had to spell out all eight columns because *PostgREST rejects a batch whose objects
have differing keys* (`PGRST102`). I had a live test written to prove it. **The claim is false on
this stack** — the first CI run failed with `expected null not to be null`, because PostgREST
happily **accepted** the differing-key batch. This is the clearest instance yet of the rule that a
mechanistic rationale is a hypothesis until executed: it survived a design review, a plan, an
implementer, two task reviews, a whole-branch adversarial pass and a security pass, because **not
one of them could run it** — the seven live suites cannot execute in this environment.

The replacement test asks the question that actually matters: does PostgREST derive the INSERT
column list from the **union** of the rows or from the **first** row? If the first, a sparse leading
row would silently drop a later row's value — real data loss, and the padding would be essential
rather than tidy. It puts a sparse row first, a row setting a column that row omits second, and
asserts the value survives the round trip. The `PGRST102` prose is corrected in `valueRow`'s
docblock, both batch-test comments, the unit-test comment and the spec, each with a dated note.
**Still open, deliberately:** whether PostgREST fills the missing columns with DEFAULT or
supabase-js normalises client-side. The test pins the outcome, not the mechanism.

**The design decisions, all recorded in the spec with what was rejected.** One bulk `insert`, not N
upserts, so a *partial* values result is not representable — either every value saves or none does,
which is what lets AC4's message be true. `insert` not `upsert` because a brand-new ticket id
cannot conflict and insert needs the narrower privilege. Draft values live in react-hook-form as a
`custom` record rather than beside it, so the reset is correct by construction instead of dependent
on one `onClosed` line surviving.

**The one real defect, found by the whole-branch pass (33 mutations, 32 killed).** `setCreated(true)`
was **not generation-guarded** while the `setError` beside it was — so a stale submit whose values
write failed latched *whichever dialog was open now*: submit disabled, no alert (the guarded
`setError` correctly swallowed it), and the user's fresh draft trapped and unsubmittable. Reachable
in production; it is the SPRIN-51 scenario with a new effect that never got its guard. Fixed
**structurally** rather than with another remembered guard: the latch moved into `CreateDialog` as
`SubmitActions.latch()`, sharing `isCurrent()` with `close` and `setError`, cleared in
`handleOpenChange`. The `submitDisabled` prop added earlier in the story was deleted outright.

**`src/lib/ticket-schemas.ts` is new, and not for tidiness.** react-hook-form's `Control<T>` is
effectively **invariant** in `T` — `T` appears contravariantly in its subscriber callbacks — so a
structural-superset type does **not** satisfy it and the control component could not type its
`control` prop. Verified by the peer reviewer with its own compiler probe, which named the path
`_subjects.state` → `FormStateSubjectRef<T>` → `subscribe`'s `Observer` parameter. It is the fifth
`*-schemas.ts` sibling, and `status-schemas.ts` exists for this identical two-consumers-one-cycle
reason.

**Two of my plan's own code sketches were wrong and the implementers caught both** — which is what
the deviation-reporting rule is for. `z.record(z.string(), z.string())` crashes `.parse()` on any
multi-field project, because untouched fields arrive as `undefined`, not `''` (fixed with
`z.string().optional()`, which lines up exactly with `parseFieldValues`'s existing signature). And
the "refuses a bad number" test I specified is **unreachable**: a `number` input cannot hold a
non-numeric string — measured under jsdom + userEvent, it holds `""` after `twelve`, `1e999` *and*
`1-2`. That branch is now pinned with a scoped spy and documented as defence in depth.

**A test I ordered to close a gap turned out to be vacuous.** After a review found the `?? ''`
fallback unpinned, I asked for a close-and-reopen test. Radix **unmounts dialog content on close**,
so the control remounts fresh regardless of `form.reset()` and the mutation still survived all 1153
tests. The real test renders the row *outside* a dialog and calls `reset()` — and it fails with
React's own controlled→uncontrolled warning when the fallback is removed. Two docblocks that
asserted a guarantee no test provided were corrected.

**Five reviewers, all briefed to mutate rather than read.** Security found nothing exploitable in 6
mutations, verified the no-migration claim against the live catalogue, and measured XSS with a real
payload rather than reasoning about it (`<img src=x onerror=…>` as a field name renders escaped, 0
`img` elements). Its one Minor — `parseFieldValues` reading an **inherited** property, measured to
emit a real write of an attacker-chosen value under a polluted prototype — is unreachable today
(uuid ids, zod drops `__proto__`, RHF bails) and was closed with `Object.hasOwn` anyway.

### Session 58 — SPRIN-88 built, reviewed by four agents, MERGED (PR #95, `baf9bba`)

**Shipped.** PR #95 squash-merged to `main` as `baf9bba`; `verify` green on the merge commit
itself (1251 tests, 70 files, 0 skipped), branch deleted, Jira Done. The migration was applied
in session 57 and is unchanged, so `main` and the database now agree.

**Epic SPRIN-71 is halfway: stories 1, 2 and 3 are done. Next is SPRIN-89** (values on the
create-ticket dialog), which will reuse `setTicketFieldValue` and `parseFieldValue` as they
stand — note it writes values for a ticket that does not exist yet, so the write cannot happen
until after the insert returns an id.

The fk-index question session 57 left open was **decided by David: keep the `(field_id)` index,
add nothing, accept 4 INFOs.** The reasoning that settled it is not the one in the spec's original
option list: mapping each fk to the lookup a cascade actually performs shows all three are already
served (the PK covers `ticket_id`, the shipped index covers the other two), because `project_id`
in those composite fks is a **tenancy** column, not a selectivity one. What goes unsatisfied is
the advisor's prefix rule, not any query. Recorded in the migration file so it travels with the SQL.

**The review was worth its cost and this is the part to read.** Three reviewers in isolated
worktrees, then a fourth re-reviewing the fix wave. Eleven mutations were reported as surviving;
**ten were real** (the re-review restored the pre-fix test file, re-planted the eleventh, and
watched it kill three existing tests — the original reviewer had run a narrow subset). All now
die. The three that mattered:

- **The whole feature could be unplugged from the app in three places with 1094 tests green** —
  only one hop was caught, and only by `no-unused-vars`. `ProjectShell.test.tsx` now carries the
  "real wiring" test its `sprints`/`statuses` siblings already had. Two reviewers found this
  independently.
- **No `.upsert()` existed in any test**, so the eight-column UPDATE grant — the entire subject of
  the story's §3 — was unverified. Every live write was a plain `.insert()`, which needs only
  INSERT privilege and never builds a SET list. Now one two-write case per value column.
- **`applyValueWrite`/`fieldValueText` had no direct tests**, resting on one component test that
  began from an empty list. Five survivors there, including `fieldValueText` erasing a stored zero
  — the exact defect its own docblock names, with no fixture holding a zero.

**Three of my own claims were wrong and are corrected in place.** The important one:
[[rls-with-check-precedes-fk-validation]] — RLS here reads `project_id` **and nothing else**, so
`ticket_id`, `field_id` and `field_type` are fk-governed *including across tenants*. My first
correction over-generalised one CI failure into "a cross-tenant row cannot isolate a foreign key",
which a reviewer refuted with a passing test twenty lines away in my own file. **That matters for
SPRIN-75**: the wrong version is exactly what licenses narrowing those composite fks to single
columns during the membership rewrite. Also wrong: the migration's "WITH CHECK is load-bearing"
note (Postgres falls back to USING, so deleting it is not observable), and my use of
`npx tsc --noEmit -p tsconfig.json`, which checks **zero files** and exits 0 — the branch was
type-clean via `npm run build` and CI, not via that check. Use `npm run typecheck`.

`ticket_field_values` is now in `docs/sprintboard_phase1_schema.sql`, which it was missing from;
`domain.test.ts`'s schema parser caught it the moment it was added without its policies.

### Session 57 — SPRIN-88 started, migration applied, no PR yet (branch `sprin-88-ticket-field-values`)

**Ended early because David's terminal needed a restart — not a blocker, and nothing is lost.
The one fact to carry: the database is AHEAD of `main`.** `ticket_field_values` is **live**,
applied 2026-08-07, while the branch carrying its spec and migration is pushed but **unmerged**.
Verified from the catalogue rather than the editor's success message: RLS on, force off, four
`tfv_owner_*` policies all using `(select auth.uid())`, table grants `authenticated=rdDxtm` and
`anon=rDxtm` (neither carrying `a` or `w` at table level), and exactly eight column rows at
`authenticated=aw`. **Do not re-apply it.** If the branch is ever abandoned the table must be
dropped by hand — nothing else will do it.

**No application code exists yet.** Spec and migration only, two commits. `database.types.ts` has
**not** been regenerated, so nothing can compile against the new table until it is — that is the
first task on resuming, before any implementation.

**The migration departs from the epic design's §3.4 deliberately.** PostgREST compiles
`.upsert(row)` to `INSERT … ON CONFLICT DO UPDATE SET c = excluded.c` for *every* column in the
payload, and Postgres requires UPDATE privilege on every column in a SET list. The payload must
carry `ticket_id, project_id, field_id, field_type` because the INSERT needs them — so the narrow
column grant the epic design implied would let the **first** write to a field succeed and every
later one fail with `42501`. UPDATE is therefore granted on all eight columns and the control
moved to the constraints: `tfv_type_fk` refuses any `field_type` that is not the definition's
own, the composite fks carry `project_id` so a row cannot be re-pointed at another project's
ticket or field, and `tfv_owner_update`'s `WITH CHECK` re-tests ownership on the post-image.
**Three live tests are owed for that argument and are not yet written** — a mismatched
`field_type` earning `23503`, a cross-project `field_id` earning `23503`, and a wrong-column-for-
the-type earning `23514`, each asserting the constraint *name* because three constraints here can
all produce `23503`.

**One open decision, asked and not answered: the fk indexes.** Applying the migration added four
INFO lints — `unindexed_foreign_keys` on all three tfv foreign keys plus `unused_index` on the
index it shipped, which covers none of them. The index rule was derived wrongly (from
`pg_constraint` without ever reading `pg_indexes`), corrected in a follow-up commit, and is now
right in both the spec and the migration: **an fk's columns must be a prefix of some index's
columns**, and `tickets_epic_fk` being flagged despite `tickets_epic_idx (parent_epic_id)`
existing settles it. The finding underneath is that **there is no zero-lint answer** — a new
table has either unindexed foreign keys or unused indexes; `project_fields` reached zero only
because its slug index happens to both cover its fk and be used. Three options with trade-offs
are in the spec's §8; the lean was option 1 (cover all three). Nothing about correctness or
tenancy depends on it and it is a follow-up `create index` either way.

Validation that did work and is worth repeating: the CHECK constraint was exercised as a `SELECT`
over a twelve-row truth table before the SQL left the session (all five type arms, `else false`,
and both the two-columns and no-columns edges), and every statement type was parse-checked by
running it under the read-only MCP and reading the SQLSTATE — **25006, never 42601**.

### Session 56 — SPRIN-91, add and rename a custom field (PR #93, `106af27`)

Settings gained an add form and inline rename, and the story paid the two debts SPRIN-90 recorded
against it. **Migration B applied live**; `get_advisors` unchanged, zero lints on `project_fields`.
66 → 68 test files, 1080 → 1148 tests.

**INSERT is granted on FOUR COLUMNS, not the table** — `project_id, slug, name, type`.
`created_at` is withheld because it is the SORT KEY: `(created_at, slug)` *is* the field order,
with no `position` column standing behind it, so a writable `created_at` is a writable sort order.
`id` is withheld because nothing in the app has reason to choose a primary key. Both are defaults,
so it costs the client nothing. **Column-level INSERT works with no table-level INSERT** — the
migration flagged that as its one unread-back claim, and CI has now executed it.

**The AC5 debt, and why story 1 was right to defer it.** With INSERT revoked, a cross-tenant
insert died on the missing GRANT before `fields_owner_insert` was consulted, and both controls
raise 42501. The proof needs the grant. It now asserts the **message** (`row-level security
policy`, explicitly NOT `permission denied`) plus a positive control on the same client. The
security review traced the deletion case: with the policy dropped, the cross-tenant half stays
green because Postgres emits the same message when no policy exists — **the positive control is
what goes red.**

**There is no `duplicate` write tag**, and this is the one place copying `StatusSettings`
wholesale would be wrong. `project_fields` has no name-uniqueness constraint, deliberately,
because AC2 requires two same-named fields to both succeed. A 23505 on the slug index is
`'stale'`.

**Three review rounds, and the yield moved later each time.** Round 1 (mutation, 76 planted / 63
killed) found two Important seam gaps. Round 2 (security) found no exploitable surface, verified
against the live catalog. **Round 3 — re-reviewing the FIX WAVE — produced the sharpest finding of
the run:** the "exhaustive" UPDATE-refusal walk said "all four of the others" and walked four.
There are **five**, and the omitted one was `project_id` — the tenancy column, where the grant is
the only thing preventing a field being moved between two projects the same user owns. Now a
table, so a sixth column is one row.

**A review claim did not survive checking.** Round 3 reported a 10 ms-delayed write resolution
turned two tests red. It does not reproduce — with the delay *and* the barrier deleted they still
pass, because `userEvent`'s own awaits already yield to the macrotask queue. The barrier was kept
(it is the correct thing to assert on) and the comment says so rather than claiming a fix it did
not make.

### Session 55 — SPRIN-71 designed, and SPRIN-90 shipped (PRs #90 `cb65b8a`, #91 `b6a19ca`)

Two things landed: the epic-level design for custom fields, and its first story — the
`project_fields` table, its RLS and grants, and a read-only Settings list. **Migration A applied
live**, `get_advisors` unchanged at zero new lints. 65 → 66 test files, 1052 → 1080 tests.

**A new table is BORN writable by `anon`, and the migration was rewritten around that.** The
instinct — "a new table starts with no privileges" — is false here. Measured from
`pg_default_acl` (not `information_schema`, whose grant views return zero rows under the
read-only MCP role and read exactly like "no privileges"):

```
public, tables: anon=arwdDxtm/postgres, authenticated=arwdDxtm/postgres
```

`ALTER DEFAULT PRIVILEGES` hands **both** app roles full CRUD the moment `create table` runs, so
the revoke is the statement that changes something. The existing tables show this was narrowed
inconsistently: `project_statuses` and `projects` had UPDATE revoked, `tickets` still carries
`arwdDxtm` for `anon`. `project_fields` ends up the **most restrictive table in the schema**.

**`UPDATE(name)` is granted for one reason: AC4 needs a positive control.** Story 1 has no write
path, so the strict reading is "revoke everything". But then the `slug`/`type` refusal test has no
permitted column to contrast against, and a blanket row-level refusal is indistinguishable from a
working column privilege — the gap already recorded below against the `is_initial` test.

**AC5 lost its insert half, deliberately.** With INSERT revoked, a cross-tenant insert dies on the
missing grant before `fields_owner_insert` is consulted — and a revoked grant and an RLS
`WITH CHECK` violation both raise `42501`. With nobody holding INSERT there is no positive control
to separate them, so the test would have passed with the policy deleted. **SPRIN-91 owes it**,
along with the `grant insert` itself (restating every column, per the REVOKE-cascade rule).

**The review found two Important defects, both mine, neither reachable by reading.** One reviewer,
43 mutations:

- **The shell → context seam for the new read was entirely unpinned.** Four type-valid, lint-clean,
  typecheck-clean mutations survived, including `fieldsPhase = statusesPhase` — which is the exact
  defect the story existed to prevent, because `SettingsTab` gates on statuses, so a failed fields
  read would have rendered "No custom fields yet." The commit message's claim that
  `SettingsTab.test.tsx` "covers the seam" was half true: it covers tab → component, not shell →
  tab, where the read lives. Fixed with a `FieldContextProbe` that renders **both** phases, since
  with both reads resolving the substitution is invisible.
- **The unit suite was issuing ~90 live HTTP requests per run.** `ProjectShell.test.tsx` never
  mocked `@/lib/project-fields`, so the real read ran in every test — 63 entries, 90 outbound
  PostgREST calls, measured by instrumentation. Invisible because `useTaggedRead` catches the
  rejection. Locally it died at DNS; **in CI that is the real project**, which is the self-inflicted
  traffic this file already blames for the moving 5s-timeout flake.

**The technique worth stealing: a SEAM CONTROL.** Four survivors is ambiguous — untested code, or a
harness that cannot see the class. The reviewer applied the identical mutations to `sprints` and
they killed 41 and 13 tests. That table is what made the finding unarguable rather than a shrug.

**Three comments described the wrong mechanism.** "With no read policy, RLS filters anon to zero
rows" is wrong: every policy here is written without a `TO` clause, so all four apply to `public`,
which **includes `anon`** (verified against `pg_policies`). Anon reads nothing because `auth.uid()`
is NULL. Same outcome, different reason — and the wrong one would let someone add a public-sharing
SELECT policy believing anon was excluded structurally.

**A docblock cited a test file that does not exist** (`CustomFieldSettings.test.tsx`). Same class as
SPRIN-86's, and it is precisely what made the missing shell seam read as covered.

**Local `verify` could not run the live half at all**, and it is worth knowing the shape: this
environment's `VITE_SUPABASE_URL` is the placeholder `example.supabase.co`, so all seven integration
files failed on `ENOTFOUND` — seven red files that look exactly like a broken diff. Absent config
skips loudly; **placeholder config fails hard.** `npm run keepalive` names the host it tried, which
is how to classify it in one command. CI holds the real secrets and is the authority.

### Session 54 — SPRIN-86, the board flags an over-limit column (PR #88, `144fdd2`)

The last story of epic **SPRIN-73**, which is now Done. A Kanban column whose status carries a
`wip_limit` shows `· limit 3`, or `· over limit 3` when over, appended to the existing summary
line. No migration. 64 → 65 test files, 1035 → 1052 tests.

**The Jira issue's complexity figure was stale and the story was designed around re-measuring
it.** It said `BoardTab` sat at 10/10 cyclomatic after SPRIN-83; it measures **7**, because
SPRIN-76's `firstUnready` refactor and SPRIN-83's two extractions bought four branches back. The
rendering still went into `BoardColumnSummary` as a prop — not from necessity, but because that is
what the component is for.

**Two new selectors, both in `board.ts`.** `selectColumnLimit(project, status, filtered)` holds
the entire "should this column show a limit" rule behind two gates: `hasWipLimits(project)`, and
whether a board filter is active. `isBoardFiltered(blockedOnly, query)` is the `||` that used to
live inside `BoardColumnEmpty`, named once now that two components need the same answer.

**A filtered board makes no WIP claim at all.** The summary renders the already-filtered column,
so under *Blocked only* or a search its count is not the column's real occupancy — five cards
against a limit of three read as "1 card". Judging against the visible count was rejected because
a filtered count is always ≤ the real one, so an over-limit column would quietly stop warning with
nothing saying the number was partial. Suppressing the segment keeps the existing invariant whole:
nothing on that line ever disagrees with the cards below it. The accepted cost is that the warning
disappears while filtering.

**The `hasWipLimits` gate is load-bearing, not decoration.** SPRIN-85 §3.4 recorded that a CHECK
body may not contain a subquery, so the database will store a `wip_limit` on a **Scrum** project's
status row. That value was inert only because nothing read it — this story is the first reader. So
AC5's test uses a Scrum project whose rows carry *real* limits.

**One reviewer, briefed to mutate rather than read, planted 44 mutations; 6 survived.** Every
AC-level mutation was killed, including three independent shapes of the hard block AC3 exists to
forbid. Four survivors were closed and each re-proven: the ` · ` separator was unpinned (dropping
it rendered `1 unestimatedover limit 2` with the suite green); `aria-hidden` and `hidden` on the
summary span both survived, since `getByText` + `toBeInTheDocument` sees neither; `toHaveClass` is
a **subset** check, so rendering `text-destructive text-muted-foreground` together passed both
colour assertions; and a substring regex let the boundary fixture change from 3 to 30, silently
ending the boundary test. One exact-string assertion per line closed three of the four.

**The mutation matrix found a vacuous test of my own, twice over.** AC5's board test asserted that
no limit appears on a Scrum board — but that board had no active sprint, so it rendered no cards,
every column was empty, and `BoardColumnSummary` returns `null` at `count === 0` before it ever
consults a limit. It passed with the gate deleted. Fixed by giving the board a running sprint plus
a positive control asserting the cards are on screen. Separately, a docblock I wrote claimed a
missing `wip_limit` "reddens loudly"; **it does not** — the review narrowed `listProjectStatuses`'s
`.select()` and deleted the fixture's `wip_limit` line, and the suite stayed green both times
while the board rendered `· limit undefined`. The comment now says what is true and points at the
follow-up recorded above.

**`project-type-single-expression.test.ts` reads prose as code.** Its read scan is a raw text
regex, so a docblock explaining SPRIN-85's CHECK gap failed `verify` merely for containing the
literal `projects.project_type`. That false positive is worth paying — teaching the scan to strip
comments means parsing, and the guard's whole design is "no parser, one chokepoint, no allowlist".
Reword the prose.

### Session 53 — SPRIN-85, a WIP limit per status (PR #86, `7224a5b`)

`project_statuses.wip_limit int`, null meaning no limit, editable only on a Kanban project's
Settings tab. 63 → 64 test files, 988 → 1035 tests.

**The migration's correctness rests on one measured fact: a table-level REVOKE CASCADES to
column grants** (PostgreSQL REVOKE reference, quoted in the file). So

```sql
revoke update on project_statuses from authenticated, anon;
grant  update (wip_limit) on project_statuses to authenticated;   -- WRONG
```

would have left `authenticated` able to write `wip_limit` **and nothing else** — every rename,
recategorise and reorder failing `42501`, with nothing in the diff looking like the cause. The
grant restates all four columns, in one transaction. Verified live against `pg_class.relacl` and
`pg_attribute.attacl` — **not** `information_schema`, whose grant views return zero rows under
the read-only MCP role and read exactly like "this table has no privileges".

**AC5 got no new test, deliberately.** Two live tests asserting `42501` on `slug` and
`is_initial` already existed and predate the story, which makes them better evidence than tests
written by someone who knew the answer. Duplicating them would put two controls on one refusal,
after which the suite could no longer say which is holding.

**An unplanned fix rode along, with David's agreement.** Regenerating `database.types.ts`
revealed it had been **stale since SPRIN-80**, which dropped `tickets.status`'s column default —
a NOT NULL column with no default generates as required-on-insert, so a truthful regeneration
turned the build red at 26 sites. The generated type cannot model a trigger, and
`resolve_initial_ticket_status()` fills `status` only when it is null, so the real contract is
*optional*. `TicketInsert` gained `status?` and one `ticketInsertPayload()` bridge now carries
the single cast. **No insert gained or lost a column** — proven by diffing `^[+-]\s*status:`
to empty on both sides, because adding `status: 'todo'` to a fixture would have made the
trigger's own tests vacuous.

**A 30-agent adversarial pass planted 61 mutations.** Two lenses returned zero findings after
nine mutations each. Six findings confirmed, one killed, all six fixed and each fix
mutation-proven. The most valuable came from the **completeness critic** and all eight lenses
missed it: **no live test proved a stranger could not directly UPDATE another tenant's status
row.** The grant is to the *role* `authenticated`, so every signed-up user holds the same
column-UPDATE privilege as the owner; only `statuses_owner_update` narrows it — and client `b`
did SELECT, DELETE and the reorder RPC against that table but never a direct `.update()`. Now
covered, asserting the **row count** (RLS filters rather than raises) and paired with an
owner-side positive control on the same row.

The migration's own post-state block had a matching blind spot: it read table-wide ACLs for
`anon` but filtered *column* ACLs to `authenticated` alone, so `... to authenticated, anon`
would have printed `ok` and committed. One verifier proved that by running the mutated DDL in
**PGlite**, a real WASM Postgres, rather than reasoning. Live state was measured and correct.

**Every finding across all reviews was in test coverage, never production code.** Three were
traceable to imprecise review briefs: "anchored regex" that permitted a regex with no `$`; a
mutation instruction that deleted the guard it was testing; and a warning aimed at
`className="hidden"` when the survivor was `aria-hidden` (`queryByRole` excludes `aria-hidden`
subtrees, so an absence test reports "absent" for a field still in the DOM and keyboard-
reachable — and that is true in a real browser too, not a jsdom artefact).

### Session 52 — SPRIN-87, pin the status delete path (PR #84, `f2d4c38`)

Tests only: `StatusSettings.test.tsx` plus its spec, zero production files. 27 tests → 41. The
Critical it was filed for was real — `deleteProjectStatus(status.id)` could be given a literal id
with the whole suite green, because `onDeleted(status.id)` was asserted and the write's own
argument never was.

**Four adversarial rounds ran and NOT ONE found a defect in production code.** Every finding was in
this story's own tests or in my claims about them. Three rounds running it was the same shape: *a
standard articulated in one commit, applied to only one of two sibling sites.* Round 1 anchored
two copy assertions and left three; round 2 added an `aria-hidden` guard to two sites and left two;
round 2's own new title assertion **was** the unanchored substring it abolished three lines away.
41 mutations, 40 killed. Details in `docs/superpowers/specs/2026-08-04-sprin-87-…-design.md`.

Three fixture **confounds** were broken, each found only after the previous one was fixed: `slug`
was the lowercased `name`; the initial status was also `statuses[0]`; `position` was `index + 1`.
Each one let two different production reads be re-keyed to the other with the suite green. The
fixture docblock now says the list is **open**, deliberately.

Two methodology scars worth more than the story:

- **A mutation harness needs a POSITIVE control, not just a null one.** The first one here passed
  `--reporter=basic`, which does not exist in Vitest 4, so every run crashed before executing a
  test and reported all 12 kills as *survivors*. A null mutation cannot catch that — zero failures
  is its expected result. Read the runner's own `Tests N passed` line and always include a mutation
  a pre-existing test must kill.
- **"The code is correct, only the coverage is missing" is not a reason to defer.** It is true of
  every unpinned line. It kept the singular `1 ticket` label out of two rounds while its
  zero-count sibling carried the identical justification.

### Session 51 — SPRIN-84, split `StatusSettings.tsx` (PR #82, `4a834e4`)

Pure code motion, no behaviour change. The file sat at exactly 400/400 counted lines, so story 85
could not add a line. The row cluster (`StatusRow`, its delete control, the confirm dialog,
`DELETE_FAILURE_COPY`, `DeleteStatusError`) moved to `src/routes/StatusRow.tsx`: **400 → 177** and
**227**, both against 400.

The cut went at the **row**, not the add form, because story 85 adds a WIP input *per status* —
the two candidate regions were near-identical in weight (204 vs 196 counted lines, measured by
piping each through `eslint --stdin`; they sum to 400, which is the check that they are exhaustive
and disjoint). Headroom in the wrong file is not headroom. `DUPLICATE_NAME` moved to
`src/lib/status-schemas.ts` because its two consumers ended up in two files and leaving it in the
parent would have been an import cycle.

AC2 was **"no test file is edited"** — the unedited suite passing *is* the evidence of no
behaviour change. That held, and the move was proved mechanically rather than by eye: the moved
cluster diffs to exactly one changed line (the added `export`), the retained half to zero.

**It also produced SPRIN-87** (below): an adversarial review planted 73 mutations, 59 killed, and
**all 14 survivors were pre-existing** gaps in the code the diff moved byte-for-byte. The headline
one is Critical and was deliberately *not* fixed here, because its fix is an assertion in the very
test file AC2 forbade touching.

### Session 50 — SPRIN-83, the Kanban board shows every ticket (PR #80)

`selectBoardScope(project, tickets, sprints)` returns one answer covering three decisions — the
caption and *both* filters had all hung off a single `activeSprint !== null` test, so removing the
caption would have silently removed the filters too. `ticketListLabels(project)` is a **function,
not a `Record`**, because indexing a map counts as a `.project_type` read and the AST guard permits
exactly one in the tree.

Review found a real defect: the board ignored `sprint_id` on a project without sprints while
`BacklogTab` still filtered on it, so the board would have shown a ticket the list hid — under a
link reading "All tickets". Fixed with a sibling `selectTicketList`.

### Session 49 — SPRIN-82, a Kanban project has no sprints (PR #78)

`hasSprints(project)` is the single expression of the rule; the nav link, the `/sprints` redirect
and the sprint picker all read it. **Migration applied live:** `revoke update on projects from
authenticated, anon`, making `project_type` immutable in the database rather than only in our code.

### Sessions 48 and earlier

Git history and `docs/superpowers/specs/` are the record. Decisions from that period that are
**still live**: project type is immutable (there is no conversion UI, by choice), and WIP limits
are **soft** (they warn, they do not block).

---

## Open follow-ups

Engineering items with no story yet. Each is a candidate for one.

- **Every table grants TRUNCATE (`D`) to both `anon` and `authenticated`, and RLS does not apply
  to TRUNCATE.** Measured on all six tables 2026-08-05. Not currently reachable — PostgREST maps
  no HTTP verb to it and no `public` function truncates (all 11 checked) — so this is
  defence-in-depth, not a live hole. It stops being theoretical the day someone adds an RPC.
  Uniform across the schema, so it wants **one deliberate sweep**, not a piecemeal revoke on
  whichever table is being touched. Belongs with SPRIN-75.
- **`tickets` still carries full `arwdDxtm` for `anon`** — an anonymous caller holds UPDATE and
  DELETE on it, with only RLS in front. `project_statuses` and `projects` were narrowed;
  `tickets` never was, and `project_fields` (SPRIN-90/91) is now the most restrictive table in the
  schema. The inconsistency is the finding, not any single table. Same sweep as above.
- **The anon sweep is BIGGER than "just `tickets`" — measured 2026-08-06 in SPRIN-91's security
  review.** `project_statuses` grants `anon` **INSERT** (`anon=arDxtm`) and `projects` grants
  `anon` **INSERT and DELETE** (`anon=ardDxtm`). Both were "narrowed" by earlier migrations, and
  both kept privileges nobody intended. RLS refuses all of it, but that is one control where
  migration A's own argument asks for two. Scope the SPRIN-75 sweep from `pg_class.relacl` across
  all six tables rather than from what previous handovers happened to notice.
- **`renameProjectField` filters on `id` alone** and leans wholly on `fields_owner_update`'s USING
  clause — a fresh instance of the SPRIN-64 class (an app-layer path resting on a policy's
  breadth). Correct today. Under a membership model where read is broader than write, a
  viewer-role rename would not be caught here and the owner-vs-stranger isolation cases would not
  flag it. Explicitly on SPRIN-75's re-audit list.
- **`toProjectField` throws out of `createProjectField`/`renameProjectField`**, which otherwise
  return a tagged result — so an unrecognised field type is a rejected promise, not
  `{ ok: false }`. **Measured unreachable**: `listProjectFields` throws first, so a field with an
  unknown type never renders a rename control. But if it ever fired, RHF re-throws in its
  `finally` and the add form shows **zero alerts and silently does nothing**, while the rename
  path discards it through `void`. Worth a tagged-error path if a sixth type is ever added.
- **`listProjectStatuses` still uses a bare `.select()`**, unlike `listProjectFields`, which names
  its columns and has a test asserting the exact string. The class is recorded below; SPRIN-90
  shows what closing it looks like, so the remaining work is mechanical.
- **Is a deadlock reachable** between the SPRIN-80 delete guard's `FOR UPDATE` on `projects` and
  the `projects → project_statuses` RI cascade? The migration records this **unresolved**. If
  reachable it is rare, non-corrupting and retryable (`40P01`). The lock's mutual exclusion is
  **untested** — a single transaction has no second session to contend with. Deserves its own story.
- **Four untested guards in the option-delete confirm dialog** (`CustomFieldOptions.tsx`), left
  deliberately by session 62 as the review's own "Deferrable" tier: the count reset on close
  (`:248`), the `if (deleting) return` that ignores Escape mid-delete (`:243`), the `setError(null)`
  ordering (`:364`), and the confirm staying disabled while the count is in flight (`:280`). Each
  is a correct guard with no test that fails without it. The first two need a close-and-reopen
  driven through the real dialog, which is why they were not free.
- **`lg:grid-cols-4` in `BoardTab` is a fixed column count** under a status list users can now
  grow — a fifth status wraps. Deferred three times; needs a layout story.
- **Nothing pins `listProjectStatuses`'s no-arg `.select()`, and SPRIN-86 gave that a
  user-visible consequence.** `project-statuses.ts` selects every column and casts the rows
  unchecked; SPRIN-86 is the first reader of `wip_limit`, and its strict `limit === null` check
  renders the literal `· limit undefined` on every Kanban column if the field ever stops
  arriving. **Measured in review:** narrowing that `.select()` to an explicit column list, and
  separately deleting the `wip_limit` line from `BoardTab.test.tsx`'s fixture, each left the
  whole suite green while the board rendered `undefined`. `project-statuses.test.ts`'s mock is
  `vi.fn(() => ({ eq }))` — argument-agnostic, so it cannot see the narrowing. A story should
  either pin the select's argument list or make a `wip_limit`-less fixture go red. Note this is
  a **class**, not one column: every future first-reader of a column inherits it.
- **`TicketCustomFields`'s render order is unpinned** (SPRIN-88's detail sidebar). Reversing its
  `fields.map` leaves the whole suite green, so the `(created_at, slug)` order `listProjectFields`
  establishes is preserved by nothing. SPRIN-89 closed the identical gap on its own
  `CreateTicketCustomFields` and deliberately left the sibling alone — same class, one test.
- **`parseFieldValues`'s traversal direction is unpinned.** Iterating the raw record's keys instead
  of the definitions list survives the suite. Observable only as the **order** fields are named in
  AC4's failure message; the definitions order is the on-screen order and is the correct one.
- **Lint budget, re-measure rather than recall.** `TicketDetailDialog` and `ProjectShell` are both
  at cyclomatic **10/10**, so one added branch reddens the gate; `TicketDetailSidebar` is at 9/10
  and is being kept there for SPRIN-71. `BoardTab` is at 7/10. A **default parameter costs a
  cyclomatic point** — measure with `npx eslint <file> --rule '{"complexity":["error",1]}'`, which
  prints every function's real number (the linter otherwise reports complexity only on violation,
  so it is invisible until it breaks).
- **Pre-existing mutation survivor** (`8273ee3`): `BoardTab`'s rollback merges onto `latest` rather
  than `ticket`, invisible to every test, while its docblock claims concurrent-edit preservation.
  **Note the SPRIN-87 lesson before deferring this again:** "the code is correct, only the coverage
  is missing" is true of every unpinned line and is not by itself a reason to leave it.
- **`createProjectStatus`'s `max(position)+1`** is derived from a list nothing refetches. The
  *failure* is honest (`'stale'`), the staleness is not. Note `is_initial` **is** writable on
  INSERT, guarded by a partial index.
- **A lint rule forbidding `toHaveTextContent` with a bare string**, requiring an anchored regex.
  This is the real remedy for the class SPRIN-87 hit in three consecutive review rounds: a bare
  string is a **substring** match, so any *additive* reword of user-facing copy survives. Vigilance
  demonstrably does not close it — four rounds of sweeping "all" sites each missed the next one.
  Wants an ADR alongside it. The nearest existing precedent is the `project_type` AST scan in
  `src/test/project-type-single-expression.test.ts`.
- **`renameProjectStatus`'s zero-row protection is only INCIDENTAL.** `.single()` errors on 0 rows
  → `writeError` → `'unknown'` → generic copy, where `deleteProjectStatus` and
  `reorderProjectStatuses` both check the row count explicitly and comment on why. Fail-closed
  today, by a less deliberate mechanism than its two siblings. Found by the SPRIN-87 security
  review; worth settling before SPRIN-75 rewrites these policies.
- **`StatusSettings`'s `error` state is not keyed on `projectId`**, so a reorder failure would
  survive the shell swapping the `statuses` prop to another project. The copy is the generic retry
  string with no data in it, so this is a staleness bug rather than a leak.
- **A disabled Delete button has no `aria-describedby`** to the sentence explaining why it is
  disabled. SPRIN-87's tests now refuse an `aria-hidden` reason, but the *relationship* is a
  production change. `fieldMessage` in the test file already exists for asserting exactly this.
- **A successful delete never calls `setConfirming(false)`** — the dialog closes only because the
  parent removes the row and unmounts it. Real today, latent if the shell ever refetches instead
  of splicing.
- **`EditableText`'s own `draft !== value` guard is unpinned and unpinnable from
  `StatusSettings.test.tsx`** — the row's trim guard shadows it on every path that file exercises.
  It needs a component-level `EditableText` test.
- **`e2e.yml` shares the global `verify` concurrency group, and the two can cancel EACH OTHER on a
  single push.** Seen twice in session 52 (PRs #84 and #85): `verify` for a PR head came back
  `cancelled` within a second of `e2e` starting on the same commit. **It is a race, not
  deterministic** — the same session's pushes at `23afd16` and `d700ccf` both had `verify` and `e2e`
  succeed side by side. The sharing is deliberate (it keeps both off the shared database), but the
  consequence is that **a required check can land as `cancelled`, which is not a failure and must
  not be read as one.** Re-run it and confirm the rerun's `headSha` matches the PR head. Worth
  deciding whether the group should be keyed per-workflow-per-SHA, which would keep the
  database-serialising intent while removing the self-cancellation.
- **Leaked Password Protection is CONFIRMED DISABLED** (measured via `get_advisors`, 2026-08-05 —
  it was previously recorded here as "never confirmed"). So the hardcoded signup password in
  `e2e/happy-path.spec.ts` is not currently a risk; that risk was conditional on the feature
  being *on*. Enabling it is still the recommendation, and doing so means randomising that
  password in the same change.
- **Supabase advisors are NOT at zero lints.** `CLAUDE.md` used to imply they were; **corrected
  2026-08-08**, which also moved the baseline into `CLAUDE.md` so a story planning a migration
  reads it without coming here. Re-measured **2026-08-08**: 1 security WARN (the leaked-password
  one above) and **14** performance lints — **6** `unindexed_foreign_keys` INFOs and **eight
  `auth_rls_initplan` warnings** where a policy calls bare `auth.uid()` instead of
  `(select auth.uid())`, re-evaluating it per row. All pre-existing; none introduced by SPRIN-85.
  The `auth_rls_initplan` fix is mechanical but touches five tables' policies, so it belongs with
  **SPRIN-75**, not bolted onto a feature story.
  **This entry was itself stale, which is the point of [[a-written-record-decays]].** It read
  "11 performance lints — three unindexed foreign keys on `tickets`" from 2026-08-05. SPRIN-88
  then added `ticket_field_values` and its three accepted INFOs, taking the fk count to 6 and the
  total to 14, and nothing brought this line with it. Re-derive from `get_advisors`; do not quote
  this paragraph as current.
  Two details make the remaining work smaller than it looks. The three `ticket_field_values`
  INFOs are **closed by David's decision** (keep `(field_id)`, accept them) and are not part of
  any sweep. And the `(select …)` form now has **three** precedents in this schema, not one:
  `statuses_owner_delete`, plus every policy on `project_fields` and `ticket_field_values`, which
  SPRIN-90 and SPRIN-88 wrote correctly — so none of those three tables is flagged.
- **`StatusWipLimitField` has no `aria-describedby`/`aria-invalid`** linking its error to its
  input, so a screen-reader user who is not focused when the live region fires gets no
  indication the field is invalid. Confirmed by probe. **The same gap exists on the pre-existing
  disabled-Delete control** (already listed below), which is why it was not fixed inline: one
  a11y story should close both rather than each riding along with an unrelated feature.
- **The `is_initial` refusal test has no same-row positive control**, unlike its `slug` sibling
  directly above it (`rls.integration.test.ts`). No update ever succeeds against that `todo` row
  anywhere in the block, so a blanket row-level refusal would be indistinguishable from a working
  column privilege. Pre-existing; SPRIN-85 closed the equivalent gap for `category` but not this.
- **AC4's CHECK tests assert the SQLSTATE but not the constraint NAME**, which is lower precision
  than this file's own convention elsewhere (the duplicate-name and slug-format tests both pin
  the name, because `message` is the only channel PostgREST exposes for constraint identity).
  Dropping the check still reddens them, so they are not vacuous — just less specific.

## Owed to SPRIN-75, added by SPRIN-92 (session 61)

- **`project_field_options` is born with TRUNCATE granted to BOTH roles**, and TRUNCATE bypasses RLS.
  Not reachable through PostgREST, so defence-in-depth rather than a live hole — but
  `revoke truncate on project_field_options from authenticated, anon;` is one line and would keep the
  new table out of the sweep. Same note SPRIN-88 recorded for `ticket_field_values`.
- **The `options_owner_*` policies read `project_id` and nothing else**, so `field_id` and `slug` are
  fk-governed *including across tenants*. Re-audit before narrowing those composite fks during the
  membership rewrite — that narrowing is exactly what the **wrong** version of the SPRIN-88 finding
  would license.
- **`deleteProjectFieldOption` filters on `(field_id, slug)` and leans on the policy's USING clause** —
  a fresh instance of the SPRIN-64 class. Correct today; under a membership model where read is
  broader than write, a viewer-role delete would not be caught here.
- ~~**`renameProjectFieldOption` relies on `.single()`'s INCIDENTAL zero-row error**~~ — **FIXED in
  session 62.** It now reads the returned row and reports `'stale'` when there is none, matching
  `deleteProjectFieldOption` ten lines below it. **`renameProjectStatus` still has the defect**, so
  the class is down to one recorded instance rather than gone; settle that one before SPRIN-75
  rewrites these policies.

## Owed to SPRIN-75, found by the SPRIN-88 security review (session 58)

Both are LOW and neither is reachable today. Recorded here because they become reachable under a
membership model, and because the reasoning is easier to reconstruct now than later.

- **`TRUNCATE` survives the revoke on `ticket_field_values`.** Live `relacl` is `anon=rDxtm`,
  `authenticated=rdDxtm` — the `D` is TRUNCATE, held by BOTH roles, and TRUNCATE bypasses RLS
  entirely. Not reachable through PostgREST (no verb, no RPC), so there is no live exploit, and
  the migration deliberately defers privilege sweeps to SPRIN-75. But `revoke truncate on
  ticket_field_values from authenticated, anon;` is one line and would have kept the new table out
  of that sweep. Worth checking whether the older tables share it.
- **A cross-tenant existence oracle via PK-vs-fk error discrimination.** Insert ordering is RLS
  WITH CHECK → CHECK → unique index → fk AFTER-triggers. So B, naming their OWN `project_id` with
  A's `ticket_id` and `field_id`, gets `23505` if A has a row for that pair and `23503` if not —
  learning whether tenant A has set a particular field on a particular ticket. Needs two of A's
  uuids, which are never disclosed cross-tenant today. **It becomes reachable for a REMOVED MEMBER
  who retains uuids from a project they no longer belong to**, which is a case SPRIN-75's isolation
  suite is already required to cover. The fix, if wanted, is a partial unique index scoped by
  project; it may not be worth it.

## Owed to SPRIN-75, found by the SPRIN-105 migration

**Co-membership is currently grantable UNILATERALLY, and SPRIN-105 is what turns that from a
nuisance into a disclosure.** `members_admin_insert`'s `WITH CHECK` constrains only `project_id`,
not `user_id`, and `seed_project_admin` (SPRIN-98) makes every project creator an admin of their
own project on creation — so any authenticated user can create a project, then `INSERT` an
arbitrary `user_id` into `project_members` for it, with no consent and no notification from that
person. Before SPRIN-105 that insert was mostly harmless: it granted board access to a stranger,
which is odd but not a disclosure. **After SPRIN-105 it also makes that stranger's `display_name`
and `email` readable by every other member of the project**, because profile visibility is now
co-membership.

It is not reachable today only because nothing in the app currently discloses another user's uuid
— verified across every column that could serve as one: `profiles.id`, `tickets.assignee_id`,
`projects.owner_id` and `project_members.user_id` are all self- or co-member-scoped, so there is
no search-by-uuid and no listing of every `auth.users.id` an attacker could reach for.
**SPRIN-102's "add member by email" is exactly that oracle, turned around** — it converts "the
attacker already knows a uuid" into "the attacker only needs to know an email address", which
anyone might. The gap itself is **inherited from SPRIN-98** (the unconstrained `WITH CHECK` and
the self-seeding admin both predate SPRIN-105); SPRIN-105 is what gives it a payload worth
exploiting. **SPRIN-102 owns the consent decision** — whether adding a member should require that
member to accept, and if not, what narrows the blast radius instead. The full argument is written
into `docs/migrations/sprin-105-profiles-email-and-co-member-reads.sql`'s header; do not re-derive
it from scratch.

## A whole-table invariant races parallel test files (SPRIN-105)

`rls.integration.test.ts` asserted, at two points, that A and B EACH see **exactly one** profile
row — an unscoped `select` over `profiles`, counting the result. Once SPRIN-105 widened
`profiles`'s read policy to co-membership, both assertions went red: `project-members.integration
.test.ts`'s own `beforeAll` fixture adds B to one of A's projects as a co-member, and **Vitest runs
test FILES in parallel against one shared live database** — so by the time `rls.integration.test.ts`
ran its count, the sibling suite's fixture was already live and A's real visible set was no longer
one row. **This is the policy working correctly, not flakiness — do not chase it as a bug.**

Both assertions are now scoped to their own subject's row before counting, rather than an unscoped
table select. The property that actually needed testing — "did the read policy widen further than
co-membership?" — moved to `profiles.integration.test.ts`'s **`shows a member exactly themselves
and their co-members`**, which is race-free because it creates its own throwaway users that no
other suite file touches.

**The general rule, because SPRIN-99/100/101 will hit this again on other tables:** under a
membership model, an unscoped `select` (or an unscoped row count) over any table another suite's
fixtures can write into is a **whole-table invariant**, and its answer depends on what sibling
suites are doing concurrently, not on your own file's setup alone. Every future story that widens a
table's read boundary owes its assertions the same audit: does this count assume it is the only
writer of this table right now? If another suite's fixture can add a row that changes the count,
scope the assertion to rows the fixture itself created — never to the whole table.

## What CI cannot pin

Anything PostgREST cannot read is invisible to the test suite, because the live suites reach the
database through it and it cannot read `pg_catalog`. Supabase advisors are not in CI either.

- `set search_path` and `revoke execute` on RPCs; policy and constraint **shape**; table **grants**.
- **A COLUMN-level grant to `anon`.** SPRIN-85's migration block now checks for it, but that runs
  only when a human re-applies the file — never in CI. What CI *can* see is behaviour: the live
  test that an anonymous UPDATE on `project_statuses` earns `42501`. Note the two failure shapes
  are different and a test must pick the right one: a **privilege** refusal is `42501` with
  `data === null`, whereas an **RLS filter** is `error: null, data: []`. Asserting the wrong one
  passes for the wrong reason.
- **`security invoker` → `definer` on `reorder_project_statuses` is the highest-consequence
  one-token change in this codebase**, and exactly one live test pins it.
- A migration's own post-state verification block **cannot** substitute: it reads back its own work
  inside the same transaction, and a `like '%x%'` shape test passes on a superset.

## Known-unpinned invariants (disclosed in PRs #65, #66, #67, #77, #80, #82 — none live)

- **"Values live in `domain.ts`" is unpinned except for `project_type`**, which has three scans in
  `src/test/project-type-single-expression.test.ts`. Ticket types, sprint statuses and status
  categories are wide open. The real fix is a repo-wide lint rule plus an ADR. A surviving hole even
  for `project_type`: a **renaming** destructure defeats a scan that forbids a spelling rather than
  guarding the read.
- **`defaultValue=` on the search box** is inert *only* while nothing but its own `onChange` writes
  `query`. URL sync would inherit a silent bug.
- **The status delete path** — closed by SPRIN-87. What replaces it: **every fixture row's
  `project_id` equals the `projectId` prop**, so those two reads are indistinguishable. Unlike the
  three confounds SPRIN-87 broke, these are genuinely equal in production and separating them would
  encode an impossible state — declared rather than fixed.
- **The UTC-safety of `sprint-cadence.ts` is unpinned in CI's own timezone** (SPRIN-96 review). The
  production code is correct and the suite is green under UTC, New York and Auckland — but *no single
  timezone kills both* local-time mutations, and CI runs the one where **neither** dies:
  `getUTCDay()` → `getDay()` (`sprint-cadence.ts:25`) survives under `TZ=UTC` and a **positive**
  offset, dying only under a negative one; dropping the `Z` and using `setDate`/`getDate`
  (`:17–18`) survives under `TZ=UTC` and a **negative** offset, dying only under a positive one.
  GitHub Actions runners default to UTC and nothing in `vite.config.ts` or `package.json` pins `TZ`,
  so the module docblock's central claim — *"never a local-timezone accessor"* — has zero protection
  at the gate. It died locally only by the accident of Europe/London being UTC+1 in August. Fix, if
  wanted: flip `process.env.TZ` to one negative- and one positive-offset zone around the existing
  weekday table (Node 20 honours a runtime change — verified). Latent regression risk, not a live bug.
- **`todayUtc`'s unit test is self-referential** (SPRIN-96 review). `sprint-dates.test.ts` asserts
  `todayUtc()` equals `new Date().toISOString().slice(0, 10)`, which *is* the implementation
  restated. Replacing the body with a local-calendar construction survives under every timezone
  tried; only a ±1-day shift dies, because that moves the value. It pins "returns today, in that
  shape" and not "derives the day in UTC". Distinct from the note in PR #109, which discloses only
  that the *dialog* suite mocks `todayUtc` to a constant.
- **`profiles.email` can drift from `auth.users.email`** (SPRIN-105). The column is backfilled once
  and mirrored on every future signup via `handle_new_user`, but nothing re-syncs an *existing* row
  when a user's email changes in `auth.users` — there is no email-change path anywhere in the app
  today, so the sync trigger was deliberately not built. **SPRIN-102 must re-read this before
  trusting the column as an identity key**, because "add member by email" is exactly the path that
  would treat a stale mirror as authoritative. Alongside it: the mirror stores whatever
  `auth.users` holds verbatim, so a **case-insensitive** lookup is a separate, undecided question —
  it would need its own `lower(email)` index (the current unique constraint is on the raw value)
  and its own decision about whether two differently-cased addresses should collide.

## Settled — do not re-raise

- **"Fused accessible names"** — disproven. It is a jsdom artefact; no browser produces those
  names. Cost a story to find out; see `CLAUDE.md`.
- **`check-bundle.mjs`'s "deleted `icons.svg`"** — that line narrates the deletion, it is not a bug.
- Orphaned fixture projects — gone. **SPRIN-58** — unbuilt, deliberately. **T7 / 80% coverage** and
  everything from Rung 2 — out of scope.

> A **project rename** story owes four specific things before it can work — SPRIN-97 discharged the
> two that were shared (the AST guard narrowing and the restored cross-tenant assertion) and added
> two that are new (the `SPRINT_CADENCE_COLUMNS` allowlist, and keeping the doc-vs-migration matcher
> in step). They are stated in `CLAUDE.md` (the `projects` UPDATE section) — not repeated here, so
> the two cannot drift.
