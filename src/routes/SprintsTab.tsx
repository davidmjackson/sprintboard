import { Navigate, useOutletContext } from 'react-router-dom'

import { selectSprintTickets } from '@/lib/backlog'
import { doneSlugs } from '@/lib/project-statuses'
import { hasSprints, SPRINT_STATUS_LABELS } from '@/lib/domain'
import type { ProjectShellContext } from './ProjectShell'
import { CompleteSprintButton } from './CompleteSprintButton'
import { CreateSprintDialog } from './CreateSprintDialog'
import { LoadFailure } from './LoadFailure'
import { SprintDates } from './SprintDates'
import { StartSprintButton } from './StartSprintButton'

/**
 * The project's sprints, newest first, with a create dialog.
 *
 * The sprints themselves live in `ProjectShellContext` (S6.2): the shell renders the ticket
 * detail dialog, whose sprint picker needs the same list this tab shows, so the read was
 * hoisted there and this tab became a pure view of it. The three-state discriminant
 * (`sprintsPhase`) and the reasoning behind it moved with it — see `ProjectShell`.
 *
 * The create trigger only renders once `sprintsPhase === 'loaded'`. `sprints` is `[]` during
 * both loading and failed, so `defaultSprintName` would otherwise number off an empty array —
 * a duplicate 'Sprint 1' if sprints are still in flight, and an invisible create (the shell's
 * `onSprintCreated` guard drops it) if the read failed.
 *
 * The Complete trigger is gated on `statusesPhase` for the same class of reason (SPRIN-77) —
 * see `canComplete` below, where the specific failure mode is spelled out.
 */
