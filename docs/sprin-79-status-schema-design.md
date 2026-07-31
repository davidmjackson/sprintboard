<!--
  PROVENANCE — read this before trusting anything below.

  Produced by a 13-agent ultracode workflow on 2026-07-31 against commit 11b2daa:
    4 parallel readers (schema / domain consumers / RLS + isolation suite / project-creation paths)
    -> 3 independent designs from different biases (minimal-change, Jira-faithful, migration-safety)
    -> 2 independent judges (both picked design 3, migration-safety-first)
    -> 3 adversarial reviewers (SQL validity, RLS boundary, the no-visible-change claim)
    -> 1 synthesis pass, which is this document.

  Adversaries raised 28 findings: 6 blocker, 7 high, 11 medium, 4 low.
  The "What the adversaries found" section states, for each, whether the final design FIXES,
  ACCEPTS or DISPUTES it. Nothing was silently dropped.

  THIS IS A DESIGN DOCUMENT, NOT A RECORD OF WORK DONE. At the time of writing, SPRIN-79 had
  no code and no migration applied. The SQL below has NOT been run against any database.
  The Supabase MCP is read_only=true by design: David pastes the migration himself.

  Run ID wf_96a76ef7-efb. Agent transcripts are under the session subagents/workflows directory.
-->
# SPRIN-79 — per-project statuses and board columns

