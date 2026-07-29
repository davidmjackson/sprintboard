import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/**
 * The guard on the CI gate.
 *
 * SPRIN-55 removed the code-quality ceremony; SPRIN-59 put the T1-T5 thresholds
 * back after measuring that they cost nothing (122 files, 0 errors, 0 warnings)
 * — see docs/adr/0006. What stayed gone is the duplication gate. This file has
 * to hold both facts: the thresholds ARE enforced, the duplication gate is NOT.
 *
 * FOUR kinds of assertion live here, and the fourth is weaker than the others.
 * An earlier draft of this comment claimed there were two and that both were
 * "positive by construction". That was false, and a reader would have trusted it
 * to mean there was no vacuity risk here — the exact trap this project has
 * walked into twice, asserting a rationale in prose that no test honours.
 *
 *   1. `eslint .` still reports a real error, at real paths, from each preset.
 *      Positive. The strongest shape available.
 *   2. Each T1-T5 threshold, pinned at its BOUNDARY — at the limit passes, one
 *      unit past it fails. Positive, and two-sided on purpose: a single "flags a
 *      violation" assertion survives a widened max, measured (T1 30->37,
 *      T2 10->13, T3 15->20, T5 400->404 all once passed the whole suite).
 *   3. `verify`'s composition and what `npm test` actually COLLECTS. Positive.
 *   4. The duplication gate is really gone. NEGATIVE, and therefore bounded by
 *      the exact names it enumerates: it can tell "absent under these names"
 *      but never "absent everywhere". Named as a limitation, not hidden.
 *
 * Every threshold assertion goes through `errorRuleIdsFor`, never `messagesFor`
 * alone: `eslint .` carries no `--max-warnings 0`, so a rule demoted from
 * 'error' to 'warn' exits 0 on a real violation while an id-only assertion stays
 * green. That defeat was observed on this repo during SPRIN-50.
 */

const require = createRequire(import.meta.url)

async function messagesFor(source, filePath) {
  const eslint = new ESLint({ cwd: process.cwd() })
  const [result] = await eslint.lintText(source, { filePath })
  return result.messages
}

/**
 * Rule ids reported at ESLint severity 2 (error) only.
 *
 * Severity is checked, not just the rule id: demoting a rule from `'error'` to
 * `'warn'` leaves `eslint .` (no `--max-warnings 0`) exiting 0 on a real
 * violation, so an id-only assertion stays green while the gate stops gating.
 * That exact defeat was observed on this repo during SPRIN-50.
 */
async function errorRuleIdsFor(source, filePath) {
  return (await messagesFor(source, filePath))
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId)
}

/**
 * One probe per PRESET, each keyed on a rule that ONLY that preset supplies.
 *
 * This is the correction to a real defect in this file's first version, found by
 * two independent reviewers. Every probe there asserted `no-empty` — which
 * `eslint.config.js` also states explicitly in its own `rules` block, so the
 * probes measured that single hand-written line and nothing else. Deleting
 * `...reactHooks.configs.recommended.rules` (one line) left `npm run lint` exit 0
 * on a conditionally-called `useState` in a real component, with every test here
 * green. Dropping `js.configs.recommended` silently removed ~60 core correctness
 * rules, also green. Both were proven live against real probe files.
 *
 * `eslint.config.js`'s header and CLAUDE.md both say what slice 3 keeps is
 * "recommended JS/TS rules, the React hook rules, and no swallowed errors".
 * That is four things, so there are four probes.
 */
