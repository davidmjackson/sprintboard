#!/usr/bin/env node
/**
 * Fail the gate if production code exceeds the standard's duplication threshold,
 * or if the scan silently measured nothing.
 *
 * The second half is the reason this file exists rather than a bare
 * `jscpd --threshold 3` in package.json. A misconfigured ignore glob makes jscpd
 * scan zero files, report a flawless 0.00%, and exit 0 — verified on this repo:
 *
 *     npx jscpd src --ignore "" --threshold 3   ->  0 files, 0.00%, exit 0
 *
 * That is not hypothetical. The E9 baseline once recorded `0(0.00%) in 0 files`
 * from bad --format arguments, while a plain re-run of the same tree found 78
 * clones. A duplication gate that cannot tell "clean" from "did not look" is
 * worse than none, because it reports success while verifying nothing.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Production code only. See docs/adr/0005-the-duplication-gate.md. */
export const PRODUCTION_SCOPE = 'src'

export const IGNORE_PATTERNS = [
  // Tests: ADR 0002 — the thresholds measure production code. Arrange blocks in
  // the integration suites are 5.3% duplicated and gating them would mean
  // restructuring suites to satisfy a metric.
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.ts',
  'src/test/**',
  // Generated from the live schema by the Supabase CLI, not hand-maintained.
  'src/lib/database.types.ts',
  // Tailwind @theme blocks: declarative repetition is the file's job.
  'src/index.css',
]

/**
 * jscpd's detection sensitivity, stated rather than inherited.
 *
 * These match jscpd 5.0.14's behaviour today. Pinning them is the ruff lesson:
 * api/pyproject.toml selected no rules, inherited whatever the installed version
 * called "default", and a version bump reddened CI on unchanged code. A gate
 * whose verdict can move without a commit is not a gate. All four detection
 * modes produced identical results on this tree when `mild` was pinned, so the
 * choice buys future determinism, not a change in today's verdict.
 */
export const SENSITIVITY = { minLines: 5, minTokens: 50, mode: 'mild' }

/**
 * `maxPercentage` is the standard's bar (core/THRESHOLDS.md: under 3%). A
 * percentage exactly equal to it passes, matching jscpd's own `--threshold`
 * semantics so a hand-run CLI and this script never disagree.
 *
 * `minSources` and `minScannedLines` are TRIPWIRES, not targets. They exist to
 * catch a broken ignore glob, and they say nothing about how much code this
 * repo should have. At pin time the real scan measured 64 files / 5,822 lines.
 * Do not raise them to track growth; do not read them as a goal.
 */
export const LIMITS = { maxPercentage: 3, minSources: 40, minScannedLines: 3000 }

/**
 * `Number.isFinite`, not `typeof === 'number'`: `typeof NaN` is also `'number'`, so
 * the type check alone would let a NaN `percentage`, `sources` or `lines` through.
 * A NaN comparison (`NaN > 3`, `NaN < 40`) is always false, so every guard below
 * would silently pass — reported as clean rather than malformed.
 */
function hasUsableStats(total) {
  return (
    Boolean(total) &&
    Number.isFinite(total.percentage) &&
    Number.isFinite(total.sources) &&
    Number.isFinite(total.lines)
  )
}

/**
 * Pure: takes a jscpd report, returns what is wrong with it.
 * Exported so the thresholds can be tested without running a scan.
 */
export function evaluateReport(report, limits = LIMITS) {
  const total = report?.statistics?.total
  if (!hasUsableStats(total)) {
    return [{ what: 'jscpd returned no statistics block — the report is malformed or truncated' }]
  }

  const violations = []

  if (total.sources < limits.minSources || total.lines < limits.minScannedLines) {
    violations.push({
      what:
        `only ${total.sources} files / ${total.lines} lines were analysed, below the floor of ` +
        `${limits.minSources} files / ${limits.minScannedLines} lines. A duplication figure ` +
        'measured over almost nothing is not a clean result — check the ignore patterns first.',
    })
  }

  if (total.percentage > limits.maxPercentage) {
    violations.push({
      what:
        `${total.percentage}% of production code is duplicated, over the ${limits.maxPercentage}% ` +
        'threshold in core/THRESHOLDS.md.',
    })
  }

  return violations
}

/** Pure: the CLI args jscpd needs for one scan. Extracted so `runDuplicationScan` stays
 * under the standard's 30-line function threshold. (`.mjs` is outside
 * `eslint.config.js`'s `**\/*.{ts,tsx}` scope, so nothing but this comment enforces
 * that here — new code holds to the bar whether or not the linter can see it.)
 */
