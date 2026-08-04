import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useOutletContext } from 'react-router-dom'

import type { Sprint, Ticket, TicketStatus } from '@/lib/domain'
import { selectBlockedTickets, selectBoardScope, summariseColumn } from '@/lib/board'
import { firstUnready } from '@/lib/project-reads'
import { statusName } from '@/lib/project-statuses'
import { isSearchActive, selectMatchingTickets } from '@/lib/ticket-search'
import { updateTicket } from '@/lib/tickets'
import type { ProjectShellContext } from './ProjectShell'
import { LoadFailure } from './LoadFailure'
import { SprintDates } from './SprintDates'
import { TicketCard } from './TicketCard'
import { TicketSearchInput } from './TicketSearchInput'

/**
 * What a column is worth, under its heading: how many cards, how many points, and — only
 * when there are any — how many cards carry no estimate, so a total is never silently
 * understated.
 *
 * It is a separate component for two reasons. When it was written `BoardTab` measured exactly
 * 10 — the T2 cyclomatic limit — so its three conditionals (the empty check, the singular/plural
 * count, and the unestimated count) HAD to be somebody else's; and the arithmetic itself is
 * `summariseColumn`'s, in `board.ts`, because board rules do not live in components.
 *
 * The first reason is no longer a constraint: SPRIN-76's `firstUnready` refactor bought two
 * branches back, and SPRIN-83 bought two more by moving the caption into `BoardSprintCaption`
 * and the ticket rule into `selectBoardScope` — `BoardTab` measures **7 of 10** as of that
 * story (`npx eslint src/routes/BoardTab.tsx --rule '{"complexity":["error",1]}'` — re-measure
 * rather than trust this line). The split stays because it is the right shape and hoisting
 * three conditionals would spend most of the margin; the second reason never depended on the
 * count at all.
 *
 * The caller passes the ALREADY-FILTERED column, so these numbers describe the cards
 * actually on screen — the blocked-only filter and the SPRIN-68 search filter both change
 * them. A total that disagreed with the cards under it would be a distinct state wearing
 * another state's face.
 *
 * Nothing is rendered for an empty column: `BoardColumnEmpty` already says something —
 * "No tickets yet." or, since SPRIN-68, "No matches." when a filter is active — and either
 * one says it better than "0 cards · 0 points" would.
 */
function BoardColumnSummary({ tickets }: { tickets: readonly Ticket[] }) {
  const { count, points, unestimated } = summariseColumn(tickets)
  if (count === 0) return null
  return (
    <span className="text-muted-foreground text-xs tabular-nums">
      {count === 1 ? '1 card' : `${count} cards`} · {points} points
      {unestimated > 0 ? ` · ${unestimated} unestimated` : ''}
    </span>
  )
}

/**
 * What an empty column says — and it is not always the same thing.
 *
 * "No tickets yet." is a claim about the SPRINT. When a filter is on, the column may be empty
 * only because the filter hid its cards, and that claim becomes false. This is the same
 * failure `BacklogTab` guards against ("a distinct state wearing another state's face"), and
 * the board already had it before this story: with blocked-only on, a column holding no
 * blocked cards has always said "No tickets yet."
 *
 * The `||` lives HERE rather than in `BoardTab` for a reason that was measured when it was
 * written: `BoardTab`'s body then sat at the T2 cyclomatic limit of exactly 10, so computing a
 * filter-active flag up there took it to 11 and reddened `npm run lint`. That is no longer
 * true — SPRIN-76's `firstUnready` refactor and SPRIN-83's two extractions left `BoardTab` at
 * **7 of 10** — so this is now a preference, not a forced move. It stays a preference worth
 * keeping: deciding the sentence in its own component costs `BoardTab` nothing, and the
 * remaining margin is better spent on a state the board cannot otherwise tell apart than on
 * inlining a `||`.
 */
function BoardColumnEmpty({ blockedOnly, query }: { blockedOnly: boolean; query: string }) {
  const filtering = blockedOnly || isSearchActive(query)
  // `role="status"`, not `role="alert"`: this appears in direct response to typing or
  // toggling a filter, the same informational case `TicketDetailHeader.tsx` announces with
  // `role="status"`. `role="alert"` stays reserved for actual failures (`LoadFailure`,
  // `ErrorBoundary`, `moveError` above) — a filter narrowing a column to nothing is not one.
  return (
    <p role="status" className="text-muted-foreground text-xs">
      {filtering ? 'No matches.' : 'No tickets yet.'}
    </p>
  )
}

