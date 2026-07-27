import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { LoginPage } from './LoginPage'
import { supabase } from '@/lib/supabase'

/**
 * `LoginPage.test.tsx` is byte-frozen for this story, so this negative control lives here
 * instead. Its own assertion — `toHaveTextContent('Invalid email or password.')` — is a
 * substring match: appending the raw GoTrue string to the generic message (e.g.
 * `` `Invalid email or password. (${error.message})` ``) would still satisfy it while
 * leaking `Invalid login credentials` into the DOM, which CLAUDE.md's standing rule forbids.
 * `SignupPage.test.tsx`'s "leaking no raw server text" test already pairs a positive
 * assertion with this kind of negative control; this file gives `LoginPage` the same
 * guard without touching the frozen file.
 */
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { signInWithPassword: vi.fn() } },
}))

const signIn = vi.mocked(supabase.auth.signInWithPassword)

describe('LoginPage — invalid credentials', () => {
  it('never renders the raw GoTrue error text', async () => {
    signIn.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    } as unknown as Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>)
    const user = userEvent.setup()
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>,
    )

    await user.type(screen.getByLabelText('Email'), 'a@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrongpassword')
    await user.click(screen.getByRole('button', { name: 'Log in' }))

    await screen.findByRole('alert')
    expect(screen.queryByText(/login credentials/i)).not.toBeInTheDocument()
  })
})
