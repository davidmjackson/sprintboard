import { SPRINT_STATUS_LABELS, type Sprint, type Ticket, type TicketUpdate } from '@/lib/domain'
import type { SprintsPhase } from './ProjectShell'
import { TicketReferenceSelect } from './TicketReferenceSelect'

/**
 * The ticket detail's sprint membership field, and the one place that decides whether the
 * project has a sprint concept at all (SPRIN-82 AC3).
 *
 * It is its own component for two reasons, and the cohesion one would justify it alone: the
 * field's rules — what "Backlog" means, why the picker is disabled until the list loads, why
 * it is not gated on ticket type — are ~15 lines of reasoning that belong beside the field
 * rather than in the middle of a Details panel that renders six other things.
 *
 * The second reason is the lint budget, and it is the one that forced the timing. `hasSprints`
 * has to be defaulted somewhere, because it travels down from `ProjectShell` through
 * `TicketDetailDialog` and `TicketDetailSidebar`, and any caller that does not set it — every
 * one of the 52 standalone renders in `TicketDetailDialog.test.tsx` — leaves it undefined.
 * **A default parameter costs a cyclomatic point in this repo's eslint config** (measured, not
 * recalled), and both of those forwarding components are at or one below the ceiling of 10:
 * the dialog is at 10 of 10 and cannot absorb a single point. So they forward the prop with no
 * destructuring default, and the default lands here, in the file whose whole job is this one
 * decision. This component ends at complexity 3.
 *
 * `hasSprints = true` — "no answer means show it" — is deliberate rather than incidental. A
 * standalone render of the detail dialog, in a test or anywhere else, is not a statement that
 * the project delivers continuously; it is a render with the question unasked, and the field
 * that has existed since S6.2 is the honest answer to an unasked question. Only a caller that
 * has actually consulted `hasSprints(project)` gets to hide it.
 */
export function TicketSprintField({
  ticket,
  sprints,
  sprintsPhase,
  commit,
  hasSprints = true,
}: {
  ticket: Ticket
  sprints: Sprint[]
  sprintsPhase: SprintsPhase
  commit: (patch: TicketUpdate) => Promise<boolean>
  /** Whether this ticket's project delivers in sprints — `hasSprints(project)` in
   *  `@/lib/domain`, never a comparison written out here. Absent means show the field: see
   *  the docblock above. */
  hasSprints?: boolean
}) {
  // Absent, not disabled and not empty. A project with no sprint concept has nothing to
  // choose between, and an empty picker reading "Backlog" would state a membership that is
  // not a fact about it.
  if (!hasSprints) return null

  return (
    /* Sprint membership (S6.2). `''` is the backlog: `backlog.ts` defines the backlog
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
       sprint", and one click would quietly unsprint it.

       The current sprint isn't in the list (deleted, or the list hasn't loaded):
       still render its value so the <select> stays controlled and the membership
       isn't silently shown as "Backlog". Same guard as the parent-epic picker in the
       sidebar — both are the same `TicketReferenceSelect` component, so it's one
       implementation used twice, not a rule mirrored by hand in two places. */
    <TicketReferenceSelect
      label="Sprint"
      ariaLabel="sprint"
      value={ticket.sprint_id}
      noneLabel="Backlog"
      unavailableLabel="Current sprint (unavailable)"
      options={sprints.map((s) => ({
        id: s.id,
        label: `${s.name} · ${SPRINT_STATUS_LABELS[s.status]}`,
      }))}
      disabled={sprintsPhase !== 'loaded'}
      onChange={(next) => commit({ sprint_id: next })}
    />
  )
}
