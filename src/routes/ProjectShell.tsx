import { Navigate, NavLink, Outlet, useOutletContext, useParams } from 'react-router-dom'

import type { ProjectsContext } from './AppLayout'
import type { Project } from '@/lib/domain'
import { cn } from '@/lib/utils'

/** What the shell hands to its Board/Backlog tabs via the nested <Outlet context>.
 *  The tabs don't need it yet; E4 will load tickets scoped to `project.id`. */
export type ProjectShellContext = { project: Project }

/**
 * The project shell, addressed by `:projectId` — so a refresh keeps you here, and the
 * chosen tab (a nested route) survives too. The project is looked up in the RLS-scoped
 * list the layout already loaded; an id that isn't in that list (another owner's, or a
 * deleted one) is not the user's to see, so we send them home rather than reveal
 * anything. Board and Backlog render inside the <Outlet>.
 */
export function ProjectShell() {
  const { projects, loading } = useOutletContext<ProjectsContext>()
  const { projectId } = useParams()

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    )
  }

  const project = projects.find((p) => p.id === projectId)
  if (!project) return <Navigate to="/" replace />

  const tabClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      'border-b-2 px-1 pb-2 text-sm font-medium transition-colors',
      isActive
        ? 'border-foreground text-foreground'
        : 'text-muted-foreground hover:text-foreground border-transparent',
    )

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex flex-col gap-3 border-b px-8 pt-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          <span className="text-muted-foreground mr-2 font-mono text-lg">{project.key}</span>
          {project.name}
        </h1>
        <nav className="flex gap-4">
          <NavLink to="board" className={tabClass}>
            Board
          </NavLink>
          <NavLink to="backlog" className={tabClass}>
            Backlog
          </NavLink>
        </nav>
      </header>
      <div className="flex-1 p-8">
        <Outlet context={{ project } satisfies ProjectShellContext} />
      </div>
    </div>
  )
}
