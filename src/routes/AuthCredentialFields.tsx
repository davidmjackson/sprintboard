import { useFormContext } from 'react-hook-form'

import { Input } from '@/components/ui/input'
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'

/**
 * The email and password fields shared by the login and signup pages — markup only.
 * Every auth API call and every user-facing error string stays in the page that owns it;
 * this component decides how the two credential inputs look, nothing else.
 *
 * `passwordAutoComplete` is required and has no default on purpose. It is the one
 * attribute that genuinely differs between the two pages (`current-password` on login,
 * `new-password` on signup), so a shared default is exactly the mistake worth making
 * impossible: the union type means a missing or misspelt value fails to compile.
 */
export function AuthCredentialFields({
  passwordAutoComplete,
}: {
  passwordAutoComplete: 'current-password' | 'new-password'
}) {
  const { control } = useFormContext()

  return (
    <>
      <FormField
        control={control}
        name="email"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Email</FormLabel>
            <FormControl>
              <Input type="email" autoComplete="email" placeholder="you@example.com" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="password"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Password</FormLabel>
            <FormControl>
              <Input type="password" autoComplete={passwordAutoComplete} {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  )
}
