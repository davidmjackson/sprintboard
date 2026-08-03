# SPRIN-82 implementation plan — a Kanban project has no sprints

**Spec:** `docs/superpowers/specs/2026-08-03-sprin-82-kanban-no-sprints-design.md`
**Branch:** `sprin-82-kanban-no-sprints`, base `bfcea3f`

Five tasks, strictly sequential, a fresh subagent each, reviewed after each. Task 5's live
assertion is red until the migration is hand-applied; that transition is deliberate evidence
and is driven by the orchestrator, not the subagent.

---

## Global constraints — every task, no exceptions

These do not travel with a subagent's context. Restate them in every dispatch.

**Verification commands.**

- `npm run lint` and `npm run format:check` — both, every task. Prettier failures are the
  most common red in this repo and `lint` does not catch them.
- `npm run test:unit` for the fast loop.
- **Never `npx tsc --noEmit`.** It checks **zero files** in this repo and exits 0 — it is a
  proxy that has reported green on a red branch.
- **Never `npm test`, and never the `*.integration.test.ts` suites.** They sign real users
  into GoTrue; repeated runs trip its rate limiter and turn CI red on an innocent branch.
  The orchestrator runs the full gate once, at the end.

**Lint thresholds (`npm run lint`, errors not warnings).** 30-line functions, cyclomatic 10,
cognitive 15, 4 parameters, 400-line files.

- **A default parameter costs one cyclomatic point.** Measured on this branch. This is the
  single constraint that shapes task 4.
- Measure, never estimate: `npx eslint <file> --rule '{"complexity":["error",1]}'` reports
  every function's real count.
- A genuine misfit is an ADR in `docs/adr/`, never an inline disable.

**Domain rules.**

- **Status, type and project-type values live in `src/lib/domain.ts` and nowhere else.**
  Never write `project_type === 'kanban'` (or `'scrum'`) in a component, a filter or a test
  helper. Call `hasSprints`.
- Never introduce a Postgres `ENUM`. `project_type` is `text` + a `check`.

**Testing rules.**

- **Every absence assertion carries a positive control in the same test.** "The Sprints link
  is not in the document" passes just as well when the whole header failed to render. This is
  the named, expected failure mode of this epic — a bare absence assertion will be rejected
  at review.
- **Accessible names: substring or regex, never exact**, for any element whose name is
  composed of several children (`{ name: /sprint/i }`, not `{ name: 'Sprint · Active' }`).
  jsdom does not compute the name a browser does for Tailwind-styled composites. An exact
  name is fine only for a single text node or an `aria-label`.
- Native `<select>` is this codebase's picker, and `userEvent.selectOptions` drives it.

**Reporting.** The plan's code is a **starting point, not gospel**. Deviating to match an
established repo pattern is correct — and every deviation must be reported back. Prefer
reporting BLOCKED over inventing an approach.

---

## Task 1 — `hasSprints` in `domain.ts`

**Files:** `src/lib/domain.ts`, `src/lib/domain.test.ts`,
`src/test/project-type-single-expression.test.ts` (new)

Add, below the existing type guards:

```ts
/**
 * Whether a project delivers work in sprints. THE single expression of the rule —
 * no component, filter or test may write `project_type === 'kanban'` itself.
 *
 * Same discipline as `doneSlugs()` being the single derivation of "terminal"
 * (SPRIN-77): two call sites reading the raw string can drift, one predicate cannot.
 *
 * Deliberately not `isKanban`. "Has sprints" and "has WIP limits" are two different
 * questions that share an answer while there are exactly two project types; a third
 * would separate them and a single negated predicate would not survive it.
 * `hasWipLimits` arrives in SPRIN-85 with its first caller — added now it would be
 * an unreferenced export and `knip` would say so.
 *
 * Takes the narrowest shape it reads so a test can pass `{ project_type: 'kanban' }`
 * without inventing eight irrelevant columns; a full `Project` is assignable.
 */
export function hasSprints(project: Pick<Project, 'project_type'>): boolean {
  return project.project_type === 'scrum'
}
```

