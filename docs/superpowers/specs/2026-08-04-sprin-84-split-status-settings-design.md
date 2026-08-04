# SPRIN-84 — Split `StatusSettings.tsx`

Story 4 of epic SPRIN-73 (Kanban project type). Independent of stories 1–3, but **must land
before SPRIN-85**. Epic design:
`docs/superpowers/specs/2026-08-03-sprin-73-kanban-project-type-design.md`.

**Pure refactor.** No migration, no policy, no grant, no CI-gate change, no behaviour change,
no new feature. Nothing here touches a security boundary.

## Why the story exists, measured rather than recalled

`src/routes/StatusSettings.tsx` is at **exactly 400 of 400** counted lines (`max-lines` with
`skipBlankLines` and `skipComments`). Measured on `8f0543a`:

```
npx eslint src/routes/StatusSettings.tsx \
  --rule '{"max-lines":["error",{"max":1,"skipBlankLines":true,"skipComments":true}]}'
→ File has too many lines (400).
```

One added line reddens `npm run lint`, and `npm run verify` runs `npm run lint`. SPRIN-85 adds
a WIP-limit control to this screen — the epic design says *"Settings shows a numeric input **per
status** when `hasWipLimits(project)`"* — so story 5 cannot add a line to this file, nor to the
row it must actually change.

## Acceptance criteria

1. The file has real headroom afterwards, not one spare line.
2. **No test file is edited.** An unedited suite passing is the evidence the behaviour is
   unchanged.
3. `npm run verify` is green.

## Where the cut goes, and why there

The file holds five things. Their counted-line weights were measured by feeding each region
through `eslint --stdin`, not estimated:

| Region | Counted lines |
|---|---|
| `DeleteStatusError` + `DELETE_FAILURE_COPY` + `StatusRow` + `StatusDeleteDialog` + `StatusDeleteControl` (raw lines 60–342) | **204** |
| everything else — imports, `DUPLICATE_NAME`, `STALE_LIST`, `AddStatusForm`, `StatusSettings` | **196** |

204 + 196 = 400, which is the arithmetic check that the regions are exhaustive and disjoint.

**The cut is the row cluster → `src/routes/StatusRow.tsx`.** Three reasons, in order of weight:

1. **It is where story 5 actually writes.** A WIP input *per status* is a row concern. Splitting
   the add-form out instead would leave the row — the thing story 5 must grow — in the file that
   has no room. Headroom in the wrong file is not headroom.
2. **It is the cohesive unit.** `StatusRow` → `StatusDeleteControl` → `StatusDeleteDialog` is a
   single ownership chain (the docblocks already say each was split from the one above it purely
   to stay under thresholds), and `DELETE_FAILURE_COPY`/`DeleteStatusError` are consumed by
   nothing outside it. The parent's remaining surface is exactly one import: `StatusRow`.
3. **It splits the file near-evenly** — ~205 each side before import redistribution, so neither
   file is left near a threshold. Shaving to a pass was explicitly rejected by the story; this is
   headroom on both sides.

### What each file ends up importing

Roughly twenty import lines move with the cluster (`ArrowUp`/`ArrowDown`, the whole
`AlertDialog` family, `EditableText`, `RenameStatusSchema`, and `deleteBlockReason` /
`deleteProjectStatus` / `removeStatus` / `renameProjectStatus`), so `StatusSettings.tsx` lands
**well below** its 196, and `StatusRow.tsx` above its 204 by its own import block. Both keep
substantial headroom, which is AC1.

`GENERIC_CREATE_ERROR` is imported from `./CreateDialog` by both files. That is not duplication
to fix — it is the existing precedent for a route module exporting shared copy to a sibling.

### The one genuinely shared thing: `DUPLICATE_NAME`

`DUPLICATE_NAME` is used by the row's rename **and** by `AddStatusForm`, and its docblock says
so deliberately: they are the same conflict on the same case-insensitive per-project index, and
two copies would drift. After the cut its two consumers are in two files, so it needs a home.

- **Rejected: leave it in `StatusSettings.tsx` and import it from `StatusRow.tsx`.** The parent
  imports the child; the child importing back is an **import cycle**. Not a style objection.
- **Rejected: export it from `StatusRow.tsx`.** No cycle, but it makes the add form's copy a
  detail of the row, which is backwards.
- **Chosen: `src/lib/status-schemas.ts`, exported.** That module already owns every user-facing
  sentence about a status *name* (`'Give the status a name'`, the 40-character message, the
  a–z/0–9 message) and its docblock already explains that uniqueness is *deliberately not* a
  schema rule but the index's job, surfacing as a `'duplicate'` write result. `DUPLICATE_NAME`
  is the words for exactly that sentence. Both consumers already import from this module, so
  this adds **zero new import edges** and cannot introduce a cycle (`status-schemas` imports only
  `./domain` and `./project-statuses`).

## What must not change

- **Every docblock travels verbatim with the code it documents.** This file's comments carry
  reasoning that cost earlier stories to learn — the cleared-before-the-no-op-check rename bug,
  why `count` stays `undefined` rather than `?? 0`, why `promoted` is guarded on `is_initial`,
  why `DELETE_FAILURE_COPY` is total rather than partial. A refactor that paraphrases them
  destroys the thing the file is most valuable for. Move, do not rewrite.
- **`StatusSettings`'s public surface.** `SettingsTab.tsx` and `StatusSettings.test.tsx` both
  import `{ StatusSettings }` from `./StatusSettings`; that export, its props and its behaviour
  are untouched.
- **No new test file.** The extracted components are covered through their parent, matching
  `TicketDetailHeader.tsx`, `TicketDetailSidebar.tsx`, `TicketActionDialogs.tsx` and
  `EditableText.tsx`, none of which has its own suite. Adding one would also be the *only* way
  this pure refactor could move the CI test-file tripwire.

## How AC2 is honoured, and why it is the real evidence

`StatusSettings.test.tsx` (580 lines) is not opened, not edited, not renamed. It exercises the
rows, the rename, the delete control, the confirm dialog and the add form through the parent —
so if the extraction changes any behaviour, an **unedited** suite goes red. That is a stronger
signal than any assertion this story could add, and it is why the story forbids touching it.

The verification is `npm run verify` in full — never `tsc --noEmit`, which checks zero files in
this repo and exits 0 regardless.
