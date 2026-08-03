# SPRIN-82 — A Kanban project has no sprints

**Story:** SPRIN-82, story 2 of epic SPRIN-73 (Rung 3.2)
**Depends on:** SPRIN-81 (`project_type` is `('scrum','kanban')`, live) — merged as `bfcea3f`
**Epic design:** `docs/superpowers/specs/2026-08-03-sprin-73-kanban-project-type-design.md` §6 story 2
**Date:** 2026-08-03

The epic design already settles what this story does. This spec records the four decisions
it left open, the measurements behind them, and one consequence nobody had noticed: the
migration this story adds **breaks an existing live RLS test**, and the honest repair is not
to make it green again but to change what it asserts.

---

## 1. Scope

The five ACs, unchanged from the epic:

1. A Kanban project shows no Sprints tab link.
2. Navigating directly to `/projects/:id/sprints` on a Kanban project redirects to the
   board, and no sprint UI renders.
3. A Kanban project's ticket detail has no sprint picker.
4. A Scrum project is unchanged on all three.
5. `hasSprints` is the only expression of the rule.

Plus one addition, approved by David before design began and **not** in the epic doc:

6. The database refuses an UPDATE to `projects` — making SPRIN-81's app-layer immutability
   claim a database control. §5.

Out of scope, and deliberately: the board's ticket selection, the sprint caption, the
filters, and the Backlog tab's label. All of that is SPRIN-83.

## 2. The rule lives in `domain.ts`

```ts
export function hasSprints(project: Pick<Project, 'project_type'>): boolean {
  return project.project_type === 'scrum'
}
```

`Pick<>` rather than `Project` because every call site passes a full `Project` (which is
assignable) while a test can pass `{ project_type: 'kanban' }` without inventing eight
irrelevant columns. That is the same reason `statusOptions` and `doneSlugs` take rows
rather than a project.

**`hasWipLimits` is NOT added here.** The epic declares both predicates, but story 5 is the
first caller and `knip` reports an unreferenced export. It arrives with its consumer.

### Why a predicate rather than a raw comparison (AC5)

Identical reasoning to `doneSlugs()` being the single derivation of "terminal" (SPRIN-77):
two call sites reading `project_type === 'kanban'` can drift; one predicate cannot. There
are three consumers in this story alone, and stories 3, 5 and 6 add more.

**How AC5 is pinned.** A new test asserts the string `'kanban'` appears in no non-test file
under `src/` except `domain.ts`. That is a text scan and it fails open on obfuscation
(`String.fromCharCode`, a computed key) — stated plainly rather than dressed up. It is
proportionate because the *positive* half of the rule is pinned by behaviour: the three
absence tests below go red if a component stops consulting the predicate. The text scan
catches only the specific regression AC5 names, which is a second, inlined comparison
sitting quietly beside a correct one.

## 3. Where the conditional lives, and why the obvious answer is wrong

Measured on this branch's base, not recalled:

| Site | Cyclomatic | Headroom |
|---|---|---|
| `TicketDetailDialog` | **10 / 10** | none |
| `ProjectShell` | **10 / 10** | none |
| `TicketDetailSidebar` | 9 / 10 | one |
| `SprintsTab` | 7 / 10 | three |
| `ProjectShellHeader` | 2 / 10 | plenty |

**A default parameter costs a cyclomatic point.** Measured directly rather than recalled —
a probe function with one defaulted parameter reports complexity 2, with two defaults, 3.
So the natural `hasSprints = true` prop on `TicketDetailDialog` would take it to **11/10 and
turn `npm run lint` red**, and `TicketDetailDialog` is the one file in the chain that cannot
absorb a single point. The prop must therefore arrive there **without** a destructuring
default.

That constraint cascades. `hasSprints?: boolean` forwarded undefined has to be defaulted
*somewhere*, and everywhere it could go is at or near the ceiling:

- Default in the sidebar (+1) **and** the conditional (+1) → 11/10. Red.
- No default, conditional written as `hasSprints !== false` → 10/10 and passes, but encodes
  "undefined means show" as a `!== false` idiom with nothing naming the intent.
- Required prop everywhere → **52 render sites** in `TicketDetailDialog.test.tsx` to edit.
  Mechanical, but it buries this story's real diff in churn and drops the dialog's
  "renders standalone without wiring" property.

### The decision: extract `TicketSprintField`

The sprint picker — a `TicketReferenceSelect` and the ~15 lines of docblock explaining the
backlog-is-`sprint_id is null` rule — moves into `src/routes/TicketSprintField.tsx`, which
owns the conditional:

