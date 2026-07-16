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

/**
 * The route table. Public auth routes, then the authenticated shell (`AppLayout`, with
 * the project nav) wrapping the project routes. Inside a project, the shell carries the
 * Board, Backlog and Sprints tabs as nested routes, so the chosen tab lives in the URL.
 */
export default function App() {
  return (
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
  )
}
