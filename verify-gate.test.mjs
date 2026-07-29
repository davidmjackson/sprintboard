import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/**
 * What survives SPRIN-55.
 *
 * The pivot's slice 3 removed the code-quality ceremony — the T1-T5 thresholds,
 * the duplication gate and the four ADRs that existed only to justify threshold
 * overrides. It deliberately did NOT remove the gate. This file is the residue
 * of `eslint.config.test.mjs`: the assertions that were about the gate rather
 * than about the thresholds, kept because they guard what slice 3 keeps.
 *
 * THREE kinds of assertion live here, and the third is weaker than the others.
 * An earlier draft of this comment claimed there were two and that both were
 * "positive by construction". That was false, and a reader would have trusted it
 * to mean there was no vacuity risk here — the exact trap this project has
 * walked into twice, asserting a rationale in prose that no test honours.
 *
 *   1. `eslint .` still reports a real error, at real paths, from each preset.
 *      Positive. The strongest shape available.
 *   2. `verify`'s composition and what `npm test` actually COLLECTS. Positive.
 *   3. The duplication gate is really gone. NEGATIVE, and therefore bounded by
 *      the exact names it enumerates: it can tell "absent under these names"
 *      but never "absent everywhere". Named as a limitation, not hidden.
 *
 * Nothing here asserts a threshold rule is absent. That would fight a future
 * decision to bring one back, which is not this file's business.
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

describe('the duplication gate is gone (a NEGATIVE check — see the header)', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

  it('is not left half-wired under any dependency map or script key', () => {
    // Both maps, not just devDependencies: re-adding jscpd under `dependencies`
    // is the strictly worse reinstatement — it ships the package into every
    // production install — and it passed a devDependencies-only assertion.
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies }
    expect(Object.keys(allDeps)).not.toContain('jscpd')
    expect(Object.keys(allDeps)).not.toContain('eslint-plugin-sonarjs')
    expect(pkg.scripts['lint:duplication']).toBeUndefined()
    expect(pkg.scripts['lint:standards']).toBeUndefined()
    expect(existsSync(resolve('scripts/check-duplication.mjs'))).toBe(false)
  })
})