```
ProjectShell            hasSprints={hasSprints(project)}   free (a call, not a branch)
  TicketDetailDialog    hasSprints?: boolean, forwarded    +0  → stays 10/10
    TicketDetailSidebar hasSprints?: boolean, forwarded    +0  → stays  9/10
      TicketSprintField hasSprints = true, early return    complexity 3 in a new file
```

Every file in the chain ends at or below where it started, the "absent prop means show it"
default is stated once in the file whose entire job is that decision, and the sidebar keeps
its one point of headroom for SPRIN-71's custom fields. It is also a cohesion win
independent of the lint budget: the sprint field's reasoning travels with the sprint field.

**Existing tests must not be edited to accommodate it.** Every current sidebar test renders
through `TicketDetailDialog`, so the DOM is unchanged and an unedited suite passing is the
evidence the extraction changed no behaviour ([[refactor-under-an-unedited-test-file]]).

## 4. The redirect (AC2)

`SprintsTab` returns `<Navigate to="../board" replace />` when `!hasSprints(project)`, after
its `useOutletContext` call and before any sprint markup — so "no sprint UI renders" is
structural rather than a claim. 7/10 → 8/10.

`../board` is relative to the `sprints` child route, resolving to `/projects/:id/board`;
`replace` keeps the dead URL out of history so Back does not bounce.

**Hiding the nav link is not enough and this is why the epic said so**: the URL stays live,
and `SprintsTab` would otherwise render `CreateSprintDialog` against a project that has no
sprint concept.

## 5. The migration — immutability stops being prose

SPRIN-81 shipped AC5 ("the type cannot change after creation") as an **app-layer** property
pinned by an AST guard over `src/`. Its own migration file says the hardening "was
deliberately left out of this story's scope". SPRIN-82 is the story that makes behaviour
depend on the column, so it picks it up.

**Measured live before writing the SQL** — `pg_class.relacl`:

| Table | `authenticated` | Reading |
|---|---|---|
| `projects` | `arwdDxtm` | holds `w` — table-wide UPDATE |
| `project_statuses` | `ardDxtm` | SPRIN-77's revoke held |

```sql
revoke update on projects from authenticated, anon;
```

**No columns are granted back**, because nothing in `src/` updates `projects` at all — only
`insert` (`projects.ts:40`) and `select` (`projects.ts:67`). This is therefore *not* the
`project_statuses` shape: there is no column-level grant to get wrong, and the
[[column-revoke-cannot-hole-a-table-grant]] trap does not arise, since the table privilege
itself is what is being revoked.

`anon` is included because it holds the same `arwdDxtm` and has no policy on the table
anyway; leaving a privilege in place that nothing may use is how the next audit gets a
false positive.

**The cost, stated plainly:** a future "rename a project" story must grant `name` back
before it can work. That is the correct direction — deny by default, widen deliberately —
and it is one line in that story's migration.

### What this does NOT do

It does not stop the *owner* from being the one who could have done it — it stops
*everyone* holding the privilege. It is not a tenant-isolation fix, because there was never
a cross-tenant hole here: `projects_owner` already confined the write to the owner's own
row. It closes a **data-integrity** hole — an owner stranding their own sprints behind a
UI that no longer shows them.

## 6. The consequence nobody had noticed

`src/test/rls.integration.test.ts:387-404`, "B cannot UPDATE any of it", counts rows:

```ts
const project = await b.from('projects').update({ name: 'pwned' }).eq('id', projectA).select()
expect(project.data).toEqual([])
```

That is correct *today* and correct *for the reason stated in its own comment*: RLS filters,
it does not raise, so an unauthorised update returns success with zero rows.

**After the revoke it returns a 42501 with `data === null`, and the assertion fails.**

Making it green again by changing `[]` to `null` would be the worst available repair. The
line would then pass because of the grant, so **deleting `projects_owner` would no longer
redden it** — B is refused by the privilege before any policy is consulted. That is
[[overlapping-defences-mask-each-other]] exactly: two controls on one write, and the test
can no longer tell you which one is holding.

**The repair:** drop the `projects` line from that test, leaving `sprints` and `tickets` —
which still hold the table-wide UPDATE grant, so they still genuinely exercise RLS filtering
— and add a comment saying where `projects` UPDATE went and why. `projects` keeps its
cross-tenant coverage for SELECT (`:370`), and for DELETE and INSERT elsewhere in the suite;
nothing is lost, because there is no longer any UPDATE privilege for RLS to filter.

