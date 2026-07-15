import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { Session, User } from '@supabase/supabase-js'

import { RequireAuth } from './RequireAuth'
import { useAuth } from '@/lib/auth-context'
import type { AuthState } from '@/lib/auth-context'

vi.mock('@/lib/auth-context', () => ({ useAuth: vi.fn() }))
const mockUseAuth = vi.mocked(useAuth)

function setAuth(state: Partial<AuthState>) {
  mockUseAuth.mockReturnValue({ session: null, user: null, loading: false, ...state })
}

// A signed-in state. Only presence matters to the guard, not the contents.
const SIGNED_IN: Pick<AuthState, 'session' | 'user'> = {
  session: { access_token: 't' } as Session,
  user: { id: 'u1' } as User,
}

/** Two protected routes so "any route" is more than one path. */
function renderGuard(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div>LOGIN SCREEN</div>} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<div>PROTECTED HOME</div>} />
          <Route path="/projects/:id" element={<div>PROTECTED DEEP</div>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('RequireAuth', () => {
  it('shows a loading state while the session resolves — no content, no premature redirect', () => {
    setAuth({ loading: true })
    renderGuard('/')

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText('PROTECTED HOME')).not.toBeInTheDocument()
    // The key correctness property: a logged-in user is NOT bounced before resolve.
    expect(screen.queryByText('LOGIN SCREEN')).not.toBeInTheDocument()
  })

  it('redirects an unauthenticated visitor from a protected route to /login', () => {
    setAuth({ session: null })
    renderGuard('/')

    expect(screen.getByText('LOGIN SCREEN')).toBeInTheDocument()
    expect(screen.queryByText('PROTECTED HOME')).not.toBeInTheDocument()
  })

  it('redirects an unauthenticated visitor from ANY protected route, including deep paths', () => {
    setAuth({ session: null })
    renderGuard('/projects/abc-123')

    expect(screen.getByText('LOGIN SCREEN')).toBeInTheDocument()
    expect(screen.queryByText('PROTECTED DEEP')).not.toBeInTheDocument()
  })

  it('renders the route for an authenticated visitor, with no redirect', () => {
    setAuth(SIGNED_IN)
    renderGuard('/')

    expect(screen.getByText('PROTECTED HOME')).toBeInTheDocument()
    expect(screen.queryByText('LOGIN SCREEN')).not.toBeInTheDocument()
  })

  it('does not redirect an authenticated visitor on a deep path either', () => {
    setAuth(SIGNED_IN)
    renderGuard('/projects/abc-123')

    expect(screen.getByText('PROTECTED DEEP')).toBeInTheDocument()
    expect(screen.queryByText('LOGIN SCREEN')).not.toBeInTheDocument()
  })
})
