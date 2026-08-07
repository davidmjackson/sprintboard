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
**custom fields (71 — in progress)** → sprint cadence (74) → **teams, roles and permissions (75 —
the security boundary, deliberately last)**.

Epic 73 is complete: 81, 82, 83, 84, 85, **86** and 87 all done. `wip_limit` is no longer inert —
SPRIN-86 renders it on the board, and the limit is **soft**: it warns, it never blocks.

**Epic SPRIN-71 is designed and stories 1 and 2 have shipped.** The design is
`docs/superpowers/specs/2026-08-05-sprin-71-custom-fields-design.md` — six stories, three
migrations, all additive. Read it before planning any of them.

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
| 3 — values on the ticket detail sidebar | **SPRIN-88 ← IN FLIGHT** | In Progress | C, **applied** |
| 4 — values on the create-ticket dialog | SPRIN-89 | To Do | — |
| 5 — single-select fields | SPRIN-92 | To Do | D |
| 6 — delete a field, with its value count | SPRIN-93 | To Do | grants |

**The migration letters have shifted by one.** The design calls `ticket_field_values` "migration
B" and `project_field_options` "migration C"; SPRIN-91's grant file took the name
`sprin-91-project-fields-insert.sql` and the B slot, so story 3's table is **C** and story 5's is
**D**. Go by the filenames in `docs/migrations/`, not by the letters in the epic design.

## Session log

Newest first. One paragraph each — detail is in the linked PRs, specs and git history.

### Session 58 — SPRIN-88 built, reviewed by four agents, PR #95 green and UNMERGED

**State to carry: PR #95 is open on `ae38a8a`, `verify` green (1251 tests, 70 files, 0 skipped),
Jira In Review, NOT merged — David had not given the merge instruction when the session ended.**
The migration is unchanged from session 57 and still applied live, so there is nothing to run.

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
- **Supabase advisors are NOT at zero lints, and `CLAUDE.md` implies they are.** Measured
  2026-08-05: 1 security WARN (the leaked-password one above) and 11 performance lints — three
  unindexed foreign keys on `tickets`, and **eight `auth_rls_initplan` warnings** where a policy
  calls bare `auth.uid()` instead of `(select auth.uid())`, re-evaluating it per row. All
  pre-existing; none introduced by SPRIN-85. The `auth_rls_initplan` fix is mechanical but
  touches five tables' policies, so it belongs with **SPRIN-75**, not bolted onto a feature
  story. Note `statuses_owner_delete` already uses the `(select …)` form and is not flagged —
  the fix has a working precedent in this very schema.
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

## Settled — do not re-raise

- **"Fused accessible names"** — disproven. It is a jsdom artefact; no browser produces those
  names. Cost a story to find out; see `CLAUDE.md`.
- **`check-bundle.mjs`'s "deleted `icons.svg`"** — that line narrates the deletion, it is not a bug.
- Orphaned fixture projects — gone. **SPRIN-58** — unbuilt, deliberately. **T7 / 80% coverage** and
  everything from Rung 2 — out of scope.

> A **project rename** story owes three specific things before it can work. They are stated in
> `CLAUDE.md` (the `projects` UPDATE revoke section) — not repeated here, so the two cannot drift.
