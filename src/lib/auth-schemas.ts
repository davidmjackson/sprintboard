import { z } from 'zod'

/**
 * The single source of truth for auth form rules. zod on the client is one of the
 * two validation edges (the other is the database); see CLAUDE.md, "Validate at both
 * edges".
 *
 * Password length here is a UX guard, not the security boundary — Supabase Auth
 * enforces its own minimum server-side. 8 is a deliberate floor above Supabase's
 * default of 6.
 */

export const SignupSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  // Optional by design: left blank, the `handle_new_user` trigger defaults
  // `profiles.display_name` to the email. Providing it exercises the other path.
  displayName: z.string().trim().max(80, 'Display name must be 80 characters or fewer').optional(),
})

export type SignupValues = z.infer<typeof SignupSchema>

export const LoginSchema = z.object({
  email: z.string().min(1, 'Email is required').email('Enter a valid email address'),
  password: z.string().min(1, 'Password is required'),
})

export type LoginValues = z.infer<typeof LoginSchema>