const PRESET_PROBES = [
  {
    what: 'js.configs.recommended (the ESLint core rules)',
    rule: 'no-constant-condition',
    path: 'src/lib/gate-probe.ts',
    source: 'export function f() {\n  if (true) {\n    return 1\n  }\n  return 0\n}\n',
  },
  {
    what: 'tseslint.configs.recommended (and, with it, the TypeScript parser)',
    rule: '@typescript-eslint/no-unused-vars',
    path: 'src/lib/gate-probe.ts',
    source: 'export function f() {\n  const unused: number = 1\n  return 2\n}\n',
  },
  {
    what: 'reactHooks.configs.recommended.rules',
    rule: 'react-hooks/rules-of-hooks',
    path: 'src/components/board/GateProbe.tsx',
    source:
      "import { useState } from 'react'\n" +
      'export function GateProbe(props: { on: boolean }) {\n' +
      '  if (props.on) {\n' +
      '    useState(0)\n' +
      '  }\n' +
      '  return null\n' +
      '}\n',
  },
  {
    what: "the explicit 'no-empty' rule (no swallowed errors)",
    rule: 'no-empty',
    path: 'src/lib/gate-probe.ts',
    source: 'export function swallow() {\n  try {\n    JSON.parse("{}")\n  } catch {}\n}\n',
  },
]

/** A genuine error under every configuration this repo has had. Used for path coverage. */
const SWALLOWED_ERROR =
  'export function swallow() {\n  try {\n    JSON.parse("{}")\n  } catch {}\n}\n'

/**
 * Plain-JS twins of the oversized/over-complex probes, for the .mjs and .js paths.
 *
 * Deliberately free of type annotations. The .ts probes elsewhere in this file
 * would ALSO parse at a .mjs path once that extension is in scope, because the
 * TypeScript parser comes in through the same config block — so a .mjs probe
 * carrying `n: number` would still pass while proving nothing about whether
 * ordinary JavaScript is linted. These say what they mean.
 */
const OVERSIZED_JS = `export function sized(out) {\n${Array.from(
  { length: 35 },
  (_, i) => `  out.push(${i})`,
).join('\n')}\n  return out\n}\n`
const OVER_COMPLEX_JS = `export function branchy(n) {\n${Array.from(
  { length: 14 },
  (_, i) => `  if (n === ${i}) return ${i}`,
).join('\n')}\n  return -1\n}\n`

describe('npm run lint still applies every rule set the gate claims to keep', () => {
  // Delete any one preset from eslint.config.js and exactly one of these goes red.
  for (const probe of PRESET_PROBES) {
    it(`reports a rule that only ${probe.what} supplies`, async () => {
      const ruleIds = await errorRuleIdsFor(probe.source, probe.path)
      expect(ruleIds).toContain(probe.rule)
    })
  }
})

describe('npm run lint still covers every part of the tree it used to', () => {
  // These pin the `ignores` list and the `files` glob rather than the rules.
  // Each path is asserted separately because an exemption is shaped like a path:
  // adding `'**/*.tsx'` to `ignores` exempts every React component in the repo,
  // and a `.ts`-only probe cannot see it. That mutation passed a whole suite here
  // once already.
  const PATHS = [
    ['a src/lib .ts file', 'src/lib/gate-probe.ts'],
    ['a real src/routes .tsx path', 'src/routes/GateProbe.tsx'],
    ['a real, non-ui src/components .tsx path', 'src/components/board/GateProbe.tsx'],
    // src/test/** holds supabase-clients.ts, which carries the apikeyOnlyFetch
    // wrapper CLAUDE.md calls load-bearing. The file this one replaced had two
    // probes at a test-file path; dropping them let `'src/test/**'` and
    // `'**/*.test.{ts,tsx}'` in `ignores` un-lint 50 of 118 tracked files silently.
    ['a src/test helper', 'src/test/gate-probe.ts'],
    ['a test file', 'src/lib/example.test.ts'],
    // SPRIN-60. The `files` glob read `'**/*.{ts,tsx}'`, so every .mjs and .js
    // file in the repo sat outside T1-T5 AND outside every preset above —
    // including scripts/check-bundle.mjs, the control that stops a service-role
    // key reaching the browser, and this guard file itself. `eslint .` exited 0
    // on all of it. Narrowing the glob back is exactly the shape of an exemption
    // these path probes exist to catch, and no .ts probe can see it.
    ['a scripts/ .mjs file', 'scripts/gate-probe.mjs'],
    ['a root .mjs guard file', 'gate-probe.test.mjs'],
    ['the .js lint config path', 'gate-probe.config.js'],
  ]

  for (const [label, path] of PATHS) {
    it(`reports a real error in ${label}`, async () => {
      const messages = await messagesFor(SWALLOWED_ERROR, path)
      // An ignored path reports this warning and no rule messages at all, so the
      // ruleId assertion below already goes red — this one makes it say why.
      expect(messages.map((message) => message.message).join('\n')).not.toMatch(/File ignored/)
      expect(messages.filter((m) => m.severity === 2).map((m) => m.ruleId)).toContain('no-empty')
    })
  }
})

