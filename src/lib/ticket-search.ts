import type { Ticket } from './domain'

/**
 * The ticket-search rule, in one place: **a ticket matches when its key or its summary
 * contains the query, case-insensitively.**
 *
 * It gets its own module rather than joining `board.ts` or `backlog.ts` because it belongs
 * to neither — the Board and the Backlog both use it, and putting it in one would make the
 * other import a rule from a module named after a surface it is not. Same reason
 * `selectSprintTickets` stays in `backlog.ts` and `board.ts` composes with it.
 *
 * **An empty or whitespace-only query returns the list unchanged, never `[]`.** Both tabs
 * mount with an empty query, so inverting this branch empties the whole product on first
 * render — it is the one line here worth a test of its own.
 *
 * Key and summary only. Description, acceptance criteria and labels are deliberately not
 * searched: neither the board card nor the backlog row renders them, so a match would be
 * invisible — the user types "auth", gets four rows, and none of them says "auth" anywhere.
 *
 * Substring rather than prefix, so `mp`, `MP-1` and a bare `1` all narrow usefully through
 * one code path. Note the consequence, which is intended: `MP-1` also matches `MP-13`.
 */
export function selectMatchingTickets(tickets: readonly Ticket[], query: string): Ticket[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...tickets]
  return tickets.filter(
    (t) => t.key.toLowerCase().includes(needle) || t.summary.toLowerCase().includes(needle),
  )
}
