import { Navigate, Outlet } from 'react-router-dom'

import { useAuth } from '@/lib/auth-context'

/**
 * The authentication gate. Wraps every protected route.
 *
 * While the initial session is still resolving we render nothing decisive — a bare
 * loading state — because redirecting before `loading` clears would bounce a
 * logged-in user to /login on every page load. Once resolved: no session → /login,
 * session → render the nested routes.
 *
 * The redirect assertions are S2.3's tests; this component ships now so the router
 * has a working guard from the first auth story.
 */
export function RequireAuth() {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <main className="flex min-h-svh items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </main>
    )
  }

  if (!session) {
    return <Navigate to="/login" replace />
  }

  return <Outlet />
}
