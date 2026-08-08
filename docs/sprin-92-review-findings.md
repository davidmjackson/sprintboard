# SPRIN-92 adversarial review — recovered findings

Recovered 2026-08-08 from run `wf_ffa450d8-7f8`, pinned to SHA `79137b3`.

**Status of the review itself — read this first.** Five finder lenses ran in separate worktrees.
Four journaled results; the fifth (`wiring-and-seams`) was killed before reporting and its
54-mutation matrix was reconstructed from its transcript. **The Verify (skeptic) and Synthesise
phases never ran**, so there is no KILLED list and *nothing below has been adversarially
verified*. Mutation counts per lens: 12, 9, 13, 14, 54 — no lens reported zero.

Items marked ✔ were re-checked against the code/test shape by hand; the mutation outcomes
themselves are agent-reported.

## Tier 1 — security coverage (CLAUDE.md mandates this)

1. **`project_field_options` has ZERO cross-tenant and zero anon assertions.** All 8 references
   in `rls.integration.test.ts` (block at :2769-2990) use client `a`. Every sibling table has
   B-coverage: `project_statuses` (:381, :466, :540, :1532), `project_fields` (:1691),
   `ticket_field_values` (:2512, :2518). It is the only one of the four holding a table-wide
   `grant delete ... to authenticated` whose delete **cascades into ticket data** via
   `tfv_option_fk`, so `options_owner_delete` is the sole barrier. Policies verified correct in
   the live catalogue today — this is a missing control, not a present leak. Nothing would catch
   their loss under SPRIN-75. `docs/migrations/sprin-92-project-field-options.sql:105` already
   claims "a live test proves it". It does not exist.
   Fix: B-read, B-insert, B-update, B-delete with **row-count** assertions (RLS filters, it does
   not raise), plus anon. Shape already used at `rls.integration.test.ts:466`.

## Tier 2 — the defect class this branch has paid for five times

2. ✔ **`SettingsTab.tsx:123` — `optionsPhase` crossed with `fieldsPhase` survives.** The same
   cross one level down in `CustomFieldSettings` is killed (M15). Sixth instance of the class,
   and the second time the hole sat one level *above* where it was closed.
3. ✔ **`countTicketsHoldingOption(fieldId, option.slug)` arguments unpinned** — found
   independently by 4 of 5 lenses. `mockCount` has no `toHaveBeenCalledWith` anywhere; the three
   sibling call sites in the same file are all pinned. Swap the args, or pass `option.label`, and
   the confirm dialog reports **0 tickets** and *unlocks* the destructive Remove. Seam control:
   the same swap on `deleteProjectFieldOption` goes red immediately.
4. ✔ **`ProjectShell` option reducers keyed on slug alone survive.** Every option fixture in
   `ProjectShell.test.tsx` carries `field_id: 'f1'` (:319, :326, :1067, :1120, :1140), so the
   tests literally named "by (field_id, slug)" never exercise the `field_id` half. Cross-field
   slug collision is the *designed* state — the PK is `(field_id, slug)` and
   `createProjectFieldOption` de-duplicates within one field only. (`onOptionDeleted` may be
   caught incidentally by TS6133 on the now-unused param; that is not a guard.)
5. ✔ **`optionsForField(...)` slice dropped at BOTH ticket `<select>` sites survives**
   (`TicketCustomFields.tsx:281`, `CreateTicketCustomFields.tsx:244`). Both test files define two
   select fields but give options only to `RISK.id`. The Settings-side sibling *is* pinned.

## Tier 3 — correctness

6. ✔ **`createProjectFieldOption`'s `as ProjectFieldOption` cast suppresses TS2739**
   (`project-field-options.ts:123`). Narrowing the returning `.select()` compiles clean with the
   cast; the sibling `renameProjectFieldOption` has no cast and *is* caught. Removing the cast
   typechecks clean — a one-word fix that restores the compiler as the guard.
7. **`renameProjectFieldOption` leans on `.single()`'s incidental zero-row error** rather than an
   explicit row count — third recorded instance of this class (after `renameProjectStatus`). The
   `delete` sibling ten lines below has the correct shape *and* a docblock explaining why.

## Tier 4 — cheap and real

8. `"1 tickets will lose this value"` — the `count === 1` branch is never exercised (fixtures use
   only 3 and 0).
9. **`docs/sprintboard_phase1_schema.sql` is missing the entire grant/revoke block** for
   `project_field_options`. A rebuild from the doc hands `authenticated` table-wide UPDATE, making
   `slug` patchable and losing the AC3 database guarantee. Every sibling table's block is present.
10. Option fixtures use `slug === label.toLowerCase()`, contradicting their own docblock at
    `CustomFieldOptions.test.tsx:41-44`, which makes a slug/label `ariaLabel` slip invisible.

## Deferrable

Four untested guards in the confirm dialog: count-reset-on-close (`CustomFieldOptions.tsx:248`),
`if (deleting) return` on Escape (:243), `setError(null)` ordering (:364), and confirm disabled
while the count is in flight (:280).

## The `wiring-and-seams` matrix — 68 mutations, 8 survivors, 5 grouped findings

This lens outlived its orchestrator and finished on 2026-08-08 at ~17:26, mid-recovery. It never
emitted a structured result (the schema tool died with the workflow), so this matrix is read from
its transcript. It ran the full unit suite (68 files / 1244 tests) after each mutation, restoring
with `git checkout --` between, and confirmed four findings with throwaway probe tests that pass
clean and fail mutated. **Its worktree stayed isolated — the main tree was never touched.**

| Survivor | Grouped finding |
|---|---|
| M7 update reducer slug-only, M9 delete reducer slug-only | #4 composite key |
| M13 SettingsTab `optionsPhase<-phase` | #2 |
| M25 count args crossed, M67 count `value_option<-fieldId` (silent zero) | #3 |
| M30 / M31 `optionsForField` dropped at both ticket select sites | #5 |
| M58 option list React `key={option.slug}` -> `key={fieldId}` | #11 (below) |

The other 60 were killed.

11. **`CustomFieldOptions.tsx` — the option list's React `key` can be changed to `fieldId`
    with all 21 tests in the file green**, and no duplicate-key warning is surfaced. Every option
    on a field then shares one key. Same root as #4: the fixtures never put two fields' options in
    one list, so nothing distinguishes a per-option key from a per-field one.
