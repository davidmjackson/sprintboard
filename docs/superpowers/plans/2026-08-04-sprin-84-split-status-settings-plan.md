# SPRIN-84 implementation plan — split `StatusSettings.tsx`

Design: `docs/superpowers/specs/2026-08-04-sprin-84-split-status-settings-design.md`.
Branch: `sprin-84-split-status-settings`, based on `8f0543a`.

One task. It is code motion, not authorship — the correct diff moves lines between files and
rewires imports, and invents no new prose, no new props and no new behaviour.

## Global constraints (every task, no exceptions)

- **Do not open, edit, rename or create any `*.test.tsx` / `*.test.ts` file.** The unedited
  suite passing is this story's entire evidence. If you believe a test must change, you have
  changed behaviour: stop and report BLOCKED instead.
- **Move docblocks and comments verbatim with the code they document.** Do not reword, shorten,
  reflow, re-indent beyond what the new nesting requires, or "improve" them. They record
  reasoning from earlier stories. A paraphrase is a defect in this story.
- **Do not add a new test file**, and do not add any new component, prop or abstraction beyond
  the two files named below.
- Thresholds are enforced as **errors**: 30-line functions, cyclomatic 10, cognitive 15, 4
  parameters, 400-line files. Scope is `**/*.{ts,tsx,mjs,js}`.
- **Verification is `npm run verify`.** `npx tsc --noEmit` checks **zero files** in this repo
  and exits 0 — it proves nothing. `npm run test:unit` is NOT the gate either.
- Formatting is Prettier via `npm run format:check`, included in `verify`. Run `npm run format`
  if it complains rather than hand-aligning.

## Task 1 — extract the row cluster

### 1a. Create `src/routes/StatusRow.tsx`

Move, **verbatim**, from `src/routes/StatusSettings.tsx` (line numbers as of `8f0543a`):

- lines **60–84** — the `DeleteStatusError` type alias and the `DELETE_FAILURE_COPY` record,
  with their docblocks;
- lines **86–342** — `StatusRow`, `StatusDeleteDialog`, `StatusDeleteControl`, with their
  docblocks.

`StatusRow` is the only **exported** symbol of the new file (`export function StatusRow`). The
other four stay module-private, exactly as they are private today.

Its import block is the subset the moved code actually uses:

- `useState` from `react`
- `ArrowDown`, `ArrowUp` from `lucide-react`
- `type ProjectStatus` and `STATUS_CATEGORY_LABELS` from `@/lib/domain`
- `deleteBlockReason`, `deleteProjectStatus`, `removeStatus`, `renameProjectStatus` from
  `@/lib/project-statuses`
- `RenameStatusSchema` **and `DUPLICATE_NAME`** from `@/lib/status-schemas`
- `Button` from `@/components/ui/button`
- the `AlertDialog` family actually referenced — `AlertDialog`, `AlertDialogCancel`,
  `AlertDialogContent`, `AlertDialogDescription`, `AlertDialogFooter`, `AlertDialogHeader`,
  `AlertDialogTitle` — from `@/components/ui/alert-dialog`
- `GENERIC_CREATE_ERROR` from `./CreateDialog`
- `EditableText` from `./EditableText`

Match the existing file's import ordering and grouping convention (react/vendor first, then
`@/lib`, then `@/components/ui`, then `./` siblings). Do not add a barrel or an index file.

### 1b. Move `DUPLICATE_NAME` to `src/lib/status-schemas.ts`

Cut lines **40–45** of `StatusSettings.tsx` (the docblock and the `const`) and paste them into
`src/lib/status-schemas.ts` as an **exported** const: `export const DUPLICATE_NAME = …`. Keep
the docblock verbatim. Place it near the other name-rule copy in that module.

Both `StatusRow.tsx` and `StatusSettings.tsx` then import it from `@/lib/status-schemas`,
alongside the schema each already imports from there. This adds **no new import edge** in
either direction. Do **not** export it from `StatusSettings.tsx` or from `StatusRow.tsx` — the
parent importing from the child it renders would be an import cycle.

### 1c. Rewire `src/routes/StatusSettings.tsx`

- Delete the moved regions.
- Add `import { StatusRow } from './StatusRow'` to the sibling import group.
- **Prune the imports that left with the cluster.** After the cut, `StatusSettings.tsx` no
  longer uses `ArrowDown`, `ArrowUp`, `EditableText`, `RenameStatusSchema`, any `AlertDialog*`,
  `deleteBlockReason`, `deleteProjectStatus`, `removeStatus` or `renameProjectStatus`. Leaving
  them reddens lint. Keep what `AddStatusForm` and `StatusSettings` still use — including
  `Button` if and only if it is still referenced (check; do not assume either way).
- Everything else — `STALE_LIST`, `AddStatusForm`, the exported `StatusSettings`, its props,
  its JSX, its `move()` — is untouched. `<StatusRow … />` is called with exactly the same props
  as today.

### Verification for task 1 (run all of these, report the actual output)

```
npx eslint src/routes/StatusSettings.tsx src/routes/StatusRow.tsx \
  --rule '{"max-lines":["error",{"max":1,"skipBlankLines":true,"skipComments":true}]}'
```

Report the **counted line number for each file**. Expected: `StatusSettings.tsx` well under
400 (roughly 175–185), `StatusRow.tsx` roughly 215–230. Neither near 400 is the AC.

```
npm run verify
```

Must be green. Report the test file count and the pass/skip counts verbatim.

`git status --porcelain` must show exactly three modified/added paths:
`src/routes/StatusRow.tsx`, `src/routes/StatusSettings.tsx`, `src/lib/status-schemas.ts`.
**Any `*.test.*` path appearing there is a failure of this task.**

## Definition of done

- AC1: both files have real headroom, evidenced by the measured counts above.
- AC2: `git status` proves no test file was touched, and the unedited suite is green.
- AC3: `npm run verify` green in full, 0 skipped, live suites collected.
