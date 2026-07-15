import type { AuthResponse } from '@supabase/supabase-js'

/**
 * Is this signup result really "email already in use"? Two independent signals,
 * because the answer depends on the project's email-confirmation setting:
 *
 *   - confirmation OFF: Supabase returns an error, "User already registered".
 *   - confirmation ON:  Supabase hides the duplicate to prevent account
 *     enumeration — it returns a *fabricated* user with an empty `identities`
 *     array and no error.
 *
 * Handling both makes the message correct without the client needing to know which
 * mode the project is in.
 *
 * The confirmation-OFF case keys on the stable machine code `user_already_exists`
 * first — `error.message` is free text GoTrue may reword or localise, so the
 * substring match is only a fallback for older servers.
 */
export function isDuplicateSignup({ data, error }: AuthResponse): boolean {
  if (error)
    return error.code === 'user_already_exists' || /already registered/i.test(error.message)
  return Array.isArray(data.user?.identities) && data.user.identities.length === 0
}