**Tests in `domain.test.ts`:** `hasSprints` is true for `'scrum'` and false for `'kanban'`;
drive it from `PROJECT_TYPES` so a third project type cannot be added without this test
having an opinion about it.

**New file `src/test/project-type-single-expression.test.ts`** — AC5's pin. Read every
non-test `.ts`/`.tsx` under `src/` and assert the literal `kanban` appears in none of them
except `src/lib/domain.ts`.

- Reuse `SRC_ROOT` / `sourceFiles` from `src/test/source-ast.ts` if they fit; read the file
  before assuming their signatures.
- **Positive control in the same test:** assert the scan actually visited a non-zero number
  of files, and that it *does* find the literal in `domain.ts`. Without that, a scan whose
  glob matched nothing passes perfectly.
- The docblock must state the limitation honestly: this is a **text scan**, so it fails open
  on obfuscation (a computed key, `String.fromCharCode`). It is proportionate because the
  positive half of the rule is pinned by the behaviour tests in tasks 2–4; it catches only
  the regression AC5 names — a second, inlined comparison beside a correct one. It does not
  close the general "values live in `domain.ts`" gap, which needs a lint rule and an ADR.

**Done when:** `npm run test:unit`, `npm run lint`, `npm run format:check` all clean.

---

## Task 2 — the Sprints nav link (AC1)

**Files:** `src/routes/ProjectShellHeader.tsx`, `src/routes/ProjectShell.test.tsx`

In `ProjectShellHeader`, render the Sprints `NavLink` only when `hasSprints(project)`. The
component already takes `project`, so nothing is threaded. It is at 2/10 cyclomatic — one
branch is free. Board, Backlog and Settings are unconditional.

**Tests** go in `ProjectShell.test.tsx`, which already has both fixtures — `PROJECTS`
(scrum) and `KANBAN_PROJECTS` — and a `renderShell(path, ctx)` helper. Read them before
writing.

1. **Kanban: no Sprints link.** `renderShell('/projects/p1/board', { projects:
   KANBAN_PROJECTS, loading: false })`. Assert the Sprints link is absent — **and in the
   same test** that the Board, Backlog and Settings links are present and the `Kanban` badge
   is present. Those are the positive controls; without them the test passes on a header
   that failed to render at all.
2. **Scrum: the Sprints link is present.** The other half of AC4.

Scope link queries with `within(...)` on the `nav`, so "the text appears somewhere on the
page" cannot stand in for "the link exists".

**Done when:** the three commands are clean, and **task 2's first test fails before the
component change and passes after** — state that you observed both.

---

## Task 3 — the deep-link redirect (AC2)

**Files:** `src/routes/SprintsTab.tsx`, `src/routes/SprintsTab.test.tsx`,
`src/routes/ProjectShell.test.tsx`

In `SprintsTab`, after the `useOutletContext` destructuring (hooks must stay unconditional)
and before anything else:

```tsx
// Absent, not merely hidden. Hiding the nav link leaves the URL live, and this tab would
// otherwise offer CreateSprintDialog on a project that has no sprint concept. `replace`
// keeps the dead URL out of history, so Back does not bounce the user straight into it.
if (!hasSprints(project)) return <Navigate to="../board" replace />
```

`../board` is relative to the `sprints` child route and resolves to `/projects/:id/board`.
7/10 → 8/10 cyclomatic.

**⚠ THE TRAP.** `SprintsTab.test.tsx:47` reads:

```ts
const project = { id: 'p1', name: 'Sprintboard', key: 'SPB' } as Project
```

No `project_type`. The cast hides it, so `hasSprints` reads `undefined`, returns false, and
**every existing test in that file redirects and fails.** Add `project_type: 'scrum'` to that
fixture. That edit is legitimate — behaviour now depends on a field the fixture never set —
and it is the only edit this task makes to existing assertions.

**Tests:**

1. In `ProjectShell.test.tsx`: `renderShell('/projects/p1/sprints', { projects:
   KANBAN_PROJECTS, loading: false })` renders **board** content, and the `Sprints` heading
   is absent. The board content *is* the positive control — it proves the redirect landed
   somewhere real rather than the tab rendering nothing.