function buildJscpdArgs({ shim, scope, sensitivity, ignore, reportDir }) {
  const args = [
    shim,
    scope,
    '--min-lines',
    String(sensitivity.minLines),
    '--min-tokens',
    String(sensitivity.minTokens),
    '--mode',
    sensitivity.mode,
    '--reporters',
    'json',
    '--output',
    reportDir,
  ]
  if (ignore.length > 0) args.push('--ignore', ignore.join(','))
  return args
}

/**
 * Throws if jscpd could not be spawned at all, or ran and exited non-zero.
 * Extracted as its own function so these failure paths are unit-testable with a
 * fabricated `spawnSync` result — forcing the *real* jscpd binary to fail this way
 * (a missing binary, a rejected argument) is fragile and version-dependent; a
 * fabricated result is neither.
 */
export function assertScanSucceeded(result) {
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`jscpd exited ${result.status}\n${result.stderr ?? ''}`)
  }
}

/**
 * jscpd 5.x ships as a platform binary with no JavaScript API, so the only way
 * to drive it is the CLI. `run-jscpd.js` is its Node shim; resolving it through
 * `createRequire` avoids depending on node_modules/.bin being on PATH.
 */
export function runDuplicationScan({
  scope = PRODUCTION_SCOPE,
  ignore = IGNORE_PATTERNS,
  sensitivity = SENSITIVITY,
} = {}) {
  const shim = createRequire(import.meta.url).resolve('jscpd/run-jscpd.js')
  const reportDir = mkdtempSync(join(tmpdir(), 'jscpd-report-'))

  try {
    const args = buildJscpdArgs({ shim, scope, sensitivity, ignore, reportDir })
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assertScanSucceeded(result)
    return JSON.parse(readFileSync(join(reportDir, 'jscpd-report.json'), 'utf8'))
  } finally {
    rmSync(reportDir, { recursive: true, force: true })
  }
}

/**
 * `scopeOverride` — this script's own process-level tests pass `process.argv[2]` to
 * point a real subprocess run at a fixture tree instead of production `src`. That is
 * the ONLY thing an override may change: `ignore` is always `IGNORE_PATTERNS` and
 * `limits` is always `LIMITS`, full stop — there is deliberately no parameter, env
 * var, or code path that relaxes the floor or drops the ignore list for any
 * invocation. A redirected scope must still fail closed on the real 40-file /
 * 3,000-line floor, exactly like a broken ignore glob would; the tests prove this
 * with a real fixture tree sized past that floor rather than by shrinking it.
 * `npm run verify` calls this with no argument.
 */
export function resolveScanOptions(scopeOverride) {
  return { scope: scopeOverride ?? PRODUCTION_SCOPE, ignore: IGNORE_PATTERNS, limits: LIMITS }
}

/**
 * `report.statistics.total` is destructured only on the clean path below, not at the
 * top of this function: a malformed report should throw the crafted "REJECTED"
 * message from the violations branch, not a bare `TypeError` from a destructure that
 * ran before anything checked whether `total` exists.
 */
function main() {
  const { scope, ignore, limits } = resolveScanOptions(process.argv[2])
  const report = runDuplicationScan({ scope, ignore })
  const violations = evaluateReport(report, limits)

  if (violations.length > 0) {
    console.error('\n  VERIFY REJECTED — the duplication gate did not pass.\n')
    for (const { what } of violations) console.error(`    ${what}`)
    for (const duplicate of report.duplicates ?? []) {
      const { firstFile, secondFile, lines: cloneLines } = duplicate
      console.error(
        `\n    ${cloneLines} duplicated lines:\n` +
          `      ${firstFile?.name}:${firstFile?.start}\n` +
          `      ${secondFile?.name}:${secondFile?.start}`,
      )
    }
    console.error('')
    process.exit(1)
    return
  }

  const { sources, lines, percentage, clones } = report.statistics.total
  console.log(
    `check-duplication: ${sources} files / ${lines} lines scanned, ` +
      `${clones} clones, ${percentage}% duplicated.`,
  )
}

/**
 * Path-safe entry-point check. `import.meta.url` percent-encodes characters like a
 * space, `#` or `?`; `process.argv[1]` never does — so comparing
 * `import.meta.url === \`file://${process.argv[1]}\`` (the original guard) silently
 * returns false, and `main()` never runs, on any checkout path containing one of
 * those characters. `fileURLToPath` decodes the URL back to a real filesystem path
 * before comparing, and `resolve` normalises argv[1] the same way. Exported so the
 * fix can be pinned with plain strings, without needing a real path on disk.
 */
export function isEntryPoint(moduleUrl, argv1) {
  return argv1 !== undefined && fileURLToPath(moduleUrl) === resolve(argv1)
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main()
}
