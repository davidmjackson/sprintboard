import { selectSprintTickets } from './backlog'
import type { Project, ProjectStatus, Sprint, Ticket } from './domain'
import { hasSprints, hasWipLimits } from './domain'
import { isSearchActive } from './ticket-search'

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
 * What a board is showing. Exported because it is the named return type of the public
 * `selectBoardScope` selector below — the same reason `ColumnSummary` is exported.
 */
export type BoardScope = {
  /** The sprint this board describes, or null: no active sprint, or no sprints at all. */
  sprint: Sprint | null
  /** Whether this board is sprint-scoped. False for a continuously-delivered project. */
  sprintScoped: boolean
  /** The tickets this board shows, in the order given. Filtered only, never sorted. */
  tickets: Ticket[]
  /** Whether the board has a ticket source, so filters are worth offering. */
  offersFilters: boolean
}

/**
 * Everything the board needs to know about what it is showing, in one answer: which sprint
 * it describes, which tickets it renders, and whether there is anything to filter.
 *
 * One function rather than three for the same reason `summariseColumn` returns three numbers
 * — the caller always reads them together, they derive from one question, and one function
 * is one place for the rule to change. Splitting them would let "which sprint" and "which
 * tickets" drift apart, which is precisely the defect SPRIN-83 fixed: the board asked one
 * question (is there an active sprint?) and used the answer for three different decisions.
 *
 * `sprintScoped` comes from `hasSprints` — the single expression of the rule (SPRIN-82 AC5).
 * This module may not compare the project type itself, and a test says so.
 *
 * A project WITHOUT sprints shows every ticket, whatever its `sprint_id`, and describes no
 * sprint even if a sprint row exists. The second half is unreachable today — the type is
 * immutable and there is no way to create a sprint on such a project — and stated anyway,
 * because a board whose users cannot see sprints must never caption itself with one.
 *
 * A project WITH sprints shows the active sprint's tickets and nothing before one starts:
 * `offersFilters` is false there, so a row of empty columns is not topped with controls that
 * can only narrow nothing to nothing. That is unchanged behaviour, kept deliberately.
 */
export function selectBoardScope(
  project: Pick<Project, 'project_type'>,
  tickets: readonly Ticket[],
  sprints: readonly Sprint[],
): BoardScope {
  const sprintScoped = hasSprints(project)
  if (!sprintScoped) {
    return { sprint: null, sprintScoped, tickets: [...tickets], offersFilters: true }
  }
  const sprint = selectActiveSprint(sprints)
  return {
    sprint,
    sprintScoped,
    tickets: sprint ? selectSprintTickets(tickets, sprint.id) : [],
    offersFilters: sprint !== null,
  }
}

/**
 * The blocked-only board filter, in one place: the tickets whose `is_blocked` flag is set.
 * Kept here beside `selectActiveSprint` rather than inlined in `BoardTab`, so "which tickets
 * are visible" stays a named, tested selector (CLAUDE.md forbids inlining domain rules in
 * components). Blocked is a flag, never a column — this narrows the set, it never moves a card.
 *
 * SPRIN-68 adds a second, independent narrowing alongside this one — the text filter in
 * `ticket-search.ts` — which `BoardTab` composes with this selector's output rather than
 * folding into it; the two AND together.
 */
export function selectBlockedTickets(tickets: readonly Ticket[]): Ticket[] {
  return tickets.filter((t) => t.is_blocked)
}

/**
 * Whether the board is narrowing what it shows — the blocked-only filter, the SPRIN-68
 * search, or both.
 *
 * This `||` lived inside `BoardColumnEmpty` until SPRIN-86, where its docblock recorded that
 * the location was once forced by complexity pressure and had since become "a preference, not
 * a forced move". Two callers need the same answer now — the empty column's sentence, and the
 * WIP-limit segment, which is suppressed while filtering (see `selectColumnLimit`) — so the
 * rule is named once here, where board rules live, rather than computed twice.
 *
 * Whitespace is not a query: `isSearchActive` trims, and this composes with that rule rather
 * than re-deciding it.
 */
export function isBoardFiltered(blockedOnly: boolean, query: string): boolean {
  return blockedOnly || isSearchActive(query)
}

/** What a board column is worth, in one pass: how many cards, how many points, and how
 *  many of those cards carry no estimate at all.
 *
 *  The three numbers are always read together by the same caller, so they are one
 *  function rather than three — one iteration, one place to change the rule, and one
 *  mutation target. Kept here beside `selectActiveSprint` and `selectBlockedTickets`
 *  rather than inlined in `BoardTab`, because board rules live in this module
 *  (CLAUDE.md forbids inlining domain rules in components).
 *
 *  `story_points` is `int` and NULLABLE, and the null case is the point of `unestimated`:
 *  a column whose total is understated by unpointed work must say so rather than quietly
 *  report a smaller number. The guard is `== null`, never a falsy check — **0 is a real
 *  estimate**, not "unestimated", and the difference is the whole signal on a Scrum board.
 *
 *  Exported deliberately: it is the named return type of the public `summariseColumn`
 *  selector below. Nothing imports `ColumnSummary` by name today, but un-exporting it
 *  would leave a public function signature referencing a private type. Keep the export. */
export type ColumnSummary = { count: number; points: number; unestimated: number }

export function summariseColumn(tickets: readonly Ticket[]): ColumnSummary {
  let points = 0
  let unestimated = 0
  for (const t of tickets) {
    if (t.story_points == null) unestimated += 1
    else points += t.story_points
  }
  return { count: tickets.length, points, unestimated }
}

/**
 * The WIP limit this column should display, or `null` for "display none" — the whole of
 * SPRIN-86's "should this column show a limit at all" rule, in one place a unit test can
 * attack. The board only renders the answer.
 *
 * TWO GATES, AND BOTH ARE LOAD-BEARING.
 *
 * `hasWipLimits` is what makes AC5 true. SPRIN-85 §3.4 recorded that a CHECK body may not
 * contain a subquery, so the constraint cannot reach `projects.project_type` and the database
 * WILL store a `wip_limit` on a Scrum project's status row. That value is inert only because
 * nothing reads it — and this function is the thing that reads it. Deleting this gate does not
 * relax a preference; it puts a Kanban-only feature on a Scrum board, using data the database
 * really holds. Written as `hasWipLimits(project)` rather than a comparison here: this module
 * may not compare the project type itself, and a test says so.
 *
 * `filtered` is the design's §5.1. A WIP limit is a claim about the column's REAL occupancy,
 * but the summary renders the ALREADY-FILTERED column, so under a filter the two disagree —
 * five cards against a limit of three read as "1 card" the moment Blocked-only is ticked.
 * Judging against the visible count was rejected: a filtered count is always <= the real one,
 * so an over-limit column would quietly stop warning with nothing saying the number was
 * partial. The board declines to make the claim instead, which keeps the summary's own
 * invariant whole — nothing on that line ever disagrees with the cards below it.
 */
export function selectColumnLimit(
  project: Pick<Project, 'project_type'>,
  status: Pick<ProjectStatus, 'wip_limit'>,
  filtered: boolean,
): number | null {
  if (filtered || !hasWipLimits(project)) return null
  return status.wip_limit
}
