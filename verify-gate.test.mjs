import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * What survives SPRIN-55.
 *
 * The pivot's slice 3 removed the code-quality ceremony — the T1-T5 thresholds,
 * the duplication gate and the four ADRs that existed only to justify threshold
 * overrides. It deliberately did NOT remove the gate. This file is the residue
 * of `eslint.config.test.mjs`: the assertions that were about the gate rather
 * than about the thresholds, kept because they guard what slice 3 keeps.
 *
 * Two kinds of assertion live here, and both are POSITIVE by construction.
 *
 *   1. `verify`'s composition, pinned as exact `&&`-separated tokens.
 *   2. `eslint .` still reports a real error at real production paths.
 *
 * Nothing here asserts that a threshold rule is ABSENT. That would be a negative
 * assertion — the weakest shape available, and the one the deleted file's own
 * BLOCKER note was written about: a negative cannot tell "the rule is off" from
 * "this file is not being linted at all". It would also fight a future decision
 * to bring a threshold back, which is not this file's business.
 */

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

/** A genuine error under `js.configs.recommended`, and nothing else. */
const REAL_VIOLATION =
  'export function swallow() {\n  try {\n    JSON.parse("{}")\n  } catch {}\n}\n'

describe('npm run lint is still a real gate over production code', () => {
  // The thresholds are gone; linting is not. These are positive controls: each
  // plants a real, ordinary lint error at a real production path and requires it
  // to be reported at severity 2.
  //
  // `.tsx` is asserted separately from `.ts` on purpose. Adding `'**/*.tsx'` to
  // eslint.config.js's global `ignores` — or `'src/routes/**'`, or
  // `'src/components/**'` — exempts every React component in the repo, and a
  // `.ts`-only probe cannot see it. That mutation was proven to pass a whole
  // suite on this repo once already.

  it('reports a real error in a src/lib .ts file', async () => {
    const ruleIds = await errorRuleIdsFor(REAL_VIOLATION, 'src/lib/gate-probe.ts')
    expect(ruleIds).toContain('no-empty')
  })

  it('reports a real error at a real src/routes .tsx path', async () => {
    const messages = await messagesFor(REAL_VIOLATION, 'src/routes/GateProbe.tsx')
    // An ignored path reports this warning and no rule messages at all, so the
    // ruleId assertion below already goes red — this one makes it say why.
    expect(messages.map((message) => message.message).join('\n')).not.toMatch(/File ignored/)
    expect(messages.filter((m) => m.severity === 2).map((m) => m.ruleId)).toContain('no-empty')
  })

  it('reports a real error at a real, non-ui src/components .tsx path', async () => {
    const ruleIds = await errorRuleIdsFor(REAL_VIOLATION, 'src/components/board/GateProbe.tsx')
    expect(ruleIds).toContain('no-empty')
  })
})

describe('the verify gate is composed of exactly the steps it claims', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

  it('scripts.lint runs plain `eslint .`, with no flag that could weaken it', () => {
    // `eslint --quiet .` silences warnings but not errors, so it would keep the
    // positive controls above green while suppressing real advisory output.
    expect(pkg.scripts.lint).toBe('eslint .')
  })

  /**
   * An exact ordered list, not a set of `toContain`s. It refuses a substitution
   * (`npm test` -> `npm run test:unit`), a deletion, a reorder (`build` after
   * `test` would run the credential check after the suite that assumes it), and
   * a silently inserted step.
   *
   * The substitution is the dangerous one and it is silent: swapping `npm test`
   * for `npm run test:unit` once left an entire scoped suite green. CLAUDE.md
   * calls that non-negotiable — `test:unit` excludes the seven live integration
   * suites, so CI would stay green while "RLS still holds" went quietly unmet on
   * every future PR.
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

  it('no duplication gate is left half-wired', () => {
    // Removing the script but leaving `lint:duplication` in package.json (or the
    // reverse) fails `verify` at run time with a confusing error rather than at
    // review time. Both halves go, or neither.
    expect(pkg.scripts['lint:duplication']).toBeUndefined()
    expect(existsSync(resolve('scripts/check-duplication.mjs'))).toBe(false)
    expect(pkg.devDependencies.jscpd).toBeUndefined()
  })
})
