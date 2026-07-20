import { useEffect, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useOutletContext } from 'react-router-dom'

import { TICKET_STATUSES, TICKET_STATUS_LABELS } from '@/lib/domain'
import type { TicketStatus } from '@/lib/domain'
import { selectActiveSprint, selectBlockedTickets } from '@/lib/board'
import { selectSprintTickets } from '@/lib/backlog'
import { updateTicket } from '@/lib/tickets'
import type { ProjectShellContext } from './ProjectShell'
import { LoadFailure } from './LoadFailure'
import { TicketCard } from './TicketCard'

/**
 * The board: the four fixed columns, in board order (from the domain module — never inlined).
 * It renders the ACTIVE sprint's tickets (S7.1), each in its status column; an empty column
 * says so. The active-sprint rule lives in `selectActiveSprint`; the membership rule in
 * `selectSprintTickets` — the board only composes them.
 *
 * The board depends on BOTH reads. Tickets tell it what exists; sprints tell it which sprint is
 * active — without that it cannot know what belongs on the board. So a failed or still-loading
 * SPRINTS read is handled exactly like the tickets read: it must not render a confident empty
 * board, which would be the S4.6 defect of a distinct state wearing the empty state's face.
 * Ticket failure is shown first when both fail — one alert, one Retry, and `onRetry` reloads
 * both reads together.
 *
 * "No active sprint" (sprints loaded, none active) is its own honest state: a caption above the
 * grid, so four empty columns are never mistaken for "you have no tickets".
 *
 * S7.2 makes the board writable: dragging a card to another column changes its `status`. The
 * move is optimistic and rolls back on failure — see `moveTicket`.
 */
export function BoardTab() {
  const { tickets, ticketsPhase, sprints, sprintsPhase, onRetry, onOpenTicket, onTicketUpdated } =
    useOutletContext<ProjectShellContext>()

  // The freshest ticket list, readable from inside an in-flight `moveTicket` async closure.
  // Writing a ref during render is forbidden by the project's react-hooks/refs rule, so the
  // sync happens in an effect — the same pattern `TicketDetailDialog` uses for `ticketRef`.
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

  // Optimistic status change with rollback — the board's first write. Mirrors
  // `TicketDetailDialog.commit()`: apply optimistically, persist, then reconcile the
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
        `Could not move ${ticket.key} to ${TICKET_STATUS_LABELS[toStatus]}. Please try again.`,
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

  if (ticketsPhase === 'failed') {
    return <LoadFailure resource="tickets" onRetry={onRetry} />
  }
  if (sprintsPhase === 'failed') {
    return <LoadFailure resource="sprints" onRetry={onRetry} />
  }
  if (ticketsPhase === 'loading' || sprintsPhase === 'loading') {
    return <p className="text-muted-foreground text-sm">Loading…</p>
  }

  const activeSprint = selectActiveSprint(sprints)
  const boardTickets = activeSprint ? selectSprintTickets(tickets, activeSprint.id) : []
  const visibleTickets = blockedOnly ? selectBlockedTickets(boardTickets) : boardTickets

  return (
    <div className="flex flex-col gap-4">
      {activeSprint === null ? (
        <p className="text-muted-foreground text-sm">
          No active sprint — start one from the Sprints tab.
        </p>
      ) : null}
      {moveError ? (
        <p role="alert" className="text-destructive text-sm">
          {moveError}
        </p>
      ) : null}
      {activeSprint !== null ? (
        <label className="text-muted-foreground flex w-fit items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={blockedOnly}
            onChange={(e) => setBlockedOnly(e.target.checked)}
            className="size-4"
          />
          Blocked only
        </label>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {TICKET_STATUSES.map((status) => {
          const column = visibleTickets.filter((ticket) => ticket.status === status)
          return (
            <section
              key={status}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(status)}
              className="bg-muted/30 flex flex-col gap-3 rounded-lg border p-3"
            >
              <h2 className="text-sm font-medium">{TICKET_STATUS_LABELS[status]}</h2>
              {column.length === 0 ? (
                <p className="text-muted-foreground text-xs">No tickets yet.</p>
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
