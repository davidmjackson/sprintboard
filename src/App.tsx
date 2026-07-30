import { Navigate, Route, Routes } from 'react-router-dom'

import { RequireAuth } from '@/routes/RequireAuth'
import { AppLayout } from '@/routes/AppLayout'
import { SignupPage } from '@/routes/SignupPage'
import { LoginPage } from '@/routes/LoginPage'
import { ProjectsHome } from '@/routes/ProjectsHome'
import { ProjectShell } from '@/routes/ProjectShell'
import { BoardTab } from '@/routes/BoardTab'
import { BacklogTab } from '@/routes/BacklogTab'
import { SprintsTab } from '@/routes/SprintsTab'
import { CrashFallback, ErrorBoundary } from '@/routes/ErrorBoundary'

/**
 * The route table. Public auth routes, then the authenticated shell (`AppLayout`, with
 * the project nav) wrapping the project routes. Inside a project, the shell carries the
 * Board, Backlog and Sprints tabs as nested routes, so the chosen tab lives in the URL.
 *
 * The app-scope `ErrorBoundary` is mounted here rather than in `main.tsx` because
 * `main.tsx` is an untested bootstrap, so a boundary placed there could never be
 * verified — a throw inside `AuthProvider` or `BrowserRouter` is still above this one.
 *
 * **Its fallback's action is a full page reload, not `reset`.** This boundary wraps
 * `<Routes>` itself, so when its fallback is on screen the entire router is unmounted —
 * there is no nav, no link, nothing left above the fallback that a re-render could change.
 * `reset` would only re-run the same render that just threw and reproduce the identical
 * crash. A reload is the one action that actually recovers a crashed root. `ProjectShell`'s
 * tab-scope boundary keeps `reset`: a tab crash leaves the rest of the shell mounted, so
 * re-rendering just the subtree is genuinely useful there.
 */
export default function App() {
  return (
    <ErrorBoundary
      fallback={() => <CrashFallback scope="app" onRetry={() => window.location.reload()} />}
    >
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/login" element={<LoginPage />} />

        <Route element={<RequireAuth />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<ProjectsHome />} />
            <Route path="/projects/:projectId" element={<ProjectShell />}>
              <Route index element={<Navigate to="board" replace />} />
              <Route path="board" element={<BoardTab />} />
              <Route path="backlog" element={<BacklogTab />} />
              <Route path="sprints" element={<SprintsTab />} />
            </Route>
            {/* Unknown authed paths fall back to the home landing. */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Route>
      </Routes>
    </ErrorBoundary>
  )
}
