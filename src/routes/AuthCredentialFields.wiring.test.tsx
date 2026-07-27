import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { LoginPage } from './LoginPage'
import { SignupPage } from './SignupPage'

/**
 * `AuthCredentialFields.test.tsx` proves the component paints whichever
 * `passwordAutoComplete` value its `Harness` is given — pass-through only, since that
 * harness always supplies the prop explicitly. It cannot see which value each real page
 * actually passes at its call site. These tests mount the real `LoginPage` and
 * `SignupPage` and pin that wiring: login must render `current-password`, signup must
 * render `new-password`.
 *
 * This is not a hypothetical gap. A widened, defaulted prop type
 * (`passwordAutoComplete?: string = 'current-password'`) with the prop then deleted
 * from both call sites passed `npm run build`, `npm run lint` and all 23 pre-existing
 * auth tests, while silently rendering `autocomplete="current-password"` on the signup
 * form — telling password managers to autofill an existing credential into a
 * registration form and suppressing strong-password generation. These two tests are
 * the guard against that regressing.
 */
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { signInWithPassword: vi.fn(), signUp: vi.fn() } },
}))

describe('AuthCredentialFields — call-site wiring', () => {
  it('LoginPage renders the password field with autocomplete=current-password', () => {
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
  })

  it('SignupPage renders the password field with autocomplete=new-password', () => {
    render(
      <MemoryRouter initialEntries={['/signup']}>
        <Routes>
          <Route path="/signup" element={<SignupPage />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password')
  })
})
