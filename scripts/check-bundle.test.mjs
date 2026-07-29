import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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

describe('isEntryPoint (the space/percent-encoding and symlink guard bugs)', () => {
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
        '/var/www/sprintboard/scripts/some-other-script.mjs',
      ),
    ).toBe(false)
  })

  it('falls back to plain path comparison when argv[1] does not exist on disk', () => {
    expect(isEntryPoint('file:///no/such/real/path.mjs', '/no/such/real/path.mjs')).toBe(true)
  })

  // IMPORTANT 5: without realpathSync on both sides, invoking this script through
  // a symlink made main() silently never run — measured directly, as a real
  // subprocess: status 0, with empty stdout AND stderr, having scanned nothing.
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
  // needs the same exact-token pin verify-gate.test.mjs gives every other step
  // of verify.
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

  it('scripts.build runs the type check, the Vite build, then check-bundle, in that order', () => {
    expect(pkg.scripts.build).toBe('tsc -b && vite build && node scripts/check-bundle.mjs')
  })

  it('is invoked by build as its own exact step', () => {
    const steps = pkg.scripts.build.split('&&').map((step) => step.trim())
    expect(steps).toContain('node scripts/check-bundle.mjs')
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
   *
   * A name may contain a `/` — `mkdirSync(recursive)` creates the parent, which
   * is a no-op for the flat names most fixtures use. Nested names matter because
   * a real Vite build puts index.html at the top level and the chunk carrying
   * inlined VITE_* values under dist/assets/, and every fixture here was flat.
   */
  function runAgainstDist(files, afterWrite) {
    const cwd = mkdtempSync(join(tmpdir(), 'check-bundle-dist-'))
    const distDir = join(cwd, 'dist')
    mkdirSync(distDir)
    for (const [name, contents] of Object.entries(files)) {
      const path = join(distDir, name)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, contents)
    }
    const scriptPath = resolve('scripts/check-bundle.mjs')
    // `afterWrite` runs INSIDE the try: it is where fixtures make things
    // unreadable, so it is the call most likely to throw — and a throw above the
    // try leaked a mkdtemp directory (containing a mode-000 file) on every failed
    // run, without bound. It may return a restore function, which the finally runs
    // before rmSync: a chmod-000 *directory* cannot be recursively removed, so the
    // fixture that creates one has to put the mode back.
    let restore
    try {
      restore = afterWrite?.(distDir)
      return spawnSync(process.execPath, [scriptPath], { cwd, encoding: 'utf8' })
    } finally {
      restore?.()
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

  /**
   * SPRIN-62. The test above pins that the build is REJECTED; nothing pinned
   * what the developer is told next. Every content assertion on this path was
   * /BUILD REJECTED/ and /sb_secret_/, so deleting the entire remediation
   * `console.error` — a plausible "tidy the noisy output" edit — left 36/36
   * green. That block is the whole value of the control at 2am: it names the
   * offending file, and it names the one action that actually matters. The key
   * is compromised the moment it was written to disk, so a rebuild without a
   * rotation is not a fix, and a developer who is only told "BUILD REJECTED"
   * will reach for the rebuild.
   *
   * The filename and its cause are asserted as a PAIR, not as two independent
   * substrings: with several files scanned, "some file contains a secret" and
   * "this file contains a secret" are different messages, and only the second
   * one can be acted on.
   */
  it('names the offending file and tells the developer to rotate the key', () => {
    const result = runAgainstFakeDist(
      'const key = "sb_secret_abcdefghijklmnopqrstuvwxyz0123456789";',
    )
    expect(result.stderr).toMatch(/index-fake\.js\s*\n\s*contains a modern service-role key/)
    expect(result.stderr).toMatch(/hand every visitor a key that bypasses RLS/)
    expect(result.stderr).toMatch(/ROTATE THE KEY/)
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
   * the "cannot tell clean from did-not-look" gap that any scanning gate has to
   * close, on the control that actually stops a service-role key shipping.
   * These build a dist/ directory that EXISTS (the no-dist/ test
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

  /**
   * SPRIN-56. Every fixture above is a single sub-200-byte line written FLAT into
   * dist/, with its credential at roughly byte 12. Three mutations of the real
   * script were applied on this branch and the suite re-run against each: reading
   * only `.slice(0, 1024)` of a file, deleting walk()'s recursion, and dropping
   * `map` from SCANNABLE. All three left the suite green — the script's behaviour
   * was never wrong, but nothing pinned it. MIN_SCANNED_FILES cannot help: it
   * counts files OPENED, never bytes READ.
   *
   * A real build is the opposite shape from these fixtures — index.html at the top
   * level, the chunk carrying inlined VITE_* values under dist/assets/, and a
   * planted key landing near byte 497,931 of ~704,000.
   */
  const CANARY = 'const k = "sb_secret_abcdefghijklmnopqrstuvwxyz0123456789"'

  /**
   * Clean, credential-free readable files at the TOP level, enough to clear
   * MIN_SCANNED_FILES on their own.
   *
   * What this actually does is prevent a false ALARM, not a false pass — the first
   * cut of this comment claimed the opposite and it was wrong when measured. A
   * dist/ holding only a nested `assets/x.js` has ONE readable file, below the
   * floor, so the script exits via the floor before scanning anything: without the
   * filler these fixtures are RED on CORRECT code (`expected 'only 1 readable
   * file(s)…' to match /sb_secret_/`), which is useless rather than dangerous.
   *
   * The assertion that prevents a false PASS is `toMatch(/sb_secret_/)`, because
   * the floor message contains no such substring. Defend THAT one. The
   * `not.toMatch(/below the floor/)` below is belt-and-braces and, measured, never
   * fires on its own — keep it if you like, but do not mistake it for the guard.
   */
  const cleanTopLevel = { 'index.html': '<!doctype html>', 'runtime.js': 'export const a = 1' }

  function expectRejectedForTheKey(result) {
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/BUILD REJECTED/)
    expect(result.stderr).toMatch(/sb_secret_/)
    expect(result.stderr).not.toMatch(/below the floor/)
    // The nesting is supplied entirely by runAgainstDist, and nothing else observes
    // it. Measured: a helper that flattens nested names instead of creating the
    // directory keeps all tests green AND keeps the walk()-recursion mutation green
    // — the exact hole this block exists to close, reopened by a test-side refactor
    // with the suite reporting success. Asserting the FLAGGED PATH is the only
    // observable that carries the property. Note the cost, accepted deliberately:
    // six fixtures now depend on the violation line printing a PATH, so changing
    // that line's format reddens six tests on a wholly correct control. It fails in
    // the safe direction, but do not delete it wholesale when it fires — the
    // recursion pin goes with it.
    expect(result.stderr).toMatch(/assets[/\\]/)
  }

  /**
   * The fail-closed contract, asserted as BEHAVIOUR rather than errno text.
   *
   * Measured: `status !== 0` is the assertion that kills the dangerous
   * `catch { continue }` mutation. A `/EACCES|permission denied/i` assertion killed
   * nothing — and went RED on a strict IMPROVEMENT, a clean
   * "BUILD REJECTED — could not read <file>; failing closed" handler. Pinning
   * Node's raw stack trace punishes the next person for hardening this control, and
   * what they will do about a red `verify` is weaken the test.
   *
   * The stdout half matters as much as the status: the failure mode being pinned is
   * a gate that announces a clean bundle having not read it.
   */
  function expectFailedClosed(result) {
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toMatch(/no privileged credentials found/)
  }

  /**
   * ONE canary can only ever pin one side of a window. This fixture took two goes
   * to get right, and the second was a REGRESSION:
   *
   *   - Cut 1 put a 600,000-byte pad BEFORE the canary and nothing after it. Every
   *     head-anchored cap below 600,000 died, but `.slice(-1024)`, `.slice(-65536)`
   *     and a head+tail read all stayed green while a real 704KB build leaked.
   *   - Cut 2 moved the canary to byte 497,931 to catch both. It did — and it
   *     silently GAVE BACK the head band [497,932..600,055], which contains 512 KiB,
   *     the single likeliest value anyone would pick for a read cap. `.slice(0,
   *     524288)` went red at cut 1 and green at cut 2. Trading one blind band for
   *     another is not progress, and the spec claimed the class was closed.
   *
   * The fix is not a better offset — no single offset exists. It is TWO DISTINCT
   * credential patterns at OPPOSITE ENDS of one file, both of which must be
   * reported. `findPrivilegedCredentials` yields one violation per PATTERN, not per
   * occurrence, so two copies of the same canary would collapse into one finding
   * and prove nothing; a different pattern at each end cannot collapse.
   *
   * Now any contiguous window read — head, tail, or interior — misses at least one
   * end and goes red. The residual is honest and unavoidable through a subprocess:
   * a cap ABOVE this file's size is still invisible, because nothing observable
   * reports bytes read. See "Not verified here" in the PR.
   */
  const SPAN = 800_000
  const TAIL_CANARY = 'process.env.SUPABASE_SERVICE_ROLE_KEY'

  it('reads a chunk end to end, not a window of it', () => {
    const chunk = CANARY + '\n' + 'x'.repeat(SPAN) + '\n' + TAIL_CANARY + '\n'
    // Nested TWO levels: one level pins only "recursion exists at all", and a walk
    // capped at depth 1 stayed green. dist/ also carries public/ passthroughs, whose
    // directory structure is copied verbatim and is arbitrarily deep.
    const result = runAgainstDist({ ...cleanTopLevel, 'assets/chunks/index-a1b2c3.js': chunk })
    expectRejectedForTheKey(result)
    // Both ends, or the read was a window. These are DIFFERENT TEXT_PATTERNS
    // entries, so both appear as separate violations on the same file.
    expect(result.stderr).toMatch(/service-role key environment variable/)
    // The shared helper only asserts /assets[/\\]/, which one separator satisfies —
    // measured: a helper collapsing just the SECOND level kept all 35 tests green
    // while a depth-1-capped walk shipped unscanned. Pin the depth this fixture
    // actually supplies.
    expect(result.stderr).toMatch(/assets[/\\]chunks[/\\]/)
  })

  it('catches a credential in a nested dist/assets/ chunk that is small', () => {
    const result = runAgainstDist({ ...cleanTopLevel, 'assets/nested.js': CANARY })
    expectRejectedForTheKey(result)
  })

  /**
   * The original defect was "SCANNABLE covers `map` but no fixture plants a
   * credential in one, so the alternation is deletable with the suite green". That
   * argument holds verbatim for its siblings, and fixing only `map` left them open:
   * dropping `css`, `mjs` or `cjs` each kept the suite green. `css` is not
   * hypothetical — the script's own comment says the three files it reads today are
   * an HTML entry, a JS chunk and a CSS chunk. `mjs`/`cjs` are JavaScript output
   * extensions, and JavaScript is exactly where Vite inlines VITE_* values.
   *
   * Every gate needs its own attack; hardening one alternation teaches nothing
   * about the next one along.
   */
  it.each(['mjs', 'cjs', 'css', 'map'])('catches a credential in a nested .%s file', (ext) => {
    const result = runAgainstDist({ ...cleanTopLevel, [`assets/index.${ext}`]: CANARY })
    expectRejectedForTheKey(result)
  })

  /**
   * Depth and byte-offset are not the only ways to look at too little. A scan that
   * stops after N files is a shallow scan too, and `scannable.slice(0, 2)` survived
   * every other fixture here — because `assets/` sorts first, so the one
   * credential-bearing file was always read FIRST and no fixture could notice an
   * early exit. Worse, the success line still prints `scannable.length`, so the
   * mutant announces "4 files scanned" having read 2 — the "cannot tell clean from
   * did-not-look" defect the floor was added to close, in a form the floor cannot
   * see.
   *
   * Planting the canary in EVERY file and counting the reported violations makes
   * this independent of readdir order, which is a filesystem detail and must never
   * be what a security test rests on.
   */
  it('reads every scannable file, not just the first few', () => {
    const planted = {
      'index.html': CANARY,
      'runtime.js': CANARY,
      'assets/a.js': CANARY,
      'assets/b.js': CANARY,
      'assets/c.js': CANARY,
    }
    const result = runAgainstDist(planted)
    expect(result.status).not.toBe(0)
    const flagged = result.stderr.match(/contains a modern service-role key/g) ?? []
    expect(flagged).toHaveLength(Object.keys(planted).length)
  })

  /**
   * The unreadable-file contract. Today the script fails closed on a read error, but
   * only by letting the exception escape — which surfaces as a raw `node:fs:449`
   * stack trace that reads exactly like a bug someone would tidy away. Wrapping the
   * read in `try { … } catch { continue }` kept the whole suite green while the
   * mutant printed "3 files scanned, no privileged credentials found" over a
   * credential it could not read. MIN_SCANNED_FILES cannot catch it: the floor and
   * the summary both count files that MATCHED SCANNABLE, not files actually read.
   */
  it('fails closed when a scannable file exists but cannot be read', () => {
    const result = runAgainstDist({ ...cleanTopLevel, 'assets/unreadable.js': CANARY }, (dist) => {
      const path = join(dist, 'assets', 'unreadable.js')
      chmodSync(path, 0o000)
      // Positive control. Running as root, chmod 000 does not stop a read, and this
      // fixture would assert nothing while passing. Go red loudly instead of
      // silently vacuous — CI is ubuntu-latest with no container, so this holds.
      expect(() => readFileSync(path, 'utf8')).toThrow()
    })
    expectFailedClosed(result)
  })

  /**
   * The sibling door, and it is the wider one. The test above covers a file that
   * cannot be READ; this covers a directory that cannot be ENUMERATED, which is
   * where walk() lives. The same defensive tidy applied there —
   * `try { … } catch { return [] }` — silently drops an ENTIRE SUBTREE, and
   * measured, it reported "2 files scanned, no privileged credentials found" over a
   * chmod-000 `assets/` holding a real key, exit 0. The floor cannot see it for the
   * reason it never can: the vanished subtree never reaches the SCANNABLE filter,
   * and the two clean top-level files satisfy the floor by themselves.
   *
   * The restore callback is required, not tidiness: rmSync cannot recurse into a
   * mode-000 directory, so without it the fixture's own cleanup throws.
   */
  it('fails closed when a directory under dist/ cannot be enumerated', () => {
    const result = runAgainstDist({ ...cleanTopLevel, 'assets/chunk.js': CANARY }, (dist) => {
      const dir = join(dist, 'assets')
      chmodSync(dir, 0o000)
      expect(() => readdirSync(dir)).toThrow() // positive control, as above
      return () => chmodSync(dir, 0o755)
    })
    expectFailedClosed(result)
  })
})
