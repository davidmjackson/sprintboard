import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link, useNavigate } from 'react-router-dom'

import { supabase } from '@/lib/supabase'
import { LoginSchema, type LoginValues } from '@/lib/auth-schemas'
import { Form } from '@/components/ui/form'
import { AuthCredentialFields } from './AuthCredentialFields'
import { FormRootError, SubmitButton } from './form-primitives'
import { AuthLayout } from './AuthLayout'

/**
 * Minimal login form, landed as the auth foundation so /signup's guard has a real
 * redirect target and a signed-up user can get back in. S2.2 owns the full behaviour
 * — invalid-credential messaging, session persistence, logout — and its tests.
 */
export function LoginPage() {
  const navigate = useNavigate()

  const form = useForm<LoginValues>({
    resolver: zodResolver(LoginSchema),
    defaultValues: { email: '', password: '' },
  })

  async function onSubmit(values: LoginValues) {
    const { error } = await supabase.auth.signInWithPassword(values)
    if (error) {
      form.setError('root', { message: 'Invalid email or password.' })
      return
    }
    navigate('/', { replace: true })
  }

  return (
    <AuthLayout
      title="Log in"
      description="Welcome back to Sprintboard."
      footer={
        <>
          Need an account?{' '}
          <Link to="/signup" className="text-primary underline-offset-4 hover:underline">
            Sign up
          </Link>
        </>
      }
    >
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <AuthCredentialFields passwordAutoComplete="current-password" />
          <FormRootError />
          <SubmitButton label="Log in" pendingLabel="Logging in…" className="w-full" />
        </form>
      </Form>
    </AuthLayout>
  )
}
