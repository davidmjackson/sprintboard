import { z } from 'zod'

/**
 * The service-role key must never reach the browser.
 *
 * READ THIS BEFORE TRUSTING THE CHECKS BELOW. They run at BOOT. Vite inlines
 * every `VITE_*` variable into the bundle at BUILD time — so if a service-role
 * key is in the environment when `vite build` runs, it is already sitting in
 * dist/assets/*.js and readable by anyone, whatever this file then does. Refusing
 * to boot limits the blast radius; it does not prevent the leak.
 *
 * The control that actually prevents it is `scripts/check-bundle.mjs`, which
 * greps the built bundle and fails `npm run build`. This file is the second line.
 */

/** The claims a Supabase legacy (JWT) key admits about itself. No signature check
 *  — we are not verifying the token, only reading what it says it is. */
function readJwtRole(key: string): string | undefined {
  const payload = key.split('.')[1]
  if (payload === undefined) return undefined

  try {
    const json: unknown = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof json !== 'object' || json === null || !('role' in json)) return undefined
    const role = (json as { role: unknown }).role
    return typeof role === 'string' ? role : undefined
  } catch {
    return undefined
  }
}

/** Modern keys are prefixed (`sb_secret_…`); legacy keys are JWTs with a role claim. */
export function isServiceRoleKey(key: string): boolean {
  return key.startsWith('sb_secret_') || readJwtRole(key) === 'service_role'
}

/**
 * An ALLOWLIST, deliberately. The previous version asked "does this look like a
 * service-role key?" and let everything else through — so an unrecognised or
 * future privileged key format would pass. This asks the opposite question, and
 * therefore fails closed: a key we cannot positively identify as browser-safe is
 * rejected, and the fix is to teach this function, not to shrug.
 */
export function isPublishableKey(key: string): boolean {
  return key.startsWith('sb_publishable_') || readJwtRole(key) === 'anon'
}

const envSchema = z.object({
  VITE_SUPABASE_URL: z
    .string()
    .url('VITE_SUPABASE_URL must be a full URL, e.g. https://x.supabase.co'),
  VITE_SUPABASE_ANON_KEY: z
    .string()
    .min(1, 'VITE_SUPABASE_ANON_KEY is required')
    // Ordered: the service-role case gets its own message because the remedy is
    // different and urgent — the key is already compromised.
    .refine(
      (key) => !isServiceRoleKey(key),
      'VITE_SUPABASE_ANON_KEY is a SERVICE-ROLE key. It bypasses RLS entirely and must never ' +
        'reach the browser. If you have run `npm run build` with it set, it is already in the ' +
        'bundle: ROTATE IT NOW, then use the anon / publishable key.',
    )
    .refine(
      (key) => isPublishableKey(key),
      'VITE_SUPABASE_ANON_KEY is not recognisably a publishable key. Expected an ' +
        '`sb_publishable_…` key or a JWT with role "anon". Refusing to boot rather than ' +
        'guess: an unrecognised key could be privileged.',
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
