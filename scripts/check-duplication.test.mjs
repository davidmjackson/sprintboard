import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  IGNORE_FILE_NAME,
  IGNORE_PATTERNS,
  LIMITS,
  PRODUCTION_SCOPE,
  SENSITIVITY,
  ancestorDirectories,
  assertScanSucceeded,
  buildJscpdArgs,
  cliArgsError,
  evaluateReport,
  externalConfigReason,
  findExternalJscpdConfig,
  isEntryPoint,
  resolveScanOptions,
  runDuplicationScan,
  scanScopeError,
  walkScope,
} from './check-duplication.mjs'

/** A report shaped exactly like jscpd's, with the numbers under test. */
function reportWith({ percentage, sources, lines }) {
  return { duplicates: [], statistics: { total: { percentage, sources, lines, clones: 0 } } }
}

const healthy = { percentage: 0, sources: 64, lines: 5822 }

/** Fixture tree helper, shared by the real-jscpd and process-level suites below. */
function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'jscpd-fixture-'))
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents)
  }
  return dir
}

// Long enough to clear jscpd's default 50-minTokens floor (~41 tokens at 9 lines
// was NOT enough — jscpd excludes whole files under that floor from "sources"
// entirely, not just from duplicate matching. Measured directly against the real
// binary; see the task report.
const clone = `export function totalPoints(tickets: { points: number }[]) {
  let total = 0
  for (const ticket of tickets) {
    if (typeof ticket.points === 'number') {
      total = total + ticket.points
    }
  }
  if (total < 0) {
    total = 0
  }
  return total
}
`

/**
 * A filler file, unique per index. Every identifier embeds `index`, which
 * empirically stops jscpd from treating structurally-identical filler files as
 * clones of each other — verified directly: two files differing only in an
 * accumulator identifier name (`total1`/`item1` vs `total2`/`item2`) scored 0
 * clones against the real binary. ~75 lines each.
 */
function fillerFile(index) {
  const lines = [`export function filler${index}(seed: number) {`, `  let acc${index} = seed`]
  for (let i = 0; i < 70; i++) {
    lines.push(`  acc${index} = acc${index} + ${i}`)
  }
  lines.push(`  return acc${index}`, '}', '')
  return lines.join('\n')
}

/**
 * A tree of `count` unique filler files. N2: process-level tests must exercise
 * `main()` against a scope that clears LIMITS' real 40-file / 3,000-line floor
 * themselves, never by relaxing the floor. 42 files × ~75 lines is comfortably
 * over both (measured directly: 42 files / 3,108 lines, 0 clones, 0%).
 */
function fillerTreeFiles(count = 42) {
  const files = {}
  for (let i = 0; i < count; i++) files[`filler${i}.ts`] = fillerFile(i)
  return files
}

/**
 * A ~215-line block, planted verbatim into two extra files alongside a filler
 * tree, so the combined duplication clears 3% of that much larger tree — the
 * same reasoning as the real `src/lib/ticket-actions.ts` proof in the task
 * report, just synthetic. Measured directly: added to `fillerTreeFiles()`, this
 * produces 44 files / 3,536 lines at 6.02% duplication.
 */
function bigCloneBlock() {
  const lines = ['export function bigDuplicateLogic(seed: number) {', '  let total = seed']
  for (let i = 0; i < 210; i++) lines.push(`  total = total + ${i}`)
  lines.push('  return total', '}', '')
  return lines.join('\n')
}

