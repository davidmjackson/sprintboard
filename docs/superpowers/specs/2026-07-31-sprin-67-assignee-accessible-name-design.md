# SPRIN-67 — Label the backlog row's assignee for screen readers

**Status:** design approved (autopilot, 2026-07-31)
**Epic:** E7 Board (SPRIN-7)
**Branch:** `sprin-a11y-names`

---

## The story this started as, and why it changed

SPRIN-67 was opened from the SPRIN-65 follow-up list to fix ticket-card and backlog-row
accessible names that appeared to fuse into a run-on string:

```
MP-1 Story5story points Wire the board
MP-1StoryWire the boardBlocked5story pointsdev@example.com
```

That observation was reproduced exactly — under Vitest. **It does not reproduce in a browser**,
and the difference is not a detail.

`dom-accessibility-api`, the implementation Testing Library uses under jsdom, performs no layout.
It therefore treats every element as inline and concatenates sibling text with no separator.
Chrome computes the name from the **rendered box tree**. Every part of a card and a row is a flex
item, and flex children are **blockified** — so Chrome inserts separators where jsdom cannot know
to.

Measured with Chrome DevTools Protocol `Accessibility.getPartialAXTree`, on markup matching the
components (same classes, same nesting, same `sr-only` definition):

| Surface | jsdom (`dom-accessibility-api`) | Chrome (real accname) |
|---|---|---|
| Board card | `MP-1 Story5story points Wire the board` | `MP-1 BLOCKED STORY 5 story points Wire the board` |
| Backlog row | `MP-1StoryWire the boardBlocked5story pointsdev@example.com` | `MP-1 STORY Wire the board BLOCKED 5 story points dev@example.com` |
| Unassigned row | — | `MP-2 BUG Second one Unassigned` |

The mechanism was **confirmed directly rather than inferred**, because a mechanistic rationale is
a hypothesis until tested. The same three spans:

```html
<button style="display:flex">  <!-- children blockified -->  →  MP-1 Story Wire the board
<button>                       <!-- children truly inline -->  →  MP-1StoryWire the board
```

So the fusion is a test-environment artefact. Building the original ACs — injecting comma
separators until the jsdom string read nicely — would have made the real browser name *noisier*
while pinning a fiction. The original AC6 ("pin each name with an exact-string name query") was
the most dangerous line in the story: it would have written the artefact into the suite as a
requirement.

**Verified in Chromium only.** Firefox and WebKit are not installed on this machine, so this spec
claims Chrome behaviour and the general spec rule about blockification, not universal agreement.

## What is actually wrong

One thing, and it is real in every engine: **the assignee is announced bare.**

The row ends `… 5 story points dev@example.com`. Every other part of the row is self-describing —
the key looks like a key, the type is a word, the story-points badge carries its unit via the
`sr-only` text S5.1 added for exactly this reason. The assignee is the only value announced with
no indication of what it is. `Unassigned` happens to read as self-describing; an email does not.

Two things were considered and deliberately left out:

- **`text-transform: uppercase` reaches the accessible name.** Chrome announces `STORY` and
  `BLOCKED`. That is real, and arguable — some screen readers spell all-caps words out. It is a
  different question with a different remedy (change the DOM text, or drop the CSS transform), and
  it touches the visible design. Its own story, if wanted.
- **Punctuation between parts.** The browser name is a run-on but correctly separated. Jira's own
  cards read the same way. Adding commas is taste, not a defect, and every comma is a thing that
  can drift out of sync with the visible design.

## The change

`BacklogTab.tsx`, the assignee cell only:

```tsx
{ticket.assignee_id === currentUser.id ? (
  <>
    <span className="sr-only">Assigned to </span>
    {currentUser.email || 'You'}
  </>
) : (
  'Unassigned'
)}
```

Decisions, with reasoning:

- **`sr-only` text, not `aria-label`.** The cell is a `<span>`, which maps to `role="generic"`, and
  ARIA 1.2 *prohibits* `aria-label` there. Browsers honour it anyway, so it looks fine and axe-core
  reports `aria-prohibited-attr` (serious). This is the identical call S5.1 made for story points,
  and the reason to prefer it holds again here: `sr-only` is **real DOM text**, so
  `getByText(/assigned to/i)` works and a negative assertion gets a positive control. An
  `aria-label` on a roleless span gives neither.
- **Prefix, not suffix.** It must precede the value it labels, or it reads as a trailing fragment.
- **Only on the assigned branch.** `Unassigned` is already a complete statement; prefixing it would
  produce "Assigned to Unassigned".
- **The trailing space inside the `sr-only` span is cosmetic, not load-bearing.** Chrome separates
  blockified nodes on its own, and the accname algorithm trims each node's text contribution — the
  existing `" story points"` proves this, since its *leading* space is what jsdom discards. The
  space is kept for the plain-DOM-text reading, not relied upon.
- **No change to `TicketCard`.** It renders no assignee. Its name is correct in a browser.

## Testing

The trap this story is about is a test that pins jsdom's fiction, so the test design is the
delicate part.

- **No test asserts an exact accessible name.** Under jsdom that string is not what any user
  hears. This is written into the spec, the code comment, and `CLAUDE.md`.
- **What is asserted is DOM text and its position** — the two properties that are true in every
  engine and that the fix actually establishes:
  1. `Assigned to` is present on an assigned row, and absent on an unassigned one (a negative
     assertion with a positive control, per S5.1).
  2. It is **inside the row's `<button>`**. This is AC4 and it is the one that matters: the whole
     `sr-only` decision rests on "the row is a `<button>`, so this text joins its accessible name."
     SPRIN-65 hit exactly this: its points badge was moved outside its button and all 12 tests
     stayed green, because `screen.getByText` searches the whole document and says nothing about
     *where*. Scope the query with `within(button)`.
- **Mutation proof required before the work is called done**: move the `sr-only` span outside the
  `<button>` and confirm the scoped test goes red while an unscoped one would not.

No live integration test. This is a client-only render change with no query, write or RLS
contract — the same reasoning as S7.3. The tripwire gap stays 7; a *constant* gap after a
client-only story is correct, not a sign the live suites skipped.

No Playwright test. The browser is the only place the accessible name is real, which is an
argument for E2E coverage — but `e2e.yml` is deliberately **not** the gate, so a browser assertion
there would not protect the merge, and the story does not justify making it required. The honest
position is recorded in the PR's "Not verified here": the browser behaviour was measured by hand
during design and is not pinned by any automated check.

## Documentation

`CLAUDE.md` gains a short subsection under the testing material: accessible names computed under
jsdom are not what a browser computes, why (no layout, so no blockification), and the standing
rule — **never assert an exact accessible name in Vitest; assert DOM text and its container
instead.** This is AC5 and it is the durable half of the story. The code change is four lines; the
reason the original four-AC version of this story was wrong is the part worth keeping.

## Out of scope

Everything on the locked-scope and parked lists. No schema change, no security boundary, no
`domain.ts` change, no new dependency, no visible design change.