/**
 * What the board says about the sprint it is showing — and on a project without sprints, that
 * is nothing at all.
 *
 * Three states, three returns, in its own component rather than as branches in `BoardTab`,
 * which is where this file already puts per-question rendering (`BoardColumnSummary`,
 * `BoardColumnEmpty`). Before SPRIN-83 the name/dates and the "No active sprint" message hung
 * off a single `activeSprint !== null` test that ALSO gated both filters — one test answering
 * three questions, which is exactly why a board on a project without sprints could not be
 * given cards without losing its filters.
 *
 * `sprintScoped` and `sprint` are two different questions and both are asked here: a project
 * that has no sprints at all says nothing, while a project that HAS them but has none running
 * says so out loud, because a row of empty columns must never be mistaken for "you have no
 * tickets". `selectBoardScope` in `board.ts` decides both — this component only renders them.
 */
function BoardSprintCaption({
  sprintScoped,
  sprint,
}: {
  sprintScoped: boolean
  sprint: Sprint | null
}) {
  if (!sprintScoped) return null
  if (sprint === null) {
    return (
      <p className="text-muted-foreground text-sm">
        No active sprint — start one from the Sprints tab.
      </p>
    )
  }
  return (
    <p className="flex flex-wrap items-baseline gap-2 text-sm">
      <span className="font-medium">{sprint.name}</span>
      <SprintDates sprint={sprint} />
    </p>
  )
}

/**
 * The board: one column per row in this project's `project_statuses` table, in the order the
 * rows arrive. That order IS `position` — `listProjectStatuses` sorts by it, and SPRIN-76 kept
 * the sort there rather than re-applying it here so exactly one place decides where a column
 * sits. Before SPRIN-76 the columns were the four fixed constants in `domain.ts`; they are the
 * project's own vocabulary now, and a project with five statuses gets five columns.
 *
 * A ticket whose `status` matches no column renders NOWHERE — no fallback column, no silent
 * reassignment. That is safe rather than lax: `tickets.status` carries a composite foreign key
 * to `project_statuses (project_id, slug)`, so the database cannot hold such a row. SPRIN-80
 * owns orphan safety in the app (the `is_initial` default, and "a project has at least one
 * status"); a test here pins the drop so the behaviour can never become silent meanwhile.
 * Everything the board keys and writes is the row's SLUG, never its id — the fk is keyed on the
 * slug precisely so renaming a status rewrites no ticket row.
 *
 * WHICH tickets it renders is `selectBoardScope`'s answer, not this component's (SPRIN-83).
 * On a project WITH sprints that is the ACTIVE sprint's tickets (S7.1), each in its status
 * column, and an empty column says so. On a project WITHOUT sprints it is every ticket the
 * project has, whatever its `sprint_id` — there is no sprint to scope to, and before SPRIN-83
 * such a board rendered permanently empty because it asked the sprint question anyway.
 *
 * The rules themselves live where board rules live: `selectActiveSprint` and `selectBoardScope`
 * in `board.ts`, composing `selectSprintTickets`' membership rule from `backlog.ts`. The board
 * only reads the answer.
 *
 * The board depends on ALL THREE reads. Tickets tell it what exists; sprints tell it which
 * sprint is active; statuses tell it what its columns ARE — without any one of them it cannot
 * render an honest board. So a failed or still-loading statuses read is handled exactly like
 * the other two: it must not render a confident empty board, which would be the S4.6 defect of
 * a distinct state wearing the empty state's face. `firstUnready` decides which read speaks —
 * any `failed` beats any `loading`, then source order — so one alert and one Retry are shown
 * however many reads are unready, and `onRetry` reloads all three together.
 *
 * "No active sprint" (sprints loaded, none active) is its own honest state: a caption above the
 * grid, so a row of empty columns is never mistaken for "you have no tickets". It belongs to a
 * project that HAS sprints — `BoardSprintCaption` renders nothing at all for one that does not,
 * which would otherwise point its users at a tab SPRIN-82 removed from them.
 *
 * S7.2 makes the board writable: dragging a card to another column changes its `status`. The
 * move is optimistic and rolls back on failure — see `moveTicket`.
 *
 * SPRIN-68 adds a text filter alongside the blocked-only one: `TicketSearchInput` narrows the
 * visible cards to those whose key or summary matches the query, and the two filters AND
 * together via `selectMatchingTickets`.
 */
