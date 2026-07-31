import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LoginPage } from './LoginPage'
import { supabase } from '@/lib/supabase'

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { signInWithPassword: vi.fn() } },
}))

const signIn = vi.mocked(supabase.auth.signInWithPassword)

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/" element={<div>AUTHED HOME</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  signIn.mockReset()
})

describe('LoginPage', () => {
  it('signs in with valid credentials and lands on the app', async () => {
    signIn.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 't' } },
      error: null,
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>)
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText('Email'), 'a@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    expect(await screen.findByText('AUTHED HOME')).toBeInTheDocument()
    expect(signIn).toHaveBeenCalledWith({ email: 'a@example.com', password: 'password123' })
  })

  it('replaces the login entry, so Back does not return to the form', async () => {
    signIn.mockResolvedValue({
      data: { user: { id: 'u1' }, session: { access_token: 't' } },
      error: null,
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>)
    const user = userEvent.setup()
    const router = createMemoryRouter(
      [
        { path: '/login', element: <LoginPage /> },
        { path: '/', element: <div>AUTHED HOME</div> },
      ],
      { initialEntries: ['/', '/login'], initialIndex: 1 },
    )
    render(<RouterProvider router={router} />)

    await user.type(screen.getByLabelText('Email'), 'a@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Log in' }))
    expect(await screen.findByText('AUTHED HOME')).toBeInTheDocument()

    // With `{ replace: true }` the /login entry is gone, so back lands on the home entry
    // that preceded it. Without it, back returns a signed-in user to the login form.
    await act(() => router.navigate(-1))
    expect(router.state.location.pathname).toBe('/')
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
  })

  it('shows one generic message on invalid credentials, revealing nothing', async () => {
    signIn.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>)
    const user = userEvent.setup()
    renderLogin()

    await user.type(screen.getByLabelText('Email'), 'a@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrongpassword')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password.')
    // The message is deliberately identical whether or not the account exists.
    expect(screen.queryByText('AUTHED HOME')).not.toBeInTheDocument()
  })

  it('blocks submission when fields are empty', async () => {
    const user = userEvent.setup()
    renderLogin()

    await user.click(screen.getByRole('button', { name: 'Log in' }))

    expect(await screen.findByText('Email is required')).toBeInTheDocument()
    expect(signIn).not.toHaveBeenCalled()
  })
})
