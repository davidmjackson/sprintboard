import { parseStoryPoints } from '@/lib/tickets'
import { parseLabels } from '@/lib/labels'
import {
  SPRINT_STATUS_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  type Sprint,
  type Ticket,
  type TicketType,
  type TicketUpdate,
} from '@/lib/domain'
import type { SprintsPhase } from './ProjectShell'
import { EditableText, FieldLabel, selectClass } from './EditableText'

/** Sidebar: a quiet "Details" panel, the Jira right rail */
export function TicketDetailSidebar({
  ticket,
  currentUser,
  epics,
  sprints,
  sprintsPhase,
  commit,
  setError,
  onEditingChange,
}: {
  ticket: Ticket
  currentUser: { id: string; email: string }
  epics: Ticket[]
  sprints: Sprint[]
  sprintsPhase: SprintsPhase
  commit: (patch: TicketUpdate) => Promise<boolean>
  setError: (ticketId: string, message: string) => void
  onEditingChange: (editing: boolean) => void
}) {
  const assigneeValue = ticket.assignee_id === currentUser.id ? currentUser.id : ''
  const initial = assigneeValue ? (currentUser.email[0]?.toUpperCase() ?? null) : null

  return (
    <aside className="bg-muted/30 flex flex-col gap-4 rounded-lg border p-4 sm:self-start">
      <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
        Details
      </h3>

      <label className="flex flex-col gap-1">
        <FieldLabel>Type</FieldLabel>
        <select
          aria-label="type"
          className={selectClass}
          value={ticket.type}
          onChange={(e) => {
            const next = e.target.value as TicketType
            // Becoming an epic clears any parent epic in the same write: an epic does
            // not nest under another epic (Phase 1), and the picker that would let you
            // clear it is hidden for epics — so leaving it set would strand an
            // unreachable, invalid reference.
            commit(next === 'epic' ? { type: next, parent_epic_id: null } : { type: next })
          }}
        >
          {TICKET_TYPES.map((t) => (
            <option key={t} value={t}>
              {TICKET_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>

      {/* Non-epic only: reference a parent epic in this project. An epic doesn't nest
          under another epic in Phase 1, so the picker is hidden for epics. The options
          are the project's epics; the composite fk `tickets_epic_fk` keeps the parent
          in the same project, so cross-project references are rejected at the DB. */}
      {ticket.type !== 'epic' ? (
        <label className="flex flex-col gap-1">
          <FieldLabel>Parent epic</FieldLabel>
          <select
            aria-label="parent epic"
            className={selectClass}
            value={ticket.parent_epic_id ?? ''}
            onChange={(e) => commit({ parent_epic_id: e.target.value || null })}
          >
            <option value="">No epic</option>
            {/* If the current parent isn't in the epics list (it was deleted or
                demoted from epic, and the list is refetch-free), still render its
                value so the <select> stays controlled and the link isn't silently
                shown as "No epic" — the user can see it exists and change or clear it. */}
            {ticket.parent_epic_id && !epics.some((e) => e.id === ticket.parent_epic_id) ? (
              <option value={ticket.parent_epic_id}>Current parent (unavailable)</option>
            ) : null}
            {epics
              .filter((e) => e.id !== ticket.id)
              .map((e) => (
                <option key={e.id} value={e.id}>
                  {e.key} · {e.summary}
                </option>
              ))}
          </select>
        </label>
      ) : null}

      {/* Sprint membership (S6.2). `''` is the backlog: `backlog.ts` defines the backlog
          as `sprint_id is null`, so "Backlog" and "no sprint" are the same fact and the
          UI uses the domain's word for it. Unlike the parent-epic picker this is NOT
          gated on ticket type — an epic can be in a sprint. Sprints are NOT filtered by
          status — barring a complete or active sprint is a rule no AC asks for, and
          S6.3/S6.4 own what starting and completing do. The composite fk
          `tickets_sprint_fk` keeps the sprint in the same project, so a cross-project
          reference is rejected at the database.

          Disabled unless the sprint list actually loaded: `sprints` is `[]` while
          loading AND after a failed read, so an empty list never means "no sprints". An
          enabled picker would then offer only "Backlog", read as "this ticket is in no
          sprint", and one click would quietly unsprint it. */}
      <label className="flex flex-col gap-1">
        <FieldLabel>Sprint</FieldLabel>
        <select
          aria-label="sprint"
          className={selectClass}
          disabled={sprintsPhase !== 'loaded'}
          value={ticket.sprint_id ?? ''}
          onChange={(e) => commit({ sprint_id: e.target.value || null })}
        >
          <option value="">Backlog</option>
          {/* The current sprint isn't in the list (deleted, or the list hasn't loaded):
              still render its value so the <select> stays controlled and the membership
              isn't silently shown as "Backlog". Mirrors the parent-epic picker's guard. */}
          {ticket.sprint_id && !sprints.some((s) => s.id === ticket.sprint_id) ? (
            <option value={ticket.sprint_id}>Current sprint (unavailable)</option>
          ) : null}
          {sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {SPRINT_STATUS_LABELS[s.status]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <FieldLabel>Assignee</FieldLabel>
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="bg-background text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-medium"
          >
            {initial ?? '—'}
          </span>
          <select
            aria-label="assignee"
            className={selectClass}
            value={assigneeValue}
            onChange={(e) => commit({ assignee_id: e.target.value || null })}
          >
            <option value="">Unassigned</option>
            <option value={currentUser.id}>{currentUser.email}</option>
          </select>
        </div>
      </label>

      <label className="flex flex-col gap-1">
        <FieldLabel>Story points</FieldLabel>
        <EditableText
          value={ticket.story_points?.toString() ?? ''}
          ariaLabel="story points"
          numeric
          placeholder="—"
          onCommit={(v) => {
            const parsed = parseStoryPoints(v)
            if (!parsed.ok) {
              setError(ticket.id, 'Whole numbers only')
              return
            }
            commit({ story_points: parsed.value })
          }}
          onEditingChange={onEditingChange}
        />
      </label>

      <label className="flex flex-col gap-1">
        <FieldLabel>Labels</FieldLabel>
        <EditableText
          value={ticket.labels.join(', ')}
          ariaLabel="labels"
          placeholder="Add labels…"
          onCommit={(v) => commit({ labels: parseLabels(v) })}
          onEditingChange={onEditingChange}
        />
      </label>

      <p className="text-muted-foreground border-border/70 border-t pt-3 text-[11px]">
        Updated {new Date(ticket.updated_at).toLocaleString()}
      </p>
    </aside>
  )
}
