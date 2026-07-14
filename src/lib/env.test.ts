import { describe, expect, it } from 'vitest'
import { isPublishableKey, isServiceRoleKey, parseEnv } from './env'

/** Builds an unsigned JWT with the given payload — enough to exercise the guard. */
function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.fake-signature`
}

const ANON_JWT = jwt({ iss: 'supabase', role: 'anon' })
const SERVICE_JWT = jwt({ iss: 'supabase', role: 'service_role' })

const VALID = {
  VITE_SUPABASE_URL: 'https://abcdefgh.supabase.co',
  VITE_SUPABASE_ANON_KEY: ANON_JWT,
}

describe('isServiceRoleKey', () => {
  it('flags a legacy service_role JWT', () => {
    expect(isServiceRoleKey(SERVICE_JWT)).toBe(true)
  })

  it('flags a modern sb_secret_ key', () => {
    expect(isServiceRoleKey('sb_secret_abc123')).toBe(true)
  })

  it('accepts a legacy anon JWT', () => {
    expect(isServiceRoleKey(ANON_JWT)).toBe(false)
  })

  it('accepts a modern publishable key', () => {
    expect(isServiceRoleKey('sb_publishable_abc123')).toBe(false)
  })

  it('does not throw on a key it cannot parse', () => {
    expect(isServiceRoleKey('not-a-jwt')).toBe(false)
    expect(isServiceRoleKey('a.b.c')).toBe(false)
    expect(isServiceRoleKey('')).toBe(false)
  })
})

/**
 * The guard is an allowlist, not a blocklist, and that distinction is the whole
 * point: a blocklist asks "is this a service-role key?" and waves through every
 * shape it does not recognise — including a privileged key format that does not
 * exist yet. These tests pin the fail-closed behaviour.
 */
describe('isPublishableKey — the allowlist', () => {
  it('accepts the two shapes that are known to be browser-safe', () => {
    expect(isPublishableKey('sb_publishable_abc123')).toBe(true)
    expect(isPublishableKey(ANON_JWT)).toBe(true)
  })

  it('rejects a service-role key', () => {
    expect(isPublishableKey(SERVICE_JWT)).toBe(false)
    expect(isPublishableKey('sb_secret_abc123')).toBe(false)
  })

  it('rejects a key it does not recognise, rather than assuming it is safe', () => {
    expect(isPublishableKey(jwt({ role: 'postgres' }))).toBe(false)
    expect(isPublishableKey('sb_somefutureprefix_abc')).toBe(false)
    expect(isPublishableKey('not-a-key-at-all')).toBe(false)
    expect(isPublishableKey('')).toBe(false)
  })
})

describe('parseEnv', () => {
  it('accepts a valid anon key', () => {
    expect(parseEnv(VALID).VITE_SUPABASE_ANON_KEY).toBe(ANON_JWT)
  })

  it('accepts a modern publishable key', () => {
    const env = { ...VALID, VITE_SUPABASE_ANON_KEY: 'sb_publishable_abc123' }
    expect(parseEnv(env).VITE_SUPABASE_ANON_KEY).toBe('sb_publishable_abc123')
  })

  // Fails CLOSED. An unrecognised key might be privileged; refusing to guess is
  // the only safe default, because the cost of being wrong is a full RLS bypass.
  it('refuses to boot on a key whose privilege it cannot determine', () => {
    expect(() => parseEnv({ ...VALID, VITE_SUPABASE_ANON_KEY: jwt({ role: 'postgres' }) })).toThrow(
      /not recognisably a publishable key/,
    )
    expect(() => parseEnv({ ...VALID, VITE_SUPABASE_ANON_KEY: 'sb_future_xyz' })).toThrow(
      /not recognisably a publishable key/,
    )
  })

  // CLAUDE.md, non-negotiable: the service-role key must never ship client-side.
  it('REFUSES to boot on a service-role key', () => {
    expect(() => parseEnv({ ...VALID, VITE_SUPABASE_ANON_KEY: SERVICE_JWT })).toThrow(
      /SERVICE-ROLE key/,
    )
  })

  it('refuses to boot on a modern secret key', () => {
    expect(() => parseEnv({ ...VALID, VITE_SUPABASE_ANON_KEY: 'sb_secret_leaked' })).toThrow(
      /SERVICE-ROLE key/,
    )
  })

  it('rejects a missing or malformed url', () => {
    expect(() => parseEnv({ ...VALID, VITE_SUPABASE_URL: undefined })).toThrow(
      /Invalid environment/,
    )
    expect(() => parseEnv({ ...VALID, VITE_SUPABASE_URL: 'abcdefgh.supabase.co' })).toThrow(
      /full URL/,
    )
  })

  it('rejects a missing key', () => {
    expect(() => parseEnv({ ...VALID, VITE_SUPABASE_ANON_KEY: '' })).toThrow(/required/)
  })
})
