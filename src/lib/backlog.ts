import type { Ticket } from './domain'

/**
 * The backlog rule, in one place: **a ticket is in the backlog when `sprint_id is null`.**
 *
 * It is deliberately NOT "anything outside the active sprint" (S5.1). That reading would
 * drag every Done ticket from every past sprint back into the backlog and contradict S6.4,
 * which retains sprint history. Status is irrelevant here — a Done ticket that was never
 * sprinted is backlog; a Done ticket in a completed sprint is not.
 *
 * The comparison is strict `=== null`, not a falsy check: `Ticket['sprint_id']` is
 * `string | null`, so `undefined` is not representable and a loose check would only serve
 * to paper over an under-specified test fixture. The database mirrors this rule in the
 * `sprint_id` column comment ("null = backlog") and indexes it (`tickets_sprint_idx`),
 * so a future server-side `.is('sprint_id', null)` filter stays consistent with this.
 */
export function isBacklogTicket(ticket: Ticket): boolean {
  return ticket.sprint_id === null
}

/**
 * The project's backlog, in the order given. Filters only — it never sorts, so the
 * number order `listTickets` returns (and the shell's append-on-create preserves) is the
 * backlog order.
 */
export function selectBacklogTickets(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter(isBacklogTicket)
}

/**
 * The tickets in one sprint, in the order given. The same rule as `isBacklogTicket`, read
 * from the other side: a ticket is in a sprint when its `sprint_id` is that sprint's id.
 * Filters only — it never sorts, so the number order `listTickets` returns is preserved.
 *
 * Strict `===` on a `string` id: `Ticket['sprint_id']` is `string | null`, so a backlog
 * ticket can never match a real sprint id and needs no special case.
 */
export function selectSprintTickets(tickets: readonly Ticket[], sprintId: string): Ticket[] {
  return tickets.filter((ticket) => ticket.sprint_id === sprintId)
}