describe('evaluateReport', () => {
  it('passes a clean production scan', () => {
    expect(evaluateReport(reportWith(healthy))).toEqual([])
  })

  it('fails when duplication is over the threshold', () => {
    const violations = evaluateReport(reportWith({ ...healthy, percentage: 3.5 }))
    expect(violations).toHaveLength(1)
    expect(violations[0].what).toMatch(/3\.5/)
  })

  it('passes at exactly the threshold, matching jscpd --threshold semantics', () => {
    expect(evaluateReport(reportWith({ ...healthy, percentage: 3 }))).toEqual([])
  })

  it('FAILS an empty scan even though the percentage is a perfect zero', () => {
    const violations = evaluateReport(reportWith({ percentage: 0, sources: 0, lines: 0 }))
    expect(violations).toHaveLength(1)
    expect(violations[0].what).toMatch(/ignore/i)
  })

  it('fails a partial scan that is under the file floor', () => {
    const violations = evaluateReport(reportWith({ percentage: 0, sources: 5, lines: 4000 }))
    expect(violations).toHaveLength(1)
  })

  it('fails a partial scan that is under the line floor', () => {
    const violations = evaluateReport(reportWith({ percentage: 0, sources: 50, lines: 100 }))
    expect(violations).toHaveLength(1)
  })

  it('fails a malformed report rather than treating it as clean', () => {
    expect(evaluateReport({})).toHaveLength(1)
  })

  it('reports both an empty scan and over-threshold duplication together', () => {
    const violations = evaluateReport(reportWith({ percentage: 90, sources: 1, lines: 10 }))
    expect(violations).toHaveLength(2)
  })

  // I1: `typeof x !== 'number'` is not a type check against NaN — `typeof NaN` is
  // itself `'number'`. Without `Number.isFinite`, a missing or NaN sources/lines/
  // percentage sails through both guards below (every comparison against NaN is
  // false) and is reported as a clean scan.
  it('fails when sources is missing, rather than treating undefined as passing every floor check', () => {
    const violations = evaluateReport({ statistics: { total: { percentage: 0, lines: 5822 } } })
    expect(violations).toHaveLength(1)
  })

  it('fails when lines is missing', () => {
    const violations = evaluateReport({ statistics: { total: { percentage: 0, sources: 64 } } })
    expect(violations).toHaveLength(1)
  })

  it('fails when sources is NaN', () => {
    const violations = evaluateReport(reportWith({ ...healthy, sources: NaN }))
    expect(violations).toHaveLength(1)
  })

  it('fails when lines is NaN', () => {
    const violations = evaluateReport(reportWith({ ...healthy, lines: NaN }))
    expect(violations).toHaveLength(1)
  })

  it('fails when percentage is NaN, rather than letting `NaN > maxPercentage` silently pass', () => {
    const violations = evaluateReport(reportWith({ ...healthy, percentage: NaN }))
    expect(violations).toHaveLength(1)
  })
})

describe('assertScanSucceeded', () => {
  // These pin the C1 mutations "remove the result.error throw" and "remove the
  // result.status !== 0 throw" without needing the real jscpd binary to actually
  // fail — which is fragile and version-dependent to force on demand.
  it('throws the spawn error when jscpd could not be started at all', () => {
    const spawnError = new Error('spawn ENOENT')
    expect(() => assertScanSucceeded({ error: spawnError })).toThrow(spawnError)
  })

  it('throws a descriptive error when jscpd exits non-zero', () => {
    expect(() => assertScanSucceeded({ status: 2, stderr: 'bad --min-tokens value' })).toThrow(
      /jscpd exited 2.*bad --min-tokens value/s,
    )
  })

  it('does not throw on a successful result', () => {
    expect(() => assertScanSucceeded({ status: 0 })).not.toThrow()
  })
})

describe('resolveScanOptions', () => {
  // N2/N1: pins the wiring itself. A future edit that swaps in weaker limits, or
  // drops the ignore list, or relaxes the floor for any argument — including no
  // argument at all — must fail this exact-equality check.
  it('with no argument, returns exactly the real production scope, ignore list and limits', () => {
    expect(resolveScanOptions()).toEqual({
      scope: PRODUCTION_SCOPE,
      ignore: IGNORE_PATTERNS,
      limits: LIMITS,
    })
  })

  it('overrides only the scope when given one — ignore and limits never change', () => {
    expect(resolveScanOptions('/some/fixture/tree')).toEqual({
      scope: '/some/fixture/tree',
      ignore: IGNORE_PATTERNS,
      limits: LIMITS,
    })
  })
})

describe('the pinned constants (against literal values, not against themselves)', () => {
  // The resolveScanOptions toEqual tests above compare against the imported
  // LIMITS/IGNORE_PATTERNS constants — self-referential, so a mutation to a
  // constant's VALUE moves both sides of that assertion and it stays green. These
  // compare against hand-written literals instead, so a value mutation has
  // somewhere to actually go red. (IGNORE_PATTERNS already has its own literal pin
  // above, in the "is exactly the pinned list" test.)
  it('LIMITS matches core/THRESHOLDS.md exactly: 3% / 40 files / 3,000 lines', () => {
    expect(LIMITS).toEqual({ maxPercentage: 3, minSources: 40, minScannedLines: 3000 })
  })

  it('SENSITIVITY matches the pinned jscpd 5.0.14 defaults exactly', () => {
    expect(SENSITIVITY).toEqual({ minLines: 5, minTokens: 50, mode: 'mild', maxSize: '1mb' })
  })
})

