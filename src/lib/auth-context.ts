import { createContext, useContext } from 'react'
import type { Session, User } from '@supabase/supabase-js'

/**
 * The auth-state context and its hook, kept apart from the `AuthProvider` component
 * (in `auth.tsx`) so each file stays single-purpose — the codebase's ESLint config
 * asks app modules to export either components or plain values, not both.
 */

export type AuthState = {
  session: Session | null
  user: User | null
  loading: boolean
}

export const AuthContext = createContext<AuthState | undefined>(undefined)

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
