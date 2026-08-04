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

Epic 73 has six stories: 81, 82, 83, 84 done; **85 (WIP limit)** and **86 (over-limit board)**
remain, plus **87** (below), which should land before 85.

## Session log

Newest first. One paragraph each — detail is in the linked PRs, specs and git history.

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
- **`createProjectStatus`'s `max(position)+1`** is derived from a list nothing refetches. The
  *failure* is honest (`'stale'`), the staleness is not. Note `is_initial` **is** writable on
  INSERT, guarded by a partial index.
- **Leaked Password Protection** is recommended but has **never been confirmed enabled** in the
  Supabase dashboard. If it is on, the hardcoded signup password in `e2e/happy-path.spec.ts`
  becomes the risk — randomise it.

## What CI cannot pin

Anything PostgREST cannot read is invisible to the test suite, because the live suites reach the
database through it and it cannot read `pg_catalog`. Supabase advisors are not in CI either.

- `set search_path` and `revoke execute` on RPCs; policy and constraint **shape**; table **grants**.
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
- **The status delete path** — see SPRIN-87.

## Settled — do not re-raise

- **"Fused accessible names"** — disproven. It is a jsdom artefact; no browser produces those
  names. Cost a story to find out; see `CLAUDE.md`.
- **`check-bundle.mjs`'s "deleted `icons.svg`"** — that line narrates the deletion, it is not a bug.
- Orphaned fixture projects — gone. **SPRIN-58** — unbuilt, deliberately. **T7 / 80% coverage** and
  everything from Rung 2 — out of scope.

> A **project rename** story owes three specific things before it can work. They are stated in
> `CLAUDE.md` (the `projects` UPDATE revoke section) — not repeated here, so the two cannot drift.