> ## SCOPE CORRECTION, 2026-07-31 — read before the rest of this document
>
> **Open question 1 below is answered, and not the way this document proposed. SPRIN-79
> is the DATABASE half only.** The board keeps rendering from `TICKET_STATUSES`; switching
> it to read `project_statuses` rows is **SPRIN-76**, which already existed on the board
> when this document was written.
>
> The 13-agent workflow read the code exhaustively but never read the sibling backlog
> items, so it specced this story to swallow the next one whole. SPRIN-76's description
> gives the reason for the split in its own words:
>
> > *"WHY THIS IS ITS OWN STORY: doing it together with the schema change would make a red
> > test ambiguous between 'the migration is wrong' and 'the rendering is wrong'.
> > Separating them keeps each diff diagnosable."*
>
> CLAUDE.md makes the board the source of truth for what is left to build, so that
> settles it. **Everything in "What the code has to change" from `src/routes/` onward
> belongs to SPRIN-76**, along with the `listProjectStatuses` read, the two
> `project-reads.ts` helpers, the ~40 `TicketDetailDialog` renders, the three
> `ProjectShellContext` fixtures and both E2E edits. Adversarial findings 6, 18, 19, 20,
> 21 and 22 are all SPRIN-76's to answer — they are not dropped, they move.
>
> What SPRIN-79 kept: the migration exactly as designed, the schema-doc edit, the
> regenerated types, the `domain.ts` contract additions, the `domain.test.ts` rework, and
> every isolation-suite case. `domain.ts` **keeps** `TICKET_STATUSES` and
> `TICKET_STATUS_LABELS` one story longer — SPRIN-76 deletes them.
>
> One thing this document did not anticipate, which the narrower scope forces: with
> `tickets_status_check` dropped and the board still rendering constants, **nothing
> connects the two halves**. `domain.test.ts` therefore gained two assertions that do not
> appear anywhere below — the seeded slugs and the seeded names must equal what the board
> renders. They are deliberately temporary and SPRIN-76 removes them.
>
> **David's answers to the other open questions**, given 2026-07-31:
> - **Q2 — SELECT-only policy + `security definer` trigger: CONFIRMED.** Taken as designed.
> - **Q5 — sequencing: build first, hand over one paste command.** Done.
> - **Q3 (`category` ships unread) and Q4 (SPRIN-77's prerequisite):** decided under
>   autopilot rather than asked. `category` stays, on the design's own reasoning — a
>   custom status added at SPRIN-77 has no inferable category, so backfilling later means
>   asking the user. The SPRIN-77 prerequisite stays enforced by the write-refusal tests,
>   which go red the day the policy widens.

## The decision

**Design 3 (`project_statuses` with a composite slug FK) wins.** Both judges reached it independently, on the same two grounds, and I agree with both. What follows is the argument, then what I grafted from the losers, then where I overruled all three designs because the adversarial pass proved them wrong.

### Call 1 — board columns are NOT their own table

A board column is a `project_statuses` row, ordered by `position`. There is no `board_columns` table.

The argument is not "fewer tables is simpler". It is that **the second table has no data to put in it and one invariant the database cannot cheaply hold.** Today `TICKET_STATUSES` (`src/lib/domain.ts:30-35`) is simultaneously the status vocabulary (`TicketDetailSidebar.tsx:64`, as `<option value>`) and the column list (`BoardTab.tsx:213`, as the column loop), and `TICKET_STATUS_LABELS` supplies both the status label and the column heading. Splitting them now creates a second axis that is 1:1 with the first, has no user-visible effect, and needs "every column contains at least one status" — which is not a CHECK and not an FK, so it is a deferred constraint or a trigger, plus a UI state for an empty column, plus a rule for what happens when the last status leaves one.

Design 2 argued the split honestly and it is the right *end* state — Jira separates them because a column can aggregate several statuses. But it also admitted the cost, and the admission is what disqualifies it for **this** slice: *"Drag acquires a rule that does not exist today ... dropping a card on a column must pick which status in that column."* That is invented semantics, untestable against current behaviour, shipped in the story whose defining requirement is that nothing changes. It also splits one visible string into two that must agree (board heading = `board_columns.name`, detail pill = `project_statuses.name`), so every existing assertion on the four headings quietly stops saying anything about the dialog. And it doubles the RLS surface immediately before SPRIN-75 rewrites every policy to a membership check.

The later split is additive and deterministic, which is exactly the hedge CLAUDE.md asks for: create `board_columns`, seed one column per existing status with the same name and position, add `project_statuses.column_id`, backfill 1:1, `set not null`, move `position`. **No ticket row is touched, because tickets never reference a column.** I have paid the one hedge that is expensive to retrofit: `project_statuses_id_project_unique unique (id, project_id)` — redundant on its own, exactly as `sprints_id_project_unique` and `tickets_id_project_unique` are — so a future `board_columns` can point at a status with a composite FK without another ALTER.

I also kept Design 3's `category text check (category in ('todo','in_progress','done'))` over Design 1's `is_done boolean`. A *custom* status added at SPRIN-77 has no inferable category, so backfilling it later means asking the user; the four seeded rows have unambiguous categories today. Both judges said the same.

### Call 2 — `tickets.status` stays `text`, and gains a composite foreign key

```sql
alter table public.tickets
  add constraint tickets_status_fk
  foreign key (project_id, status)
  references public.project_statuses (project_id, slug)
  on update no action on delete no action
  deferrable initially deferred;
alter table public.tickets drop constraint tickets_status_check;
```

**Not an ENUM.** Never a candidate. An enum is globally scoped, which is the opposite of a per-project vocabulary, and `alter type` cannot remove a value at all. CLAUDE.md is right that it would be the single most damaging change available.

**Why an FK and not just dropping the CHECK.** A per-project vocabulary cannot be a CHECK — CHECK bodies may not contain subqueries. Today `tickets_status_check` is the only thing guaranteeing the client never sees an unknown status (`isTicketStatus()` is its mirror, not the guarantee). Drop it with nothing in its place and the column is unvalidated at the database edge for the first time, breaking rule 8.

**Why the slug and not a surrogate `status_id uuid`.** The slug rewrites **zero ticket rows**. The surrogate requires adding a column, backfilling by joining on the old text, and deciding whether to drop the old column — a lossy, irreversible step, hand-pasted, against a live database. It also breaks `.neq('status','done')`'s single atomic round trip, breaks `e2e:169 toHaveValue('in_progress')`, and breaks `domain.ts`'s `Ticket = Omit<Tables<'tickets'>, 'status'|'type'>` **silently** (omitting a key that no longer exists succeeds without a compiler complaint). The usual argument for a surrogate — rename without cascade — is answered by splitting `slug` (immutable machine identity, the FK target) from `name` (the editable label). Users rename `name`; renaming touches zero tickets.

**`on update no action`, not `on update cascade`.** Design 1 chose cascade and it is a latent data-integrity hole: the referencing column list includes `project_id`, so cascading a change to `project_statuses.project_id` would propagate into `tickets.project_id`, silently moving tickets between projects and possibly colliding with `tickets_project_number_unique`. Design 3 caught this; Design 1 did not.

**`deferrable initially deferred` is load-bearing, and this is where Designs 1 and 2 are factually wrong.** Both justify non-deferrable `on delete no action` with the claim that the check is queued to the end of the outer statement. It is not: each RI cascade runs its own inner `DELETE`, and that inner statement's immediate checks fire at the end of *that* inner statement. Safety therefore depends purely on RI trigger name order. I measured it live:

```
RI_ConstraintTrigger_a_17656/17657  projects → project_counters_project_id_fkey
RI_ConstraintTrigger_a_17676/17677  projects → sprints_project_id_fkey
RI_ConstraintTrigger_a_17704/17705  projects → tickets_project_id_fkey
```

On *this* database a new `project_statuses_project_id_fkey` gets a higher OID and fires last, so tickets are gone first and non-deferrable would happen to work. On a **fresh apply of the schema doc** it does not: `project_statuses` must be created before `tickets` (tickets references it), so its cascade trigger sorts *first*, the statuses go before the tickets, and `delete from projects` raises 23503 — taking every integration teardown and the E2E user teardown with it. Design 1's own schema-doc instruction ("insert the `create table project_statuses` block after `project_counters` and before `sprints`") walks straight into it. Deferring to COMMIT is correct in either order.

### What was grafted from the losers

- **From Design 2: `is_initial boolean` + `create unique index ... where is_initial`.** Both judges nominated this. Its argument is correct and neither other design answered it: "where new tickets land" must not be derived from `position = 1`, because dragging Done to the front of the board would then silently start creating tickets in Done. Adding the column now costs one column, one partial index and one seeded value, and avoids a second ALTER on a live table.
- **From Design 1: inline the four seed values in both the trigger and the backfill, rather than a shared `default_project_statuses()` function.** Design 1's reasoning is right and Design 3 missed it: `revoke execute` **cannot** be applied to a helper that a security-invoker trigger calls, so the helper stays a live anon-callable PostgREST RPC forever. Inlining removes findings 7, 17 and 28 outright. The duplication is bounded to one file and pinned by test.
- **From Design 1: the trigger-before-backfill lock reasoning**, kept as a comment beside Design 3's explicit `LOCK TABLE`, so nobody "simplifies" the ordering away.
- **From Design 1: the cross-project-FK negative test** — the only test that proves the FK is composite. RLS cannot catch it, because both projects belong to the same owner.

### Where the judges disagreed, and how I resolved it

They did not disagree on the winner or the margin (27/24/**34** and 28/21/**36**). They disagreed on one point of credit: Judge 1 and Judge 2 both credited Design 3 with `lock_timeout`/`statement_timeout`. **Those lines do not exist in Design 3's DDL** — they exist in its prose (risk #5) and in Design 1's DDL. Adversarial finding 24 caught it. I resolved it by taking Design 1's lines. This matters: I measured `authenticated` at `statement_timeout=8s` and `postgres` at no timeout, so a hand-run `LOCK TABLE` with no `lock_timeout` waits forever while every CI fixture insert behind it dies in 8 seconds and reddens an innocent PR.

### Where I overruled all three designs

**All three ship a `for all` policy on `project_statuses`, and all three are wrong for this slice.** Adversarial findings 1 and 2 are correct and they are the most serious thing in the whole pass. Details are in the next section; the decision is:

> **In SPRIN-79 the status vocabulary is server-owned. Clients may `select` it and nothing else. The only writer is the seeding trigger, which is therefore `security definer` — reversing Design 3's invoker choice.**

That is precisely behaviour-preserving: today a client cannot change the vocabulary at all, because it is a CHECK constraint. Write access arrives with SPRIN-77, which is the story that also builds the UI to render a changed vocabulary.

---

## What the adversaries found, and what changed because of it

### Blockers

**1 — Dropping the CHECK while granting owners `for all` removes the database-edge validation entirely. FIXED.**
The finding is right and the "strictly stronger" claim in all three designs is right only about *cross-project* integrity. The property the CHECK actually provided — a client cannot write a status the client does not understand — is destroyed, because the referenced set moves from an unwritable CHECK into a table on which `pg_default_acl` grants `anon`/`authenticated` full DML, guarded by a `for all` policy the owner passes. Two ordinary PostgREST requests widen the vocabulary and then write into it; the ticket then renders in no column, `TICKET_STATUS_LABELS['zzz']` is `undefined`, and `listTickets`' `data as Ticket[]` cast keeps calling it a `TicketStatus`. Nothing goes red.
**Fix taken:** option (a) from the finding — `statuses_owner_read` is `for select` only. There is no client write path, so the hole does not exist. The migration's post-conditions assert `pg_policies.cmd = 'SELECT'`, and the isolation suite asserts that even the owner's own INSERT is rejected with 42501. Both go red the day SPRIN-77 opens writes, which is correct: that story must change them consciously.

**2 — An owner can permanently break ticket creation today by deleting the `todo` status. FIXED, and the finding's framing was right against Design 3.** Design 3 filed this as a Rung 3 risk; the finding correctly points out the *capability* is created by this migration, not by a future UI. With no client DELETE policy the capability does not exist. `is_initial` is added now (grafted from Design 2) so SPRIN-80 has its hook, and `default 'todo'` is retained — safe in this slice because the vocabulary is immutable to clients, and pinned by an integration assertion that the `is_initial` row's slug is exactly `'todo'`, tying the two mechanisms together.

**9 — Every proposed isolation test passes vacuously against a de-correlated policy, because B owns no project. FIXED, and this is the sharpest finding in the pass.**
Verified: `grep -rn "signIn('B')" src/` shows B is signed in at `rls.integration.test.ts:29` and never inserts a project — the only `projects` insert in that file is A's at :35-41. So `exists (select 1 from projects p where p.owner_id = auth.uid())` — the policy with its correlation clause deleted — is false for B and true for A, and every B-is-filtered assertion still passes. Contrast `tickets_owner`, whose correlation *is* exercised, because `tickets.integration.test.ts:130-137` gives B a real project.
**Fix taken:** `projectB` fixture (B is already signed in, so this costs no extra `signIn()`), plus an **unfiltered two-owner read in both directions** with a positive control inside the same assertion. Full text in the isolation-suite section.

**10 — No WITH CHECK-on-UPDATE test; a status row could be moved into another tenant's project. FIXED by removal.** Correct against a `for all` policy: USING is evaluated on the OLD row, WITH CHECK on the NEW one, and a USING miss short-circuits, so the existing "B cannot UPDATE" shape never reaches WITH CHECK. With a select-only policy there is no UPDATE path for any client. The `ProjectStatusUpdate` write type the finding asks for is therefore not added — there is nothing to type. **This must be revisited in SPRIN-77**, and the test that pins "no writes" is what will force it.

**18 — Hoisting the read does not hoist the branch; BoardTab and ProjectShell are both at exactly 10. FIXED, and the finding is right that no candidate design had an answer.** I re-measured:

```
$ npx eslint src/routes/BoardTab.tsx src/routes/ProjectShell.tsx src/routes/TicketDetailSidebar.tsx \
    --rule '{"complexity":["error",1]}'
BoardTab             complexity 10
ProjectShell         complexity 10
TicketDetailSidebar  complexity  9
```

**Fix taken:** the story budgets a guard-block rewrite that *reduces* BoardTab. Two pure helpers in `src/lib/project-reads.ts` — `firstFailedResource(entries)` and `anyLoading(phases)` — replace BoardTab's two `if (… === 'failed')` branches with one and its `ticketsPhase === 'loading' || sprintsPhase === 'loading'` (two branches) with one. Net −2 before the third read is added, so BoardTab lands at 8 with statuses included. `ProjectShell` gains only `statuses: statusRead.items` / `statusesPhase: statusRead.phase` on the context object — no branches — and stays at 10. `TicketDetailSidebar` goes 9 → 10 for `disabled={statusesPhase !== 'loaded'}`, which passes; the label lookup goes into a `statusLabel()` helper in `domain.ts` so it costs the component nothing. **Re-measure with the command above before writing the split, not after.**

**19 — A board rendered from loaded rows shows zero columns while the read is in flight, and `ProjectShell.test.tsx` does not mock the new read. FIXED.** Confirmed: `project-reads.ts` returns `items: []` on both `loading` and `failed`, and the existing gate at `BoardTab.tsx:162-170` consults only the other two phases. The rewritten guard block from finding 18 covers the loading and failed states. `ProjectShell.test.tsx:20-36`'s `vi.mock` block gains the statuses read with a four-row `mockResolvedValue`.

### Highs

**3 — The migration never exercises the seeding trigger under RLS; its own smoke test admits it runs as `postgres`. FIXED, and this is the best structural idea in the pass.** The migration now runs an **in-transaction smoke test as `authenticated`**, before COMMIT. I verified it is possible here: `postgres` is a member of `authenticated` **with admin option** (`pg_auth_members`), and `auth.uid()` reads `current_setting('request.jwt.claims',true)::jsonb ->> 'sub'`, so both are settable with `set_config(..., true)`. If the policy predicate or the trigger is wrong, the migration aborts with a sentence and nothing lands.

**11 — The trigger-seeded fixture read produces the exact `TypeError … reading 'id'` that CLAUDE.md documents as a transient auth flake. FIXED.** Unlike `.select().single()`, a plural read returns `{ data: [], error: null }` when the policy filters everything, so `data[0].id` throws a bare TypeError in `beforeAll` — matching the documented rate-limit signature, which sends the operator to a cooldown-and-rerun for a broken policy. The fixture now throws a named error whose text says **"do not re-run it"**.

**12 — The proposed orphan check is structurally incapable of detecting an orphan. FIXED.** Correct: once the `projects` row is deleted, `statuses_owner_read`'s EXISTS is false for every RLS-subject role, so the post-teardown read returns `[]` in the healthy case *and* in the leaking case. The check uses `adminClient()` (service-role, RLS-bypassing, already the sanctioned test-side privileged client) with a positive control taken before the delete.

**20 — Adding required fields to `ProjectShellContext` breaks `npm run build` in two test files and passes silently in a third. FIXED.** Verified: `BoardTab.test.tsx:44` (`ctxWith`), `BoardTab.test.tsx:107` (`boardCtx`) and `BacklogTab.test.tsx:34` (`ctxWith`) are return-position object literals annotated `: ProjectShellContext` — missing properties are TS2739 under `tsc -b`. `SprintsTab.test.tsx:123` uses `as ProjectShellContext`, which compiles with the new fields `undefined` — and that file's own comment at :109-112 explains why that is worse. All three are in the file list, and the `as` cast becomes an annotation.

**21 — ~40 standalone `TicketDetailDialog` renders pass no statuses. FIXED.** `statuses` and `statusesPhase` are **required** props on `TicketDetailDialog` — no defaults — so `tsc -b` enumerates every call site. Defaulting `statuses` to the four constants would reintroduce the hard-coded four in a component (CLAUDE.md rule 2) and make forty tests green while proving nothing.

**22 — The E2E keyboard leg breaks if the status picker is disabled while its read is in flight. FIXED.** Confirmed at `e2e/happy-path.spec.ts:150-160`: a Tab loop cannot focus a disabled `<select>`, and `page.goto` at :121 restarts every read while the spec proceeds as soon as the *tickets* read lands. The spec gains `await expect(statusSelect).toBeEnabled()` before the loop, and the ordinal assumption at :158 is replaced by an assertion of the full option order. `e2e.yml` is not the gate, so this would have failed invisibly.

**23 — Both ends of the four-column guarantee are cut in the same commit. FIXED with three-way pinning.** Verified the regex: `checkConstraintValues('tickets','status')` **throws** (`domain.test.ts:47`) once the check leaves the `create table tickets` block. The replacement is three assertions, not one: live DB ≡ `domain.ts` (integration test reads all four rows including `name`, `position`, `category`, `is_initial`), schema doc ≡ `domain.ts` (unit test parses the trigger's VALUES list), and pasted migration ≡ live DB (the AFTER query). The **live** assertion is the primary guard, because it is the only one that reads what actually ran.

### Mediums and lows

**4 — `alter table public.project_statuses enable row level security;` trips the ALTER TABLE tripwire. FIXED; the finding is exactly right and I verified it:**

```
node> 'alter table public.project_statuses enable row level security;'
       .match(/^\s*alter table (?!\w+\s+enable row level security)/gim)
["alter table "]      // qualified form is CAPTURED — the test fails
```
`\w` does not match `.`. The **schema doc must use the unqualified form**; only the pasted migration uses `public.`. Called out explicitly in the file list.

**5 — `create table if not exists public.project_statuses (` cannot go in the schema doc. FIXED, and verified:** `tableBody()`'s regex against the qualified/`if not exists` form returns `null`. The schema doc gets `create table project_statuses (` — no prefix, no `if not exists`. Separately, the migration now uses a **plain** `create table` (no `if not exists`), so a second paste fails loudly at step 4 instead of silently skipping a differently-shaped table; the whole file is one transaction, so nothing lands.

**6 — The breaks list was self-contradictory about `ProjectShellContext`. RESOLVED by deciding.** It cannot both be true that the read lands and that the four-heading assertions stay green. **This story switches the UI.** `BoardTab.test.tsx:116-118/133-136/139-141`, `TicketDetailDialog.test.tsx:758-764` and `ProjectShell.test.tsx:213-228` all change in this commit. (If you would rather split — see Open questions.)

**7 / 17 / 28 — `default_project_statuses()` becomes an anon-callable RPC and cannot be revoked. FIXED by deletion.** Confirmed the mechanism: `create_project_counter` is not a precedent because it `returns trigger` and PostgREST excludes those; a `returns table` function in `public` **is** published. The function is gone; the four values are inlined in the trigger and the backfill, pinned by test. `database.types.ts`'s `Functions: { [_ in never]: never }` stays empty.

**8 — Nothing verifies `notify pgrst`. FIXED.** A `curl` reachability check is the **first** item in the AFTER block, with the remedy next to it, because a stale schema cache and a failed migration look identical to `npm test`.

**13 — A filtering policy failure renders a blank board with `phase === 'loaded'`. FIXED.** `listProjectStatuses` **throws** on an empty result — a project always has at least one status by construction — so `useTaggedRead` reports `failed` and the board shows `LoadFailure`. This is the same discipline `src/lib/tickets.ts` already applies (`[]` is indistinguishable from "no tickets").

**14 — Nothing proves the FK is composite. FIXED, with a wrinkle the finding did not have.** Under the select-only policy every project has an identical vocabulary, so a "slug that exists only in P2" is unreachable through a client. The test uses `adminClient()` to plant a `qa_review` status in P2, then attempts the cross-project write as A. Two cases: an entirely unknown slug (proves the FK exists) and P2's slug (proves it is composite). Both under `describe.skipIf(!hasServiceRoleKey)`.

**15 — No anon assertion on the new table. FIXED.** `anonClient()` performs no sign-in, so it adds zero pressure on the GoTrue rate limiter. Added, with a positive control as A in the same test.

**16 — Nothing detects a table added without RLS or a policy. FIXED.** Added to `domain.test.ts`, with the "guard the guard" length assertion so it cannot pass vacuously if the `create table` regex stops matching.

**24 — `lock_timeout` is credited but absent. FIXED.** Verified live: `authenticated` `statement_timeout=8s`, `postgres` none. Both `set local` lines are in the migration.

**25 — Status labels lose compile-time exhaustiveness and can render nothing. FIXED.** One `statusLabel(statuses, slug)` helper in `domain.ts` with a slug fallback, used by both `TicketDetailHeader` and `BoardTab` — one tested function rather than three inline `??`s in files at their complexity limit.

**26 — `deferrable` moves the failure from a statement-time 23514 to a commit-time 23503. ACCEPTED, with the fix.** The finding is right, and it is the price of order-independent cascades — which is not negotiable, per Call 2. The instruction is explicit: **OBSERVE the actual PostgREST/supabase-js response for a deferred violation before writing any assertion**, and annotate it as observed, exactly as `rls.integration.test.ts:228-235` annotates its 42501-vs-23502 reasoning. The finding's second half is also taken: a live test of the property `deferrable` exists for — create project + ticket, `delete from projects`, assert one row and no 23503 — so the cascade safety is covered by `npm run verify`, not only by a hand-run smoke test.

**27 — `category` is seeded and read by nothing; `'done'` stays hard-coded at two mirrored sites. ACCEPTED, with a named prerequisite.** `sprints.ts:230` `.neq('status','done')` and `ProjectShell.tsx:153` `t.status !== 'done'` are left alone. In this slice that is *correct*, not lazy: with a select-only policy every project has exactly the four seeded statuses, so `'done'` is guaranteed to exist and to be the only terminal one. The hazard becomes reachable the moment writes open. Recorded as a hard prerequisite: **SPRIN-77 must move the terminal-status rule onto `category = 'done'` before it opens write access to `project_statuses`**, and it must move *both* sites at once — this repo has shipped a one-sided fix of a mirrored finding before. Pinned by an integration assertion that `category = 'done'` on exactly the `done` slug. I kept `category` rather than dropping it because a custom status added at SPRIN-77 has no inferable category, so backfilling later means asking the user.

---

## The migration

Two artefacts, deliberately different: **the file you paste** (below, `public.`-qualified, ALTER form) and **`docs/sprintboard_phase1_schema.sql`** (edited in place, unqualified, CREATE TABLE form — see the file list). They are not interchangeable; `domain.test.ts` enforces the difference.

### BEFORE — run this first and read every line

```sql
select
  current_setting('server_version')                                 as pg_version,      -- expect 15+
  (select count(*) from public.projects)                            as projects,
  (select count(*) from public.tickets)                             as tickets,
  to_regclass('public.project_statuses')::text                      as must_be_null,
  (select count(*) from public.tickets
     where status not in ('todo','in_progress','in_review','done')) as must_be_zero,
  (select count(*) from auth.users)                                 as users_must_be_gt_0;
```

```sql
select pid, state, wait_event_type, left(query, 80) as query
from pg_stat_activity
where datname = current_database() and state <> 'idle' and pid <> pg_backend_pid();
```

And not a SQL check: confirm no CI run is in flight (`gh run list --limit 5`). The `verify` workflow's live suites insert projects, `authenticated` has an 8-second `statement_timeout`, and step 3 takes a lock they conflict with.

### The migration

```sql
-- =============================================================================
-- SPRIN-79  Per-project statuses / board columns   (Rung 3 epic SPRIN-72, slice 1)
--
-- BEHAVIOUR-PRESERVING. After this the app looks and behaves exactly as now: the
-- same four slugs, the same four labels, the same order, the same tickets.status
-- text column with the same `default 'todo'`. No ticket row is rewritten.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- One explicit transaction. If any statement errors, NOTHING lands.
--
-- RE-RUN: NOT idempotent by design. A second paste fails at step 4 (`create table`
-- already exists) and rolls back harmlessly — there is no partial state to repair,
-- so a loud failure beats a silent skip over a differently-shaped table. The one
-- piece that IS idempotent is the backfill, because the integration suites create
-- and drop projects on every CI run and could interleave with the paste.
--
-- The vocabulary is SERVER-OWNED in this slice: clients may SELECT project_statuses
-- and nothing else. Write access is SPRIN-77's, which is the story that also builds
-- the UI to render a changed vocabulary. Do not widen the policy here.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 1. Bound the damage. A lock_timeout abort is the SAFE outcome: nothing lands,
--    just re-run. Measured: `authenticated` carries statement_timeout=8s and
--    `postgres` carries none, so without this the SQL editor waits forever while
--    every CI fixture insert queued behind it dies in eight seconds.
-- -----------------------------------------------------------------------------
set local lock_timeout      = '5s';
set local statement_timeout = '120s';

-- -----------------------------------------------------------------------------
-- 2. Preconditions.
-- -----------------------------------------------------------------------------
do $$
begin
  if current_setting('server_version_num')::int < 150000 then
    raise exception
      'SPRIN-79: needs PostgreSQL 15+ (the existing `on delete set null (col)` syntax already does); found %',
      current_setting('server_version');
  end if;

  if exists (select 1 from public.tickets t
             where t.status not in ('todo','in_progress','in_review','done')) then
    raise exception
      'SPRIN-79: tickets exist with a status outside the four defaults. tickets_status_check '
      'should have made this impossible. Investigate before proceeding.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 3. Close the race BEFORE reading `projects`.
--
--    Without this, a project committed after the backfill's snapshot but before
--    the FK is added ends up with NO statuses, and its tickets violate the new FK
--    INVISIBLY — ADD CONSTRAINT only validates rows visible to its own snapshot.
--    The migration would succeed and leave a project whose every future ticket
--    insert fails with 23503.
--
--    SHARE ROW EXCLUSIVE blocks INSERT/UPDATE/DELETE on `projects` but NOT SELECT.
--    After it, every project either already exists (the backfill sees it) or is
--    blocked until we commit (and then fires the seeding trigger). No third case.
--
--    Belt and braces, and the reason step 5's ordering matters even if someone
--    deletes this lock: `create trigger` itself takes SHARE ROW EXCLUSIVE on
--    `projects`, so creating the trigger BEFORE the backfill closes the same
--    window independently. Do not reorder them.
-- -----------------------------------------------------------------------------
lock table public.projects in share row exclusive mode;

-- -----------------------------------------------------------------------------
-- 4. The table. A board column IS a status row; `position` is board order.
--
--    NO separate board_columns table: the mapping is 1:1 today, and the Rung 3
--    split is purely additive — create board_columns, seed one per status, add a
--    nullable project_statuses.column_id, backfill, set not null, move `position`.
--    No ticket row is touched, because tickets never reference a column.
--
--    text + check throughout. NEVER an enum (CLAUDE.md).
-- -----------------------------------------------------------------------------
create table public.project_statuses (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,

  -- Stable machine identity, and the fk target for tickets.status. Users rename
  -- `name`, never `slug` — the same division projects.key already uses.
  slug        text not null,

  -- The board column heading. Seeded to today's TICKET_STATUS_LABELS verbatim.
  name        text not null,

  -- Jira's status category, and the eventual home of the "done is terminal" rule
  -- currently inlined at src/lib/sprints.ts:230 and src/routes/ProjectShell.tsx:153.
  -- The default is deliberately the NON-terminal middle bucket: a Rung 3 flow that
  -- forgets to set it produces a status that is not treated as Done, so incomplete
  -- tickets return to the backlog. Fail safe, not fail convenient.
  category    text not null default 'in_progress',

  -- Board order. Dense 1..N per project.
  position    int  not null,

  -- Where new tickets land. NOT derived from position: under a position-derived
  -- default, dragging Done to the front of the board would silently start creating
  -- tickets in Done. Seeded true on `todo`, which is also tickets.status's column
  -- default — the integration suite asserts those two agree.
  is_initial  boolean not null default false,

  created_at  timestamptz not null default now(),

  constraint project_statuses_slug_format
    check (slug ~ '^[a-z][a-z0-9_]{0,29}$'),
  constraint project_statuses_name_nonempty
    check (btrim(name) <> '' and length(name) <= 40),
  constraint project_statuses_category_check
    check (category in ('todo','in_progress','done')),
  constraint project_statuses_position_positive
    check (position > 0),

  -- The fk target for tickets. NON-deferrable, so it remains a legal fk target and
  -- can still arbitrate ON CONFLICT.
  constraint project_statuses_project_slug_unique
    unique (project_id, slug),

  -- DEFERRABLE so a Rung 3 reorder can swap positions inside ONE statement without
  -- a temporary sentinel. NOTE: a DEFERRABLE constraint cannot be used for ON
  -- CONFLICT inference — upserts must target (project_id, slug).
  constraint project_statuses_project_position_unique
    unique (project_id, position) deferrable initially deferred,

  -- Redundant on its own (id is the PK). Exists so a Rung 3 board_columns table can
  -- point at a status with a COMPOSITE fk and prove same-project membership —
  -- exactly why sprints_id_project_unique and tickets_id_project_unique exist.
  constraint project_statuses_id_project_unique
    unique (id, project_id)
);

comment on table public.project_statuses is
  'Per-project ticket statuses. One row = one board column (1:1 at Rung 3 slice 1). '
  'SERVER-OWNED: clients may SELECT only; the seeding trigger is the sole writer. '
  'SPRIN-77 opens writes and MUST first move the terminal-status rule off the literal '
  ''''done'''' at src/lib/sprints.ts and src/routes/ProjectShell.tsx onto category.';

-- At most one initial status per project. Same idiom as sprints_one_active_per_project,
-- and the same limitation: it prevents two, not zero.
create unique index project_statuses_one_initial_per_project
  on public.project_statuses (project_id) where is_initial;

-- -----------------------------------------------------------------------------
-- 5. RLS, immediately after the table and in the same transaction.
--
--    MEASURED, not assumed: ALTER DEFAULT PRIVILEGES in `public` grants anon,
--    authenticated and service_role full DML (arwdDxtm) on every new table. A table
--    created without a policy is world-writable to anonymous callers. The policy is
--    the ONLY guard, so it never leaves this transaction.
--
--    FOR SELECT, not FOR ALL — and this is the deliberate departure from the four
--    existing policies. Today a client cannot change the status vocabulary at all,
--    because it is a CHECK constraint. A FOR ALL policy would hand every owner
--    INSERT/UPDATE/DELETE on their own vocabulary over PostgREST, using only the
--    anon key and their own JWT, while the UI still hard-codes four columns:
--    a ticket set to an unknown status renders in NO column and vanishes, and an
--    owner deleting the `todo` row permanently breaks ticket creation. Both are
--    reachable in two ordinary requests. Write access belongs to SPRIN-77.
-- -----------------------------------------------------------------------------
alter table public.project_statuses enable row level security;

-- project_statuses: readable only via an owned project
create policy statuses_owner_read on public.project_statuses
  for select
  using (exists (select 1 from public.projects p
                 where p.id = project_statuses.project_id
                   and p.owner_id = auth.uid()));

-- -----------------------------------------------------------------------------
-- 6. Seed on project creation — by EVERY creation path.
--
--    A trigger, not client code: there are four ways a projects row appears (the
--    app's createProject, nine raw fixture inserts across the integration suites,
--    the Playwright E2E through the real dialog, and a human pasting SQL). Only a
--    trigger covers all four, and it fires in the parent's transaction, so "a
--    project with no statuses" is not a reachable state.
--
--    SECURITY DEFINER, following handle_new_user and NOT create_project_counter.
--    That is forced by the select-only policy above: an invoker function's INSERT
--    would be denied. It pays for the privilege exactly as handle_new_user does —
--    an empty pinned search_path, schema-qualified references, and a revoke. It
--    cannot be abused: it only ever fires after a projects INSERT that already
--    passed projects_owner's WITH CHECK, so new.id is a project the caller owns.
--
--    AFTER, not BEFORE: the projects row must be visible for the fk to resolve.
--
--    Two triggers now fire on this event, in NAME order:
--      on_project_created (the counter) then on_project_created_statuses.
--    Neither depends on the other; the name states the order rather than stumbling
--    into it.
--
--    The four values are inlined here and again in the backfill, deliberately. A
--    shared helper returning a table would be published by PostgREST as an
--    anon-callable RPC, and handle_new_user's `revoke execute` remedy cannot be
--    applied to it without breaking whichever function calls it. The duplication is
--    bounded to this file plus the schema doc and is pinned by test.
-- -----------------------------------------------------------------------------
create or replace function public.seed_project_statuses()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.project_statuses
    (project_id, slug, name, category, position, is_initial)
  values
    (new.id, 'todo',        'To Do',       'todo',        1, true),
    (new.id, 'in_progress', 'In Progress', 'in_progress', 2, false),
    (new.id, 'in_review',   'In Review',   'in_progress', 3, false),
    (new.id, 'done',        'Done',        'done',        4, false)
  on conflict (project_id, slug) do nothing;
  return new;
end;
$$;

revoke execute on function public.seed_project_statuses() from public, anon, authenticated;

create trigger on_project_created_statuses
  after insert on public.projects
  for each row execute function public.seed_project_statuses();

-- -----------------------------------------------------------------------------
-- 7. Backfill every project that already exists.
--
--    Runs as `postgres` in the SQL editor, which owns these tables and has
--    BYPASSRLS, so it seeds EVERY owner's projects, not just the operator's. That
--    is required, and it is the reason this must be a hand-run migration rather
--    than anything the app could do.
--
--    Idempotent via ON CONFLICT, arbitrated by the non-deferrable
--    project_statuses_project_slug_unique.
-- -----------------------------------------------------------------------------
insert into public.project_statuses
  (project_id, slug, name, category, position, is_initial)
select p.id, d.slug, d.name, d.category, d.ord, d.is_initial
  from public.projects p
 cross join (values
   ('todo',        'To Do',       'todo',        1, true),
   ('in_progress', 'In Progress', 'in_progress', 2, false),
   ('in_review',   'In Review',   'in_progress', 3, false),
   ('done',        'Done',        'done',        4, false)
 ) as d(slug, name, category, ord, is_initial)
on conflict (project_id, slug) do nothing;

-- -----------------------------------------------------------------------------
-- 8. Pre-flight, BEFORE we constrain tickets. Without these the failure mode is a
--    bare 23503 from ADD CONSTRAINT naming no row and no cause.
--
--    The invariant asserted is "every project has AT LEAST the four default slugs",
--    not "exactly four rows": exactly-four is a today-only fact and would make this
--    file hostile to a legitimate Rung 3 project with five columns.
-- -----------------------------------------------------------------------------
do $$
declare
  v_unseeded int;
  v_dangling int;
  v_initial  int;
begin
  select count(*) into v_unseeded
    from public.projects p
   where exists (
     select 1 from (values ('todo'),('in_progress'),('in_review'),('done')) as d(slug)
      where not exists (select 1 from public.project_statuses s
                         where s.project_id = p.id and s.slug = d.slug)
   );
  if v_unseeded > 0 then
    raise exception
      'SPRIN-79: % project(s) are missing one or more of the four default statuses '
      'after backfill. Aborting before the tickets fk is added.', v_unseeded;
  end if;

  select count(*) into v_initial
    from public.projects p
   where (select count(*) from public.project_statuses s
           where s.project_id = p.id and s.is_initial) <> 1;
  if v_initial > 0 then
    raise exception
      'SPRIN-79: % project(s) do not have exactly one is_initial status.', v_initial;
  end if;

  select count(*) into v_dangling
    from public.tickets t
   where not exists (select 1 from public.project_statuses s
                      where s.project_id = t.project_id and s.slug = t.status);
  if v_dangling > 0 then
    raise exception
      'SPRIN-79: % ticket(s) hold a status with no matching project_statuses row. '
      'The fk would reject them. Aborting.', v_dangling;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 9. Index the referencing side of the new fk. Every DELETE of a project_statuses
--    row (including the cascade from a project delete) probes
--    `tickets where project_id = ? and status = ?`; without this that is a seq scan
--    per deleted status row — four per project teardown, on every integration run.
--    tickets_project_idx alone does not cover the pair.
-- -----------------------------------------------------------------------------
create index tickets_project_status_idx on public.tickets (project_id, status);

-- -----------------------------------------------------------------------------
-- 10. The foreign key. This is the whole story.
--
--     COMPOSITE, carrying project_id: exactly the tickets_sprint_fk /
--     tickets_epic_fk idiom. A plain fk on `status` alone cannot exist (slugs
--     repeat across projects); carrying project_id makes "a ticket in project A
--     holding project B's status" unrepresentable rather than merely discouraged.
--     Both referencing columns are NOT NULL, so MATCH SIMPLE always checks — there
--     is no null escape hatch, unlike sprint_id / parent_epic_id.
--
--     ON UPDATE NO ACTION, not CASCADE: the referencing column list includes
--     project_id, so ON UPDATE CASCADE would propagate a change to
--     project_statuses.project_id into tickets.project_id, silently moving tickets
--     between projects and possibly colliding with tickets_project_number_unique.
--
--     DEFERRABLE INITIALLY DEFERRED, and this is load-bearing, not tidiness.
--     `delete from projects` fires one cascade per referencing fk; each cascade runs
--     its OWN inner DELETE, whose own immediate checks fire at the end of THAT inner
--     statement. So a non-deferrable NO ACTION check is only safe if the tickets
--     cascade happens to run first — which is RI trigger name/OID order, i.e. luck.
--     Measured on this database: tickets_project_id_fkey is RI_ConstraintTrigger_a_17704
--     and a new project_statuses fk sorts after it, so it would work HERE. It would
--     NOT work on a fresh apply of docs/sprintboard_phase1_schema.sql, where
--     project_statuses must be created before tickets and therefore cascades first —
--     raising 23503 and taking every integration teardown and the E2E user teardown
--     with it. Deferring to COMMIT is correct in either order.
--
--     It weakens nothing that matters: RLS WITH CHECK still raises 42501 at statement
--     time, so the existing cross-tenant assertions are untouched. It DOES move a
--     rejected status from a statement-time error to a commit-time one — OBSERVE the
--     actual PostgREST response before pinning a SQLSTATE in any new test.
--
--     tickets currently holds 0 rows (measured), so the validating scan under ACCESS
--     EXCLUSIVE is microseconds. See the LARGE-TABLE VARIANT at the bottom if that
--     ever stops being true.
-- -----------------------------------------------------------------------------
alter table public.tickets
  add constraint tickets_status_fk
  foreign key (project_id, status)
  references public.project_statuses (project_id, slug)
  on update no action
  on delete no action
  deferrable initially deferred;

-- -----------------------------------------------------------------------------
-- 11. Retire the global check constraint — AFTER the fk is in place, so `status` is
--     never unvalidated for an instant.
--
--     The fk is stronger where it counts: the old check accepted 'done' on any
--     project; the fk accepts 'done' only on a project that HAS a `done` status.
--     What the check also provided — that a client cannot invent a status — is
--     preserved in this slice by the select-only policy above, NOT by the fk. That
--     is why the policy is not FOR ALL, and why widening it is a story, not a tweak.
-- -----------------------------------------------------------------------------
alter table public.tickets drop constraint tickets_status_check;

-- -----------------------------------------------------------------------------
-- 12. Post-conditions, still inside the transaction.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'tickets_status_fk'
                    and conrelid = 'public.tickets'::regclass
                    and condeferrable and condeferred) then
    raise exception 'SPRIN-79: tickets_status_fk missing or not deferrable/deferred.';
  end if;

  if exists (select 1 from pg_constraint
              where conname = 'tickets_status_check'
                and conrelid = 'public.tickets'::regclass) then
    raise exception 'SPRIN-79: tickets_status_check still present.';
  end if;

  if not (select relrowsecurity from pg_class
           where oid = 'public.project_statuses'::regclass) then
    raise exception 'SPRIN-79: RLS is not enabled on project_statuses.';
  end if;

  -- Pins the select-only decision at migration time. This assertion is EXPECTED to
  -- be changed by SPRIN-77, consciously, together with the tests that mirror it.
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'project_statuses'
                    and policyname = 'statuses_owner_read' and cmd = 'SELECT') then
    raise exception
      'SPRIN-79: statuses_owner_read is missing or is not a SELECT-only policy.';
  end if;
  if (select count(*) from pg_policies
       where schemaname = 'public' and tablename = 'project_statuses') <> 1 then
    raise exception 'SPRIN-79: project_statuses has more than one policy.';
  end if;

  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.projects'::regclass
                    and tgname = 'on_project_created_statuses' and not tgisinternal) then
    raise exception 'SPRIN-79: on_project_created_statuses trigger is missing.';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 13. LIVE SMOKE TEST, as `authenticated`, before COMMIT.
--
--     Everything above ran as postgres, which owns these tables and has BYPASSRLS —
--     so nothing above proves the policy predicate or the trigger actually works for
--     a real user. Without this block, the first thing to evaluate statuses_owner_read
--     is a CI run, AFTER commit and AFTER tickets_status_check has been dropped.
--
--     Verified prerequisites: postgres is a member of `authenticated` WITH ADMIN
--     OPTION, and auth.uid() reads current_setting('request.jwt.claims')::jsonb->>'sub'.
--
--     This also proves the `revoke execute` above does not break the trigger
--     (EXECUTE is checked at CREATE TRIGGER time, not at fire time). If that
--     assumption is wrong, this block raises and the whole migration rolls back —
--     which is exactly why it is here.
--
--     It leaves nothing behind: the project it creates is deleted, and the delete is
--     itself the cascade-ordering test.
-- -----------------------------------------------------------------------------
do $$
declare
  v_owner  uuid;
  v_proj   uuid;
  v_key    text;
  v_n      int;
  v_status text;
  v_slug   text;
  v_del    int;
begin
  select id into v_owner from auth.users order by created_at limit 1;
  if v_owner is null then
    raise exception 'SPRIN-79: no auth.users row to run the smoke test as. Aborting.';
  end if;
  v_key := 'Z' || upper(substr(md5(random()::text), 1, 3));

  perform set_config('request.jwt.claims',
                     json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);

  insert into public.projects (owner_id, name, key)
  values (v_owner, 'SPRIN-79 smoke', v_key)
  returning id into v_proj;

  -- The load-bearing assertion: the definer trigger seeded four rows AND
  -- statuses_owner_read lets their owner read them back.
  select count(*) into v_n
    from public.project_statuses where project_id = v_proj;
  if v_n <> 4 then
    raise exception
      'SPRIN-79 SMOKE FAIL: an authenticated owner sees % statuses, expected 4. '
      'This is seed_project_statuses() or statuses_owner_read, not the app.', v_n;
  end if;

  select slug into v_slug
    from public.project_statuses where project_id = v_proj and is_initial;
  if v_slug is distinct from 'todo' then
    raise exception
      'SPRIN-79 SMOKE FAIL: is_initial slug is %, expected todo (it must agree with '
      'tickets.status''s column default).', coalesce(v_slug, '<none>');
  end if;

  -- The vocabulary is server-owned: even its OWNER may not write it in this slice.
  begin
    insert into public.project_statuses (project_id, slug, name, category, position)
    values (v_proj, 'planted', 'Planted', 'in_progress', 9);
    raise exception
      'SPRIN-79 SMOKE FAIL: an owner was able to INSERT a status. The policy is not '
      'SELECT-only.';
  exception when insufficient_privilege then
    null;  -- 42501, expected
  end;

  insert into public.tickets (project_id, summary)
  values (v_proj, 'smoke')
  returning status into v_status;
  if v_status <> 'todo' then
    raise exception 'SPRIN-79 SMOKE FAIL: default status is %, expected todo', v_status;
  end if;

  -- Force the deferred fk to check NOW, then restore deferral so the delete below
  -- still exercises the order-independent path.
  set constraints public.tickets_status_fk immediate;
  set constraints public.tickets_status_fk deferred;

  delete from public.projects where id = v_proj;
  get diagnostics v_del = row_count;
  if v_del <> 1 then
    raise exception 'SPRIN-79 SMOKE FAIL: smoke project delete removed % rows, expected 1', v_del;
  end if;

  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
  raise notice 'SPRIN-79 SMOKE OK: seed, read, write-refusal, default and cascade all pass.';
end $$;

-- PostgREST caches the schema. Without this, /rest/v1/project_statuses 404s until the
-- next reload. Delivered at COMMIT, so it is correctly a no-op if we abort.
notify pgrst, 'reload schema';

commit;
```

### AFTER — this proves it worked, not merely that it did not error

**(0) Reachability first.** A stale PostgREST schema cache is indistinguishable from a failed migration when `npm test` fails, so check it before anything else. Expect `200`; if not, re-issue `notify pgrst, 'reload schema';` — do **not** assume the migration failed.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -H "apikey: $VITE_SUPABASE_ANON_KEY" \
  "$VITE_SUPABASE_URL/rest/v1/project_statuses?select=slug&limit=1"
```

**(A) Every project has exactly the four, in order, with the right labels, categories and initial flag. EXPECT 0 ROWS.**

```sql
select p.key,
       count(s.id) as n,
       array_agg(s.slug     order by s.position) as slugs,
       array_agg(s.name     order by s.position) as names,
       array_agg(s.category order by s.position) as categories
from public.projects p
left join public.project_statuses s on s.project_id = p.id
group by p.id, p.key
having count(s.id) <> 4
    or array_agg(s.slug order by s.position)
       is distinct from array['todo','in_progress','in_review','done']::text[]
    or array_agg(s.name order by s.position)
       is distinct from array['To Do','In Progress','In Review','Done']::text[]
    or array_agg(s.category order by s.position)
       is distinct from array['todo','in_progress','in_progress','done']::text[]
    or count(*) filter (where s.is_initial and s.slug = 'todo') <> 1;
```

**(B) No ticket holds a dangling status. EXPECT 0 ROWS.**

```sql
select t.key, t.status
from public.tickets t
where not exists (select 1 from public.project_statuses s
                  where s.project_id = t.project_id and s.slug = t.status);
```

**(C) Catalogue readout. Read it, do not skim it.**

```sql
select conname, pg_get_constraintdef(oid) as def, condeferrable, condeferred
from pg_constraint where conrelid = 'public.tickets'::regclass
  and conname in ('tickets_status_fk','tickets_status_check');
-- EXPECT exactly one row: tickets_status_fk, condeferrable = t, condeferred = t.
```

```sql
select relrowsecurity, relforcerowsecurity
from pg_class where oid = 'public.project_statuses'::regclass;
-- EXPECT t, f
```

```sql
select policyname, permissive, cmd, qual, with_check
from pg_policies where schemaname='public' and tablename='project_statuses';
-- EXPECT exactly one row: statuses_owner_read, PERMISSIVE, SELECT,
-- qual correlated on project_statuses.project_id, with_check NULL.
```

```sql
select tgname from pg_trigger
where tgrelid='public.projects'::regclass and not tgisinternal order by 1;
-- EXPECT on_project_created, on_project_created_statuses
```

**(D) Then run the real gate:** `npm run verify`. Not `npx tsc --noEmit` — it checks zero files here and exits 0.

### Re-run safety, stated plainly

**Not idempotent, and deliberately so.** A second paste fails at step 4 (`create table public.project_statuses` already exists) and rolls back with nothing applied. There is no partial state to repair — the whole file is one transaction — so a loud failure is strictly better than `if not exists` silently skipping a table of a different shape. The only idempotent piece is the backfill (`on conflict do nothing`), because CI creates and drops projects continuously and could interleave with the paste. A `lock_timeout` abort is likewise safe: nothing lands, wait for CI to finish, paste again.

### Large-table variant — not needed today, documented so nobody rediscovers it

`tickets` holds 0 rows (measured), so step 10's validating scan under ACCESS EXCLUSIVE is microseconds. If that ever stops being true, split step 10:

```sql
-- in the main transaction, instant, catalog-only:
alter table public.tickets
  add constraint tickets_status_fk
  foreign key (project_id, status)
  references public.project_statuses (project_id, slug)
  on update no action on delete no action
  deferrable initially deferred
  not valid;

-- THEN, in a SEPARATE transaction after COMMIT (SHARE UPDATE EXCLUSIVE — blocks
-- neither reads nor writes):
alter table public.tickets validate constraint tickets_status_fk;
```

`NOT VALID` still enforces the constraint on all NEW rows from the moment it is added. **Do not drop `tickets_status_check` until `VALIDATE` has succeeded.**

---

## What the code has to change

### `docs/sprintboard_phase1_schema.sql` — edited IN PLACE, never appended to

`src/lib/domain.test.ts:106-116` asserts the file contains **zero** `alter table` statements other than `enable row level security`. The pasted migration (ALTER form, `public.`-qualified) and this document (CREATE TABLE form, unqualified) are two artefacts of one change.

- Insert a `create table project_statuses (` block **after `project_counters` and before `sprints`** — statuses must exist before tickets references them.
  - **Exactly `create table project_statuses (`** — no `if not exists`, no `public.` prefix. Verified: `tableBody()`'s regex (`domain.test.ts:37`) requires the literal form and returns `null` for either variation, throwing `No "create table project_statuses" block found` on a file that visibly contains it.
- Inside `create table tickets`, replace `check (status in (...))` on the `status` line with `constraint tickets_status_fk foreign key (project_id, status) references project_statuses (project_id, slug) on update no action on delete no action deferrable initially deferred` in the constraint list. Keep `status text not null default 'todo'`.
- Add `seed_project_statuses()` + `on_project_created_statuses` + the `revoke execute` line in narrative position beside `create_project_counter`.
- Add `create unique index project_statuses_one_initial_per_project ...` and `create index tickets_project_status_idx ...` beside the other indexes.
- Add **`alter table project_statuses enable row level security;`** to the grouped block at :301-305 — **unqualified**. Verified: the qualified form is captured by the tripwire regex, because `\w` does not match `.`, and the test fails with a message about teaching `checkConstraintValues()` to apply ALTERs — entirely the wrong diagnosis.
- Add `statuses_owner_read` to the policy list.
- The doc is applied **whole**, in its own `begin; … commit;`. Do not run it in chunks: between `create table` and the grouped RLS block, the table exists with anon's default DML grants and no policy.

### `src/lib/database.types.ts` — GENERATED, regenerate after the paste

Supabase MCP `generate_typescript_types` (generation is a read, so it works under `read_only=true`). Gains a `project_statuses` entry with a `Relationships` block; `tickets` gains `tickets_status_fk`. `tickets.status` stays `string`, so **nothing forces this regeneration** — which is exactly how it gets forgotten. Until it lands, `.from('project_statuses')` does not type-check and `npm run build` is red. `Functions` stays `{ [_ in never]: never }` — no RPC is created.

### `src/lib/domain.ts` — governed by the standing rule, so read this carefully

The rule is *"status, type and column definitions live in `domain.ts` and nowhere else."* domain.ts stops being the source of the **values** and becomes the client-side contract for the **shape** and the **seed**. It does not stop being the single place: the four names still appear in exactly one TypeScript file.

**Remove:** `TicketStatus`, `TICKET_STATUSES`, `TICKET_STATUS_LABELS`, `isTicketStatus`, `AssertTicketStatusesExhaustive`, `AssertTicketStatusColumn`.

**Add:**
```ts
export type StatusCategory = 'todo' | 'in_progress' | 'done'
export const STATUS_CATEGORIES = ['todo','in_progress','done'] as const
  satisfies readonly StatusCategory[]
export function isStatusCategory(v: string): v is StatusCategory

/** One project's status row. A board column IS one of these, ordered by `position`. */
export type ProjectStatus = Omit<Tables<'project_statuses'>, 'category'> & {
  category: StatusCategory
}

/** What seed_project_statuses() writes for every new project — the client half of the
 *  seed contract. domain.test.ts asserts this equals the VALUES list in the schema file;
 *  rls.integration.test.ts asserts it equals what the live database actually seeded. */
export const DEFAULT_PROJECT_STATUSES = [
  { slug: 'todo',        name: 'To Do',       category: 'todo',        position: 1, is_initial: true  },
  { slug: 'in_progress', name: 'In Progress', category: 'in_progress', position: 2, is_initial: false },
  { slug: 'in_review',   name: 'In Review',   category: 'in_progress', position: 3, is_initial: false },
  { slug: 'done',        name: 'Done',        category: 'done',        position: 4, is_initial: false },
] as const

/** The board-column label for a ticket's status slug. Falls back to the slug, so an
 *  unknown status renders SOMETHING rather than an empty span. One tested function
 *  instead of three inline `??`s in files at their complexity limit. */
export function statusLabel(statuses: ProjectStatus[], slug: string): string

export type AssertStatusCategoriesExhaustive =
  Expect<Exact<StatusCategory, (typeof STATUS_CATEGORIES)[number]>>
export type AssertStatusCategoryColumn =
  Assignable<StatusCategory, Tables<'project_statuses'>['category']>
```

**Change, and handle deliberately:** `Ticket` becomes `Omit<Tables<'tickets'>, 'type'> & { type: TicketType }` — `status` widens to `string`. **The `Omit` of `'status'` must be removed by hand.** Omitting a key that still exists compiles silently, so if you forget, the narrowing survives as a lie about an open-ended value with no compiler complaint. This is the failure mode the file's own docblock warns about.

**Do not add** a `doneSlugs()` helper. Nothing consumes `category` in this slice; an unused export is cruft, and SPRIN-77 should add it together with its call sites.

### `src/lib/project-reads.ts`

- `listProjectStatuses(projectId)` — `.select('*').eq('project_id', projectId).order('position')`. **It throws on an empty result.** A project always has at least one status by construction, so `[]` means the policy filtered everything — a broken security boundary, not an empty project — and it must reach the user as `LoadFailure`, not as a blank board. Same discipline as `src/lib/tickets.ts`.
- Two pure helpers, so BoardTab's guard block gets *cheaper* while gaining a third read:
  - `firstFailedResource(entries: [string, ReadPhase][]): string | null`
  - `anyLoading(phases: ReadPhase[]): boolean`
  Both unit-tested in `project-reads.test.ts`.

### `src/routes/ProjectShell.tsx`

- Third `useTaggedRead(activeProjectId, reloadNonce, listProjectStatuses)` beside the two at :92-93. `onRetry` already bumps the shared nonce, so retry covers all three.
- `ProjectShellContext` (:33-63) gains `statuses: ProjectStatus[]` and `statusesPhase: ReadPhase`, documented like the other two (`[]` while loading and when failed — always read the phase).
- Adds **no branches**; ProjectShell stays at cyclomatic 10.
- `:153` `t.status !== 'done'` is **unchanged** in this slice. See Risks accepted.

### `src/routes/BoardTab.tsx`

- Replace the two `if (… === 'failed')` returns and the `ticketsPhase === 'loading' || sprintsPhase === 'loading'` return with:
  ```ts
  const failed = firstFailedResource([
    ['tickets', ticketsPhase], ['sprints', sprintsPhase], ['statuses', statusesPhase],
  ])
  if (failed) return <LoadFailure resource={failed} onRetry={onRetry} />
  if (anyLoading([ticketsPhase, sprintsPhase, statusesPhase])) return <p …>Loading…</p>
  ```
  Net −2 branches before the third read; measured landing point is 8.
- `:213` `TICKET_STATUSES.map(...)` → `statuses.map(...)`; `key={status}` → `key={s.slug}`; `:214` bucketing stays `ticket.status === s.slug` (this is the payoff of the text FK); `:223` heading becomes `{s.name}`.
- `:137` drag-failure message becomes `statusLabel(statuses, toStatus)`.
- `:212` **`lg:grid-cols-4` hard-codes "four" in the LAYOUT** and no grep for a status finds it. Behaviour-preserving today because every project has four columns. Tailwind cannot take a runtime value in a class name; leave it, with a comment naming it as the remaining hard-coded four and pointing at SPRIN-77.
- The drag mechanism needs **no change**: the drop target is a closure over the map variable (`onDrop={() => handleDrop(status)}`), not a parsed DOM id, and the write is still `{ status: slug }`.
- `:75` docblock ("the four fixed columns") rewritten.

### `src/routes/TicketDetailSidebar.tsx`

- Options come from the loaded rows; `e.target.value as TicketStatus` becomes a plain `string` (the fk is now the real validator).
- **The comment at :49-55 becomes FALSE** — "the option list is a compile-time constant, so there is no loading state to be honest about". Add `disabled={statusesPhase !== 'loaded'}`, exactly as the Sprint picker beside it already does. 9 → 10 complexity; at the limit, passes. Rewrite the comment.

### `src/routes/TicketDetailHeader.tsx` and `TicketDetailDialog.tsx`

- `:37` `TICKET_STATUS_LABELS[ticket.status]` → `statusLabel(statuses, ticket.status)`.
- `TicketDetailDialog` gains **required** props `statuses: ProjectStatus[]` and `statusesPhase: ReadPhase` — no defaults, so `tsc -b` enumerates every call site. Defaulting to the four constants would put the hard-coded four back in a component and make forty tests green while proving nothing.

### `src/lib/tickets.ts`

- `:9` docblock is now wrong in mechanism but right in outcome: `status` is still left to the DB default `'todo'`, which now resolves against a `project_statuses` row rather than a CHECK constraint. Update the wording, and add: **`createTicket` needs no code change** — that is the point of the slug FK.

### `src/lib/projects.ts`

- No code change. Add to the docblock that statuses are seeded by `on_project_created_statuses`, so nobody adds a client-side seed insert that the nine raw fixture inserts across the integration suites would bypass.

### Tests that must change (this is the bulk of the diff)

| File | What |
|---|---|
| `src/lib/domain.test.ts:119-121` | `checkConstraintValues('tickets','status')` **throws** once the check is gone. Replace with: parse `seed_project_statuses()`'s VALUES list out of the schema doc and assert it equals `DEFAULT_PROJECT_STATUSES`. **Keep** the `expect(...).not.toContain('blocked')` guard, restated against `DEFAULT_PROJECT_STATUSES`. Also add `checkConstraintValues('project_statuses','category')` ≡ `STATUS_CATEGORIES`. |
| `src/lib/domain.test.ts` (new) | Structural guard: for every `create table <t>` in the schema doc, assert `alter table <t> enable row level security` and `create policy … on <t>` both exist, plus `expect(tables.length).toBeGreaterThanOrEqual(6)` so the test cannot pass vacuously if the regex stops matching. |
| `src/routes/BoardTab.test.tsx:44,107` | `ctxWith` and `boardCtx` are return-position literals annotated `: ProjectShellContext` — TS2739 without the new fields. Add the four-row fixture and `statusesPhase: 'loaded'`. |
| `src/routes/BoardTab.test.tsx:116-118,133-136,139-141` and nine heading lookups (:117, :284, :313, :330, :525, :673, :691) | These now assert against a fixture the test wrote. Keep them, but add one test that renders with an *empty* status list and asserts a visible error (scoped with `within()`, paired with a substring role-name query so an `aria-hidden` subtree cannot satisfy it). |
| `src/routes/BacklogTab.test.tsx:34` | Same `ctxWith` fix. BacklogTab renders no status, so fixtures only. |
| `src/routes/SprintsTab.test.tsx:123` | Change `} as ProjectShellContext` to an explicit `: ProjectShellContext` annotation. The file's own comment at :109-112 already argues for this and stopped one step short; leaving the cast means the new fields arrive `undefined` and the tests pass for the wrong reason. |
| `src/routes/ProjectShell.test.tsx:20-36, 41-51` | Add `listProjectStatuses` to the `vi.mock` block with a four-row `mockResolvedValue`. Without it the real supabase client is hit under jsdom, `findByRole('heading', {name:'To Do'})` at :207 times out, and the sibling `not.toBeInTheDocument()` assertions at :222/:228 pass **vacuously**. |
| `src/routes/TicketDetailDialog.test.tsx` (~40 renders) | Add `statuses` + `statusesPhase` to every render — use a shared `renderDialog()` helper. `:725-740` and `:742-763` keep their assertions but now read from the fixture. `:766` ("enabled, so a keyboard user can reach it") becomes two tests: enabled once `statusesPhase === 'loaded'`, disabled while it is not. |
| `src/lib/sprints.test.ts:308,369-372` | **Unchanged.** `toHaveBeenCalledWith('status','done')` still pins the real behaviour in this slice. |
| `src/test/tickets.integration.test.ts:63` | `toMatchObject({ …, status: 'todo' })` still passes, but now pins the seeded `is_initial` row rather than a bare column default. Re-comment it: correct for a new reason. |
| `e2e/happy-path.spec.ts:150-160` | Add `await expect(statusSelect).toBeEnabled()` before the Tab loop — a disabled `<select>` is out of the tab order and the loop cannot terminate. `:158` replace the "In Progress is index 1" ordinal assumption with an assertion of the full option order, so the spec states that In Progress is second **because `position = 2`**. `:169` and `:188-190` survive unchanged (slugs and names preserved) — check explicitly, because `e2e.yml` is not the gate. |
| `CLAUDE.md` | The "Fixed four board columns" locked-scope line and the "never inline the four column names" rule both need restating for a per-project world. If a new integration file is added, the documented `npm test` vs `test:unit` gap moves from 7 to 8 — re-derive with `npx vitest list --filesOnly \| wc -l`, never copy the number. |
| `docs/sprintboard_phase1_traceability.md` | `statuses_owner_read` needs a row in the E8 RLS-in-CI audit trail. |

---

## New isolation-suite cases

All of these go **inside** `src/test/rls.integration.test.ts`, extending existing `describe`s and `it`s. Do not open a new `describe` with fresh `signIn()` calls — sign-ins are the fuel for the documented auth rate-limit flake. B is already signed in at :29, so `projectB` costs nothing.

**1 — `beforeAll`: give B a project, and read A's seeded statuses with a NAMED failure.**

```ts
const { data: projB, error: pbErr } = await b
  .from('projects')
  .insert({ owner_id: userBId, name: "B's project", key: runKey() })
  .select()
  .single()
if (pbErr) throw new Error(`Fixture: could not create B's project: ${pbErr.message}`)
projectB = projB.id

const { data: statuses, error: stErr } = await a
  .from('project_statuses')
  .select('id, slug, name, category, position, is_initial')
  .eq('project_id', projectA)
  .order('position')
if (stErr) throw new Error(`Fixture: could not read A's seeded statuses: ${stErr.message}`)
if (!statuses || statuses.length !== 4)
  throw new Error(
    `Fixture: expected 4 seeded statuses for A's project, got ${statuses?.length ?? 0}. ` +
      'This is on_project_created_statuses or statuses_owner_read, NOT the auth rate ' +
      'limiter — do not re-run it.',
  )
statusA = statuses[0]!.id
```

The "do not re-run it" text is the load-bearing part. Without it, a plural read on a broken policy returns `{ data: [], error: null }` and `data[0].id` throws the bare `TypeError … reading 'id'` that CLAUDE.md documents as the rate-limit signature — sending the operator to a five-minute cooldown for a security defect.

**2 — In `afterAll`, delete B's project too**, as B, asserting exactly one row, alongside A's existing teardown assertion.

**3 — Seeding-trigger test, in the existing `describe('the S1.2 triggers, finally executed rather than merely catalogued')`.** Project-scoped, exact rows, exact order — the `create_project_counter` template at :113-124, including its comment about why unfiltered would flake or vacuously pass.

```ts
it('on_project_created_statuses seeded exactly the four board columns, in order', async () => {
  const { data, error } = await a
    .from('project_statuses')
    .select('slug, name, category, position, is_initial')
    .eq('project_id', projectA)
    .order('position')
  expect(error).toBeNull()
  expect(data).toEqual([
    { slug: 'todo',        name: 'To Do',       category: 'todo',        position: 1, is_initial: true  },
    { slug: 'in_progress', name: 'In Progress', category: 'in_progress', position: 2, is_initial: false },
    { slug: 'in_review',   name: 'In Review',   category: 'in_progress', position: 3, is_initial: false },
    { slug: 'done',        name: 'Done',        category: 'done',        position: 4, is_initial: false },
  ])
  // The initial status must equal tickets.status's column default, or ticket
  // creation and "where new tickets land" disagree.
  expect(data!.find((s) => s.is_initial)!.slug).toBe('todo')
})
```

**4 — The correlation test. This is the one that kills the mutation, and none of the others do.**
Dropping `and p.id = project_statuses.project_id` leaves a policy that compiles, deparses plausibly, and passes every filtered assertion — because B owns no project today.

```ts
it("A sees only A's own project statuses, never B's (indirect-ownership correlation)", async () => {
  const { data, error } = await a.from('project_statuses').select('project_id')
  expect(error).toBeNull()
  expect(data!.filter((r) => r.project_id === projectB)).toEqual([])   // negative
  expect(data!.filter((r) => r.project_id === projectA)).toHaveLength(4) // positive, same read
})

it("B sees only B's own project statuses, never A's", async () => {
  const { data, error } = await b.from('project_statuses').select('project_id')
  expect(error).toBeNull()
  expect(data!.filter((r) => r.project_id === projectA)).toEqual([])
  expect(data!.filter((r) => r.project_id === projectB)).toHaveLength(4)
})
```

The second doubles as the data-plane identity control for the new table — the job `:194-202` does with `profiles`.

**5 — One line in each of the three existing `B cannot SELECT / UPDATE / DELETE any of it` tests**, keeping each paired with its existing positive control as A:

```ts
const status = await b.from('project_statuses').select('id').eq('id', statusA)
expect(status.data).toEqual([])
```

**6 — No client may write the vocabulary at all — not even its owner.** This is the test that pins the select-only decision, and it is *expected* to be changed by SPRIN-77, consciously.

```ts
it('the status vocabulary is server-owned: even its owner cannot INSERT one', async () => {
  const { data, error } = await a
    .from('project_statuses')
    .insert({ project_id: projectA, slug: 'planted', name: 'Planted', position: 9 } as never)
    .select()
  expect(data).toBeNull()
  // OBSERVE this against the live database before pinning it. Expected 42501:
  // statuses_owner_read is FOR SELECT, so no INSERT policy exists and RLS denies
  // by default. SPRIN-79 keeps the vocabulary immutable to clients because the UI
  // cannot yet render a changed one. SPRIN-77 must change THIS TEST deliberately.
  expect(error!.code).toBe('42501')
  const asA = await a.from('project_statuses').select('id').eq('project_id', projectA)
  expect(asA.data).toHaveLength(4) // nothing landed
})

it("B cannot INSERT a status into A's project either", async () => {
  const { data, error } = await b
    .from('project_statuses')
    .insert({ project_id: projectA, slug: 'planted', name: 'Planted', position: 9 } as never)
    .select()
  expect(data).toBeNull()
  expect(error!.code).toBe('42501') // OBSERVE before pinning
  const asA = await a.from('project_statuses').select('id').eq('project_id', projectA)
  expect(asA.data).toHaveLength(4)
})
```

**7 — An anonymous caller sees nothing.** `anonClient()` performs no sign-in, so this adds zero rate-limiter pressure. `anon` holds SELECT on the table via `ALTER DEFAULT PRIVILEGES`; RLS is the only thing emptying it.

```ts
it('an anonymous caller sees no statuses at all', async () => {
  const { data, error } = await anonClient().from('project_statuses').select('id')
  expect(error).toBeNull()
  expect(data).toEqual([])
  const asA = await a.from('project_statuses').select('id').eq('project_id', projectA)
  expect(asA.data).toHaveLength(4) // positive control: the rows exist
})
```

**8 — The cascade actually cascades, checked with a role that can tell "gone" from "hidden".**
A post-teardown read as A returns `[]` whether the rows cascaded or were stranded, because once the `projects` row is gone `statuses_owner_read`'s EXISTS is false for everyone. Use `adminClient()` (RLS-bypassing, no sign-in, the sanctioned test-side privileged client), guarded by `hasServiceRoleKey`, with a positive control taken **before** the delete:

```ts
// before the project delete, in afterAll:
const before = await adminClient().from('project_statuses').select('id').eq('project_id', projectA)
expect(before.data).toHaveLength(4)
// … delete the project …
const orphans = await adminClient().from('project_statuses').select('id').eq('project_id', projectA)
expect(orphans.error).toBeNull()
expect(orphans.data).toEqual([])
```

**9 — The composite fk, in `src/test/tickets.integration.test.ts`** (which already has the two-own-projects fixture at :426-460, so it costs no sign-in). Under the select-only policy every project has an identical vocabulary, so the "slug that exists only in P2" case needs `adminClient()` to plant it — put this under `describe.skipIf(!hasServiceRoleKey)`.

```ts
// (a) The fk exists at all: a slug in no project.
// (b) The fk is COMPOSITE: a slug that exists ONLY in p2, with both projects owned
//     by A — so RLS passes on both sides and only tickets_status_fk can stop it.
// NOTE: tickets_status_fk is DEFERRABLE INITIALLY DEFERRED, so the violation
// surfaces at COMMIT. Through PostgREST that is still the same request — but
// OBSERVE the actual error shape before pinning a code.
```

**10 — The property `deferrable` was chosen for**, in `rls.integration.test.ts` or `tickets.integration.test.ts`: create a project and a ticket as A, `delete from projects`, assert exactly one row deleted and no 23503. Without this, the migration's headline safety property is covered only by a smoke test that runs once by hand.

**Tripwire:** all of the above extend existing files, so the documented `npm test` vs `test:unit` gap stays at **7**. Re-derive with `npx vitest list --filesOnly | wc -l` regardless.

---

## Open questions for David

1. **Does SPRIN-79 include the UI switch, or only the database?** I have specified it as *including* it — schema + regenerated types + `domain.ts` contract + the read + the render switch in the board and the detail dialog — because otherwise the seeded rows are inert and nothing user-facing proves they are what the board shows. The cost, measured not guessed, is: a BoardTab guard-block rewrite (two new helpers in `project-reads.ts`), three `ProjectShellContext` test-helper fixes, ~40 `TicketDetailDialog` render updates, and two E2E edits. If you would rather ship the migration alone and switch the UI in a second PR, say so — the migration and the isolation cases stand on their own, and the only change is that `domain.ts` keeps `TICKET_STATUSES`/`TICKET_STATUS_LABELS` one story longer.

2. **`security definer` on `seed_project_statuses()` is the direct consequence of the select-only policy, and it puts a second `SECURITY DEFINER` function in `public` — the schema currently has exactly one.** I think it is the right trade (the alternative is a write-open vocabulary the UI cannot render, plus a delete-guard trigger, plus a slug CHECK — more machinery for less safety). But it is a deliberate widening of the schema's one RLS-bypassing surface and it reverses the winning design's stated preference, so it is your call, not mine.

3. **`category` ships seeded and read by nothing.** I kept it because a custom status added at SPRIN-77 has no inferable category, so backfilling it later means asking the user. The honest downside is that a seeded-but-unread column looks like coverage and is not. The alternative is to drop it now and add it in SPRIN-77 with its call sites. Your call.

4. **Should SPRIN-77 be blocked on moving the terminal-status rule?** I have recorded it as a hard prerequisite in the table comment and in Risks accepted: `sprints.ts:230` and `ProjectShell.tsx:153` must move to `category = 'done'` **before** write access to `project_statuses` opens, and both must move together. If you want that enforced rather than documented, the mechanism is a test in this story that fails the moment the policy stops being SELECT-only — which case 6 above already is. Confirm that is the enforcement you want.

5. **When do you want to paste it?** The migration takes SHARE ROW EXCLUSIVE on `projects` and ACCESS EXCLUSIVE on `tickets`. `lock_timeout` is set to 5s so it aborts rather than blocking, but `authenticated` carries an 8-second `statement_timeout`, so a concurrent CI run can still be collateral damage. Check `gh run list` first.

---

## Risks accepted

- **`'done'` stays hard-coded at two mirrored call sites** (`src/lib/sprints.ts:230` `.neq('status','done')` and `src/routes/ProjectShell.tsx:153` `t.status !== 'done'`). Correct in this slice, because every project has exactly the four seeded statuses and clients cannot change them. It becomes wrong the instant SPRIN-77 opens writes, and the failure is *silent*: renaming a terminal slug makes `completeSprint` pull finished tickets back into the backlog and strip their sprint history, while `sprints.test.ts:308` stays green because it asserts the literal.

- **`category` is seeded, constrained and tested for value, but no application code reads it.** Nothing in `npm run verify` would notice if it were semantically wrong beyond the exact-value assertion.

- **`lg:grid-cols-4` at `BoardTab.tsx:212` still hard-codes "four" in the layout.** No grep for a status value finds it, and Tailwind cannot take a runtime value in a class name. Behaviour-preserving today because every project has four columns; wrong for the first project with a fifth.

- **`tickets.status` keeps a static `default 'todo'`.** Safe only while the vocabulary is immutable to clients. SPRIN-80 must replace it with `is_initial` resolution *in the same story* that allows a status to be deleted or renamed — and that trigger perturbs `assign_ticket_key`'s documented "NULL then NOT NULL aborts" security property, so it deserves its own review.

- **Nothing enforces "a project has at least one status."** A CHECK cannot span rows, and I have deliberately not built a delete-guard trigger — there is no delete path to guard in this slice. SPRIN-80 inherits it as a named hand-off, not an oversight.

- **`deferrable initially deferred` moves a rejected status from a statement-time 23514 to a commit-time 23503.** This is the price of cascade-order independence and it is not negotiable. It means the new database-edge error arrives further from its cause, and any future RPC that batches writes will surface it at a confusing point.

- **The `revoke execute` on `seed_project_statuses()` rests on EXECUTE being checked at CREATE TRIGGER time rather than at fire time.** I believe that is correct, and the in-transaction smoke test gates it — but I could not execute the migration to confirm (the MCP is `read_only=true`, deliberately). If the smoke test raises `permission denied for function`, drop the revoke line and re-paste.

- **The whole migration is unrun.** Every statement was reasoned against the live catalogue and the constructs most likely to bite were parse-tested against the real database (`returns table (position int)` really is a syntax error — 42601; the `create table` body parses to 25006, past the parser). But no statement has executed. Treat it as a draft until the AFTER queries come back clean.

- **RI checks always bypass RLS**, so the fk is evaluated without row security. It is not a cross-tenant existence oracle, because the composite key's leading column is `project_id` and `tickets_owner`'s WITH CHECK rejects a foreign `project_id` with 42501 before the fk's AFTER trigger runs. That ordering is reasoning, verified once at `rls.integration.test.ts:228-235` for a different constraint — **it must be re-derived, not assumed, when SPRIN-75 rewrites `tickets_owner` for a membership model.**

- **`sprints.status` is untouched and must not be "generalised" by anyone reading this as a template.** `sprints_one_active_per_project` is a partial unique index whose predicate cannot contain a subquery, so it cannot be rebuilt against a foreign key, and CLAUDE.md's one-active-sprint rule would lose its enforcement outright. SPRIN-79 is ticket statuses only.