export function SprintsTab() {
  const {
    project,
    sprints,
    sprintsPhase: phase,
    onSprintCreated,
    onSprintUpdated,
    onSprintCompleted,
    onRetry,
    tickets,
    ticketsPhase,
    statuses,
    statusesPhase,
  } = useOutletContext<ProjectShellContext>()

  /**
   * SPRIN-82 AC2. ABSENT, not merely hidden — and this is a different hole from the one
   * `ProjectShellHeader` closes by not rendering the nav link.
   *
   * Hiding a link removes the door a user is OFFERED; it leaves the URL itself fully live.
   * A bookmark, a shared link, browser history, the back button, or a link written down
   * before the project's type was known all arrive here directly, and without this guard
   * they get the whole tab: the sprint list, the Start and Complete buttons, and above all
   * `CreateSprintDialog` — which would happily write a real sprint row for a project that
   * delivers continuously and has nowhere left to show it. That row is not cosmetic; it is
   * a sprint the user can neither see nor complete afterwards.
   *
   * It sits AFTER the `useOutletContext` destructuring above and before everything else,
   * which is the only correct position: hooks must run unconditionally on every render
   * (returning before one would break the rules of hooks the moment a second hook is added
   * here), and nothing below should get the chance to build sprint UI first.
   *
   * `replace` rather than a push, so the dead URL does not enter the history stack. Pushing
   * would leave Back pointing at the sprints route, which redirects forward again — the
   * user presses Back, watches the board reappear, and is trapped. Replacing it means Back
   * goes to wherever they genuinely came from.
   *
   * `../board` is relative to this `sprints` CHILD ROUTE, so `..` climbs one route level to
   * the project shell — `/projects/:projectId` — and resolves to `/projects/:id/board`, not
   * to `/board`. The board is the right destination because it is the one tab every project
   * type has, and it is where a continuously-delivered project's work actually lives.
   *
   * The rule itself is `hasSprints` in `domain.ts` and is never re-spelled here: two copies
   * of one predicate agree right up until someone edits one of them (SPRIN-82 AC5).
   */
  if (!hasSprints(project)) return <Navigate to="../board" replace />

  // Derived ONCE for every row, from the project's status rows by CATEGORY rather than by the
  // slug 'done' (SPRIN-77). `doneSlugs` is the single derivation the sprint-completion DB
  // filter and the shell's optimistic reducer both use — two independent derivations of
  // "terminal" could drift, and the reducer's idempotency argument depends on them agreeing.
  const terminalSlugs = doneSlugs(statuses)

  // And the phase is consulted before the list, the same rule the create trigger below
  // follows. This is not decoration: `statuses` is `[]` both while loading and when the read
  // failed, which yields an EMPTY terminal set — indistinguishable from a project that has
  // nothing terminal, in which case `completeSprint` omits its filter and returns EVERY
  // ticket to the backlog, Done ones included. Before SPRIN-77 the rule was a hardcoded
  // literal and could not be wrong; now that it is read, a degraded read must not be allowed
  // to look like an answer. Hiding the button is the honest degradation — the same one the
  // ticket-count badge makes — and the tab's own Retry restores it.
  const canComplete = statusesPhase === 'loaded'

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Sprints</h2>
        {phase === 'loaded' ? (
          <CreateSprintDialog
            projectId={project.id}
            existing={sprints}
            onCreated={onSprintCreated}
          />
        ) : null}
      </div>

      {phase === 'loading' ? <p className="text-muted-foreground text-sm">Loading…</p> : null}

      {/* `onRetry` re-runs both of the shell's reads, so this one button also clears a
          failed ticket count in the rows below — the two reads usually fail together. */}
      {phase === 'failed' ? <LoadFailure resource="sprints" onRetry={onRetry} /> : null}

      {phase === 'loaded' && sprints.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center rounded-lg border border-dashed">
          <p className="text-muted-foreground text-sm">No sprints yet.</p>
        </div>
      ) : null}

      {sprints.length > 0 ? (
        <ul className="divide-y rounded-lg border">
          {sprints.map((sprint) => (
            <li key={sprint.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-[2] truncate font-medium">{sprint.name}</span>
              {sprint.goal ? (
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                  {sprint.goal}
                </span>
              ) : null}
              <SprintDates sprint={sprint} />
              {/* Membership comes from `selectSprintTickets`, never an inline filter: the
                  `sprint_id` rule lives in `backlog.ts` and is read from both sides there —
                  the backlog is `sprint_id is null`, a sprint's tickets are the ones naming
                  it. The bare number needs a unit for screen readers, and it is real
                  `sr-only` text rather than an `aria-label`: a <span> maps to
                  `role="generic"`, on which ARIA 1.2 *prohibits* aria-label — browsers
                  honour it so it looks fine, but axe-core flags it.

                  A count is only rendered once the tickets are actually IN HAND: `tickets` is
                  `[]` both while the read is in flight and when it failed, so anything short
                  of 'loaded' would count an empty array and render a confident "0 tickets" for
                  a list we do not have. Hence `!== 'loaded'` rather than a test per phase — a
                  gate naming only 'failed' would let the loading case fall through, and vice
                  versa, which is exactly how the false zero survived S6.2. This count is the
                  only observable evidence that a ticket joined a sprint, so a false zero
                  discredits the one thing the tab is meant to show. '—' is not a number and
                  cannot be misread as one.

                  The two non-loaded phases render the same '—' but are not the same fact —
                  one resolves on its own, the other will not — so the `sr-only` text differs.
                  There is no Retry here: a badge cannot hold one, and the sprint list around
                  it loaded fine. The Backlog and Board carry the retry for this same failed
                  read; a degraded badge is not a page-level error. */}
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
                {ticketsPhase !== 'loaded' ? (
                  <>
                    <span aria-hidden="true">—</span>
                    {/* Honest: the number is not known, rather than claiming a count. The
                        em-dash is aria-hidden, so this text is the only thing that carries
                        the distinction to a screen reader. */}
                    <span className="sr-only">
                      {ticketsPhase === 'loading'
                        ? 'Ticket count loading'
                        : 'Ticket count unavailable'}
                    </span>
                  </>
                ) : (
                  <>
                    {selectSprintTickets(tickets, sprint.id).length}
                    <span className="sr-only"> tickets</span>
                  </>
                )}
              </span>
              <span className="bg-muted text-muted-foreground shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
                {SPRINT_STATUS_LABELS[sprint.status]}
              </span>
              {sprint.status === 'future' ? (
                <StartSprintButton sprint={sprint} onStarted={onSprintUpdated} />
              ) : null}
              {sprint.status === 'active' && canComplete ? (
                <CompleteSprintButton
                  sprint={sprint}
                  terminalSlugs={terminalSlugs}
                  onCompleted={onSprintCompleted}
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
