import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import App from './App'
import { AuthProvider } from '@/lib/auth'

// `vi.mock` factories are hoisted ABOVE plain `const` declarations, so anything they
// close over must come from `vi.hoisted` or the factory hits a TDZ error at run time.
// `App.test.tsx` uses the same device for the same reason.
const h = vi.hoisted(() => ({
  canary: 'canary-rls-policy-detail',
  session: { access_token: 't', user: { id: 'u1', email: 'a@example.com' } },
}))

// The landing page is the simplest authed route to crash on purpose.
vi.mock('@/routes/ProjectsHome', () => ({
  ProjectsHome: () => {
    throw new Error(h.canary)
  },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
    auth: {
      getSession: vi.fn(async () => ({ data: { session: h.session } })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
      signOut: vi.fn(),
    },
  },
}))

describe('the app-scope error boundary', () => {
  it('contains a crash in a route instead of blanking the page, and hides the error text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    )

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    expect(document.body.textContent).not.toContain(h.canary)
    vi.restoreAllMocks()
  })
})
