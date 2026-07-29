# SPRIN-61 — Keyboard and touch path for board status change

**Story:** S7.4, under E7 Board (`SPRIN-7`).
**Date:** 2026-07-29.
**Bar for done, set by David before design:** an *equivalent* keyboard- and touch-operable
path. **Not** the full WCAG grab/lift/move/drop keyboard pattern, and **not** pointer-event
touch drag. Both were offered and both were declined.

---

## The defect

S7.2 made the board writable by native HTML5 drag. Drag is the **only** way a ticket's
status ever changes:

- `BoardTab.tsx:151` wires `onDragStart` on each card; `handleDrop` (`:89`) is the only
  caller of `moveTicket` (`:59`), the only status write in the app outside the backlog.
- `TicketDetailHeader.tsx:37` renders `TICKET_STATUS_LABELS[ticket.status]` as **read-only
  text**.
- `TicketDetailSidebar.tsx` has pickers for type, parent epic, sprint, assignee, story
  points and labels — **and no status picker**.

Native HTML5 drag fires no events for touch and has no keyboard equivalent. So a keyboard
user, a screen-reader user, and anyone on a tablet cannot move a ticket out of To Do **at
all**. This is a total loss of the board's one write, not a degraded experience.

It is also worse than the board: the **backlog** has no drag either, so from the backlog
there is no status path for *any* input device.

## The diagnosis that decides the design

The path to a status control already exists end to end for keyboard and touch — it just
ends at a control that isn't there.

A board card is a real `<button>` (`TicketCard.tsx:23`) whose `onClick` calls
`onOpenTicket`. A `<button>` is in the tab order, activates on Enter/Space, and taps on
touch. So **every user can already reach the ticket detail dialog without a pointer**.
What is missing is the last control: the dialog shows status but does not let you change
it.

That reframes the story from "add a second status-change mechanism to the board" to "add
the missing field editor to the dialog, where every other ticket field is already edited".

## Decision: a Status `<select>` in the ticket detail sidebar

Add a **native `<select>`** for status to `TicketDetailSidebar`, as the **first** field in
the Details panel, above Type. It writes through the existing `commit()` from
`useTicketCommit`.

### Why this and not a control on the board card

Three approaches were considered.

**A. A "Move to" control on each board card** (Radix `DropdownMenu`, or a `<select>`).
Fewest steps on the board, and it would route through `moveTicket`, reusing its rollback.
Rejected on two grounds. First, the card is a `<button>`, and an interactive control cannot
be nested inside a `<button>` — it is invalid HTML and the inner control's events would also
trigger the card's `onClick`. Making it work means restructuring `TicketCard` into a
container with a separate clickable region, which puts the existing click-to-open and drag
behaviour at risk for no functional gain over B. Second, `sprintboard-frontend-conventions`
records a deliberate S4.3 decision that per-ticket action menus live in the dialog header,
**not** on board or backlog cards.

**B. A Status `<select>` in the dialog sidebar** — chosen. It mirrors the Type `<select>`
immediately below it, line for line: same `selectClass`, same `aria-label` convention, same
`commit()` call. It touches one component, adds no new interaction pattern, and fixes the
**backlog** as well as the board, because the same dialog opens from both. Native `<select>`
is also the project's recorded default for a fixed enum in preference to Radix `Select`,
which is flaky in jsdom.

**C. Both A and B.** Rejected as YAGNI. B alone meets the bar David set.

### Why status is duplicated in the header and the sidebar

`TicketDetailHeader` will keep rendering status as a read-only badge. This is not
redundancy to be tidied away: the header already does **exactly this for `type`**
(`TicketDetailHeader.tsx:31-33` shows the type badge while `TicketDetailSidebar.tsx:48`
edits it). Status now follows the established pattern — at-a-glance in the title row,
editable in Details.

### Why it does not go through `moveTicket`

The board keeps `moveTicket` for drag; the dialog uses `commit()`. These are not two
implementations of one rule — they are two affordances with different error surfaces.
`moveTicket` writes a board-level `role="alert"` naming the ticket and target column
("Could not move MP-1 to In Progress"); `commit()` writes the dialog's own `role="alert"`
("Could not save your change"), the message every other field in that dialog already uses.
A status change made *in the dialog* must report itself *in the dialog*, next to the
control that failed — not on a board the user cannot see behind the modal.

Both are optimistic, both roll back **only the changed field** onto whatever is latest at
continuation time, so the behavioural contract in the ACs is met by either. `commit()` is
additionally guarded for unmount and ticket-switch races (`isMounted`, the identity guard),
which `moveTicket` is not — so the dialog path is the stronger of the two, not a shortcut.

### Placement and scope details decided here

- **First in the Details panel, above Type.** It is the field this story exists to expose
  and the one a board user reaches for most.
