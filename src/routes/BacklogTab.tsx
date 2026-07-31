import { useState } from 'react'
import { useOutletContext } from 'react-router-dom'

import { TICKET_TYPE_LABELS } from '@/lib/domain'
import { selectBacklogTickets } from '@/lib/backlog'
import { selectMatchingTickets } from '@/lib/ticket-search'
import type { ProjectShellContext } from './ProjectShell'
import { BlockedBadge } from './BlockedBadge'
import { LoadFailure } from './LoadFailure'
import { TicketSearchInput } from './TicketSearchInput'

/**
 * The backlog: the project's tickets with **no sprint**, ordered by number (the order
 * `listTickets` returns and the shell's append-on-create preserves).
 *
 * The `sprint_id is null` rule lives in `selectBacklogTickets`, never inlined here. The
 * filter runs client-side over the shell's shared list rather than as a second
 * `.is('sprint_id', null)` query: the shell already owns a single, once-fetched list that
 * Board and Backlog both read, so filtering here keeps the two tabs consistent and keeps
 * the create path's append working (S5.2's "appears immediately"). A separate query would
 * split that source of truth and reintroduce the stale-response race S4.1 removed.
 */
export function BacklogTab() {
  const { tickets, ticketsPhase, onRetry, currentUser, onOpenTicket } =
    useOutletContext<ProjectShellContext>()
  const [query, setQuery] = useState('')

  const backlog = selectBacklogTickets(tickets)

  // Guarded on the phase alone, as `BoardTab` is. `useTaggedRead` derives `phase` and
  // `items` from one binding, so 'loading' already implies an empty list — an extra
  // `backlog.length === 0` conjunct could never be false here and was only ever
  // transcribed from a plan draft. The branch itself is load-bearing: without it a
  // loading read falls through to "Nothing in the backlog.", the same false claim the
  // `failed` check below exists to prevent.
  if (ticketsPhase === 'loading') {
    return <p className="text-muted-foreground text-sm">Loading…</p>
  }

  if (ticketsPhase === 'failed') {
    // Checked BEFORE the empty state, and that order is the whole story: `tickets` is `[]`
    // on a failed read, so falling through would render "Nothing in the backlog." — a
    // confident claim about work we could not see. The empty state below now speaks only
    // for a read that actually landed.
    return <LoadFailure resource="tickets" onRetry={onRetry} />
  }

  if (backlog.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed">
        {/* Covers both "no tickets at all" and "every ticket is in a sprint" — from the
            backlog's point of view those are the same fact. A failed read is NOT one of
            them and no longer reaches here. */}
        <p className="text-muted-foreground text-sm">Nothing in the backlog.</p>
      </div>
    )
  }

  // Filtered AFTER the empty check above, and that order is the whole of AC5: `backlog` is
  // the unfiltered list, so "Nothing in the backlog." can only be reached when the project
  // really has no unsprinted tickets. A filtered-empty result is a different fact and says so
  // below. Same lesson as the `failed` check above it — a distinct state must never wear
  // another state's face.
  const matches = selectMatchingTickets(backlog, query)

  return (
    <div className="flex flex-col gap-4">
      {/* Rendered here, inside the branch guarded by the UNFILTERED backlog, so it is on
          screen for every query — including one that matches nothing. Gating it on `matches`
          would strand the user: the box that hid the rows would itself disappear. */}
      <TicketSearchInput value={query} onChange={setQuery} />
      {matches.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed">
          {/* `role="status"` — this message appears in direct response to typing, the same
              reason `TicketDetailHeader.tsx` puts `role="status"` on its own informational
              text. Not `role="alert"`: that project convention (`LoadFailure`, `ErrorBoundary`,
              `BoardTab`'s `moveError`) is reserved for actual failures, and a filter narrowing
              to nothing is not one. */}
          <p role="status" className="text-muted-foreground text-sm">
            No tickets match your search.
          </p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {matches.map((ticket) => (
            <li key={ticket.id}>
              <button
                type="button"
                onClick={() => onOpenTicket(ticket)}
                className="hover:bg-muted/60 flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors"
              >
                <span className="text-muted-foreground w-16 shrink-0 font-mono text-xs">
                  {ticket.key}
                </span>
                <span className="text-muted-foreground w-14 shrink-0 text-xs uppercase">
                  {TICKET_TYPE_LABELS[ticket.type]}
                </span>
                <span className="flex-1 truncate">{ticket.summary}</span>
                {ticket.is_blocked ? <BlockedBadge /> : null}
                {/* `!= null`, not a falsy check: 0 is a real estimate, not "unestimated". */}
                {ticket.story_points != null ? (
                  <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
                    {ticket.story_points}
                    {/* A bare number reads as nothing on its own, so the unit is spelled out
                        for screen readers. It is real text rather than an `aria-label`
                        because a <span> maps to `role="generic"`, on which ARIA 1.2
                        *prohibits* aria-label — browsers honour it today, axe-core flags it,
                        and the row is a <button>, so this text joins its accessible name. */}
                    <span className="sr-only"> story points</span>
                  </span>
                ) : null}
                <span className="text-muted-foreground w-40 shrink-0 truncate text-right text-xs">
                  {/* Phase 1 is single-owner, so the only name we can resolve is the signed-in
                      user's — `listTickets` does no `profiles` join, and `assignee_id` is a
                      bare uuid. Anything else reads as Unassigned, exactly as the detail
                      dialog's `{ Unassigned, you }` picker already does.

                      `currentUser.email` falls back to '' in the shell when the session has
                      no email, so it is not safe to render bare: an assigned ticket would
                      show a blank cell, indistinguishable from a broken one. 'You' is the
                      honest answer — we know it is theirs, we just have no name for them.

                      The `sr-only` prefix is the SPRIN-67 fix, and the same call S5.1 made
                      for story points: real text rather than an `aria-label`, because this
                      is a <span> (`role="generic"`) and ARIA 1.2 prohibits aria-label there.
                      Without it the row's accessible name ends "… 5 story points
                      dev@example.com" — every other part of the row says what it is, and the
                      assignee was the one bare value. It joins the name only because the row
                      is a <button>, so `BacklogTab.test.tsx` scopes its assertion to that
                      button; an unscoped `getByText` would stay green if it drifted outside.
                      Only the assigned branch takes it: 'Unassigned' is already a complete
                      statement, and prefixing it would announce "Assigned to Unassigned". */}
                  {ticket.assignee_id === currentUser.id ? (
                    <>
                      <span className="sr-only">Assigned to </span>
                      {currentUser.email || 'You'}
                    </>
                  ) : (
                    'Unassigned'
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
