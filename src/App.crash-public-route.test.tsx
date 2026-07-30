import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { AuthProvider } from '@/lib/auth'

// FIX 3: `App.crash.test.tsx` only ever crashes an AUTHED route (`ProjectsHome`, reached
// through `RequireAuth` + `AppLayout`), so moving the app-scope `ErrorBoundary` down to
// wrap only `<AppLayout />` would still leave that suite green — the boundary would still
// sit above the one route under test. It would silently lose containment on `/login` and
// `/signup`, which sit OUTSIDE `AppLayout`. This test crashes a public route instead, so it
// can only pass while the boundary sits above `<Routes>` itself.
//
// `vi.mock` factories are hoisted ABOVE plain `const` declarations, so anything they close
// over must come from `vi.hoisted` — same device `App.crash.test.tsx` and `App.test.tsx` use.
const h = vi.hoisted(() => ({ canary: 'canary-public-route-crash' }))

vi.mock('@/routes/LoginPage', () => ({
  LoginPage: () => {
    throw new Error(h.canary)
  },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  },
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the app-scope error boundary above a public route', () => {
  it('contains a crash on the public /login route, not just an authed one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    expect(document.body.textContent).not.toContain(h.canary)
  })
})
