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

**The mechanism, corrected after review.** The first draft of this spec said
`dom-accessibility-api` "performs no layout, so it treats every element as inline". That is false
and refutable in one command: it reads `getComputedStyle(child).display` and inserts a separator
for any non-inline child (`accessible-name-and-description.js`, the `separator` line). The jsdom
cell of the table below contains two spaces, which the claim could not explain.

The divergence has **two** causes and needs both:

1. **The test document loads no stylesheet.** Tailwind's `flex` never enters the cascade, so each
   `<span>` falls back to the UA default `inline` and earns no separator.
2. **jsdom does not blockify flex children.** Chrome does, and that is what actually separates the
   parts — `getComputedStyle` on the row button's six span children returns `block` for all but
   one.

Measured with Chrome DevTools Protocol `Accessibility.getPartialAXTree` and, on the jsdom side,
`computeAccessibleName`. Both columns are the **same ticket in the same state** — blocked, five
points, assigned — and both are post-change, so the table does not go stale the day it lands:

| Surface | jsdom (`dom-accessibility-api`) | Chrome (real accname) |
|---|---|---|
| Board card | `MP-1 BlockedStory5story points Wire the board` | `MP-1 BLOCKED STORY 5 story points Wire the board` |
| Backlog row | `MP-1StoryWire the boardBlocked5story pointsAssigned todev@example.com` | `MP-1 STORY Wire the board BLOCKED 5 story points Assigned to dev@example.com` |

**What was and was not confirmed directly.** The Chrome half was: three spans under a
`display:flex` button give `MP-1 Story Wire the board`, and under a default button
`MP-1StoryWire the board`. The first draft of this spec presented that pair as proof of the *jsdom*
claim too — it is not, and cannot be: run the identical pair under jsdom and **both** give
`MP-1StoryWire the board`, because jsdom ignores the blockification entirely. A Chrome-only
measurement was being used to certify a claim about jsdom. That is the right answer by the wrong
road, which is the failure mode this section invokes by name; it was caught in review and the jsdom
half has since been measured separately.

So the fusion is a test-environment artefact. Building the original ACs — injecting comma
separators until the jsdom string read nicely — would have made the real browser name *noisier*
while pinning a fiction. The original AC6 ("pin each name with an exact-string name query") was
the most dangerous line in the story: it would have written the artefact into the suite as a
requirement.

**Verified in Chromium only.** Firefox and WebKit are not installed on this machine, so this spec
claims Chrome behaviour and the general spec rule about blockification, not universal agreement.
Chrome also uppercases via `text-transform` when computing the name (`STORY`), where Playwright's
independent accname implementation does not — another reason not to treat any single engine's
string as the truth.

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
- **The trailing space inside the `sr-only` span is not load-bearing *for the accessible name*.**
  Chrome separates blockified nodes on its own (`sr-only` computes to `display:block;
  position:absolute`), and the accname algorithm trims each node's text contribution — the existing
  `" story points"` proves that, since its *leading* space is what jsdom discards. It **is** pinned
  by the order assertion's text-content regex, which reads the raw DOM rather than the name;
  deleting the space reddens that test. Both statements are true and the distinction matters: the
  name does not depend on it, the DOM-text assertion does.
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
- **DOM text alone proved insufficient, and review caught it.** The first draft asserted only that
  the text existed under the button carrying class `sr-only`. Three mutations survived that, each
  reverting the story's entire deliverable with every test green: `aria-hidden="true"` on the
  prefix, `className="sr-only hidden"`, and moving the prefix to a *suffix*. The remedy is three
  more assertions, none of them an exact name:
  1. a **substring** name query (`getByRole('button', { name: /assigned to/i })`). It honours
     `aria-hidden` where `getByText` does not — `getByText` ignores only `<script>`/`<style>` — and
     it is engine-independent precisely *because* it is not exact. Reaching for "assert DOM text,
     never the name" and stopping there skipped the one query that both complies with the new rule
     and closes the worst gap.
  2. an **exact class** assertion. `toHaveClass` is a subset check, so `sr-only hidden` passes it.
  3. an **order** assertion on the cell's text content. "Prefix, not suffix" is a stated design
     decision above and was pinned by nothing.
  4. an assertion that the **value itself stays visible** — `getByText(email)` must resolve to the
     cell, not to some wrapper. Review rated this one unkillable in jsdom; it is not. `getByText`
     matches the element whose *direct* text children match, so wrapping the email in `sr-only`
     (which blanks the cell on screen) moves the match and reddens it.
- **Mutation proof required before the work is called done.** Eight mutations, all killed, and the
  matrix re-run **in full** after the tests changed rather than only for the new cases — changing a
  test can silently un-kill a mutation it already killed. Delete the prefix; move it outside the
  `<button>`; drop `sr-only`; prefix both branches; `aria-hidden="true"`; `sr-only hidden`;
  suffix-not-prefix; wrap the value in `sr-only`; **widen the predicate to `assignee_id != null`**,
  which announced the viewer's own address over a ticket assigned to somebody else — a false
  ownership claim that all 65 other tests passed. Nine in total.
- **A claim that stopped being true, and the correction.** The `within(row)` scoping *was*
  separately proven load-bearing against the first draft: with the prefix moved outside the button,
  the scoped test went red while a byte-identical unscoped assertion passed 5/5. Adding the
  substring name query then made the two overlap — that mutation now reddens the name query as
  well, so removing the scoping alone no longer goes green. The scoping stays (it is the assertion
  that names the property), but "proven load-bearing" is no longer the right description and has
  been corrected here, in the test comment and in the PR body. A defence that is currently
  redundant is not the same as one that is unnecessary — and a fix that silently invalidates the
  evidence for an earlier claim is exactly how overlapping defences mask each other.

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
