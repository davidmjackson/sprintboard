import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link, useNavigate } from 'react-router-dom'

import { supabase } from '@/lib/supabase'
import { LoginSchema, type LoginValues } from '@/lib/auth-schemas'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
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

  const rootError = form.formState.errors.root?.message

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
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="email"
                    placeholder="you@example.com"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input type="password" autoComplete="current-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {rootError ? (
            <p role="alert" className="text-destructive text-sm">
              {rootError}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Logging in…' : 'Log in'}
          </Button>
        </form>
      </Form>
    </AuthLayout>
  )
}
