import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * A function well over T1's 30-line cap. Built from `push` calls rather than
 * `const` declarations so it trips `max-lines-per-function` and nothing else —
 * unused locals would drown the assertion in `no-unused-vars` noise.
 */
function oversizedFunction() {
  const body = Array.from({ length: 35 }, (_, i) => `  out.push(${i})`).join('\n')
  return `export function big(out: number[]) {\n${body}\n  return out\n}\n`
}

async function messagesFor(source, filePath) {
  const eslint = new ESLint({ cwd: process.cwd() })
  const [result] = await eslint.lintText(source, { filePath })
  return result.messages
}

async function ruleIdsFor(source, filePath) {
  return (await messagesFor(source, filePath)).map((message) => message.ruleId)
}

/**
 * Rule ids reported at ESLint severity 2 (error) only. `ruleIdsFor` maps
 * `message.ruleId` alone and never `message.severity`, so demoting every T1-T5
 * rule in eslint.config.js from `'error'` to `'warn'` left every "flags ..."
 * test below green while `eslint .` exited 0 on a real violation — verified
 * directly: all 10 tests stayed green and `npx eslint` printed
 * "0 errors, 1 warning" / exit 0 against a real T4 violation. `npm run lint`
 * (`eslint .` with no `--max-warnings 0`) treats that as success, so the gate
 * silently reverts to the advisory report this branch exists to retire.
 * Every positive "flags" assertion below must go through this helper, not
 * `ruleIdsFor`, so a demotion to 'warn' fails it.
 */
async function errorRuleIdsFor(source, filePath) {
  return (await messagesFor(source, filePath))
    .filter((message) => message.severity === 2)
    .map((message) => message.ruleId)
}

/**
 * A function over cognitive-complexity's threshold of 15. Nested `if`s cost more
 * per level than sequential ones (sonarjs's nesting-increment rule), so six
 * levels of nesting (1+2+3+4+5+6 = 21) clears 15 without also tripping
 * cyclomatic `complexity` (only 6 branches, well under its max of 10) — keeps
 * the assertion isolated to the rule under test.
 */
function deeplyNestedFunction() {
  const depth = 6
  let open = ''
  let close = ''
  for (let i = 0; i < depth; i += 1) {
    const indent = '  '.repeat(i + 1)
    open += `${indent}if (n === ${i}) {\n`
    close = `${indent}}\n${close}`
  }
  const innerIndent = '  '.repeat(depth + 1)
  return `export function nested(n: number) {\n  let out = 0\n${open}${innerIndent}out = 1\n${close}  return out\n}\n`
}

/**
 * A function of cyclomatic complexity 15, over T2's max of 10, and nothing else:
 * 14 sequential `if`s cost one branch each, and every one returns, so neither
 * `sonarjs/cognitive-complexity` (no nesting) nor T1 (well under 30 lines) fires.
 */
function overComplexFunction() {
  const branches = Array.from({ length: 14 }, (_, i) => `  if (n === ${i}) return ${i}`).join('\n')
  return `export function branchy(n: number) {\n${branches}\n  return -1\n}\n`
}

/**
 * A file well over T5's 400-line cap. Each line is a distinct, exported
 * top-level `const` — distinct names avoid a redeclaration parse error, and
 * `export` keeps every one "used" so `no-unused-vars` stays silent.
 */
function oversizedFileSource() {
  const lines = Array.from({ length: 405 }, (_, i) => `export const v${i} = ${i}`)
  return `${lines.join('\n')}\n`
}

