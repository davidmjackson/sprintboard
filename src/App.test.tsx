import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import App from './App'
import { AuthProvider } from '@/lib/auth'

// A configurable auth mock: `state.session` is what getSession() returns, the
// onAuthStateChange callback is captured so signOut() can drive a real state change,
// and signOut() nulls the session and fires that callback — exactly as GoTrue does.
const h = vi.hoisted(() => {
  const state: { session: unknown } = { session: null }
  let cb: ((event: string, session: unknown) => void) | null = null
  return {
    state,
    reset() {
      state.session = null
      cb = null
    },
    getSession: vi.fn(async () => ({ data: { session: state.session } })),
    onAuthStateChange: vi.fn((fn: (e: string, s: unknown) => void) => {
      cb = fn
      return { data: { subscription: { unsubscribe: vi.fn() } } }
    }),
    signOut: vi.fn(async () => {
      state.session = null
      cb?.('SIGNED_OUT', null)
      return { error: null }
    }),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
  }
})

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: h.getSession,
      onAuthStateChange: h.onAuthStateChange,
      signOut: h.signOut,
      signInWithPassword: h.signInWithPassword,
      signUp: h.signUp,
    },
  },
}))

const SESSION = { access_token: 't', user: { id: 'u1', email: 'a@example.com' } }

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  h.reset()
  h.signOut.mockClear()
})

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

  it('restores a persisted session on load, landing on the app not /login', async () => {
    // A refresh is a remount: getSession() reads the persisted session.
    h.state.session = SESSION
    renderAt('/')
    expect(await screen.findByText(/You are signed in/)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Log in' })).not.toBeInTheDocument()
  })

  it('logs out: clears the session and returns to the login screen', async () => {
    h.state.session = SESSION
    const user = userEvent.setup()
    renderAt('/')

    await screen.findByText(/You are signed in/)
    await user.click(screen.getByRole('button', { name: 'Log out' }))

    expect(h.signOut).toHaveBeenCalledOnce()
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
  })
})