- **Labels come from `TICKET_STATUS_LABELS` and the option list from `TICKET_STATUSES`**,
  both in `src/lib/domain.ts`. The four column names are never inlined (CLAUDE.md). Because
  `TICKET_STATUSES` is the same array the board maps over, the picker's options and the
  board's columns cannot drift.
- **Never disabled.** Unlike the Sprint picker, which is disabled until `sprintsPhase ===
  'loaded'` because an empty list would read as "no sprints", the status list is a compile-time
  constant. There is no loading state to be honest about.
- **No new rule about which transitions are legal.** Any status may follow any other, exactly
  as drag allows today. Workflows are Rung 3 and parked.
- **No schema change, no new query, no RLS change.** `status` is already in `TicketUpdate`
  (it is absent from the `Omit` list in `domain.ts`) and `updateTicket` already writes it for
  drag.

## Data flow

```
sidebar <select> onChange
  → commit({ status })                       [useTicketCommit]
      → onUpdated({...ticket, status})        optimistic; ProjectShell context updates
      → await updateTicket(id, { status })    PATCH /rest/v1/tickets, RLS owner-scoped
      → isMounted() bail  ·  identity guard
      → ok:    reconcile status + updated_at onto the latest ticket
        !ok:   revert ONLY status onto the latest ticket, setError(...)
```

Because `ProjectShell` owns the ticket list and both the board and the dialog read it, the
card visibly moves column behind the open dialog as soon as the optimistic write applies.
No refetch, no second source of truth.

## Testing

The split follows the one this project already uses for drag, and the honest statement of
it matters more than the count.

**Vitest (the gate) proves structure and wiring:**

1. The sidebar renders a `combobox` named `status` whose value is the ticket's current
   status, and whose options are all four `TICKET_STATUS_LABELS` in `TICKET_STATUSES` order.
2. It is **not disabled** and carries no negative `tabindex` — i.e. it is in the natural tab
   order. This is the structural half of "keyboard-operable".
3. Changing it calls `updateTicket` with `{ status: <new> }` and nothing else.
4. The optimistic paint: `onUpdated` fires with the new status **before** the write resolves.
5. Failure reverts **only** `status` and raises the dialog's `role="alert"`.
6. A board card, focused and activated with **Enter**, calls `onOpen` — the keyboard route
   *to* the dialog. jsdom does dispatch click for Enter on a focused `<button>`.

**Playwright (non-gated) proves the gesture**, which jsdom structurally cannot:

7. With the detail dialog open, press **Tab** repeatedly (bounded, and failing if not
   found) until focus lands on the status select, then change it with **ArrowDown** alone —
   no pointer at any point — and assert the resulting `tickets` **PATCH** is `ok()`.
   Persistence, not the optimistic paint: `updateTicket` uses `.select().single()`, so a
   zero-row update returns 406 and `.ok()` cannot be fooled.

The E2E already opens the detail dialog mid-flow to assign the sprint, so this leg reuses
the existing fixture and adds no new signup.

**What is NOT proven, stated plainly:**

- **Touch.** A native `<select>` opens the OS picker on tap; there is no browser-automatable
  gesture for that and Playwright runs chromium desktop. AC2 rests on the element's
  construction, not on a test. Choosing a native `<select>` over a custom widget is
  *precisely* what makes that argument safe to make.
- **Screen-reader announcement.** Not asserted anywhere. A labelled native `<select>` is
  announced correctly by construction.

## Tripwire consequence

This is a client-only story: it adds no query, no write path, no RLS surface, and no DB
contract, so it adds **zero live integration tests** — deliberately, per the S7.3 precedent.
Client-only tests raise the full count and the `test:unit` count **by the same amount**, so
the live gap stays at **7**. An unchanged gap here is correct and is not evidence the live
suites skipped.

## Out of scope

- Full WCAG grab/lift/move/drop keyboard drag on the card — declined by David.
- Pointer-event touch drag — declined by David.
- Any status control on the board card itself — approach A above.
- Workflows, legal-transition rules, editable columns or statuses — **Rung 3, parked.**
- The `BlockedBadge` `title` tooltip, which is also pointer-only. A real and related a11y
  gap, recorded in `sprintboard-frontend-conventions` as an accepted follow-up. Fixing it
  here would widen the story.

## Acceptance criteria (revised from the ones filed on SPRIN-61)

AC4 and AC6 as originally filed presumed a control on the board card, which approach B does
not build. They are restated to describe behaviour rather than implementation:

1. From the board, a keyboard user can change a ticket's status using the keyboard alone,
   with no pointer at any step.
2. From the board, a touch user can change a ticket's status by tapping, with no drag
   gesture.
3. The control exposes the ticket's current status and offers all four columns; every column
   name comes from `src/lib/domain.ts` and is never inlined.
4. The change is optimistic, reverts **only** the status field if the write fails, and
   surfaces a failure message beside the control that failed.
5. Dragging a card still changes status exactly as before.
6. The same control works from the backlog, where no status path existed for any device.
