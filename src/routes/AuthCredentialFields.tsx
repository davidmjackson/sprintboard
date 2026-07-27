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
 * `new-password` on signup). The union type buys real, compiler-checked protection:
 * omitting the prop, passing `undefined`, or misspelling either literal all fail to
 * compile. It buys nothing beyond that — nothing here stops a later edit from
 * widening the type (e.g. to `string` with a default) or stops one call site from
 * passing the *other* page's valid literal; both are type-correct and were confirmed
 * to pass `npm run build`, `npm run lint` and every pre-existing auth test. Which page
 * passes which value is pinned by `AuthCredentialFields.wiring.test.tsx`, which mounts
 * the real `LoginPage` and `SignupPage` and asserts the rendered `autocomplete`
 * attribute — not by this type.
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
