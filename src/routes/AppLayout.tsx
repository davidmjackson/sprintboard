import { useCallback, useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'

import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { listProjects } from '@/lib/projects'
import type { Project } from '@/lib/domain'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { CreateProjectDialog } from './CreateProjectDialog'

/** What the layout hands to its routed children via <Outlet context>. */
export type ProjectsContext = { projects: Project[]; loading: boolean }

/**
 * The authenticated shell: a left nav listing the owner's projects, and the routed
 * project view beside it. Selecting a project is a navigation to /projects/:id, so the
 * choice lives in the URL and survives a refresh. The list is RLS-scoped by
 * `listProjects` — another user's projects can never appear.
 */
export function AppLayout() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      setProjects(await listProjects())
    } catch {
      // Keep the current list on a transient failure — same posture as the mount load.
    }
  }, [])

  useEffect(() => {
    let active = true
    listProjects()
      .then((p) => active && setProjects(p))
      .catch(() => {}) // an empty nav is the acceptable failure mode here
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="flex min-h-svh">
      <aside className="bg-muted/30 flex w-64 shrink-0 flex-col gap-4 border-r p-4">
        <span className="font-semibold tracking-tight">Sprintboard</span>

        <nav className="flex flex-1 flex-col gap-1">
          {loading ? (
            <p className="text-muted-foreground text-sm">Loading…</p>
          ) : projects.length === 0 ? (
            <p className="text-muted-foreground text-sm">No projects yet.</p>
          ) : (
            projects.map((project) => (
              <NavLink
                key={project.id}
                to={`/projects/${project.id}`}
                className={({ isActive }) =>
                  cn(
                    'hover:bg-muted flex items-baseline gap-2 rounded-md px-2 py-1.5 text-sm',
                    isActive && 'bg-muted font-medium',
                  )
                }
              >
                <span className="text-muted-foreground font-mono text-xs">{project.key}</span>
                <span className="truncate">{project.name}</span>
              </NavLink>
            ))
          )}
        </nav>

        <CreateProjectDialog
          onCreated={(project) => {
            // Insert optimistically so the navigation lands on the new project
            // immediately. refetch is a round-trip; navigating before it resolves would
            // hit ProjectView with a stale list and bounce the user home. The
            // background refetch then reconciles ordering.
            setProjects((prev) => [...prev, project])
            navigate(`/projects/${project.id}`)
            void refetch()
          }}
        />

        <div className="border-t pt-3">
          {user?.email ? (
            <p className="text-muted-foreground truncate text-xs">{user.email}</p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="mt-2 w-full"
            onClick={() => {
              void supabase.auth.signOut()
            }}
          >
            Log out
          </Button>
        </div>
      </aside>

      <main className="flex-1">
        <Outlet context={{ projects, loading } satisfies ProjectsContext} />
      </main>
    </div>
  )
}
