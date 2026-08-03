import { NavLink } from 'react-router-dom'

import { PROJECT_TYPE_LABELS, type Project, type Ticket } from '@/lib/domain'
// Imported from the hook module, not from `./ProjectShell`. `ProjectShell` value-imports
// this component, so taking the type from there would close an import cycle — harmless
// today because `import type` is erased, but not worth leaving for someone to trip over.
import type { ReadPhase } from '@/lib/project-reads'
import { cn } from '@/lib/utils'
import { CreateTicketDialog } from './CreateTicketDialog'

function tabClass({ isActive }: { isActive: boolean }): string {
  return cn(
    'border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
    isActive
      ? 'border-foreground text-foreground'
      : 'text-muted-foreground hover:text-foreground border-transparent',
  )
}

type ProjectShellHeaderProps = {
  project: Project
  ticketsPhase: ReadPhase
  /** Called with the created ticket so the shell can append it to its own list. */
  onTicketCreated: (ticket: Ticket) => void
}

/**
 * The project title, the create-ticket affordance, and the tab bar.
 *
 * Split out of `ProjectShell` so the shell reads as state and wiring rather than markup —
 * and so the create gate below sits next to the reasoning that justifies it instead of
 * being buried in a 100-line render.
 */
export function ProjectShellHeader({
  project,
  ticketsPhase,
  onTicketCreated,
}: ProjectShellHeaderProps) {
  return (
    <header className="flex flex-col gap-3 border-b px-8 pt-6">
      <div className="flex items-start justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="text-muted-foreground mr-2 font-mono text-lg">{project.key}</span>
          {/* Rendered for EVERY project type, not only Kanban: "Scrum" is a badge reading
              Scrum, never the absence of one. Same treatment as the ticket-type badge on
              `TicketCard`, deliberately reused rather than reinvented. The label comes from
              `PROJECT_TYPE_LABELS` — display names live in `domain.ts` and nowhere else. */}
          <span className="bg-muted text-muted-foreground mr-2 rounded px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase">
            {PROJECT_TYPE_LABELS[project.project_type]}
          </span>
          {project.name}
        </h1>
        {/* The trigger only renders once `ticketsPhase === 'loaded'`, and that gate is
            load-bearing — do not remove it to "always let people create a ticket".

            The shell's `onTicketCreated` appends only to a `loaded` list, because it cannot
            do anything else: a `failed` state has no tickets to append to, and inventing one
            would resurrect the very "a failed read looks successful" defect S4.6 removed. So
            an UNGATED trigger plus that guard equals an INVISIBLE CREATE: `createTicket`
            succeeds, the row is really written and really holds a key, the dialog closes —
            and the UI shows no trace at all. The user reads that as "it didn't work", creates
            it again, and now owns duplicate tickets. A create whose result you cannot see is
            worse than no create button, so the button is withheld until we have a list to put
            the result into. Hiding rather than disabling matches `SprintsTab`'s
            CreateSprintDialog, which gates on its own phase for this same reason.

            The Board and Backlog carry the error and the Retry for this failed read, so the
            create affordance comes back on its own the moment the read recovers. */}
        {ticketsPhase === 'loaded' ? (
          <CreateTicketDialog projectId={project.id} onCreated={onTicketCreated} />
        ) : null}
      </div>
      <nav className="flex gap-4">
        <NavLink to="board" className={tabClass}>
          Board
        </NavLink>
        <NavLink to="backlog" className={tabClass}>
          Backlog
        </NavLink>
        <NavLink to="sprints" className={tabClass}>
          Sprints
        </NavLink>
        <NavLink to="settings" className={tabClass}>
          Settings
        </NavLink>
      </nav>
    </header>
  )
}
