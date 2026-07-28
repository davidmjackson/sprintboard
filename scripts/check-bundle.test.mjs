import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { MIN_SCANNED_FILES, findPrivilegedCredentials, isEntryPoint } from './check-bundle.mjs'

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

  // IMPORTANT 8: three of the four TEXT_PATTERNS entries had zero coverage —
  // each could be deleted from scripts/check-bundle.mjs with the whole suite
  // green, since only the sb_secret_ pattern and the JWT-decode path (above)
  // had a direct test. Verified directly by deleting each pattern in turn.
  it('catches a raw, unencoded "role":"service_role" payload fragment', () => {
    const violations = findPrivilegedCredentials('console.log(\'{"role":"service_role"}\')')
    expect(violations).toContainEqual(
      expect.objectContaining({ what: expect.stringContaining('service_role') }),
    )
  })

  it('catches the SUPABASE_SERVICE_ROLE_KEY environment variable name', () => {
    const violations = findPrivilegedCredentials(
      'const key = process.env.SUPABASE_SERVICE_ROLE_KEY',
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ what: expect.stringContaining('service-role key environment') }),
    )
  })

  it('catches a VITE_RLS_TEST_ credential name', () => {
    const violations = findPrivilegedCredentials(
      'const email = import.meta.env.VITE_RLS_TEST_EMAIL_A',
    )
    expect(violations).toContainEqual(
      expect.objectContaining({ what: expect.stringContaining('VITE_') }),
    )
  })
})