describe('the T1-T5 thresholds are enforced, each pinned at its boundary', () => {
  // SPRIN-59 restored these (docs/adr/0006). Each pair brackets the real limit:
  // AT the limit must pass, one unit past must fail. A single "flags a violation"
  // assertion is NOT enough — widening every max by a few units once left the
  // whole pre-existing suite green, which is how these boundary pairs came to
  // exist in the first place.
  //
  // `src/lib/*.ts` is the probe path throughout: it is production code with no
  // override applied to it, so every threshold is live there.
  const PROBE = 'src/lib/threshold-probe.ts'

  it('T1: a 30-line function passes, a 31-line function is flagged', async () => {
    // 1 declaration + 27 body + 1 return + 1 closing brace = 30.
    const sized = (bodyLines) =>
      `export function sized(out: number[]) {\n${Array.from(
        { length: bodyLines },
        (_, i) => `  out.push(${i})`,
      ).join('\n')}\n  return out\n}\n`
    expect(await errorRuleIdsFor(sized(27), PROBE)).not.toContain('max-lines-per-function')
    expect(await errorRuleIdsFor(sized(28), PROBE)).toContain('max-lines-per-function')
  })

  it('T2: cyclomatic complexity of 10 passes, 11 is flagged', async () => {
    // Complexity is (independent branches + 1), so 9 ifs -> 10.
    const branchy = (ifs) =>
      `export function branchy(n: number) {\n${Array.from(
        { length: ifs },
        (_, i) => `  if (n === ${i}) return ${i}`,
      ).join('\n')}\n  return -1\n}\n`
    expect(await errorRuleIdsFor(branchy(9), PROBE)).not.toContain('complexity')
    expect(await errorRuleIdsFor(branchy(10), PROBE)).toContain('complexity')
  })

  it('T3: cognitive complexity of 15 passes, 16 is flagged', async () => {
    // sonarjs charges more per NESTING level than per sibling branch, so depth-5
    // nesting costs 1+2+3+4+5 = 15 — exactly the limit. One extra top-level `if`
    // (nesting 0, cost 1) tips it to 16 without touching cyclomatic complexity.
    const nested = (extraSibling) => {
      let open = ''
      let close = ''
      for (let i = 0; i < 5; i += 1) {
        const indent = '  '.repeat(i + 1)
        open += `${indent}if (n === ${i}) {\n`
        close = `${indent}}\n${close}`
      }
      const extra = extraSibling ? '  if (n === 99) { out = 2 }\n' : ''
      return `export function nested(n: number) {\n  let out = 0\n${open}${'  '.repeat(6)}out = 1\n${close}${extra}  return out\n}\n`
    }
    expect(await errorRuleIdsFor(nested(false), PROBE)).not.toContain(
      'sonarjs/cognitive-complexity',
    )
    const over = await messagesFor(nested(true), PROBE)
    const hit = over.find((m) => m.ruleId === 'sonarjs/cognitive-complexity' && m.severity === 2)
    expect(hit).toBeDefined()
    // The message carries the configured limit, so a changed number is caught
    // even if the boundary pair above were somehow satisfied another way.
    expect(hit.message).toMatch(/to the 15 allowed/)
  })

  it('T4: four parameters pass, five are flagged', async () => {
    const params = (n) => {
      const names = Array.from({ length: n }, (_, i) => `a${i}: number`).join(', ')
      const body = Array.from({ length: n }, (_, i) => `a${i}`).join(' + ')
      return `export function takes(${names}) {\n  return ${body}\n}\n`
    }
    expect(await errorRuleIdsFor(params(4), PROBE)).not.toContain('max-params')
    expect(await errorRuleIdsFor(params(5), PROBE)).toContain('max-params')
  })

  it('T5: a 400-line file passes, a 401-line file is flagged', async () => {
    // Distinct exported consts: distinct names avoid a redeclaration parse error
    // and `export` keeps each one used, so no-unused-vars stays quiet.
    const file = (n) =>
      `${Array.from({ length: n }, (_, i) => `export const v${i} = ${i}`).join('\n')}\n`
    expect(await errorRuleIdsFor(file(400), PROBE)).not.toContain('max-lines')
    expect(await errorRuleIdsFor(file(401), PROBE)).toContain('max-lines')
  })
})

