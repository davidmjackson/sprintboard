# SPRIN-87 — Pin the status delete path

**Story:** [SPRIN-87](https://david-jackson.atlassian.net/browse/SPRIN-87) · epic SPRIN-73 (Kanban).
**Shape:** tests only. No production code changes, no migration, no security boundary.

Filed by the SPRIN-84 adversarial review: 73 mutations planted, 59 killed, **14 survived**, and
every survivor was pre-existing code that SPRIN-84 moved byte-for-byte. SPRIN-84's own AC2 was
"no test file is edited" — the unedited suite passing *was* that story's evidence of no behaviour
change — so the fixes had to become their own story. This is it.

It lands **before SPRIN-85**, which threads a WIP-limit prop through `StatusRow`/
`StatusDeleteControl`. Pinning the cluster first means 85 is refactoring under tests rather than
into a hole.

---

## What is unpinned today, and why each matters

| # | Survivor | Severity |
|---|---|---|
| 1 | `deleteProjectStatus(status.id)` — the **argument** is asserted by nothing | Critical |
| 2 | The dialog's three in-flight guards: `if (deleting) return`, Cancel `disabled`, Delete `disabled` | Important |
| 3 | The rename's zod-failure branch — uncovered and user-reachable | Important |
| 4 | `DELETE_FAILURE_COPY.last` and `.stale` — rewordable to the generic copy with nothing red | Important |

**#1 is the one that is actually destructive.** `mockDelete` is the only one of the four mocks in
`StatusSettings.test.tsx` with no `toHaveBeenCalledWith` at all (`mockCreate` has one, `mockRename`
one, `mockReorder` two). Because `onDeleted(status.id)` *is* asserted, replacing the write's
argument with a literal leaves the shell removing the right row optimistically while the database
loses a different status: silent, destructive, and green.

---

## Decisions

### The tests go in `StatusSettings.test.tsx`, not a new `StatusRow.test.tsx`

SPRIN-84 split the component; it did not split the suite, and this story is the wrong place to.
Every one of these tests renders `StatusSettings` — the composition is what executes the delete
path, and the sibling cases they strengthen (`calls onDeleted after a successful delete`,
`surfaces a has_tickets refusal`) already live in that file's `deleting a status` block. A second
file would duplicate the fixture vocabulary, `renderSettings`, `rowFor`/`deleteRowFor`, and split
one behaviour across two places.

`max-lines` is **off** for `**/*.{test,spec}.{ts,tsx,mjs}` (`eslint.config.js:90`), so the 580-line
file growing is not a threshold question. Verified rather than assumed.

### Cancel's `disabled` is pinned by the attribute, because the two guards overlap

`if (deleting) return` in `onOpenChange` and `disabled={deleting}` on Cancel both prevent a close
mid-flight. So a behavioural test — "click Cancel while deleting, the dialog stays open" — passes
with *either* one removed, and pins neither. That is
[[overlapping-defences-mask-each-other]] exactly.

So they are pinned on different observations:

- **`if (deleting) return`** — by **Escape**, which reaches `onOpenChange` without going through
  the Cancel button at all. This is the only close path that is not itself disabled, and therefore
  the only one where that guard is the sole defence.
- **Cancel's `disabled`** — by `toBeDisabled()`. Asserting the mechanism is the honest choice here
  rather than a lapse: with the other guard standing, the attribute is the *only* observable
  difference, and a disabled control is itself the user-facing property (not focusable, visibly
  unavailable).
- **Delete's `disabled`** — by both: `toBeDisabled()` **and** the consequence, a second click
  sending no second write. Nothing else guards this one, so the double-click test is real.

### The rename zod branch gets two cases, not one

The empty name (`min(1)`) is the reachable one: `EditableText` commits whenever `draft !== value`,
so clearing the field and pressing Enter reaches it. But a single case leaves
`setError(parsed.error.issues[0]?.message ?? …)` mutable to a hardcoded `'Give the status a name'`
and still green. A second case at 41 characters — a different schema message from the same
expression — kills that. Two cheap tests, one real mutation each.

### `last` and `stale` are driven through the mock, as `has_tickets` already is

`last` is gated in the UI (`deleteBlockReason` disables Delete on a one-status list) and `stale` is
a race. Both are still reachable write results, and the existing `has_tickets` test already
establishes the pattern: open the dialog on a status the UI permits, and let the mock return the
refusal.

**Each is asserted with an ANCHORED regex, `/^…$/`.** The first version of this section said they
were asserted "twice — it says its own specific thing, and it is *not* the generic retry sentence",
and that second assertion was never written; the tests asserted the bare sentence and the docblock
called it exact. It is not. `toHaveTextContent` with a string is a **substring** match, so
appending the generic retry copy to the end of the sentence — the precise mutation these tests
exist to kill — left the whole suite green. Review caught it, measured; anchoring is what makes
"this sentence and nothing else" true, and it subsumes the pair the spec originally promised.

`has_tickets` was pinned by the fragment `/move them/i` and is now anchored to the same standard,
for the same reason: it could lose its entire explanation of *why* and stay green.

### What review added, and why the "out of scope" line moved

The original plan was to fix the four ACs and record everything else. Three reviewers (two mutating
in isolated worktrees, one read-only security pass) changed that, and the honest reason is that the
findings were **Important**, not that the scope was renegotiated:

- **Two of them were defects in my own new tests** — the substring/anchoring gap above, and a
  fixture docblock claiming an inert `waitFor` was the synchronisation point when `await u.click`
  already flushes. A third traded one coupling for another and the commit message overclaimed it.
- **`submit()`'s `setError(null)`, which this section originally deferred, turned out to have a
  MIRROR** in `move()`. Fixing one of two mirrored call sites is a mistake this project has made
  twice. Both are pinned, and so is the fixture that could not tell a slug from a lowercased name —
  it left the reorder payload and the counts lookup unprotected at once.

**Still out of scope, deliberately, and recorded rather than fixed:**

- The singular `1 ticket` label. The code is correct; only the coverage is missing (mutation 22).
- `EditableText`'s own `draft !== value` guard, which the row's trim guard shadows on every path
  this file exercises. It cannot be pinned from here — it needs a component-level test (mutation 23).
- Wiring `aria-describedby` from a disabled Delete button to the sentence explaining it. The test
  now refuses an `aria-hidden` reason, but the relationship itself is a **production** change, and
  this is a tests-only story.
- A successful delete never calls `setConfirming(false)`; the dialog closes only because the parent
  removes the row and unmounts it. Real today, latent if the shell ever refetches instead of splicing.

---

## Acceptance criteria → test

| AC | Test |
|---|---|
| 1 | `sends the id of the status being deleted, not merely the id it reports back` |
| 2 | `keeps the dialog open on Escape while the delete is in flight`; `disables both footer buttons while the delete is in flight`; `sends only one delete when Delete is clicked twice` |
| 3 | `refuses an emptied name at the client edge, without a write`; `refuses an over-long name with the schema's own message` |
| 4 | `explains a last-status refusal in its own words`; `explains a stale refusal in its own words` |
| 5 | Every test above is run against a mutated source and observed **failing** before being accepted. Recorded in the PR body as a matrix. |
| 6 | `npm run verify` green, 0 skipped, tripwire gap 7. No file outside `StatusSettings.test.tsx` changes. |

## Process deviations, recorded

- **No plan document.** The ACs already name each assertion, its file and its target. A plan would
  restate them — the ceremony SPRIN-55 retired.
- **No subagent-driven development.** This is one test file whose conventions are subtle and
  unwritten in the file itself (SPRIN-67 scoping discipline, no exact composed accessible names,
  `within()` on every DOM-text assertion). A context-free implementer is a worse bet than direct
  edits here, and the mutation proof — which *is* the story — has to run in one tree anyway.
  Precedent: runs 2 and 10. The saved effort goes into the review.
