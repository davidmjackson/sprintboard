import { Navigate, useOutletContext, useParams } from 'react-router-dom'

import type { ProjectsContext } from './AppLayout'

/**
 * The selected project, addressed by the `:projectId` in the URL — so a refresh keeps
 * you here. The project is looked up in the RLS-scoped list the layout already loaded;
 * an id that isn't in that list (another owner's, or a deleted one) is not the user's
 * to see, so we send them home rather than reveal anything. The Board and Backlog tabs
 * arrive with S3.3.
 */
export function ProjectView() {
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

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        <span className="text-muted-foreground mr-2 font-mono text-lg">{project.key}</span>
        {project.name}
      </h1>
      <p className="text-muted-foreground text-sm">Board and Backlog arrive with S3.3.</p>
    </div>
  )
}
