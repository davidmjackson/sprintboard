import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  IGNORE_PATTERNS,
  LIMITS,
  PRODUCTION_SCOPE,
  assertScanSucceeded,
  evaluateReport,
  isEntryPoint,
  resolveScanOptions,
  runDuplicationScan,
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
})