2. Same path with `PROJECTS` (scrum) renders the `Sprints` heading. AC4's half.
3. In `SprintsTab.test.tsx`, a direct-render case for a Kanban project asserting no sprint
   UI, with a scrum control beside it.

**Done when:** the three commands are clean, and the whole pre-existing `SprintsTab.test.tsx`
suite passes with only the fixture line changed.

---

## Task 4 — extract `TicketSprintField` (AC3)

**Files:** `src/routes/TicketSprintField.tsx` (new), `src/routes/TicketSprintField.test.tsx`
(new), `src/routes/TicketDetailSidebar.tsx`, `src/routes/TicketDetailDialog.tsx`,
`src/routes/ProjectShell.tsx`, `src/routes/ProjectShell.test.tsx`

**Read §3 of the spec before starting.** The obvious implementation turns the gate red, and
the reason is not obvious.

The budget, measured on this branch's base:

| File | Now | Must end at |
|---|---|---|
| `TicketDetailDialog` | 10 / 10 | 10 — **no default parameter, no conditional** |
| `ProjectShell` | 10 / 10 | 10 — a function call is not a branch |
| `TicketDetailSidebar` | 9 / 10 | 9 — the picker moves out, nothing is added |

**Move** the sprint picker — the `<TicketReferenceSelect label="Sprint" …>` block at
`TicketDetailSidebar.tsx:136-166` **and its two docblocks** — into
`src/routes/TicketSprintField.tsx`. The reasoning travels with the code; do not leave it
behind and do not rewrite it.

```tsx
export function TicketSprintField({
  ticket,
  sprints,
  sprintsPhase,
  commit,
  hasSprints = true,
}: { … }) {
  if (!hasSprints) return null
  return <TicketReferenceSelect … />
}
```

- `hasSprints = true` is the **only** default in the chain. It lives here because this file
  has the headroom (it ends at complexity 3) and because "a standalone render shows the
  picker" is this component's decision to state.
- `TicketDetailSidebar` and `TicketDetailDialog` declare `hasSprints?: boolean` and forward
  it **with no destructuring default**. A default in either turns `lint` red.
- `ProjectShell` passes `hasSprints={hasSprints(project)}` to `TicketDetailDialog`.

**Do not edit `TicketDetailDialog.test.tsx`.** All 52 render sites omit the new optional
prop, the default supplies `true`, and the suite passing **unedited** is the evidence the
extraction changed no behaviour. If a test there fails, that is a real finding — report it,
do not adjust the test.

**Tests:**

1. `TicketSprintField.test.tsx` — renders the picker when `hasSprints` is true, renders
   nothing when false, and renders it when the prop is omitted (the default). The absence
   case needs a positive control: assert the picker IS there in the true case of the same
   suite.
2. **The seam test, in `ProjectShell.test.tsx`** — this is the one that matters. Open a
   ticket's detail dialog on a **Kanban** project and assert no `sprint` picker, **with the
   `status`, `type` and `assignee` pickers present in the same test** as the control; then
   the same on a Scrum project asserting the `sprint` picker IS present. Per-component tests
   cannot see this seam: task 4 could wire `hasSprints` to nothing at all and both
   component suites would still pass. Reuse the existing pattern for opening the dialog from
   a board card (`onBoard`, `activeSprint`).

**Done when:** the three commands are clean, every file lands at the complexity in the table
above (paste the measurements), and `TicketDetailDialog.test.tsx` is byte-for-byte unchanged.

---

## Task 5 — the migration, and the RLS test it breaks

**Files:** `docs/migrations/sprin-82-projects-immutable.sql` (new),
`docs/sprintboard_phase1_schema.sql`, `src/test/projects.integration.test.ts`,
`src/test/rls.integration.test.ts`, `src/test/project-type-immutability.test.ts`

**Read §§5–6 of the spec first.** This task writes SQL and tests; it does **not** run the
live suites and does **not** apply the migration. The orchestrator applies it by hand.

**5a. The migration.** Follow `docs/migrations/sprin-81-project-type-kanban.sql` for house
style: a banner explaining what and why, one explicit `begin; … commit;`, a re-run note, and
a post-state verification block.

```sql
revoke update on projects from authenticated, anon;
```

