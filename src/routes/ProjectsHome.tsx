import { useOutletContext } from 'react-router-dom'

import type { ProjectsContext } from './AppLayout'

/** The `/` landing inside the shell: no project is selected yet. */
export function ProjectsHome() {
  const { projects, loading } = useOutletContext<ProjectsContext>()

  const message = loading
    ? 'Loading…'
    : projects.length === 0
      ? 'Create your first project to get started.'
      : 'Select a project from the left to open it.'

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-2 p-8 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">Sprintboard</h1>
      <p className="text-muted-foreground text-sm">{message}</p>
    </div>
  )
}
