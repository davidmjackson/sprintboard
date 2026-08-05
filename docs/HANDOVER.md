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
custom statuses (**SPRIN-72, done**) → Kanban project type (**SPRIN-73, in progress**) → custom
fields (71) → sprint cadence (74) → **teams, roles and permissions (75 — the security boundary,
deliberately last)**.

Epic 73 has six stories: 81, 82, 83, 84, **85** and 87 done. **Only 86 (the board flags an
over-limit column) remains**, and it is the last story of the epic. `wip_limit` exists, is
writable, and is inert until 86 renders it — deliberately, and nothing reads it yet.

## Session log

Newest first. One paragraph each — detail is in the linked PRs, specs and git history.

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

- **Is a deadlock reachable** between the SPRIN-80 delete guard's `FOR UPDATE` on `projects` and
  the `projects → project_statuses` RI cascade? The migration records this **unresolved**. If
  reachable it is rare, non-corrupting and retryable (`40P01`). The lock's mutual exclusion is
  **untested** — a single transaction has no second session to contend with. Deserves its own story.
- **`lg:grid-cols-4` in `BoardTab` is a fixed column count** under a status list users can now
  grow — a fifth status wraps. Deferred three times; needs a layout story.
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
