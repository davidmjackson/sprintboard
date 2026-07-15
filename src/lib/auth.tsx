import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'

import { supabase } from './supabase'
import { AuthContext } from './auth-context'

/**
 * Publishes auth state to React, and nothing else.
 *
 * The provider is deliberately the only writer of session state and holds no
 * `signUp`/`signIn`/`signOut` actions: forms call `supabase.auth.*` directly, and the
 * `onAuthStateChange` listener below is the single path by which that reaches React.
 * One writer, one subscription — no chance of the context and the client drifting.
 *
 * `loading` is true only until the initial session resolves. Guards must wait on it:
 * redirecting to /login before the session is known would bounce an authenticated
 * user out on every refresh. See `RequireAuth`.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true

    // The initial read: what does persisted storage say right now?
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return
      setSession(data.session)
      setLoading(false)
    })

    // Every subsequent change: sign-in, sign-out, token refresh, another tab.
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return
      setSession(nextSession)
      setLoading(false)
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  return (
    <AuthContext.Provider value={{ session, user: session?.user ?? null, loading }}>
      {children}
    </AuthContext.Provider>
  )
}
