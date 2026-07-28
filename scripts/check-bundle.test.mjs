import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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

describe('main() as a real subprocess (pins that the entry-point guard actually runs it)', () => {
  // path.resolve, not new URL('./check-bundle.mjs', import.meta.url): Vite specially
  // rewrites that exact pattern into an asset-URL reference served by its dev server,
  // rather than leaving it as plain runtime URL resolution — verified directly. cwd
  // is the repo root for every test run here, so this is both correct and immune to it.
  it('exits 1 with a clear message when no dist/ directory exists', () => {
    const scriptPath = resolve('scripts/check-bundle.mjs')
    const cwd = mkdtempSync(join(tmpdir(), 'check-bundle-no-dist-'))
    try {
      const result = spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' })
      expect(result.status).toBe(1)
      expect(result.stderr).toMatch(/no dist\/ directory/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  /**
   * Positive/negative controls on the branch that actually stops a service-role
   * key shipping. The no-dist/ test above pins that `main()` executes at all, but
   * does not touch `findPrivilegedCredentials` or the `process.exit(1)` on the
   * violations branch — a mutation of that `exit(1)` to `exit(0)` survives it.
   * These build a fake dist/ (never the real one) and run the script as a real
   * subprocess against it.
   */
  function runAgainstFakeDist(bundleContents) {
    const cwd = mkdtempSync(join(tmpdir(), 'check-bundle-fake-dist-'))
    const distDir = join(cwd, 'dist')
    mkdirSync(distDir)
    writeFileSync(join(distDir, 'index-fake.js'), bundleContents)
    const scriptPath = resolve('scripts/check-bundle.mjs')
    try {
      return spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  it('exits non-zero and prints BUILD REJECTED when a planted sb_secret_ canary is in dist/', () => {
    const result = runAgainstFakeDist(
      'const key = "sb_secret_abcdefghijklmnopqrstuvwxyz0123456789";',
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/BUILD REJECTED/)
    expect(result.stderr).toMatch(/sb_secret_/)
  })

  it('exits 0 when only a public sb_publishable_ key is in dist/', () => {
    const result = runAgainstFakeDist(
      'const key = "sb_publishable_abcdefghijklmnopqrstuvwxyz0123456789";',
    )
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/no privileged credentials found/)
  })
})
