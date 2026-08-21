import { z } from 'zod'

import { PROJECT_ROLES } from './domain'

/**
 * The add-a-member form's rules (SPRIN-102). zod on the client is one of the two validation
 * edges; the other is the database, where `project_members_role_check` constrains the role
 * and `add_project_member_by_email` re-checks the vocabulary itself before touching a row.
 *
 * **The email is TRIMMED here but never lowercased, and the split is the point.** The RPC
 * normalises with `lower(btrim(p_email))`, and the two halves of that are not equivalent
 * risks. Trimming is IDEMPOTENT and decision-free: `btrim` of an already-trimmed string is
 * the same string, so a client-side trim cannot disagree with the server no matter how
 * either changes. LOWERCASING is a real decision — the migration argues at length for an
 * exact match against a lowercased input, because `profiles_email_key` is case-sensitive and
 * a case-insensitive match could pick the wrong row of two — so it stays in the RPC alone,
 * where every caller inherits one implementation.
 *
 * Trimming is not cosmetic here. `.email()` rejects a padded address outright, so without
 * `.trim()` an address pasted with a trailing space — the ordinary way an address arrives
 * from a chat window or a spreadsheet — is refused as malformed, while the RPC that would
 * receive it handles it perfectly well.
 *
 * **`role` is built from `PROJECT_ROLES`, never spelled out.** The set the form accepts and
 * the set the picker offers are then the same object, so a third role added to the domain
 * union cannot appear in one and be rejected by the other. `z.enum` needs a non-empty
 * tuple, hence the destructured spread rather than a bare array.
 */
const [FIRST_ROLE, ...OTHER_ROLES] = PROJECT_ROLES

export const AddMemberSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address'),
  role: z.enum([FIRST_ROLE, ...OTHER_ROLES]),
})

export type AddMemberValues = z.infer<typeof AddMemberSchema>
