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
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
 * jscpd's detection and file-selection settings, stated rather than inherited.
 *
 * These match jscpd 5.0.14's behaviour today. Pinning them is the ruff lesson:
 * api/pyproject.toml selected no rules, inherited whatever the installed version
 * called "default", and a version bump reddened CI on unchanged code. A gate
 * whose verdict can move without a commit is not a gate. All four detection
 * modes produced identical results on this tree when `mild` was pinned, so the
 * choice buys future determinism, not a change in today's verdict.
 *
 * `maxSize` is jscpd's silent file-skipping cap, in BYTES — jscpd accepts a raw
 * byte count as readily as `'1mb'`, and one numeric constant serves both the CLI
 * flag and `scanScopeError`'s size check, so the flag and the guard cannot drift
 * apart into disagreeing about the same fact.
 *
 * The cap is the one setting whose breach the file/line floors cannot see AT ALL.
 * Measured: two verbatim 2.4MB duplicates dropped into `src/lib/` produced
 * `64 files / 5822 lines scanned, 0 clones, 0% duplicated.` — byte-identical to the
 * honest baseline, exit 0. Not under-sensitive; structurally blind, because an
 * over-cap file never enters the denominator to begin with. `scanScopeError`
 * therefore refuses outright rather than trusting the floors to notice.
 */
export const SENSITIVITY = { minLines: 5, minTokens: 50, mode: 'mild', maxSize: 1048576 }

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
 * under the standard's 30-line function threshold, and so the flags below can be
 * asserted directly rather than only through a scan's numbers. (`.mjs` is outside
 * `eslint.config.js`'s `**\/*.{ts,tsx}` scope, so nothing but this comment enforces
 * that here — new code holds to the bar whether or not the linter can see it.)
 *
 * `--no-gitignore` is load-bearing, not tidiness. jscpd's merged config defaults to
 * `no_gitignore: false`, so without this flag every gitignore-family file silently
 * removes matching files from the scan. Git keeps tracking a file that is already in
 * the index when it is later added to `.gitignore`, so such a file still ships to
 * production while never being measured — and the summary line comes out
 * BYTE-IDENTICAL to an honest run (same file count, same line count), because the
 * hidden file was never counted. Reproduced on this repo: a tracked 212-line verbatim
 * duplicate plus one line in `.gitignore` turned `3.49% / exit 1` into
 * `64 files / 5822 lines, 0 clones, 0% / exit 0`.
 *
 * Measured, so the boundary is known rather than assumed: this flag switches off a
 * root `.gitignore`, a nested `src/lib/.gitignore`, `.git/info/exclude`, and a
 * machine-global git excludes file. It does NOT switch off a plain `.ignore` — that
 * is a different family with no flag to disable it, and `scanScopeError` refuses to
 * run rather than pretending this flag covers it.
 */
