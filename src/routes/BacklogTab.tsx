import { useOutletContext } from 'react-router-dom'

import { TICKET_TYPE_LABELS } from '@/lib/domain'
import { selectBacklogTickets } from '@/lib/backlog'
import type { ProjectShellContext } from './ProjectShell'
import { BlockedBadge } from './BlockedBadge'

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
  const { tickets, ticketsPhase, currentUser, onOpenTicket } =
    useOutletContext<ProjectShellContext>()

  const backlog = selectBacklogTickets(tickets)

  if (ticketsPhase === 'loading' && backlog.length === 0) {
    return <p className="text-muted-foreground text-sm">Loading…</p>
  }

  if (backlog.length === 0) {
    return (
      <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed">
        {/* Covers both "no tickets at all" and "every ticket is in a sprint" — from the
            backlog's point of view those are the same fact.
            TODO(S4.6): it still claims a FAILED read too. That is no longer structural —
            `ticketsPhase` is a real discriminant now, so `'failed'` is readable right here
            — only unsurfaced: the error UI is a later task in this same story. */}
        <p className="text-muted-foreground text-sm">Nothing in the backlog.</p>
      </div>
    )
  }

  return (
    <ul className="divide-y rounded-lg border">
      {backlog.map((ticket) => (
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
                  honest answer — we know it is theirs, we just have no name for them. */}
              {ticket.assignee_id === currentUser.id ? currentUser.email || 'You' : 'Unassigned'}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}
