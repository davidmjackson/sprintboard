import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SignupPage } from './SignupPage'
import { isDuplicateSignup } from '@/lib/auth-signup'
import { supabase } from '@/lib/supabase'

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { signUp: vi.fn() } },
}))

const signUp = vi.mocked(supabase.auth.signUp)

/** Render /signup with a distinguishable authed landing page to detect navigation. */
function renderSignup() {
  return render(
    <MemoryRouter initialEntries={['/signup']}>
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/" element={<div>AUTHED HOME</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

function ok(overrides: Record<string, unknown> = {}) {
  return {
    data: { user: { id: 'u1', identities: [{ id: 'i1' }] }, session: { access_token: 't' } },
    error: null,
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof supabase.auth.signUp>>
}

beforeEach(() => {
  signUp.mockReset()
})

describe('isDuplicateSignup', () => {
  it('flags the confirmation-off error', () => {
    expect(
      isDuplicateSignup({
        data: { user: null, session: null },
        error: { message: 'User already registered' },
      } as never),
    ).toBe(true)
  })

  it('flags the confirmation-on obfuscation (empty identities)', () => {
    expect(
      isDuplicateSignup({
        data: { user: { identities: [] }, session: null },
        error: null,
      } as never),
    ).toBe(true)
  })

  it('does not flag a genuine new user', () => {
    expect(
      isDuplicateSignup({
        data: { user: { identities: [{ id: 'i1' }] }, session: null },
        error: null,
      } as never),
    ).toBe(false)
  })
})

describe('SignupPage', () => {
  it('rejects an invalid email without calling the API', async () => {
    const user = userEvent.setup()
    renderSignup()

    await user.type(screen.getByLabelText('Email'), 'notanemail')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(signUp).not.toHaveBeenCalled()
  })

  it('rejects a short password without calling the API', async () => {
    const user = userEvent.setup()
    renderSignup()

    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'short')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument()
    expect(signUp).not.toHaveBeenCalled()
  })

  it('signs up with no display name, so the trigger defaults it to the email', async () => {
    signUp.mockResolvedValue(ok())
    const user = userEvent.setup()
    renderSignup()

    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('AUTHED HOME')).toBeInTheDocument()
    expect(signUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'password123',
      options: undefined,
    })
  })

  it('passes a provided display name through to user metadata', async () => {
    signUp.mockResolvedValue(ok())
    const user = userEvent.setup()
    renderSignup()

    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.type(screen.getByLabelText('Display name'), 'Ada')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('AUTHED HOME')).toBeInTheDocument()
    expect(signUp).toHaveBeenCalledWith({
      email: 'new@example.com',
      password: 'password123',
      options: { data: { display_name: 'Ada' } },
    })
  })

  it('shows a clear message when the email is already registered (error form)', async () => {
    signUp.mockResolvedValue(
      ok({ data: { user: null, session: null }, error: { message: 'User already registered' } }),
    )
    const user = userEvent.setup()
    renderSignup()

    await user.type(screen.getByLabelText('Email'), 'taken@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(
      await screen.findByText(/An account with this email already exists/i),
    ).toBeInTheDocument()
    expect(screen.queryByText('AUTHED HOME')).not.toBeInTheDocument()
  })

  it('shows the same message for the confirmation-on obfuscation (empty identities)', async () => {
    signUp.mockResolvedValue(ok({ data: { user: { identities: [] }, session: null }, error: null }))
    const user = userEvent.setup()
    renderSignup()

    await user.type(screen.getByLabelText('Email'), 'taken@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(
      await screen.findByText(/An account with this email already exists/i),
    ).toBeInTheDocument()
  })

  it('tells the user to check their email when confirmation is required (no session)', async () => {
    signUp.mockResolvedValue(
      ok({ data: { user: { identities: [{ id: 'i1' }] }, session: null }, error: null }),
    )
    const user = userEvent.setup()
    renderSignup()

    await user.type(screen.getByLabelText('Email'), 'new@example.com')
    await user.type(screen.getByLabelText('Password'), 'password123')
    await user.click(screen.getByRole('button', { name: 'Create account' }))

    expect(await screen.findByText('Check your email')).toBeInTheDocument()
    expect(screen.queryByText('AUTHED HOME')).not.toBeInTheDocument()
  })
})