export function buildJscpdArgs({ shim, scope, sensitivity, ignore, reportDir }) {
  const args = [
    shim,
    scope,
    '--min-lines',
    String(sensitivity.minLines),
    '--min-tokens',
    String(sensitivity.minTokens),
    '--mode',
    sensitivity.mode,
    '--max-size',
    String(sensitivity.maxSize),
    '--no-gitignore',
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
 * jscpd 5.0.14 auto-discovers configuration from the scanning process's cwd and lets
 * it silently override every option this script does not pass as an explicit CLI
 * flag. This is not hypothetical: confirmed directly against the pinned binary — a
 * planted `.jscpd.json` containing only `{"maxSize": "6kb"}` excluded the twelve
 * largest production files (the whole data layer and routes) from the scan, leaving
 * a healthy-looking `52 files / 3591 lines, 0 clones, 0%` that clears both tripwires
 * while a real, planted duplicate went unreported. A `"jscpd"` key in `package.json`
 * does the same and reads as ordinary tool config in a PR diff.
 *
 * `.jscpd.json` and `package.json`'s `"jscpd"` key are the two real, live discovery
 * paths — confirmed both by the binary's own embedded strings ("Using config from
 * .jscpd.json" / "Using config from package.json") and by testing each file below
 * directly against it. `.jscpdrc`, `.jscpdrc.json` and `.jscpd.js` were ALSO tested
 * directly and have NO effect on this exact pinned version — but their presence is
 * refused too, defensively, since a future jscpd bump could reintroduce support for
 * a legacy name without this file being touched.
 *
 * Discovery is cwd-only, confirmed empirically against the pinned binary: a
 * `.jscpd.json` in a PARENT of the cwd, and one inside the scanned tree itself, both
 * had no effect. So checking `process.cwd()` alone is sufficient, not a shortcut.
 *
 * What this refusal does and does not buy. It closes the discovered-config channel
 * completely — nothing on disk can hand jscpd options behind this script's back. It
 * does NOT make every jscpd setting explicit: `formats`, `pattern`, `ignore_patterns`
 * and `cross_formats` are still whatever jscpd 5.0.14 defaults to, and the only thing
 * pinning those is the exact version in package.json. That is a deliberate trade —
 * pinning `--format` to a list would silently drop any new file type someone adds to
 * `src`, which is the same failure in the other direction. See the ADR.
 */
const EXTERNAL_CONFIG_FILES = ['.jscpd.json', '.jscpdrc', '.jscpdrc.json', '.jscpd.js']

/**
 * Pure: returns the offending file/key name, or `null` if none exists. Exported so
 * it is testable with a real temp directory rather than only through a subprocess.
 */
export function findExternalJscpdConfig(cwd = process.cwd()) {
  const configFile = EXTERNAL_CONFIG_FILES.find((name) => existsSync(join(cwd, name)))
  if (configFile) return configFile

  try {
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    if (pkg.jscpd !== undefined) return 'package.json (a "jscpd" key)'
  } catch {
    // No package.json here, or it isn't valid JSON — not this check's problem.
  }

  return null
}

/** Pure: the crafted rejection text for a discovered config file, or `null` for none. */
export function externalConfigReason(configFile) {
  if (!configFile) return null
  return (
    `found ${configFile}, an external jscpd configuration file.\n\n` +
    '    jscpd auto-discovers config from the process cwd and lets it silently override\n' +
    '    every option this script does not pass explicitly — that defeats the whole\n' +
    '    point of this gate. The settings live in scripts/check-duplication.mjs\n' +
    '    (SENSITIVITY, IGNORE_PATTERNS, LIMITS) and nowhere else: remove this file, or\n' +
    '    fold whatever it was trying to do into that script instead.'
  )
}

const ARGUMENT_ADVICE =
  '\n\n    This script takes at most one argument: a directory to scan instead of\n' +
  '    production `src`, used only by its own process-level tests. It is forwarded\n' +
  '    to jscpd as a positional path, so an unchecked value is an unchecked jscpd\n' +
  '    CLI token: `--config=/elsewhere/dup.json`, `--max-size=6kb`, `--ignore=...`\n' +
  '    and `--pattern=...` each redefine what the gate measures while it still\n' +
  '    reports a clean 0% and exits 0 — and a flag also empties the positional path\n' +
  '    list, so jscpd walks the whole cwd instead of the intended tree. `npm run\n' +
  '    lint:duplication -- --max-size=6kb` needed no repo change at all to do this.'

/**
 * Pure: why these raw CLI arguments are not an acceptable scope override, or `null`.
 * Split from `scanScopeError` so the "is it a flag" rule can be tested without a
 * filesystem, and validated BEFORE the value can reach jscpd's argument vector.
 */
export function cliArgsError(args) {
  if (args.length > 1) {
    return `expected at most one argument (a directory to scan), got ${args.length}: ${args.join(' ')}${ARGUMENT_ADVICE}`
  }
  if (args[0]?.startsWith('-')) {
    return `"${args[0]}" starts with "-", so it is a jscpd flag and not a directory.${ARGUMENT_ADVICE}`
  }
  return null
}

/**
 * The one ignore-file family `--no-gitignore` does NOT switch off, measured against
 * the pinned binary rather than assumed. With `--no-gitignore` in place, a `.gitignore`
 * (root or nested), `.git/info/exclude`, and even a machine-global git excludes file
 * (`$XDG_CONFIG_HOME/git/ignore`) all stopped affecting the scan — that last one is
 * worth noticing, since it lives entirely outside the repo. A plain `.ignore` kept
 * working: 120 sources became 119 with `.ignore` present, flag or no flag. jscpd 5.0.14
 * exposes no `--no-ignore`, so the only honest response is to refuse to run.
 */
export const IGNORE_FILE_NAME = '.ignore'

/** Every directory from `scope` up to the filesystem root, innermost first. */
export function ancestorDirectories(scope) {
  const dirs = []
  let dir = resolve(scope)
  while (dirname(dir) !== dir) {
    dir = dirname(dir)
    dirs.push(dir)
  }
  return dirs
}

/**
 * One recursive walk of `scope`, returning the first symbolic link and the first
 * `.ignore` file found in it, each as a full path or `null`. A single walk because
 * both checks want the same directory listing. `readdirSync({ recursive: true })`
 * does not follow links, so a symlink loop terminates rather than hanging — verified
 * directly against a self-referential tree.
 */
export function walkScope(scope, maxSize = SENSITIVITY.maxSize) {
  const entries = readdirSync(scope, { withFileTypes: true, recursive: true })
  const at = (entry) => (entry ? join(entry.parentPath, entry.name) : null)
  // `isFile()` comes from the dirent's own type, so a symlink is never stat'ed here
  // and a broken one cannot throw before `scanScopeError` gets to refuse it.
  const files = entries.filter((entry) => entry.isFile())
  return {
    symlink: at(entries.find((entry) => entry.isSymbolicLink())),
    ignoreFile: at(files.find((entry) => entry.name === IGNORE_FILE_NAME)),
    oversized: at(files.find((entry) => statSync(at(entry)).size > maxSize)),
  }
}

const IGNORE_FILE_ADVICE =
  '\n\n    `.ignore` files are read by jscpd from the scanned tree AND from every\n' +
  '    directory above it, and `--no-gitignore` does not switch them off — verified\n' +
  '    against this pinned binary. A tracked production file named in one still ships\n' +
  '    while never being measured, and the summary line is byte-identical to an honest\n' +
  '    run. Delete it, or express the exclusion in IGNORE_PATTERNS in\n' +
  '    scripts/check-duplication.mjs, where it is pinned by a test and visible in the ADR.'

const SYMLINK_ADVICE =
  '\n\n    jscpd does not follow links (`follow_symlinks: false`), so it and anything\n' +
  '    under it would be dropped from the scan without a word while still shipping —\n' +
  '    measured: a fixture of two real files plus a symlinked duplicate reported\n' +
  '    `sources: 1, clones: 0`, and `sources: 3` with the clone found once links were\n' +
  '    followed. This refuses rather than passing `--follow-symlinks`, because\n' +
  '    following links fails the other way: a link pointing out of `src` pulls foreign\n' +
  '    code into the denominator and can dilute a real violation under the 3% bar.\n' +
  '    Replace it with the real file, or move it out of the scanned tree.'

const OVERSIZED_ADVICE =
  '\n\n    jscpd skips a file over `--max-size` in silence, and unlike a bad ignore glob\n' +
  '    the floors cannot see it: an over-cap file never enters the denominator, so the\n' +
  '    summary line is byte-identical to an honest run. Measured — two verbatim 2.4MB\n' +
  '    duplicates in src/lib gave `64 files / 5822 lines, 0 clones, 0%`, exit 0.\n' +
  '    Split the file, or raise SENSITIVITY.maxSize and record why in the ADR.\n' +
  '    Note this check does not consult IGNORE_PATTERNS: a deliberately-excluded file\n' +
  '    over the cap is refused too, because "excluded" and "too big to measure" should\n' +
  '    not look the same from here. Excluding it from the SCOPE is the way out.'

/**
 * Why the resolved scan scope is unusable, or `null`. A scope that IS itself a symlink
 * is fine and deliberately not refused — jscpd traverses a symlinked root normally,
 * verified — so only links found *inside* the tree are rejected.
 */
export function scanScopeError(scope) {
  if (!existsSync(scope) || !statSync(scope).isDirectory()) {
    return `the scan scope "${scope}" is not an existing directory, so there is nothing to measure.`
  }
  const { symlink, ignoreFile, oversized } = walkScope(scope)
  const above = ancestorDirectories(scope)
    .map((dir) => join(dir, IGNORE_FILE_NAME))
    .find((path) => existsSync(path))

  const foundIgnoreFile = ignoreFile ?? above
  if (foundIgnoreFile)
    return `found ${foundIgnoreFile}, an ignore file jscpd honours.${IGNORE_FILE_ADVICE}`
  if (symlink) return `"${symlink}" inside the scan scope is a symbolic link.${SYMLINK_ADVICE}`
  if (oversized)
    return `"${oversized}" is larger than the ${SENSITIVITY.maxSize}-byte cap.${OVERSIZED_ADVICE}`
  return null
}

/**
 * Prints the crafted rejection and terminates the process. Takes the reason returned
 * by one of the pure checks above, and does nothing when that reason is `null`.
 *
 * There is no return value on purpose: `process.exit` does not return control, so a
 * caller cannot observe one and an earlier `return true` here was dead code whose
 * JSDoc described a contract that could only ever yield `false`.
 */
function refuseIf(reason) {
  if (!reason) return
  console.error(`\n  VERIFY REJECTED — ${reason}\n`)
  process.exit(1)
}

/**
 * `scopeOverride` — this script's own process-level tests pass `process.argv[2]` to
 * point a real subprocess run at a fixture tree instead of production `src`.
 *
 * What this genuinely guarantees: the override reaches only the `scope` field.
 * `ignore` is always `IGNORE_PATTERNS` and `limits` is always `LIMITS`; neither is a
 * parameter here, so no argument can relax the floor or drop the ignore list, and a
 * redirected scope still fails closed on the real 40-file / 3,000-line floor. The
 * tests prove that with a fixture tree sized past the floor rather than by shrinking
 * it, and `main()` validates the raw argument (`cliArgsError`, then `scanScopeError`)
 * before it ever reaches jscpd's argument vector.
 *
 * What it does NOT guarantee, so nobody stops looking here. A valid directory
 * override still redirects the gate away from production code, and nothing in this
 * file prevents that — it is `package.json` that has to be right. Two tests carry
 * that weight, and an earlier version of this comment claimed one of them did more
 * than it did: pinning `scripts['lint:duplication']` alone was defeated twice while
 * every test stayed green, once by wiring `npm run lint:duplication -- docs` into
 * `verify` (the script string is untouched) and once by adding a second script,
 * `lint:duplication:fast`, whose name a substring match on `verify` also accepted.
 * The pins are therefore the exact script string AND `verify` split on `&&` into
 * exact tokens, one of which must be exactly `npm run lint:duplication`. That pair
 * holds against both defeats; it is still a review-time assertion rather than a
 * runtime guard, and it says nothing about how CI invokes anything.
 *
 * Nor can any check inside this file defend against `NODE_OPTIONS`, a tampered
 * `node_modules`, or an edit to the file itself — anyone able to set those can
 * replace the gate outright. `npm run verify` calls this with no argument.
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
function reportViolations(report, violations) {
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
}

function main() {
  const args = process.argv.slice(2)
  refuseIf(externalConfigReason(findExternalJscpdConfig()))
  refuseIf(cliArgsError(args))

  const { scope, ignore, limits } = resolveScanOptions(args[0])
  refuseIf(scanScopeError(scope))

  const report = runDuplicationScan({ scope, ignore })
  const violations = evaluateReport(report, limits)

  if (violations.length > 0) {
    reportViolations(report, violations)
    process.exit(1)
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