describe('package.json wiring (the delivery route a reviewer named for the argv injection)', () => {
  // `"lint:duplication": "node scripts/check-duplication.mjs --config=.config/dup.json"`
  // reads as ordinary tool wiring in a PR diff and needs no change to this script.
  // cliArgsError now refuses a flag at runtime; this refuses one at review time, and
  // also refuses a *valid directory* argument, which cliArgsError deliberately allows
  // (the tests need it) but which would silently point the gate away from `src`.
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

  it('runs the gate with no arguments at all', () => {
    expect(pkg.scripts['lint:duplication']).toBe('node scripts/check-duplication.mjs')
  })

  it('is part of verify, the required CI check', () => {
    expect(pkg.scripts.verify).toMatch(/npm run lint:duplication/)
  })

  it('has no top-level "jscpd" config key of its own', () => {
    expect(pkg.jscpd).toBeUndefined()
  })
})

describe('buildJscpdArgs', () => {
  const args = buildJscpdArgs({
    shim: '/shim.js',
    scope: 'src',
    sensitivity: SENSITIVITY,
    ignore: IGNORE_PATTERNS,
    reportDir: '/out',
  })

  // N1: without this flag every .gitignore/.ignore/global-excludes file silently
  // removes tracked, shipping files from the scan and the summary line stays
  // byte-identical to an honest run. The behavioural proof is the process-level
  // "hidden by .gitignore" test below; this pins the flag itself.
  it('passes --no-gitignore so the scan scope is IGNORE_PATTERNS and nothing else', () => {
    expect(args).toContain('--no-gitignore')
  })

  it('states --max-size rather than inheriting whatever the installed jscpd defaults to', () => {
    expect(args.slice(args.indexOf('--max-size'), args.indexOf('--max-size') + 2)).toEqual([
      '--max-size',
      '1mb',
    ])
  })

  it('puts the scope first, as a positional path, and forwards the ignore list', () => {
    expect(args[0]).toBe('/shim.js')
    expect(args[1]).toBe('src')
    expect(args).toContain(IGNORE_PATTERNS.join(','))
  })
})

describe('cliArgsError (N2: argv[2] reached jscpd as a raw CLI token)', () => {
  it('accepts no arguments at all', () => {
    expect(cliArgsError([])).toBeNull()
  })

  it('accepts a single plain path', () => {
    expect(cliArgsError(['src'])).toBeNull()
  })

  // Each of these was demonstrated to produce a green gate over a redefined scan:
  // --max-size=6kb dropped the largest production files; --config= re-opened the
  // external-config channel from OUTSIDE cwd, where findExternalJscpdConfig cannot
  // see it. A flag also empties the positional path list, so jscpd walks all of cwd.
  it.each(['--max-size=6kb', '--config=/tmp/evil.json', '--ignore=**/*.ts', '-z', '--'])(
    'refuses %s, because a leading "-" makes it a jscpd flag',
    (arg) => {
      expect(cliArgsError([arg])).toMatch(/starts with "-"/)
    },
  )

  it('refuses a second argument, which would also travel to jscpd', () => {
    expect(cliArgsError(['src', '--max-size=6kb'])).toMatch(/at most one argument/)
  })
})

describe('externalConfigReason', () => {
  it('is null when nothing was found, so refuseIf does nothing', () => {
    expect(externalConfigReason(null)).toBeNull()
  })

  it('names the offending file in the rejection', () => {
    expect(externalConfigReason('.jscpd.json')).toMatch(/found \.jscpd\.json/)
  })
})

describe('ancestorDirectories', () => {
  it('walks from the given directory up to the filesystem root, innermost first', () => {
    expect(ancestorDirectories('/a/b/c')).toEqual(['/a/b', '/a', '/'])
  })

  it('terminates at the root rather than looping', () => {
    expect(ancestorDirectories('/')).toEqual([])
  })
})

