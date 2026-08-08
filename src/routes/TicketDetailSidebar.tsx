import { parseStoryPoints } from '@/lib/tickets'
import { parseLabels } from '@/lib/labels'
import {
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  type ProjectField,
  type ProjectFieldOption,
  type ProjectStatus,
  type Sprint,
  type Ticket,
  type TicketType,
  type TicketUpdate,
} from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import { statusOptions } from '@/lib/project-statuses'
import type { SprintsPhase } from './ProjectShell'
import { EditableText, FieldLabel } from './EditableText'
import { selectClass } from './form-primitives'
import { TicketCustomFields } from './TicketCustomFields'
import { TicketReferenceSelect } from './TicketReferenceSelect'
import { TicketSprintField } from './TicketSprintField'

/** Sidebar: a quiet "Details" panel, the Jira right rail */
export function TicketDetailSidebar({
  ticket,
  currentUser,
  epics,
  sprints,
  sprintsPhase,
  statuses,
  statusesPhase,
  commit,
  setError,
  onEditingChange,
  hasSprints,
  fields,
  fieldsPhase,
  options,
  optionsPhase,
  onRetryFields,
}: {
  ticket: Ticket
  currentUser: { id: string; email: string }
  epics: Ticket[]
  sprints: Sprint[]
  sprintsPhase: SprintsPhase
  /** The project's status rows, in column (`position`) order — the picker's options. */
  statuses: ProjectStatus[]
  statusesPhase: ReadPhase
  commit: (patch: TicketUpdate) => Promise<boolean>
  setError: (ticketId: string, message: string) => void
  onEditingChange: (editing: boolean) => void
  /** Whether the project delivers in sprints (SPRIN-82). Forwarded straight through to
   *  `TicketSprintField`, which owns both the conditional and the "absent means show it"
   *  default — deliberately NOT defaulted here, where the cyclomatic budget has one point
   *  left and SPRIN-71's custom fields will want it. */
  hasSprints?: boolean
  /** The project's custom field definitions and the phase of that read (SPRIN-88), forwarded
   *  straight through to `TicketCustomFields`.
   *
   *  **NO DEFAULTS HERE, and that is load-bearing rather than style** — the point the
   *  `hasSprints` note above anticipated. A destructuring default costs a cyclomatic point,
   *  this component sits at 9 of 10, and the dialog that forwards these sits at 10 of 10 with
   *  none at all. Both defaults live in `TicketCustomFields`, which is a new file with its own
   *  budget. Adding `= []` at either stop is what would redden the gate. */
  fields?: ProjectField[]
  fieldsPhase?: ReadPhase
  /** The project's `select`-field options (SPRIN-92 task 10), forwarded straight through to
   *  `TicketCustomFields`, which owns the `[]` default. */
  options?: ProjectFieldOption[]
  /** REQUIRED (fix round 2), not optional — a plain pass-through with no destructuring
   *  default either way, so this costs nothing regardless: this component is measured
   *  UNCHANGED at 9/10 with the type made required, `?` removed. `TicketCustomFields` no
   *  longer defaults it, so a caller of THIS component that forgets to pass it now gets a
   *  compile error here rather than a silently-'loaded' select three hops down. */
  optionsPhase: ReadPhase
  /** The SHELL's retry. The definitions read belongs to the shell, so a failure of it cannot
   *  be fixed by anything this dialog owns. */
  onRetryFields?: () => void
}) {
  const assigneeValue = ticket.assignee_id === currentUser.id ? currentUser.id : ''
  const initial = assigneeValue ? (currentUser.email[0]?.toUpperCase() ?? null) : null

  return (
    <aside className="bg-muted/30 flex flex-col gap-4 rounded-lg border p-4 sm:self-start">
      <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
        Details
      </h3>

      {/* Status. First in the panel: it is the field the board is organised by, and the
          only one that had no keyboard or touch path at all before SPRIN-61 — drag was
          the sole way to change it, which excluded keyboard, screen-reader and touch
          users entirely.

          The options are the project's own `project_statuses` rows (SPRIN-76), which is
          the same list the board renders its columns from — so the picker and the columns
          still cannot drift apart, but the vocabulary is now per-project rather than a
          compile-time constant.

          Because it is a fetch now, it IS disabled until it loads — the docblock here used
          to say the opposite, and that premise is exactly what this story removed.
          `statuses` is `[]` while loading AND after a failed read, so an enabled picker
          over an empty list would render a blank value and offer nothing but the ticket's
          own current status; one interaction could then silently move the ticket. Same
          reason, same shape, as the Sprint picker immediately below.

          `statusOptions` (`@/lib/project-statuses`) — not an inline map — keeps the
          "current status stays selectable even when no row matches it" rule in the domain
          layer, and keeps this component's cyclomatic count off the T2 ceiling. */}
      <label className="flex flex-col gap-1">
        <FieldLabel>Status</FieldLabel>
        <select
          aria-label="status"
          className={selectClass}
          value={ticket.status}
          disabled={statusesPhase !== 'loaded'}
          onChange={(e) => commit({ status: e.target.value })}
        >
          {statusOptions(statuses, ticket.status).map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

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
      {/* If the current parent isn't in the epics list (it was deleted or
          demoted from epic, and the list is refetch-free), still render its
          value so the <select> stays controlled and the link isn't silently
          shown as "No epic" — the user can see it exists and change or clear it. */}
      {ticket.type !== 'epic' ? (
        <TicketReferenceSelect
          label="Parent epic"
          ariaLabel="parent epic"
          value={ticket.parent_epic_id}
          noneLabel="No epic"
          unavailableLabel="Current parent (unavailable)"
          options={epics
            .filter((e) => e.id !== ticket.id)
            .map((e) => ({ id: e.id, label: `${e.key} · ${e.summary}` }))}
          onChange={(next) => commit({ parent_epic_id: next })}
        />
      ) : null}

      {/* Sprint membership (S6.2), and whether the project has sprints at all (SPRIN-82).
          Both live in `TicketSprintField` — the field's reasoning travelled with the field,
          and the `hasSprints` default has to live in a file with cyclomatic headroom, which
          this one does not have. `hasSprints` is forwarded with NO default here for exactly
          that reason: a destructuring default costs a point this component cannot spend. */}
      <TicketSprintField
        ticket={ticket}
        sprints={sprints}
        sprintsPhase={sprintsPhase}
        commit={commit}
        hasSprints={hasSprints}
      />

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
          // The ESTIMATION rule, stated where it belongs. It was `EditableText`'s hardcoded
          // default until SPRIN-88 gave custom `number` fields — which legitimately take
          // negatives — the same component.
          min={0}
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

      {/* The project's custom fields (SPRIN-88), each with this ticket's value. Rendered
          UNCONDITIONALLY — no `fields.length &&` guard, no phase check — because a conditional
          here costs the one cyclomatic point this component has left, and SPRIN-92 (single-select
          fields) still has to fit. `TicketCustomFields` answers "should anything show at all?"
          itself, and renders nothing when the project has no custom fields, which is AC6.

          Last in the panel on purpose: the built-in fields are the ones every project has, and a
          project with no custom fields must read exactly as it did before this story. */}
      <TicketCustomFields
        ticket={ticket}
        fields={fields}
        fieldsPhase={fieldsPhase}
        options={options}
        optionsPhase={optionsPhase}
        onRetryFields={onRetryFields}
      />

      <p className="text-muted-foreground border-border/70 border-t pt-3 text-[11px]">
        Updated {new Date(ticket.updated_at).toLocaleString()}
      </p>
    </aside>
  )
}
