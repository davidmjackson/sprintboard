import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  IGNORE_PATTERNS,
  LIMITS,
  assertScanSucceeded,
  evaluateReport,
  isEntryPoint,
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
   * `CHECK_DUPLICATION_SCOPE` is the test-only escape hatch documented on
   * `resolveScanOptions` in check-duplication.mjs: it points a real, spawned-as-a-
   * process run of the script at a fixture tree instead of production `src`.
   */
  function runScriptAgainst(scope) {
    const scriptPath = resolve('scripts/check-duplication.mjs')
    return spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { ...process.env, CHECK_DUPLICATION_SCOPE: scope },
    })
  }

  it('exits non-zero and prints both file paths of a real planted clone', () => {
    const dir = fixtureDir({ 'a.ts': clone, 'b.ts': clone })
    try {
      const result = runScriptAgainst(dir)
      const output = result.stdout + result.stderr

      expect(result.status).not.toBe(0)
      // Pins firstFile.name/.start + secondFile.name/.start rendering: a mutation to
      // .path/.startLine would print "undefined:undefined" and fail this match.
      expect(output).toMatch(/a\.ts:\d+/)
      expect(output).toMatch(/b\.ts:\d+/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits 0 and prints the summary line over a clean fixture tree', () => {
    const dir = fixtureDir({ 'a.ts': clone, 'b.ts': 'export const answer = 42\n' })
    try {
      const result = runScriptAgainst(dir)
      expect(result.status).toBe(0)
      expect(result.stdout).toMatch(/^check-duplication: \d+ files \/ \d+ lines scanned/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
