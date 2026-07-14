import { describe, expect, it } from 'vitest'
import { findPrivilegedCredentials } from './check-bundle.mjs'

/** Realistic Supabase-shaped JWT header, base64url-encoded, shared by every token below. */
const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')

function jwt(payload) {
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${HEADER}.${payloadSegment}.signature-not-checked`
}

/**
 * Pads `ref` so the `"role":"service_role"` substring inside the JSON payload
 * lands at a chosen byte offset mod 3 — the exact variable that determines
 * which base64 characters it encodes to. Verified empirically to land at
 * offsets whose mod-3 residues are 0, 1 and 2 respectively for pad 0, 1, 2.
 */
function serviceRoleJwtAtAlignment(pad) {
  const payload = {
    iss: 'supabase',
    ref: 'abcxyz' + 'x'.repeat(pad),
    role: 'service_role',
    iat: 1_700_000_000,
    exp: 1_999_999_999,
  }
  const json = JSON.stringify(payload)
  const offset = json.indexOf('"role":"service_role"')
  return { token: jwt(payload), offset }
}

describe('findPrivilegedCredentials', () => {
  it.each([0, 1, 2])(
    'catches a legacy service-role JWT at byte alignment offset %% 3 === %i',
    (pad) => {
      const { token, offset } = serviceRoleJwtAtAlignment(pad)
      expect(offset % 3).toBe(pad) // sanity: we actually hit the intended alignment

      const violations = findPrivilegedCredentials(`const key = "${token}";`)

      expect(violations).toContainEqual(
        expect.objectContaining({ what: expect.stringContaining('service-role JWT') }),
      )
    },
  )

  it('does not flag a legacy anon JWT (public by design, must ship)', () => {
    const token = jwt({
      iss: 'supabase',
      ref: 'xcnmyhozmcopcpxlagrk',
      role: 'anon',
      iat: 1_700_000_000,
      exp: 1_999_999_999,
    })

    const violations = findPrivilegedCredentials(`const key = "${token}";`)

    expect(violations).toEqual([])
  })

  it('catches a modern sb_secret_ service-role key', () => {
    const violations = findPrivilegedCredentials(
      'const key = "sb_secret_abcdefghijklmnopqrstuvwxyz0123456789";',
    )

    expect(violations).toContainEqual(
      expect.objectContaining({ what: expect.stringContaining('sb_secret_') }),
    )
  })

  it('does not flag a modern sb_publishable_ key (public by design, must ship)', () => {
    const violations = findPrivilegedCredentials(
      'const key = "sb_publishable_abcdefghijklmnopqrstuvwxyz0123456789";',
    )

    expect(violations).toEqual([])
  })

  it('does not throw on a malformed, JWT-shaped string', () => {
    const notActuallyBase64Json = `${HEADER}.eyJ${'not-valid-base64url-json!!!'}`

    expect(() => findPrivilegedCredentials(`const x = "${notActuallyBase64Json}";`)).not.toThrow()
    expect(findPrivilegedCredentials(`const x = "${notActuallyBase64Json}";`)).toEqual([])
  })
})