describe('isEntryPoint (mirrors check-duplication.mjs; the space/percent-encoding and symlink guard bugs)', () => {
  it('is false when argv[1] is undefined — imported as a module, not run as a script', () => {
    expect(isEntryPoint('file:///anything/check-bundle.mjs', undefined)).toBe(false)
  })

  it('is true for a plain path with no special characters', () => {
    expect(
      isEntryPoint(
        'file:///var/www/sprintboard/scripts/check-bundle.mjs',
        '/var/www/sprintboard/scripts/check-bundle.mjs',
      ),
    ).toBe(true)
  })

  it('is true even when the checkout path contains a space', () => {
    // import.meta.url percent-encodes a space as %20; process.argv[1] never does.
    // The naive `import.meta.url === \`file://${argv1}\`` comparison fails here, so
    // main() would silently never run and the build would "pass" a check that
    // never scanned dist/.
    expect(
      isEntryPoint(
        'file:///home/dev/my%20project/scripts/check-bundle.mjs',
        '/home/dev/my project/scripts/check-bundle.mjs',
      ),
    ).toBe(true)
  })

  it('is false for a different file entirely', () => {
    expect(
      isEntryPoint(
        'file:///var/www/sprintboard/scripts/check-bundle.mjs',
        '/var/www/sprintboard/scripts/check-duplication.mjs',
      ),
    ).toBe(false)
  })

  it('falls back to plain path comparison when argv[1] does not exist on disk', () => {
    expect(isEntryPoint('file:///no/such/real/path.mjs', '/no/such/real/path.mjs')).toBe(true)
  })

  // IMPORTANT 5: without realpathSync on both sides, invoking this script through
  // a symlink made main() silently never run — measured directly on this exact
  // guard's twin in scripts/check-duplication.mjs (see its test file for the
  // full before/after subprocess proof: status 0, empty stdout AND stderr).
  it('is true when the module URL is the real target of a symlink argv[1] points at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-bundle-entry-point-symlink-'))
    const target = join(dir, 'real.mjs')
    writeFileSync(target, '')
    const link = join(dir, 'link.mjs')
    symlinkSync(target, link)
    try {
      expect(isEntryPoint(`file://${target}`, link)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('package.json wiring (IMPORTANT 4: nothing pinned that build runs check-bundle)', () => {
  // Deleting `&& node scripts/check-bundle.mjs` from scripts.build left the
  // whole scoped suite green — verified directly (140 tests, 3 files, all
  // passed with the credential control entirely absent from the build). This
  // is the control that stops a service-role key shipping to browsers; it
  // needs the same exact-token pin scripts/check-duplication.test.mjs already
  // gives lint:duplication's presence in verify.
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

  it('scripts.build runs the type check, the Vite build, then check-bundle, in that order', () => {
    expect(pkg.scripts.build).toBe('tsc -b && vite build && node scripts/check-bundle.mjs')
  })

  it('is invoked by build as its own exact step', () => {
    const steps = pkg.scripts.build.split('&&').map((step) => step.trim())
    expect(steps).toContain('node scripts/check-bundle.mjs')
  })
})

describe('devDependencies.jscpd is pinned to the exact version ADR 0005 relies on', () => {
  // MINOR 11: ADR 0005 says the pinned jscpd version is the only thing holding
  // its unset defaults stable — a floating spec (jscpd: "^5.0.14" or "~5.0.14")
  // would let a future install silently pick up a different minor/patch whose
  // defaults differ, exactly the ruff-version-drift lesson this repo already
  // learned once for api/pyproject.toml.
  it('devDependencies.jscpd is exactly 5.0.14, not a range', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    expect(pkg.devDependencies.jscpd).toBe('5.0.14')
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
   * Filler files with no credential content, used only to clear
   * MIN_SCANNED_FILES (IMPORTANT 9) so tests that plant one specific bundle
   * file are not accidentally caught by the file-count floor instead of the
   * behaviour they mean to test. `.js`, so they count toward the floor — which
   * counts the files the scan actually reads, not everything under dist/.
   */
  function fillerBundleFiles(count) {
    const files = {}
    for (let i = 0; i < count; i++) files[`filler-${i}.js`] = `export const filler${i} = ${i}\n`
    return files
  }

  /**
   * Runs the real script, as a real subprocess, against a throwaway dist/ built
   * from `{ name: contents }`. Never the repo's own dist/.
   */
  function runAgainstDist(files) {
    const cwd = mkdtempSync(join(tmpdir(), 'check-bundle-dist-'))
    const distDir = join(cwd, 'dist')
    mkdirSync(distDir)
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(distDir, name), contents)
    }
    const scriptPath = resolve('scripts/check-bundle.mjs')
    try {
      return spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  /**
   * Positive/negative controls on the branch that actually stops a service-role
   * key shipping. The no-dist/ test above pins that `main()` executes at all, but
   * does not touch `findPrivilegedCredentials` or the `process.exit(1)` on the
   * violations branch — a mutation of that `exit(1)` to `exit(0)` survives it.
   * These build a fake dist/ (never the real one) and run the script as a real
   * subprocess against it. `extraFiles` defaults to enough filler to clear
   * MIN_SCANNED_FILES, so these tests exercise the credential branch, not the
   * floor.
   */
  function runAgainstFakeDist(
    bundleContents,
    extraFiles = fillerBundleFiles(MIN_SCANNED_FILES - 1),
  ) {
    return runAgainstDist({ 'index-fake.js': bundleContents, ...extraFiles })
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

  /**
   * IMPORTANT 9: before MIN_SCANNED_FILES existed, an empty (or near-empty)
   * dist/ reported "no privileged credentials found" having scanned nothing —
   * the same "cannot tell clean from did-not-look" gap check-duplication.mjs's
   * floors exist to close, on the control that actually stops a service-role
   * key shipping. These build a dist/ directory that EXISTS (the no-dist/ test
   * above covers "does not exist at all") but is below the floor.
   */
  function runAgainstSparseDist(fileCount) {
    return runAgainstDist(fillerBundleFiles(fileCount))
  }

  it('exits non-zero on a completely empty dist/ directory (exists, zero files)', () => {
    const result = runAgainstSparseDist(0)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/BUILD REJECTED/)
    expect(result.stderr).toMatch(new RegExp(`below the floor of ${MIN_SCANNED_FILES}`))
  })

  it('exits non-zero when dist/ has files but fewer than the floor', () => {
    const result = runAgainstSparseDist(MIN_SCANNED_FILES - 1)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/BUILD REJECTED/)
    expect(result.stderr).toMatch(new RegExp(`only ${MIN_SCANNED_FILES - 1} readable file`))
  })

  it('exits 0 at exactly the floor (MIN_SCANNED_FILES itself is pinned against the literal 2)', () => {
    expect(MIN_SCANNED_FILES).toBe(2)
    const result = runAgainstSparseDist(MIN_SCANNED_FILES)
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/no privileged credentials found/)
  })

  /**
   * BLOCKER: the floor's first cut gated everything `walk()` returned while the
   * scan loop read only js/mjs/cjs/css/html/map. Of the 10 files a real build
   * emits, only 3 match — so this exact dist/ (10 `.woff2` font subsets, each
   * containing a literal `sb_secret_…` key) printed `check-bundle: 10 files
   * scanned, no privileged credentials found.` and exited 0, having read zero
   * bytes. Verified directly against the pre-fix script. The floor now counts
   * reads, so the same dist/ is refused: not because the key was found — it is
   * unreachable inside a binary asset either way — but because the check can no
   * longer report a clean result on a build it did not look at.
   */
  it('refuses a dist/ that is over the old file-count floor but has nothing readable in it', () => {
    const fonts = {}
    for (let i = 0; i < 10; i++) {
      fonts[`geist-subset-${i}.woff2`] = 'sb_secret_abcdefghijklmnopqrstuvwxyz0123456789'
    }
    const result = runAgainstDist(fonts)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/BUILD REJECTED/)
    expect(result.stderr).toMatch(/only 0 readable file/)
    expect(result.stdout).not.toMatch(/no privileged credentials found/)
  })

  /**
   * The other half of the same defect: the success line claimed a number the
   * scan never used. Two dist/ directories differing only in font subsets — the
   * routine churn of a `@fontsource` bump, or of deleting an unused `public/`
   * asset, which is what reddened the required check on a legitimate diff —
   * must report the same count, and it must be the number of files read.
   */
  it('reports the number of files it actually read, and asset churn does not move it', () => {
    const bundle = {
      'index.html': '<!doctype html><script src="/assets/index.js"></script>',
      'index.js': 'export const anon = "sb_publishable_abcdefghijklmnop"',
    }
    const bare = runAgainstDist(bundle)
    expect(bare.status).toBe(0)
    expect(bare.stdout).toMatch(/check-bundle: 2 files scanned/)

    const assets = {}
    for (let i = 0; i < 7; i++) assets[`asset-${i}.woff2`] = 'binary-ish'
    assets['logo.svg'] = '<svg/>'
    const withAssets = runAgainstDist({ ...bundle, ...assets })
    expect(withAssets.status).toBe(0)
    expect(withAssets.stdout).toMatch(/check-bundle: 2 files scanned/)
  })

  /**
   * The floor must never become a reason to stop reading: a credential in a
   * readable file is still rejected in a dist/ whose readable count sits right
   * at the floor and whose unreadable assets outnumber it.
   */
  it('still rejects a planted key in a readable file surrounded by unreadable assets', () => {
    const result = runAgainstDist({
      'index.html': '<!doctype html>',
      'index.js': 'const key = "sb_secret_abcdefghijklmnopqrstuvwxyz0123456789";',
      'a.woff2': 'x',
      'b.woff2': 'x',
      'c.png': 'x',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/BUILD REJECTED/)
    expect(result.stderr).toMatch(/sb_secret_/)
  })
})
