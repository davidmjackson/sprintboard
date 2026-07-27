import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useForm } from 'react-hook-form'

import { Form } from '@/components/ui/form'
import { AuthCredentialFields } from './AuthCredentialFields'

function Harness({
  passwordAutoComplete,
}: {
  passwordAutoComplete: 'current-password' | 'new-password'
}) {
  const form = useForm<{ email: string; password: string }>({
    defaultValues: { email: '', password: '' },
  })
  return (
    <Form {...form}>
      <form noValidate>
        <AuthCredentialFields passwordAutoComplete={passwordAutoComplete} />
      </form>
    </Form>
  )
}

describe('AuthCredentialFields', () => {
  it('renders a labelled email field of type email', () => {
    render(<Harness passwordAutoComplete="current-password" />)
    const email = screen.getByLabelText('Email')
    expect(email).toHaveAttribute('type', 'email')
    expect(email).toHaveAttribute('autocomplete', 'email')
    expect(email).toHaveAttribute('placeholder', 'you@example.com')
  })

  it('renders a labelled password field of type password', () => {
    render(<Harness passwordAutoComplete="current-password" />)
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password')
  })

  // The one attribute that legitimately differs between the two pages, and the one a
  // careless shared default would silently collapse. These two tests only prove
  // pass-through: `Harness` always supplies `passwordAutoComplete` explicitly, so they
  // cannot see which value each real page passes at its call site — a hard-coded value
  // in the component would fail them, but a hard-coded value at a call site would not.
  // That wiring is pinned separately, by `AuthCredentialFields.wiring.test.tsx`, which
  // mounts the real `LoginPage` and `SignupPage`.
  it('gives the password field autocomplete=current-password when asked', () => {
    render(<Harness passwordAutoComplete="current-password" />)
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
  })

  it('gives the password field autocomplete=new-password when asked', () => {
    render(<Harness passwordAutoComplete="new-password" />)
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'new-password')
  })
})
