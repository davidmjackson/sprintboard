import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

afterEach(() => {
  vi.restoreAllMocks()
})

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
  })

  // FIX 1: the app boundary wraps <Routes> itself, so its fallback's `reset` would only
  // re-run the identical render that just threw — there is no router left above the
  // fallback to navigate with. The action is a full page reload instead. jsdom does not
  // let a spy redefine `window.location.reload` directly ("Cannot redefine property:
  // reload"), so the whole `location` object is swapped for a stub with a spy reload,
  // then restored — proven necessary by running the direct `vi.spyOn` form first and
  // watching it throw.
  it('reloads the page instead of re-rendering when Try again is clicked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    const originalLocation = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload },
    })

    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>,
    )

    await screen.findByRole('alert')
    await user.click(screen.getByRole('button', { name: 'Reload page' }))

    expect(reload).toHaveBeenCalledOnce()

    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
  })
})