The new assertion lives in `src/test/projects.integration.test.ts` and says the honest
thing: **the owner's own** `.update({ project_type: 'kanban' })` on **their own** project is
refused with `42501`, and the row still reads `scrum` afterwards. Owner rather than stranger
is the point — a stranger was already blocked, so a stranger-only test would pass on the
unmigrated database and prove nothing.

It goes in an **existing** `*.integration.test.ts` file so the CI tripwire gap stays at
seven files.

### The AST guard stays, and its docblock is now wrong

`src/test/project-type-immutability.test.ts` opens with "There is no database control behind
that sentence." That becomes false with this migration and must be rewritten — a guard whose
docblock misdescribes the world is how the next person deletes the wrong one.

Both layers stay, and they do not mask each other, which is the test that matters after §6:
they fail on **disjoint mutations**. Restoring the grant reddens the live test and leaves the
AST guard green; adding a `.update({ project_type })` to `src/` reddens the AST guard and
leaves the live test green. Neither is the other's backstop, so neither hides the other's
regression.

## 7. Tests

Every absence assertion carries a **positive control in the same test** — the epic names
this as the single likeliest way the epic ships broken and green, because "the Sprints link
is not in the document" also passes when the whole header failed to render.

| AC | Assertion | Positive control in the same test |
|---|---|---|
| 1 | Kanban: no `Sprints` nav link | Board, Backlog and Settings links **are** there, and the `Kanban` badge **is** |
| 1 / 4 | Scrum: `Sprints` link is present | — (this test *is* the control) |
| 2 | Kanban `/sprints`: board content renders, no `Sprints` heading | Scrum `/sprints` renders the `Sprints` heading |
| 3 | Kanban detail: no `sprint` picker | `status`, `type` and `assignee` pickers **are** there |
| 3 / 4 | Scrum detail: `sprint` picker present | — |
| 5 | `'kanban'` appears in no non-test `src/` file but `domain.ts` | the scan sees a non-zero number of files |
| 6 | owner's own `project_type` UPDATE → `42501`, row still `scrum` | the same client can still SELECT the project |

Two rules carried in from memory, both load-bearing here:

- **Assert on the error `code`, not merely that an error exists.** A 42501 is the grant; an
  RLS-filtered update is `error === null` with zero rows ([[rls-tests-pass-for-the-wrong-reason]]).
  Only the code distinguishes them, and this whole story turns on the distinction.
- **Query accessible names by substring, never exact.** jsdom does not compute the names a
  browser does for Tailwind-styled composites (CLAUDE.md, SPRIN-67). `{ name: /sprint/i }`,
  not `{ name: 'Sprint · Active' }`.

## 8. Files

| File | Change |
|---|---|
| `src/lib/domain.ts` | `hasSprints` |
| `src/lib/domain.test.ts` | its unit tests |
| `src/routes/ProjectShellHeader.tsx` | Sprints link conditional (2 → 3) |
| `src/routes/SprintsTab.tsx` | redirect (7 → 8) |
| `src/routes/TicketSprintField.tsx` | **new** — the picker and its conditional |
| `src/routes/TicketDetailSidebar.tsx` | picker moves out, prop forwarded (9 → 9) |
| `src/routes/TicketDetailDialog.tsx` | prop forwarded, **no default** (10 → 10) |
| `src/routes/ProjectShell.tsx` | `hasSprints={hasSprints(project)}` (10 → 10) |
| `docs/migrations/sprin-82-projects-immutable.sql` | **new** |
| `docs/sprintboard_phase1_schema.sql` | the revoke, beside the `project_statuses` grants |
| `src/test/projects.integration.test.ts` | the 42501 assertion |
| `src/test/rls.integration.test.ts` | `projects` UPDATE line removed, §6 |
| `src/test/project-type-immutability.test.ts` | docblock corrected, checks untouched |

No change to `src/App.tsx`: the route stays, the component redirects. No change to
`BacklogTab` or `BoardTab` — those are SPRIN-83.

## 9. Review depth

Not a security-boundary diff by the project's definition — no authentication, no tenant
isolation, no secret handling, no CI-gate change. The migration is a **privilege
revocation**, which narrows rather than widens, and the app has no consumer of the privilege
being removed.

**One adversarial reviewer**, in its own worktree, briefed to mutate rather than read — with
the absence tests and their positive controls named as the first thing to attack, since a
vacuous absence test is this epic's declared failure mode. Plus the standing end-of-build
security review.
