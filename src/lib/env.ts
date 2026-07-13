import { z } from 'zod'

/**
 * The service-role key must never reach the browser. Documenting that is not
 * enforcement, so we detect it and refuse to boot.
 *
 * Two shapes exist. Modern Supabase keys are prefixed (`sb_secret_…` vs
 * `sb_publishable_…`). Legacy keys are JWTs whose payload carries a `role`
 * claim, so we decode the payload — no signature check, we are not verifying
 * the token, only reading what it admits about itself.
 */
export function isServiceRoleKey(key: string): boolean {
  if (key.startsWith('sb_secret_')) return true

  const payload = key.split('.')[1]
  if (payload === undefined) return false

  try {
    const json: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return (
      typeof json === 'object' &&
      json !== null &&
      'role' in json &&
      (json as { role: unknown }).role === 'service_role'
    )
  } catch {
    // Not a JWT we can read. Fall through: the prefix check already ran, and a
    // key we cannot parse is not evidence of a service-role key.
    return false
  }
}

const envSchema = z.object({
  VITE_SUPABASE_URL: z
    .string()
    .url('VITE_SUPABASE_URL must be a full URL, e.g. https://x.supabase.co'),
  VITE_SUPABASE_ANON_KEY: z
    .string()
    .min(1, 'VITE_SUPABASE_ANON_KEY is required')
    .refine(
      (key) => !isServiceRoleKey(key),
      'VITE_SUPABASE_ANON_KEY looks like a SERVICE-ROLE key. It must never ship to the browser: ' +
        'it bypasses RLS entirely. Use the anon / publishable key, and rotate the one you just leaked.',
    ),
})

export type Env = z.infer<typeof envSchema>

export function parseEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw)

  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.message}`).join('\n')
    throw new Error(`Invalid environment.\n${problems}\n\nSee .env.example.`)
  }

  return result.data
}

let cached: Env | undefined

/**
 * Validated at first use, not at import. Eager module-scope validation would
 * throw merely on importing this file, which makes it a landmine for any test
 * or tool that touches the module without a full environment.
 *
 * The app still fails fast: supabase.ts calls this at its own module scope, so
 * a bad environment stops the boot rather than surfacing at the first query.
 */
export function getEnv(): Env {
  cached ??= parseEnv(import.meta.env as unknown as Record<string, unknown>)
  return cached
}
