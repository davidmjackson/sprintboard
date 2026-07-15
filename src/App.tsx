import { Navigate, Route, Routes } from 'react-router-dom'

import { RequireAuth } from '@/routes/RequireAuth'
import { SignupPage } from '@/routes/SignupPage'
import { LoginPage } from '@/routes/LoginPage'

/**
 * The route table. Public auth routes, then everything else behind the auth guard.
 * The authenticated area is still the Phase 1 placeholder — the real project shell
 * arrives with S3.3.
 */
export default function App() {
  return (
    <Routes>
      <Route path="/signup" element={<SignupPage />} />
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route path="/" element={<BoardPlaceholder />} />
        {/* Unknown authed paths fall back to the board. */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

/** Placeholder for the authenticated app. Replaced by the project shell in S3.3. */
function BoardPlaceholder() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-8">
      <div className="space-y-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">Sprintboard</h1>
        <p className="text-muted-foreground text-sm">
          You are signed in. The board arrives with S3.3.
        </p>
      </div>
    </main>
  )
}
