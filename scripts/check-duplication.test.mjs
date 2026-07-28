import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  IGNORE_PATTERNS,
  LIMITS,
  evaluateReport,
  runDuplicationScan,
} from './check-duplication.mjs'

/** A report shaped exactly like jscpd's, with the numbers under test. */
function reportWith({ percentage, sources, lines }) {
  return { duplicates: [], statistics: { total: { percentage, sources, lines, clones: 0 } } }
}

const healthy = { percentage: 0, sources: 64, lines: 5822 }

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
})

describe('runDuplicationScan (end to end, real jscpd binary)', () => {
  /**
   * The pure tests above cannot catch the failure that actually matters: an
   * ignore glob so wrong that jscpd never sees the duplicated code. These two
   * run the real binary over a real fixture tree.
   */
  function fixtureDir(files) {
    const dir = mkdtempSync(join(tmpdir(), 'jscpd-fixture-'))
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(dir, name), contents)
    }
    return dir
  }

  // Long enough to clear jscpd's default 50-minTokens floor (~41 tokens at 9
  // lines was NOT enough — jscpd excludes whole files under that floor from
  // "sources" entirely, not just from duplicate matching. Measured directly
  // against the real binary; see the task report.
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

  it('excludes the two files the gate must never fail on', () => {
    expect(IGNORE_PATTERNS).toContain('src/lib/database.types.ts')
    expect(IGNORE_PATTERNS).toContain('src/index.css')
  })
})