export function BoardTab() {
  const {
    project,
    tickets,
    ticketsPhase,
    sprints,
    sprintsPhase,
    statuses,
    statusesPhase,
    onRetry,
    onOpenTicket,
    onTicketUpdated,
  } = useOutletContext<ProjectShellContext>()

  // The freshest ticket list, readable from inside an in-flight `moveTicket` async closure.
  // Writing a ref during render is forbidden by the project's react-hooks/refs rule, so the
  // sync happens in an effect — the same pattern `useTicketCommit` (`src/lib/ticket-commit.ts`)
  // uses for its own ticket ref.
  const ticketsRef = useRef(tickets)
  useEffect(() => {
    ticketsRef.current = tickets
  })

  // The card currently mid-drag. The drag payload travels through React state, NOT
  // `dataTransfer`: jsdom has no dataTransfer, and state is robust in real browsers too.
  const [draggingId, setDraggingId] = useState<string | null>(null)
  // The last failed move's message, shown as a role="alert" above the grid.
  const [moveError, setMoveError] = useState<string | null>(null)
  // S7.3 AC2: the blocked-only board filter, off by default.
  const [blockedOnly, setBlockedOnly] = useState(false)
  // S7.3's blocked-only filter and this one are both local ephemeral view state — not
  // context, not the URL. See `TicketSearchInput` for why the query is not hoisted.
  const [query, setQuery] = useState('')

  // Optimistic status change with rollback — the board's first write. Mirrors
  // `commit()` in `src/lib/ticket-commit.ts`: apply optimistically, persist, then reconcile the
  // DB-refreshed row on success or revert ONLY this write's field (status) on failure —
  // merged onto whatever is latest NOW (from `ticketsRef`), so a concurrent edit to a
  // DIFFERENT field of the same ticket is preserved, not clobbered.
  async function moveTicket(ticketId: string, toStatus: TicketStatus) {
    const ticket = ticketsRef.current.find((t) => t.id === ticketId)
    if (!ticket || ticket.status === toStatus) return // no-op: dropped on its own column
    const fromStatus = ticket.status
    setMoveError(null)
    onTicketUpdated({ ...ticket, status: toStatus }) // optimistic
    const result = await updateTicket(ticketId, { status: toStatus })
    const latest = ticketsRef.current.find((t) => t.id === ticketId) ?? ticket
    if (!result.ok) {
      onTicketUpdated({ ...latest, status: fromStatus }) // revert only status, onto latest
      setMoveError(
        `Could not move ${ticket.key} to ${statusName(statuses, toStatus)}. Please try again.`,
      )
      return
    }
    onTicketUpdated({
      ...latest,
      status: result.ticket.status,
      updated_at: result.ticket.updated_at,
    })
  }

  function handleDragStart(e: DragEvent, ticketId: string) {
    setDraggingId(ticketId)
    setMoveError(null)
    // Firefox refuses to start a drag unless setData is called; nothing reads it back. jsdom
    // has no dataTransfer, hence the guard.
    e.dataTransfer?.setData('text/plain', ticketId)
  }

  function handleDrop(toStatus: TicketStatus) {
    const id = draggingId
    setDraggingId(null)
    if (id) void moveTicket(id, toStatus)
  }

  // The three-read gate. `firstUnready`'s array order is the tie-break WITHIN a kind, so
  // tickets still speak first when several reads fail together — the S7.1 behaviour, unchanged.
  // The literal `resource` strings are what keep `LoadFailure`'s closed union closed: `R`
  // infers `'tickets' | 'sprints' | 'statuses'` here and flows in unwidened.
  const unready = firstUnready([
    { resource: 'tickets', phase: ticketsPhase },
    { resource: 'sprints', phase: sprintsPhase },
    { resource: 'statuses', phase: statusesPhase },
  ])
  if (unready) {
    return unready.phase === 'failed' ? (
      <LoadFailure resource={unready.resource} onRetry={onRetry} />
    ) : (
      <p className="text-muted-foreground text-sm">Loading…</p>
    )
  }

  // A SUCCESSFUL statuses read that returned no rows. Without it, execution fell through to
  // `statuses.map([])` and painted a columnless `<div class="grid">` under the sprint name and
  // the filters — every card in the sprint gone, nothing announced, the chrome above implying a
  // healthy board. That is the S4.6 defect once more: a distinct state wearing another's face.
  //
  // It is unreachable today (the seed trigger guarantees four rows and `activeProjectId` comes
  // from the owner-scoped project list) and deliberately handled anyway, because RLS FILTERS
  // rather than raises: a policy that denies the read returns `{data: [], error: null}`, which
  // arrives here as exactly `phase: 'loaded'` with `items: []`. SPRIN-77/80 (status deletion,
  // with nothing yet enforcing "a project has at least one status") and SPRIN-75 (every policy
  // rewritten to a membership check, where a `project_statuses` policy narrower than the
  // `projects` one hands a member a blank board) both make it reachable.
  //
  // `role="status"`, not `role="alert"`, and no Retry: the read SUCCEEDED. `role="alert"` and
  // `LoadFailure` stay reserved for actual failures. The sentence names COLUMNS and STATUSES so
  // it cannot be misread as either neighbour — "No active sprint — start one from the Sprints
  // tab." or a column's own "No tickets yet." / "No matches." It deliberately does not point at
  // the Settings tab either: SPRIN-77 built that screen, but this state is reached by a DEGRADED
  // READ as often as by a genuinely empty vocabulary, and a project whose statuses the client
  // could not see is not one the user fixes by adding another. Returning early is the point: the
  // empty grid, the sprint caption and the filters must not sit above this.
  if (statuses.length === 0) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        This board has no columns — this project has no statuses, so none of its tickets can be
        shown.
      </p>
    )
  }

  // One question, one answer, and the three decisions below all read it: which sprint this
  // board describes, which tickets it renders, and whether there is anything worth filtering.
  // They used to be one `activeSprint !== null` test doing all three jobs (SPRIN-83).
  const {
    sprint,
    sprintScoped,
    tickets: boardTickets,
    offersFilters,
  } = selectBoardScope(project, tickets, sprints)
  const visibleTickets = selectMatchingTickets(
    blockedOnly ? selectBlockedTickets(boardTickets) : boardTickets,
    query,
  )

  return (
    <div className="flex flex-col gap-4">
      <BoardSprintCaption sprintScoped={sprintScoped} sprint={sprint} />
      {moveError ? (
        <p role="alert" className="text-destructive text-sm">
          {moveError}
        </p>
      ) : null}
      {/* The filters hang off `offersFilters`, NOT off the caption's question. They used to
          share one test with it, which is why a board with no sprint to describe could not be
          given cards without silently losing both controls (SPRIN-83). A sprint-scoped board
          with nothing running still offers nothing: controls that can only narrow nothing to
          nothing are worse than no controls. */}
      {offersFilters ? (
        <>
          <label className="text-muted-foreground flex w-fit items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={blockedOnly}
              onChange={(e) => setBlockedOnly(e.target.checked)}
              className="size-4"
            />
            Blocked only
          </label>
          <TicketSearchInput value={query} onChange={setQuery} />
        </>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {statuses.map((status) => {
          const column = visibleTickets.filter((ticket) => ticket.status === status.slug)
          return (
            <section
              key={status.slug}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(status.slug)}
              className="bg-muted/30 flex flex-col gap-3 rounded-lg border p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                <h2 className="text-sm font-medium">{status.name}</h2>
                <BoardColumnSummary tickets={column} />
              </div>
              {column.length === 0 ? (
                <BoardColumnEmpty blockedOnly={blockedOnly} query={query} />
              ) : (
                column.map((ticket) => (
                  <TicketCard
                    key={ticket.id}
                    ticket={ticket}
                    onOpen={() => onOpenTicket(ticket)}
                    onDragStart={(e) => handleDragStart(e, ticket.id)}
                    onDragEnd={() => setDraggingId(null)}
                  />
                ))
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
