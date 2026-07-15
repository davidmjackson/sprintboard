import { Navigate, Route, Routes } from 'react-router-dom'

import { supabase } from '@/lib/supabase'
import { useAuth } from '@/lib/auth-context'
import { Button } from '@/components/ui/button'
import { RequireAuth } from '@/routes/RequireAuth'
import { SignupPage } from '@/routes/SignupPage'
import { LoginPage } from '@/routes/LoginPage'
import { CreateProjectDialog } from '@/routes/CreateProjectDialog'

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

/**
 * Placeholder for the authenticated app. Replaced by the project shell in S3.3, which
 * is where the logout control ultimately lives — it sits here now because this is the
 * only authenticated surface. Logout just calls `signOut`: `onAuthStateChange` nulls
 * the session and `RequireAuth` redirects to /login, so no explicit navigation.
 */
function BoardPlaceholder() {
  const { user } = useAuth()

  return (
    <div className="min-h-svh">
      <header className="flex items-center justify-between border-b px-4 py-3">
        <span className="font-semibold tracking-tight">Sprintboard</span>
        <div className="flex items-center gap-3">
          {user?.email ? <span className="text-muted-foreground text-sm">{user.email}</span> : null}
          <CreateProjectDialog />
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void supabase.auth.signOut()
            }}
          >
            Log out
          </Button>
        </div>
      </header>

      <main className="flex flex-col items-center justify-center gap-6 p-8">
        <div className="space-y-2 text-center">
          <h1 className="text-3xl font-semibold tracking-tight">Sprintboard</h1>
          <p className="text-muted-foreground text-sm">
            You are signed in. The board arrives with S3.3.
          </p>
        </div>
      </main>
    </div>
  )
}