Facts to state in the banner, all measured live rather than assumed:

- `pg_class.relacl` for `projects` reads `authenticated=arwdDxtm` and `anon=arwdDxtm` — both
  hold table-wide UPDATE. `project_statuses` reads `ardDxtm`, so SPRIN-77's revoke held.
- **No columns are granted back**, because nothing in `src/` updates `projects` — only
  `insert` (`projects.ts:40`) and `select` (`projects.ts:67`). This is therefore not the
  `project_statuses` shape, and the "a column REVOKE cannot hole a table grant" trap does
  not arise: the table privilege itself is what is revoked.
- It closes a **data-integrity** hole, not a tenant-isolation one — `projects_owner` already
  confined the write to the owner's own row. What it prevents is an owner stranding their
  own sprints behind a UI that no longer shows them.
- The cost: a future "rename a project" story must `grant update (name)` before it can work.

The post-state block should re-read `relacl` and show the `w` is gone for both roles.

**5b. The schema doc.** Add the same revoke to `docs/sprintboard_phase1_schema.sql`, beside
the `project_statuses` grant block (~line 718), with a short comment. This file is parsed by
`domain.test.ts`, so keep the existing formatting conventions exactly.

**5c. The new live assertion**, in the existing `src/test/projects.integration.test.ts` (an
existing file, so the CI tripwire gap stays at seven):

> **the owner's own** `project_type` update on **their own** project is refused

- Assert `error.code === '42501'`. **Not merely that an error exists** — an RLS-filtered
  update is `error === null` with zero rows, and only the code distinguishes the grant from
  the policy. This whole story turns on that distinction.
- Then re-select the row and assert `project_type` is still `'scrum'`.
- **Positive control in the same test:** the same client can still SELECT that project.
  Without it the test passes when the fixture was never created.
- Owner rather than stranger is the point: a stranger was already blocked by RLS, so a
  stranger-only test would pass on the unmigrated database and prove nothing.
- The update needs a cast to get past `TablesUpdate`; follow the `as never` idiom already
  used at `rls.integration.test.ts:350` and say why in a comment — the point is to prove the
  DATABASE holds, not the type.

**5d. Repair `rls.integration.test.ts:387-404`.** After the revoke, `b.from('projects')
.update({ name: 'pwned' })` returns 42501 with `data === null`, so `expect(project.data)
.toEqual([])` fails.

**Delete the `projects` line and its expectation**, leaving `sprints` and `tickets` — which
still hold table-wide UPDATE and so still genuinely exercise RLS *filtering*. Add a comment
saying where `projects` UPDATE coverage went and why it moved.

**Do not "fix" it by changing `[]` to `null`.** The line would then pass because of the
grant, so deleting `projects_owner` would no longer redden it — two controls on one write,
and the test can no longer tell you which is holding.

**5e. Correct the AST guard's docblock.** `src/test/project-type-immutability.test.ts` opens
with "There is no database control behind that sentence." That is false as of this
migration. Rewrite that paragraph, and the "WHEN A LEGITIMATE PROJECT UPDATE ARRIVES"
paragraph, to describe two layers. State why both stay and why neither masks the other:
they fail on **disjoint mutations** — restoring the grant reddens the live test only;
adding a `.update({ project_type })` to `src/` reddens the AST guard only.

**Change no check in that file.** Only prose.

**Done when:** `npm run lint`, `npm run format:check` and `npm run test:unit` are clean.
`test:unit` excludes the integration suites, so 5c and 5d are not exercised here — that is
expected, and the orchestrator verifies them after applying the migration.

---

## After the tasks

1. Orchestrator hands David the migration as one copy-paste command; `get_advisors`
   afterwards, expecting the count unchanged at 8 WARN + 3 INFO (the pre-existing
   `auth_rls_initplan` set, which SPRIN-75 fixes wholesale).
2. Watch 5c go red → apply → green. That transition is the evidence the test tests the
   migration.
3. One adversarial reviewer in its own worktree, briefed to mutate, with the absence tests
   and their positive controls named as the first target. Plus the standing security review.
4. Orchestrator runs `npm run verify` in full and checks the tripwire gap is seven files
   with 0 skipped.