describe('the threshold overrides are scoped exactly as their ADRs say', () => {
  const OVERSIZED = `export function sized(out: number[]) {\n${Array.from(
    { length: 35 },
    (_, i) => `  out.push(${i})`,
  ).join('\n')}\n  return out\n}\n`
  const OVER_COMPLEX = `export function branchy(n: number) {\n${Array.from(
    { length: 14 },
    (_, i) => `  if (n === ${i}) return ${i}`,
  ).join('\n')}\n  return -1\n}\n`

  // ADR 0001 — T1 counts JSX as lines, so it is off for components.
  it('T1 is off in a .tsx component (ADR 0001) but on in src/lib', async () => {
    expect(await errorRuleIdsFor(OVERSIZED, 'src/routes/Probe.tsx')).not.toContain(
      'max-lines-per-function',
    )
    expect(await errorRuleIdsFor(OVERSIZED, 'src/lib/threshold-probe.ts')).toContain(
      'max-lines-per-function',
    )
  })

  // ADR 0002 — size rules off in tests; T2 and T4 explicitly stay ON. Both
  // halves are asserted: turning `complexity` off for test files once left the
  // rest of this file green.
  it('T1 is off in test files but T2 stays on (ADR 0002)', async () => {
    expect(await errorRuleIdsFor(OVERSIZED, 'src/lib/example.test.ts')).not.toContain(
      'max-lines-per-function',
    )
    expect(await errorRuleIdsFor(OVER_COMPLEX, 'src/lib/example.test.ts')).toContain('complexity')
  })

  // SPRIN-60 — the thresholds reach .mjs, and scripts/ is not a quiet exemption.
  // This is the assertion the old config failed: check-bundle.mjs's main() sat at
  // 43 lines against a max of 30 with `npm run lint` green.
  it('T1 is on in a scripts/*.mjs file, where the bundle control lives', async () => {
    expect(await errorRuleIdsFor(OVERSIZED_JS, 'scripts/gate-probe.mjs')).toContain(
      'max-lines-per-function',
    )
  })

  // ADR 0002 covers .mjs test files too, or the six describe/it blocks across
  // this file and check-bundle.test.mjs would be flagged for block size — the
  // exact measurement ADR 0002 already ruled is not a design signal in .ts.
  // Both halves again: the override must not take T2 down with it.
  it('T1 is off in a .mjs test file but T2 stays on (ADR 0002)', async () => {
    expect(await errorRuleIdsFor(OVERSIZED_JS, 'gate-probe.test.mjs')).not.toContain(
      'max-lines-per-function',
    )
    expect(await errorRuleIdsFor(OVER_COMPLEX_JS, 'gate-probe.test.mjs')).toContain('complexity')
  })

  // ...and the exemption really is scoped to TEST .mjs files. A glob of
  // '**/*.mjs' in the ADR 0002 override would read as tidier and would silently
  // hand scripts/check-bundle.mjs back its exemption.
  it('the .mjs test exemption does not leak to non-test .mjs', async () => {
    expect(await errorRuleIdsFor(OVERSIZED_JS, 'scripts/check-bundle-probe.mjs')).toContain(
      'max-lines-per-function',
    )
  })

  // Widening this glob to src/components/** or src/** would exempt ~34 real
  // production components from T2-T5, so both a real route path and a real
  // non-ui component path must still be flagged.
  it('the shadcn override exempts only src/components/ui/**', async () => {
    expect(await errorRuleIdsFor(OVER_COMPLEX, 'src/components/ui/probe.tsx')).not.toContain(
      'complexity',
    )
    expect(await errorRuleIdsFor(OVER_COMPLEX, 'src/routes/Probe.tsx')).toContain('complexity')
    expect(await errorRuleIdsFor(OVER_COMPLEX, 'src/components/board/Probe.tsx')).toContain(
      'complexity',
    )
  })

  it('T5 is off only for the generated database.types.ts', async () => {
    const big = `${Array.from({ length: 405 }, (_, i) => `export const v${i} = ${i}`).join('\n')}\n`
    expect(await errorRuleIdsFor(big, 'src/lib/database.types.ts')).not.toContain('max-lines')
    expect(await errorRuleIdsFor(big, 'src/lib/threshold-probe.ts')).toContain('max-lines')
  })
})