describe('the code quality standard is enforced by npm run lint', () => {
  it('flags an over-length function in src/lib (T1 applies to real logic)', async () => {
    const ruleIds = await errorRuleIdsFor(oversizedFunction(), 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('max-lines-per-function')
  })

  it('does NOT flag the same function in a .tsx component (ADR 0001)', async () => {
    const ruleIds = await ruleIdsFor(oversizedFunction(), 'src/routes/ThresholdProbe.tsx')
    expect(ruleIds).not.toContain('max-lines-per-function')
  })

  it('flags a function over the cyclomatic complexity threshold (T2)', async () => {
    const ruleIds = await errorRuleIdsFor(overComplexFunction(), 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('complexity')
  })

  /**
   * BLOCKER: every positive "flags ..." assertion in this file used a `.ts`
   * filePath — including both shadcn-glob tests below, whose whole subject is a
   * directory of `.tsx` components. Adding `'**\/*.tsx'` to eslint.config.js's
   * global `ignores` array — or `'src/routes/**\/*.tsx'`, or
   * `'src/components/**\/*.tsx'` — therefore exempted EVERY React component in
   * the repo with the whole suite green. Verified end to end: a genuine
   * complexity-15 violation planted at src/components/ThresholdProbe.tsx made
   * `eslint .` report `error ... complexity` / exit 1 at baseline, and under the
   * mutation `eslint .` exited 0 with all 19 tests still passing. The only `.tsx`
   * test was ADR 0001's NEGATIVE assertion, which an ignored file satisfies
   * vacuously — a negative can never notice that a file is not being linted.
   */
  it('flags an over-complex function at a real .tsx component path (T2 applies to components)', async () => {
    const messages = await messagesFor(overComplexFunction(), 'src/routes/ThresholdProbe.tsx')
    // An ignored path reports this warning and no rule messages at all, so the
    // ruleId assertion below already goes red — this one makes it say why.
    expect(messages.map((message) => message.message).join('\n')).not.toMatch(/File ignored/)
    const ruleIds = messages.filter((m) => m.severity === 2).map((m) => m.ruleId)
    expect(ruleIds).toContain('complexity')
  })

  it('flags a function with more than four parameters (T4)', async () => {
    const source =
      'export function tooMany(a: 1, b: 2, c: 3, d: 4, e: 5) {\n  return [a, b, c, d, e]\n}\n'
    const ruleIds = await errorRuleIdsFor(source, 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('max-params')
  })

  it('keeps T4 on in test files, where ADR 0002 leaves it on', async () => {
    const source =
      'export function tooMany(a: 1, b: 2, c: 3, d: 4, e: 5) {\n  return [a, b, c, d, e]\n}\n'
    const ruleIds = await errorRuleIdsFor(source, 'src/lib/example.test.ts')
    expect(ruleIds).toContain('max-params')
  })

  it('turns T1 off in test files (ADR 0002)', async () => {
    const ruleIds = await ruleIdsFor(oversizedFunction(), 'src/lib/example.test.ts')
    expect(ruleIds).not.toContain('max-lines-per-function')
  })

  it('flags a function over the cognitive complexity threshold (T3)', async () => {
    const ruleIds = await errorRuleIdsFor(deeplyNestedFunction(), 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('sonarjs/cognitive-complexity')
  })

  it('flags a file over 400 lines in src/lib (T5)', async () => {
    const ruleIds = await errorRuleIdsFor(oversizedFileSource(), 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('max-lines')
  })

  it('does NOT flag the same oversized file at src/lib/database.types.ts (generated)', async () => {
    const ruleIds = await ruleIdsFor(oversizedFileSource(), 'src/lib/database.types.ts')
    expect(ruleIds).not.toContain('max-lines')
  })

  it('does NOT flag an over-complex function in src/components/ui (vendored)', async () => {
    const ruleIds = await ruleIdsFor(overComplexFunction(), 'src/components/ui/threshold-probe.tsx')
    expect(ruleIds).not.toContain('complexity')
  })

  // ADR 0002: "T2 (cyclomatic complexity 10) ... stays on" in test files. Only the
  // T4 half of that clause had a test — turning `complexity` off for every test
  // file (adding it to OVERRIDE 2's rules alongside max-lines-per-function etc.)
  // left every other test in this file green. Verified directly.
  it('keeps T2 on in test files, where ADR 0002 leaves it on', async () => {
    const ruleIds = await errorRuleIdsFor(overComplexFunction(), 'src/lib/example.test.ts')
    expect(ruleIds).toContain('complexity')
  })
})

describe('the shadcn/ui override glob is scoped exactly to src/components/ui/**', () => {
  // Widening `files: ['src/components/ui/**']` to `src/components/**`, or adding
  // `src/routes/**`, exempts ~34 production components from T2-T5 with the whole
  // suite green — falsifying ADR 0001, which draws the override at the vendored
  // directory only. These assert a THRESHOLD VIOLATION at a real production path
  // outside that directory is still reported, so a widened glob goes red.
  //
  // Both use `.tsx`, not `.ts`: the components these globs decide the fate of are
  // React components, and a `.ts` probe cannot see a `.tsx`-shaped exemption
  // (a global `ignores` entry, or an override with a `.tsx` `files` glob) — see
  // the BLOCKER note on the .tsx test above.
  it('flags an over-complex function at a real src/routes path', async () => {
    const ruleIds = await errorRuleIdsFor(overComplexFunction(), 'src/routes/ThresholdProbe.tsx')
    expect(ruleIds).toContain('complexity')
  })

  it('flags an over-complex function at a real, non-ui src/components path', async () => {
    const ruleIds = await errorRuleIdsFor(
      overComplexFunction(),
      'src/components/board/ThresholdProbe.tsx',
    )
    expect(ruleIds).toContain('complexity')
  })
})

describe('the T1/T2/T3/T5 threshold NUMBERS, pinned against literals rather than each other', () => {
  // MINOR 10: T1 30->37, T2 10->13, T3 15->20, T5 400->404 each survived the
  // whole suite before these boundary pins — verified directly by widening all
  // four in eslint.config.js and re-running the pre-existing tests above, all of
  // which stayed green. Each pair below brackets the real threshold: AT the
  // limit passes, one unit past it fails, so a widened max moves the boundary
  // and one side of the pair goes red.

  it('T1: a 30-line function passes, a 31-line function is flagged', async () => {
    const bodyAt = (bodyLines) => {
      const body = Array.from({ length: bodyLines }, (_, i) => `  out.push(${i})`).join('\n')
      return `export function sized(out: number[]) {\n${body}\n  return out\n}\n`
    }
    // 1 declaration line + 27 body lines + 1 return + 1 close brace = 30.
    const atLimit = await errorRuleIdsFor(bodyAt(27), 'src/lib/threshold-probe.ts')
    expect(atLimit).not.toContain('max-lines-per-function')
    const overLimit = await errorRuleIdsFor(bodyAt(28), 'src/lib/threshold-probe.ts')
    expect(overLimit).toContain('max-lines-per-function')
  })

  it('T2: cyclomatic complexity of 10 passes, 11 is flagged', async () => {
    const branchyAt = (ifs) => {
      const branches = Array.from({ length: ifs }, (_, i) => `  if (n === ${i}) return ${i}`).join(
        '\n',
      )
      return `export function branchy(n: number) {\n${branches}\n  return -1\n}\n`
    }
    // 9 independent ifs -> complexity 10 (ifs + 1).
    const atLimit = await errorRuleIdsFor(branchyAt(9), 'src/lib/threshold-probe.ts')
    expect(atLimit).not.toContain('complexity')
    const overLimit = await errorRuleIdsFor(branchyAt(10), 'src/lib/threshold-probe.ts')
    expect(overLimit).toContain('complexity')
  })

  it('T3: cognitive complexity of 15 passes, 16 is flagged, reporting "the 15 allowed"', async () => {
    // depth-5 nesting (1+2+3+4+5 = 15) is at the limit; one sibling `if` at the
    // top level (nesting 0, cost 1) tips it to 16.
    const nestedAt = (extraSibling) => {
      const depth = 5
      let open = ''
      let close = ''
      for (let i = 0; i < depth; i += 1) {
        const indent = '  '.repeat(i + 1)
        open += `${indent}if (n === ${i}) {\n`
        close = `${indent}}\n${close}`
      }
      const innerIndent = '  '.repeat(depth + 1)
      const extra = extraSibling ? '  if (n === 99) { out = 2 }\n' : ''
      return `export function nested(n: number) {\n  let out = 0\n${open}${innerIndent}out = 1\n${close}${extra}  return out\n}\n`
    }
    const atLimitMessages = await messagesFor(nestedAt(false), 'src/lib/threshold-probe.ts')
    expect(atLimitMessages.some((m) => m.ruleId === 'sonarjs/cognitive-complexity')).toBe(false)

    const overLimitMessages = await messagesFor(nestedAt(true), 'src/lib/threshold-probe.ts')
    const overLimitError = overLimitMessages.find(
      (m) => m.ruleId === 'sonarjs/cognitive-complexity' && m.severity === 2,
    )
    expect(overLimitError).toBeDefined()
    expect(overLimitError.message).toMatch(/to the 15 allowed/)
  })

  it('T5: a 400-line file passes, a 401-line file is flagged', async () => {
    const fileAt = (n) => {
      const lines = Array.from({ length: n }, (_, i) => `export const v${i} = ${i}`)
      return `${lines.join('\n')}\n`
    }
    const atLimit = await errorRuleIdsFor(fileAt(400), 'src/lib/threshold-probe.ts')
    expect(atLimit).not.toContain('max-lines')
    const overLimit = await errorRuleIdsFor(fileAt(401), 'src/lib/threshold-probe.ts')
    expect(overLimit).toContain('max-lines')
  })
})

describe('package.json wiring (IMPORTANT 3: nothing pinned that verify runs the real lint)', () => {
  // scripts/check-duplication.test.mjs already pins verify's composition for
  // lint:duplication by exact `&&`-separated token, with a documented history of
  // two defeats a substring match missed. Applying the same technique here: the
  // "lint" step was previously entirely unpinned — a hand-assembled subset such as
  // `eslint --quiet .` (which silences warnings but not the errors this branch now
  // relies on for the demoted-rule case above) or a moved/renamed script could
  // replace it inside `verify` with every test in this file still green.
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))

  it('scripts.lint runs plain `eslint .`, with no flag that could weaken it', () => {
    expect(pkg.scripts.lint).toBe('eslint .')
  })

  // Exact token, not a substring — see scripts/check-duplication.test.mjs's
  // "package.json wiring" describe block for the two ways a substring match on
  // `verify` was defeated with the whole suite green.
  it('is invoked by verify as its own exact step', () => {
    const steps = pkg.scripts.verify.split('&&').map((step) => step.trim())
    expect(steps).toContain('npm run lint')
  })

  /**
   * IMPORTANT 3: the per-step pins — this file's `npm run lint`,
   * check-duplication.test.mjs's `npm run lint:duplication`, and
   * check-bundle.test.mjs's `node scripts/check-bundle.mjs` inside `build` —
   * cover 2 of verify's 5 steps between them. The other three were unpinned, and
   * the worst of the substitutions is silent: swapping `npm test` for
   * `npm run test:unit` left all 143 tests in this scoped suite green. CLAUDE.md
   * calls that one non-negotiable — `test:unit` excludes the seven integration
   * suites, so CI "would stay green while the 'RLS still holds' line went quietly
   * unmet on every future PR". `format:check` and `build` are the same shape:
   * dropping either leaves nothing red.
   *
   * An exact ordered list, not a set of `toContain`s: it refuses a substitution
   * (`npm test` -> `npm run test:unit`), a deletion, a reorder (`build` after
   * `test` would run the credential check after the suite that assumes it), and a
   * silently inserted step. Adding a real step to `verify` means updating this
   * list in the same commit — that is the point, not friction to work around.
   */
  it('verify runs exactly these five steps, in this order', () => {
    const steps = pkg.scripts.verify.split('&&').map((step) => step.trim())
    expect(steps).toEqual([
      'npm run lint',
      'npm run lint:duplication',
      'npm run format:check',
      'npm run build',
      'npm test',
    ])
  })

  it('scripts.test is the full vitest run, not the integration-excluding fast loop', () => {
    expect(pkg.scripts.test).toBe('vitest run')
  })
})
