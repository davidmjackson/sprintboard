import type { Sprint, Ticket } from './domain'

/**
 * The board rule, in one place: **the board shows the ACTIVE sprint** — the one sprint whose
 * status is `'active'`. Kept here rather than inlined in `BoardTab`, mirroring how
 * `backlog.ts` owns the backlog rule (CLAUDE.md forbids inlining domain rules in components).
 *
 * `.find` returning the first match is safe because "one active sprint per project" is a hard
 * invariant, enforced by the `sprints_one_active_per_project` partial unique index — there can
 * never be a second active sprint to disambiguate. Returns `null`, not `undefined`, so callers
 * discriminate with a plain truthiness/`=== null` check and never see the array-`find` gap.
 *
 * The ticket half of "the active sprint's tickets" is NOT here: `selectSprintTickets` in
 * `backlog.ts` already owns the `sprint_id === id` membership rule, and this composes with it.
 */
export function selectActiveSprint(sprints: readonly Sprint[]): Sprint | null {
  return sprints.find((s) => s.status === 'active') ?? null
}

/**
 * The blocked-only board filter, in one place: the tickets whose `is_blocked` flag is set.
 * Kept here beside `selectActiveSprint` rather than inlined in `BoardTab`, so "which tickets
 * are visible" stays a named, tested selector (CLAUDE.md forbids inlining domain rules in
 * components). Blocked is a flag, never a column — this narrows the set, it never moves a card.
 */
export function selectBlockedTickets(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((t) => t.is_blocked)
}
