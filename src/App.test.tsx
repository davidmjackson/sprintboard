import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import App from './App'
import { AuthProvider } from '@/lib/auth'

// The AuthProvider reads the session and subscribes; give it a signed-out client.
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      onAuthStateChange: vi.fn().mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
      }),
      signUp: vi.fn(),
      signInWithPassword: vi.fn(),
    },
  },
}))

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

describe('routing and the auth guard', () => {
  it('renders the signup form at /signup', async () => {
    renderAt('/signup')
    expect(await screen.findByRole('heading', { name: 'Create your account' })).toBeInTheDocument()
    // S1.1's intent lives on: a shadcn Button, styled by its cva variants, renders.
    const button = screen.getByRole('button', { name: 'Create account' })
    expect(button).toHaveClass('inline-flex', 'items-center', 'justify-center')
  })

  it('redirects an unauthenticated visit to the board to /login', async () => {
    renderAt('/')
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
  })
})
