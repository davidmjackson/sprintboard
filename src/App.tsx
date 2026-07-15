import { Navigate, Route, Routes } from 'react-router-dom'

import { RequireAuth } from '@/routes/RequireAuth'
import { AppLayout } from '@/routes/AppLayout'
import { SignupPage } from '@/routes/SignupPage'
import { LoginPage } from '@/routes/LoginPage'
import { ProjectsHome } from '@/routes/ProjectsHome'
import { ProjectView } from '@/routes/ProjectView'

/**
 * The route table. Public auth routes, then the authenticated shell (`AppLayout`, with
 * the project nav) wrapping the project routes. The board tabs inside a project arrive
 * with S3.3.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<AppLayout />}>
          <Route path="/" element={<ProjectsHome />} />
          <Route path="/projects/:projectId" element={<ProjectView />} />
          {/* Unknown authed paths fall back to the home landing. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  )
}
