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
    // AppLayout lists projects on mount; give it an empty list.
    from: () => ({ select: () => ({ order: () => Promise.resolve({ data: [], error: null }) }) }),
    auth: {
      getSession: h.getSession,
      onAuthStateChange: h.onAuthStateChange,
      signOut: h.signOut,
      signInWithPassword: h.signInWithPassword,
      signUp: h.signUp,
    },
  },
}))

/**
 * The four project tabs, stubbed down to a sentinel each, plus a `ProjectShell` that is nothing
 * but the `<Outlet />` its real counterpart renders.
 *
 * The subject here is `App`'s ROUTE TABLE and only that: which paths exist, and which element
 * each one resolves to. Stubbing the tabs is what keeps it that — the real components need
 * tickets, sprints and statuses plumbed through the shell's context, and a test that supplied
 * all of it would go red for a dozen reasons that have nothing to do with a route. Every tab's
 * own behaviour is covered in its own file; none of those files can see this table at all.
 */
vi.mock('@/routes/ProjectShell', async () => {
  const { Outlet } = await import('react-router-dom')
  return { ProjectShell: () => <Outlet /> }
})
vi.mock('@/routes/BoardTab', () => ({ BoardTab: () => <p>the board tab</p> }))
vi.mock('@/routes/BacklogTab', () => ({ BacklogTab: () => <p>the backlog tab</p> }))
vi.mock('@/routes/SprintsTab', () => ({ SprintsTab: () => <p>the sprints tab</p> }))
vi.mock('@/routes/SettingsTab', () => ({ SettingsTab: () => <p>the settings tab</p> }))

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
    // The authed shell renders (its Log out control), not the login screen.
    expect(await screen.findByRole('button', { name: 'Log out' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Log in' })).not.toBeInTheDocument()
  })

  /**
   * THE ROUTE, NOT THE LINK — and against the REAL table, which is the part that was missing.
   *
   * `ProjectShell.test.tsx` builds its own `<Routes>` containing a settings route, so it
   * exercises that fixture and never this file: deleting `<Route path="settings">` from `App`,
   * or misspelling its path, left all 750 unit tests green while `/projects/:id/settings`
   * silently fell through to the catch-all redirect and the whole user-facing surface of
   * SPRIN-77 became unreachable.
   *
   * A missing route does not 404 here — `<Route path="*">` sends it to the home landing — so
   * the assertion pairs the tab's sentinel WITH the absence of that landing. The sentinel alone
   * would be enough today, but the pairing is what names the actual failure mode.
   *
   * All four tabs, not only Settings: the blind spot was never specific to the new route (the
   * pre-existing `sprints` route survived deletion in exactly the same way), and covering the
   * other three costs one table row each.
   */
  it.each([
    ['board', 'the board tab'],
    ['backlog', 'the backlog tab'],
    ['sprints', 'the sprints tab'],
    ['settings', 'the settings tab'],
  ])('resolves /projects/:projectId/%s to its tab', async (tab, sentinel) => {
    h.state.session = SESSION
    renderAt(`/projects/p1/${tab}`)

    expect(await screen.findByText(sentinel)).toBeInTheDocument()
    // `ProjectsHome`'s heading — what the catch-all redirect lands on. Its ABSENCE is the
    // second half of the evidence: the sentinel says the tab rendered, this says the router
    // did not quietly bounce the URL somewhere that happens to render nothing recognisable.
    expect(screen.queryByRole('heading', { name: 'Sprintboard' })).not.toBeInTheDocument()
  })

  it('logs out: clears the session and returns to the login screen', async () => {
    h.state.session = SESSION
    const user = userEvent.setup()
    renderAt('/')

    await user.click(await screen.findByRole('button', { name: 'Log out' }))

    expect(h.signOut).toHaveBeenCalledOnce()
    expect(await screen.findByRole('heading', { name: 'Log in' })).toBeInTheDocument()
  })
})
