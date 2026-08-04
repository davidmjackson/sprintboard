import type { Project, Ticket } from './domain'
import { hasSprints } from './domain'

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
 * What the flat ticket-list tab shows — the backlog on a project with sprints, and **every
 * ticket** on a project without them.
 *
 * A SIBLING of `selectBacklogTickets` rather than a change to it, and that is the whole
 * design: the backlog rule stays `sprint_id is null` (it is the rule the Scrum board, the
 * sprint planner and the database's `tickets_sprint_idx` all share), and this selector
 * decides which question the TAB is asking. Two rules, two functions, one caller.
 *
 * IT EXISTS BECAUSE THE TWO TABS MUST AGREE ABOUT THE SAME TICKET. `selectBoardScope` in
 * `board.ts` deliberately ignores `sprint_id` on a project without sprints — a board whose
 * users cannot see sprints must show all of their work — so a tab still filtering on
 * `sprint_id is null` would HIDE a ticket the board next door SHOWS, under a nav link
 * reading "All tickets". Whichever answer is right, the two tabs giving different ones is
 * the defect; an asymmetric defence is worse than either choice made consistently.
 *
 * The divergent state is unreachable today — `project_type` is immutable and SPRIN-82
 * removed the only path that could put a `sprint_id` on such a ticket — and defended anyway,
 * mirroring the second half of `selectBoardScope`'s own contract, which is stated for the
 * same reason. Both are rules written where a test can hold them, not patches over a live
 * bug.
 *
 * `hasSprints` rather than a comparison written here: it is the single expression of the
 * rule (SPRIN-82 AC5), and `project-type-single-expression.test.ts` makes that mechanical.
 * The copy on the no-sprints branch keeps the return type `Ticket[]` honest without handing
 * a caller the shell's own array to mutate — `selectBacklogTickets` returns a fresh array
 * from `.filter`, and the two branches must not differ in that.
 */
export function selectTicketList(
  project: Pick<Project, 'project_type'>,
  tickets: readonly Ticket[],
): Ticket[] {
  return hasSprints(project) ? selectBacklogTickets(tickets) : [...tickets]
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