describe('the shadcn/ui override is scoped exactly to src/components/ui/**', () => {
  // The file this replaced had a dedicated describe for this, whose probes keyed
  // on `complexity` — a rule the override really did switch off. Rekeying them to
  // `no-empty`, which the override never touches, made them blind: widening the
  // glob to `src/**` disabled react-refresh repo-wide with everything green.
  // `only-export-components` is 'warn', so severity 1 is the correct assertion
  // here and `errorRuleIdsFor` is deliberately not used.
  const MIXED_EXPORTS =
    'export function helper() {\n  return 1\n}\nexport function GateProbe() {\n  return null\n}\n'

  it('warns outside src/components/ui', async () => {
    const ruleIds = (await messagesFor(MIXED_EXPORTS, 'src/components/board/GateProbe.tsx')).map(
      (m) => m.ruleId,
    )
    expect(ruleIds).toContain('react-refresh/only-export-components')
  })

  it('does not warn inside src/components/ui (vendored)', async () => {
    const ruleIds = (await messagesFor(MIXED_EXPORTS, 'src/components/ui/gate-probe.tsx')).map(
      (m) => m.ruleId,
    )
    expect(ruleIds).not.toContain('react-refresh/only-export-components')
  })
})

describe('the verify gate is composed of exactly the steps it claims', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

  // Every step of `verify` has its BODY pinned, not just its presence: `lint` and
  // `format:check` here, `build` in scripts/check-bundle.test.mjs, and `test` by
  // the collection assertions below. `format:check` was the odd one out in the
  // first version — narrowing it to a single path left it in the step list,
  // exiting 0, checking almost nothing, with everything green.
  it('scripts.lint runs plain `eslint .`, with no flag that could weaken it', () => {
    expect(pkg.scripts.lint).toBe('eslint .')
  })

  it('scripts.format:check runs prettier over the whole repo', () => {
    expect(pkg.scripts['format:check']).toBe('prettier --check .')
  })

  /**
   * An exact ordered list, not a set of `toContain`s. It refuses a substitution
   * (`npm test` -> `npm run test:unit`), a deletion, a reorder (`build` after
   * `test` would run the credential check after the suite that assumes it), and
   * a silently inserted step.
   *
   * Exact tokens rather than a substring match on the whole string: a substring
   * match was defeated twice on this repo, once by an appended argument and once
   * by a second script whose name contained the first's.
   *
   * Adding a real step to `verify` means updating this list in the same commit.
   * That is the point, not friction to work around.
   */
  it('verify runs exactly these four steps, in this order', () => {
    const steps = pkg.scripts.verify.split('&&').map((step) => step.trim())
    expect(steps).toEqual(['npm run lint', 'npm run format:check', 'npm run build', 'npm test'])
  })

  it('scripts.test is the full vitest run, not the integration-excluding fast loop', () => {
    expect(pkg.scripts.test).toBe('vitest run')
  })
})

