import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { Link, useNavigate } from 'react-router-dom'

import { supabase } from '@/lib/supabase'
import { SignupSchema, type SignupValues } from '@/lib/auth-schemas'
import { isDuplicateSignup } from '@/lib/auth-signup'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { AuthLayout } from './AuthLayout'

const DUPLICATE_MESSAGE = 'An account with this email already exists. Try logging in instead.'
const GENERIC_ERROR = 'Something went wrong. Please try again.'

export function SignupPage() {
  const navigate = useNavigate()
  const [confirmationSent, setConfirmationSent] = useState(false)

  const form = useForm<SignupValues>({
    resolver: zodResolver(SignupSchema),
    defaultValues: { email: '', password: '', displayName: '' },
  })

  async function onSubmit(values: SignupValues) {
    const displayName = values.displayName?.trim()
    const result = await supabase.auth.signUp({
      email: values.email,
      password: values.password,
      // Omitting `data.display_name` lets the trigger default it to the email.
      options: displayName ? { data: { display_name: displayName } } : undefined,
    })

    if (isDuplicateSignup(result)) {
      form.setError('email', { message: DUPLICATE_MESSAGE })
      return
    }

    if (result.error) {
      // Surface one generic message, never the raw GoTrue string: those can carry
      // rate-limit internals or server-side rules and are not for end users. Field
      // validation is already handled client-side by zod before submit.
      form.setError('root', { message: GENERIC_ERROR })
      return
    }

    // Confirmation off → we have a session and the guard will let us in.
    // Confirmation on → no session yet; tell the user to check their email.
    if (result.data.session) {
      navigate('/', { replace: true })
    } else {
      setConfirmationSent(true)
    }
  }

  if (confirmationSent) {
    return (
      <AuthLayout
        title="Check your email"
        description="We sent a confirmation link. Click it to finish signing up."
      >
        <p className="text-muted-foreground text-sm">
          Once confirmed, you can{' '}
          <Link to="/login" className="text-primary underline-offset-4 hover:underline">
            log in
          </Link>
          .
        </p>
      </AuthLayout>
    )
  }

  const rootError = form.formState.errors.root?.message

  return (
    <AuthLayout
      title="Create your account"
      description="Sign up to start building your Sprintboard."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="text-primary underline-offset-4 hover:underline">
            Log in
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
                  <Input type="password" autoComplete="new-password" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="displayName"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Display name</FormLabel>
                <FormControl>
                  <Input autoComplete="name" placeholder="Optional" {...field} />
                </FormControl>
                <FormDescription>Defaults to your email if left blank.</FormDescription>
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
            {form.formState.isSubmitting ? 'Creating account…' : 'Create account'}
          </Button>
        </form>
      </Form>
    </AuthLayout>
  )
}