describe('walkScope', () => {
  it('finds nothing in a plain tree', () => {
    const dir = fixtureDir({ 'a.ts': clone })
    try {
      expect(walkScope(dir)).toEqual({ symlink: null, ignoreFile: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds a nested symlink and a nested .ignore, reported as full paths', () => {
    const dir = fixtureDir({ 'a.ts': clone })
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, 'nested', IGNORE_FILE_NAME), 'a.ts\n')
    symlinkSync(join(dir, 'a.ts'), join(dir, 'nested', 'link.ts'))
    try {
      const found = walkScope(dir)
      expect(found.ignoreFile).toBe(join(dir, 'nested', '.ignore'))
      expect(found.symlink).toBe(join(dir, 'nested', 'link.ts'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('scanScopeError', () => {
  it('accepts the real production scope', () => {
    expect(scanScopeError(PRODUCTION_SCOPE)).toBeNull()
  })

  it('refuses a scope that does not exist rather than measuring nothing', () => {
    expect(scanScopeError(join(tmpdir(), 'no-such-tree-12345'))).toMatch(
      /not an existing directory/,
    )
  })

  it('refuses a scope that is a file, not a directory', () => {
    expect(scanScopeError(resolve('package.json'))).toMatch(/not an existing directory/)
  })

  // `--no-gitignore` does NOT switch .ignore files off — measured against the pinned
  // binary, and jscpd 5.0.14 has no --no-ignore. Refusing is the only honest response.
  it('refuses an .ignore file inside the scope', () => {
    const dir = fixtureDir({ 'a.ts': clone, [IGNORE_FILE_NAME]: 'a.ts\n' })
    try {
      expect(scanScopeError(dir)).toMatch(/an ignore file jscpd honours/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // jscpd reads .ignore from every directory ABOVE the scanned tree too — verified
  // directly, including from the parent of the process cwd.
  it('refuses an .ignore file in a directory above the scope', () => {
    const root = mkdtempSync(join(tmpdir(), 'jscpd-ancestor-'))
    const dir = join(root, 'tree')
    mkdirSync(dir)
    writeFileSync(join(root, IGNORE_FILE_NAME), 'a.ts\n')
    writeFileSync(join(dir, 'a.ts'), clone)
    try {
      expect(scanScopeError(dir)).toMatch(/an ignore file jscpd honours/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a symlink inside the scope, which jscpd would skip in silence', () => {
    const dir = fixtureDir({ 'a.ts': clone })
    symlinkSync(join(dir, 'a.ts'), join(dir, 'b.ts'))
    try {
      expect(scanScopeError(dir)).toMatch(/is a symbolic link/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A symlinked ROOT is traversed normally by jscpd (verified), so refusing one would
  // be a false positive — `src` itself being a link is fine.
  it('accepts a scope that is itself a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'jscpd-linkroot-'))
    const real = join(root, 'real')
    const link = join(root, 'link')
    mkdirSync(real)
    writeFileSync(join(real, 'a.ts'), clone)
    symlinkSync(real, link)
    try {
      expect(scanScopeError(link)).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('findExternalJscpdConfig', () => {
  function tempDir() {
    return mkdtempSync(join(tmpdir(), 'jscpd-config-probe-'))
  }

  it('returns null when no external config exists', () => {
    const dir = tempDir()
    try {
      expect(findExternalJscpdConfig(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('detects a .jscpd.json file', () => {
    const dir = tempDir()
    writeFileSync(join(dir, '.jscpd.json'), '{"maxSize": "6kb"}')
    try {
      expect(findExternalJscpdConfig(dir)).toBe('.jscpd.json')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.each(['.jscpdrc', '.jscpdrc.json', '.jscpd.js'])(
    'detects a %s file even though it has no effect on this pinned jscpd version',
    (name) => {
      const dir = tempDir()
      writeFileSync(join(dir, name), '{}')
      try {
        expect(findExternalJscpdConfig(dir)).toBe(name)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  it('detects a "jscpd" key in package.json', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ jscpd: { maxSize: '6kb' } }))
    try {
      expect(findExternalJscpdConfig(dir)).toMatch(/package\.json/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // This exact shape is our own real package.json: "jscpd" appears only nested
  // under devDependencies (the version pin), never as a top-level config key.
  it('does not false-positive on "jscpd" nested under devDependencies', () => {
    const dir = tempDir()
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'x', devDependencies: { jscpd: '5.0.14' } }),
    )
    try {
      expect(findExternalJscpdConfig(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not throw when package.json is missing or malformed', () => {
    const dir = tempDir()
    try {
      expect(() => findExternalJscpdConfig(dir)).not.toThrow()
      writeFileSync(join(dir, 'package.json'), '{ not valid json')
      expect(() => findExternalJscpdConfig(dir)).not.toThrow()
      expect(findExternalJscpdConfig(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('confirms the real repo root has no external config the gate would trip on', () => {
    expect(findExternalJscpdConfig(resolve('.'))).toBeNull()
  })
})

describe('isEntryPoint (the space/percent-encoding guard bug)', () => {
  it('is false when argv[1] is undefined — imported as a module, not run as a script', () => {
    expect(isEntryPoint('file:///anything/check-duplication.mjs', undefined)).toBe(false)
  })

  it('is true for a plain path with no special characters', () => {
    expect(
      isEntryPoint(
        'file:///var/www/sprintboard/scripts/check-duplication.mjs',
        '/var/www/sprintboard/scripts/check-duplication.mjs',
      ),
    ).toBe(true)
  })

  it('is true even when the checkout path contains a space — the exact bug a reviewer demonstrated', () => {
    // import.meta.url percent-encodes a space as %20; process.argv[1] never does.
    // The old `import.meta.url === \`file://${argv1}\`` comparison failed here, so
    // main() silently never ran and the gate exited 0 having scanned nothing.
    expect(
      isEntryPoint(
        'file:///home/dev/my%20project/scripts/check-duplication.mjs',
        '/home/dev/my project/scripts/check-duplication.mjs',
      ),
    ).toBe(true)
  })

  it('is false for a different file entirely', () => {
    expect(
      isEntryPoint(
        'file:///var/www/sprintboard/scripts/check-duplication.mjs',
        '/var/www/sprintboard/scripts/check-bundle.mjs',
      ),
    ).toBe(false)
  })
})

describe('IGNORE_PATTERNS', () => {
  // Structural pin (I2/I4): the list itself, not just "does it contain these two
  // strings". Changing this list is a deliberate act — reflect it in
  // docs/adr/0005-the-duplication-gate.md when it happens.
  it('is exactly the pinned list', () => {
    expect(IGNORE_PATTERNS).toEqual([
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/*.spec.ts',
      'src/test/**',
      'src/lib/database.types.ts',
      'src/index.css',
    ])
  })

  // Behavioural (I4): membership in the array proves nothing about jscpd actually
  // honouring it. Prove the wildcard test-file pattern really filters, by running
  // the real binary over a fixture once with the pattern applied and once without.
  it('actually excludes *.test.ts files via jscpd, not just lists the pattern', () => {
    const dir = fixtureDir({ 'a.test.ts': clone, 'b.test.ts': clone })
    try {
      const ignored = runDuplicationScan({ scope: dir, ignore: IGNORE_PATTERNS })
      expect(ignored.statistics.total.sources).toBe(0)

      const unignored = runDuplicationScan({ scope: dir, ignore: [] })
      expect(unignored.statistics.total.sources).toBe(2)
      expect(unignored.statistics.total.clones).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Behavioural, on the real tree: proves database.types.ts and index.css are
  // actually excluded from the production scan, not merely named in a list that
  // could silently stop matching if either file moved or was renamed.
  it('excludes the generated types file and Tailwind CSS from the real scan', () => {
    const withIgnore = runDuplicationScan()
    const withoutTypesAndCssIgnore = runDuplicationScan({
      ignore: IGNORE_PATTERNS.filter(
        (pattern) => pattern !== 'src/lib/database.types.ts' && pattern !== 'src/index.css',
      ),
    })
    expect(withoutTypesAndCssIgnore.statistics.total.sources).toBeGreaterThan(
      withIgnore.statistics.total.sources,
    )
  })
})

describe('runDuplicationScan (end to end, real jscpd binary)', () => {
  /**
   * The pure tests above cannot catch the failure that actually matters: an
   * ignore glob so wrong that jscpd never sees the duplicated code. These two
   * run the real binary over a real fixture tree.
   */
  it('detects a planted clone in the scanned tree', () => {
    const dir = fixtureDir({ 'a.ts': clone, 'b.ts': clone })
    try {
      const report = runDuplicationScan({ scope: dir, ignore: [] })
      expect(report.statistics.total.sources).toBe(2)
      expect(report.statistics.total.clones).toBeGreaterThan(0)
      expect(evaluateReport(report, { ...LIMITS, minSources: 1, minScannedLines: 1 })).not.toEqual(
        [],
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes a tree with no duplication', () => {
    const dir = fixtureDir({ 'a.ts': clone, 'b.ts': 'export const answer = 42\n' })
    try {
      const report = runDuplicationScan({ scope: dir, ignore: [] })
      expect(report.statistics.total.clones).toBe(0)
      expect(evaluateReport(report, { ...LIMITS, minSources: 1, minScannedLines: 1 })).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scans the real production tree with a healthy denominator', () => {
    const report = runDuplicationScan()
    expect(report.statistics.total.sources).toBeGreaterThanOrEqual(LIMITS.minSources)
    expect(evaluateReport(report)).toEqual([])
  })
})

describe('main() as a real subprocess (pins the exit-code contract verify actually depends on)', () => {
  /**
   * `path.resolve`, not `new URL('./check-duplication.mjs', import.meta.url)`:
   * Vite specially rewrites that exact pattern into an asset-URL reference served
   * by its dev server (e.g. `http://localhost:3000/scripts/check-duplication.mjs`)
   * rather than leaving it as plain runtime URL resolution — verified directly,
   * not assumed. `process.cwd()` is the repo root for every test run here (`npm
   * test`, `npm run test:unit`, and this file all run from it), so a cwd-relative
   * path is both correct and immune to that rewrite.
   *
   * The scope override travels as `argv[2]` (`resolveScanOptions`'s own
   * parameter), never an env var: it is then visible in `package.json`/the spawn
   * call rather than invisible in the environment, and — critically — it can
   * never carry a relaxed `ignore`/`limits` alongside it, because
   * `resolveScanOptions` does not accept them as arguments at all.
   */
  function runScriptAgainst(scope) {
    const scriptPath = resolve('scripts/check-duplication.mjs')
    return spawnSync(process.execPath, [scriptPath, scope], { encoding: 'utf8' })
  }

  it('exits non-zero and prints both file paths of a real planted clone, over a tree that clears the real production floor', () => {
    const dir = fixtureDir({
      ...fillerTreeFiles(),
      'dup-a.ts': bigCloneBlock(),
      'dup-b.ts': bigCloneBlock(),
    })
    try {
      const result = runScriptAgainst(dir)
      const output = result.stdout + result.stderr

      expect(result.status).not.toBe(0)
      // Pins firstFile.name/.start + secondFile.name/.start rendering: a mutation to
      // .path/.startLine would print "undefined:undefined" and fail this match.
      expect(output).toMatch(/dup-a\.ts:\d+/)
      expect(output).toMatch(/dup-b\.ts:\d+/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits 0 and prints the summary line over a clean tree that also clears the real production floor', () => {
    const dir = fixtureDir(fillerTreeFiles())
    try {
      const result = runScriptAgainst(dir)
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/^check-duplication: \d+ files \/ \d+ lines scanned/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // N2: proves there is no invocation — argv override included — that produces a
  // green gate over a scan smaller than the real production floor. A redirected
  // scope must fail closed on it, exactly like a broken ignore glob would.
  it('exits non-zero on the real floor violation even when the scope is redirected to a tiny tree', () => {
    const dir = fixtureDir({ 'a.ts': clone, 'b.ts': 'export const answer = 42\n' })
    try {
      const result = runScriptAgainst(dir)
      expect(result.status).not.toBe(0)
      expect(result.stdout + result.stderr).toMatch(/below the floor/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Deferred item: main()'s no-argument path (process.argv[2] ?? PRODUCTION_SCOPE)
  // had no process-level coverage — every test above passes an explicit scope.
  // Mutating that default (e.g. to 'src/lib', which real-scans at 22 files / 2,081
  // lines — under the floor) would survive every other test here. This runs the
  // real script, with NO argv override, against the real production tree.
  it('exits 0 against the real production tree when given no scope argument at all', () => {
    const scriptPath = resolve('scripts/check-duplication.mjs')
    const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    const match = result.stdout.match(/^check-duplication: (\d+) files/)
    expect(match).not.toBeNull()
    expect(Number(match[1])).toBeGreaterThanOrEqual(LIMITS.minSources)
  })

  /**
   * CRITICAL: jscpd auto-discovers `.jscpd.json` / a `"jscpd"` key in package.json
   * from the SCANNING PROCESS's cwd — not from `scope` — and lets either silently
   * override every option this script passes explicitly. These run the real
   * script with `cwd` pointed at a throwaway temp directory (never the real repo
   * root), so the planted config can never leak into `git status`.
   */
  function runScriptWithCwd(cwd, scope) {
    const scriptPath = resolve('scripts/check-duplication.mjs')
    return spawnSync(process.execPath, [scriptPath, scope], { cwd, encoding: 'utf8' })
  }

  it('exits non-zero when a .jscpd.json exists in the process cwd', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'check-duplication-external-config-'))
    const dir = fixtureDir(fillerTreeFiles())
    writeFileSync(join(cwd, '.jscpd.json'), '{"maxSize": "6kb"}')
    try {
      const result = runScriptWithCwd(cwd, dir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/\.jscpd\.json/)
      expect(result.stderr).toMatch(/VERIFY REJECTED/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits non-zero when package.json in the process cwd has a "jscpd" key', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'check-duplication-external-config-'))
    const dir = fixtureDir(fillerTreeFiles())
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ jscpd: { maxSize: '6kb' } }))
    try {
      const result = runScriptWithCwd(cwd, dir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/package\.json/)
      expect(result.stderr).toMatch(/VERIFY REJECTED/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * N1, behaviourally — the test that actually dies if `--no-gitignore` is dropped.
   *
   * jscpd only honours `.gitignore` when a `.git` directory exists above the scanned
   * tree (`require_git`; measured — the same fixture scored 2 sources with no `.git`
   * present and 1 with one), so the fixture puts an empty `.git` beside the tree
   * rather than inside it, where its contents would land in the scan.
   *
   * Without the flag the hidden file is dropped and the run still clears the floor
   * (43 files / ~3,300 lines) and reports 0 clones, 0%, exit 0 — a green gate over a
   * scan that never saw a tracked, shipping 215-line duplicate.
   */
  it('still measures a file that a .gitignore hides from jscpd', () => {
    const root = mkdtempSync(join(tmpdir(), 'jscpd-gitignore-'))
    const dir = join(root, 'tree')
    mkdirSync(join(root, '.git'))
    mkdirSync(dir)
    const files = { ...fillerTreeFiles(), 'dup-a.ts': bigCloneBlock(), 'dup-b.ts': bigCloneBlock() }
    for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents)
    writeFileSync(join(dir, '.gitignore'), 'dup-b.ts\n')
    try {
      const result = runScriptAgainst(dir)
      const output = result.stdout + result.stderr

      expect(result.status).not.toBe(0)
      expect(output).toMatch(/dup-b\.ts:\d+/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses to run at all when an .ignore file could shrink the scan', () => {
    const dir = fixtureDir({ ...fillerTreeFiles(), [IGNORE_FILE_NAME]: 'filler1.ts\n' })
    try {
      const result = runScriptAgainst(dir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/VERIFY REJECTED/)
      expect(result.stderr).toMatch(/an ignore file jscpd honours/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses to run at all when a symlink inside the scope would be skipped', () => {
    const dir = fixtureDir(fillerTreeFiles())
    symlinkSync(join(dir, 'filler0.ts'), join(dir, 'linked.ts'))
    try {
      const result = runScriptAgainst(dir)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/is a symbolic link/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /**
   * N2 end to end: the flag must be refused BEFORE it reaches jscpd's argument
   * vector. `--config=` is the sharp one — it points jscpd at a config file outside
   * cwd, exactly where `findExternalJscpdConfig` cannot see it, re-opening the channel
   * the external-config refusal closed. Both of these previously exited 0 over the
   * real `src` tree with a planted 212-line clone present.
   */
  it.each(['--max-size=6kb', '--config=/tmp/evil.json'])(
    'refuses %s as an argument instead of forwarding it to jscpd',
    (arg) => {
      const result = spawnSync(process.execPath, [resolve('scripts/check-duplication.mjs'), arg], {
        encoding: 'utf8',
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(/starts with "-"/)
      expect(result.stdout).not.toMatch(/check-duplication: \d+ files/)
    },
  )

  it('refuses a scope argument that is not an existing directory', () => {
    const result = spawnSync(
      process.execPath,
      [resolve('scripts/check-duplication.mjs'), join(tmpdir(), 'no-such-tree-98765')],
      { encoding: 'utf8' },
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/not an existing directory/)
  })

  it('exits 0 over the same fixture tree when the process cwd has no external config', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'check-duplication-no-external-config-'))
    const dir = fixtureDir(fillerTreeFiles())
    try {
      const result = runScriptWithCwd(cwd, dir)
      expect(result.status).toBe(0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