/**
 * CLAUDE.md's tripwire, made executable.
 *
 * Pinning `scripts.test === 'vitest run'` proves the SCRIPT is right and nothing
 * about what it collects. `vite.config.ts`'s `test.exclude` is a second, entirely
 * separate lever: adding `'**\/*.integration.test.ts'` there takes the run from 50
 * files to 43 and the live suites from 7 to 0 — CLAUDE.md's stated failure
 * condition, a GAP of exactly zero — while every assertion above stays green. And
 * `'**\/verify-gate.test.mjs'` makes this guard delete itself.
 *
 * So the assertion is on the COLLECTED SET, derived from vitest itself, not on a
 * string in package.json. It names the seven live suites individually rather than
 * counting them, because a count moves every time a story adds a test file and a
 * name does not. It also requires this file's own presence, which is what closes
 * the self-deletion route.
 */
describe('npm test really collects the live integration suites', () => {
  const LIVE_SUITES = [
    'src/test/rls.integration.test.ts',
    'src/test/keepalive.integration.test.ts',
    'src/test/signup.integration.test.ts',
    'src/test/login.integration.test.ts',
    'src/test/projects.integration.test.ts',
    'src/test/tickets.integration.test.ts',
    'src/test/sprints.integration.test.ts',
  ]

  const collected = (() => {
    const bin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
    const result = spawnSync(process.execPath, [bin, 'list', '--filesOnly'], {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: { ...process.env, CI: '1' },
    })
    if (result.status !== 0) {
      throw new Error(`vitest list failed (${result.status})\n${result.stderr ?? ''}`)
    }
    return result.stdout.split('\n').map((line) => line.trim().replace(/\\/g, '/'))
  })()

  it.each(LIVE_SUITES)('collects %s', (suite) => {
    expect(collected.some((line) => line.endsWith(suite))).toBe(true)
  })

  it('collects this guard file itself', () => {
    // Excluding this file from collection would otherwise disarm every assertion
    // above in a single line of vite.config.ts, silently.
    expect(collected.some((line) => line.endsWith('verify-gate.test.mjs'))).toBe(true)
  })

  it('still excludes e2e/**, which Vitest cannot load', () => {
    // Playwright specs are `*.spec.ts`, which matches Vitest's default include
    // glob. A Vitest run that tries to load one errors — restore the exclude,
    // don't rename the specs.
    expect(collected.some((line) => /(^|\/)e2e\//.test(line))).toBe(false)
  })
})

describe('the duplication gate is still gone (a NEGATIVE check — see the header)', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

  // SPRIN-59 brought the THRESHOLDS back but deliberately not the duplication
  // gate (docs/adr/0006). This describe holds that line. Note what changed with
  // it: `eslint-plugin-sonarjs` is no longer forbidden — it supplies T3 — so it
  // moved from the "must be absent" list to the "must be present" assertion
  // below. Deleting it would silently drop cognitive complexity, so it needs a
  // positive assertion, not merely the absence of a negative one.
  it('is not left half-wired under any dependency map or script key', () => {
    // Both maps, not just devDependencies: re-adding jscpd under `dependencies`
    // is the strictly worse reinstatement — it ships the package into every
    // production install — and it passed a devDependencies-only assertion.
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(Object.keys(allDeps)).not.toContain('jscpd')
    expect(pkg.scripts['lint:duplication']).toBeUndefined()
    expect(pkg.scripts['lint:standards']).toBeUndefined()
    expect(existsSync(resolve('scripts/check-duplication.mjs'))).toBe(false)
  })

  it('but the plugin supplying T3 IS a devDependency', () => {
    // The T3 boundary probe above would also catch its removal, by failing to
    // parse the rule. This says why, so the failure is diagnosable.
    expect(Object.keys(pkg.devDependencies)).toContain('eslint-plugin-sonarjs')
  })
})
