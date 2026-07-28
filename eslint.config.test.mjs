import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

/**
 * A function well over T1's 30-line cap. Built from `push` calls rather than
 * `const` declarations so it trips `max-lines-per-function` and nothing else —
 * unused locals would drown the assertion in `no-unused-vars` noise.
 */
function oversizedFunction() {
  const body = Array.from({ length: 35 }, (_, i) => `  out.push(${i})`).join('\n')
  return `export function big(out: number[]) {\n${body}\n  return out\n}\n`
}

async function ruleIdsFor(source, filePath) {
  const eslint = new ESLint({ cwd: process.cwd() })
  const [result] = await eslint.lintText(source, { filePath })
  return result.messages.map((message) => message.ruleId)
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
    const ruleIds = await ruleIdsFor(oversizedFunction(), 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('max-lines-per-function')
  })

  it('does NOT flag the same function in a .tsx component (ADR 0001)', async () => {
    const ruleIds = await ruleIdsFor(oversizedFunction(), 'src/routes/ThresholdProbe.tsx')
    expect(ruleIds).not.toContain('max-lines-per-function')
  })

  it('flags a function over the cyclomatic complexity threshold (T2)', async () => {
    const branches = Array.from({ length: 14 }, (_, i) => `  if (n === ${i}) return ${i}`).join(
      '\n',
    )
    const source = `export function branchy(n: number) {\n${branches}\n  return -1\n}\n`
    const ruleIds = await ruleIdsFor(source, 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('complexity')
  })

  it('flags a function with more than four parameters (T4)', async () => {
    const source =
      'export function tooMany(a: 1, b: 2, c: 3, d: 4, e: 5) {\n  return [a, b, c, d, e]\n}\n'
    const ruleIds = await ruleIdsFor(source, 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('max-params')
  })

  it('keeps T4 on in test files, where ADR 0002 leaves it on', async () => {
    const source =
      'export function tooMany(a: 1, b: 2, c: 3, d: 4, e: 5) {\n  return [a, b, c, d, e]\n}\n'
    const ruleIds = await ruleIdsFor(source, 'src/lib/example.test.ts')
    expect(ruleIds).toContain('max-params')
  })

  it('turns T1 off in test files (ADR 0002)', async () => {
    const ruleIds = await ruleIdsFor(oversizedFunction(), 'src/lib/example.test.ts')
    expect(ruleIds).not.toContain('max-lines-per-function')
  })

  it('flags a function over the cognitive complexity threshold (T3)', async () => {
    const ruleIds = await ruleIdsFor(deeplyNestedFunction(), 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('sonarjs/cognitive-complexity')
  })

  it('flags a file over 400 lines in src/lib (T5)', async () => {
    const ruleIds = await ruleIdsFor(oversizedFileSource(), 'src/lib/threshold-probe.ts')
    expect(ruleIds).toContain('max-lines')
  })

  it('does NOT flag the same oversized file at src/lib/database.types.ts (generated)', async () => {
    const ruleIds = await ruleIdsFor(oversizedFileSource(), 'src/lib/database.types.ts')
    expect(ruleIds).not.toContain('max-lines')
  })

  it('does NOT flag an over-complex function in src/components/ui (vendored)', async () => {
    const branches = Array.from({ length: 14 }, (_, i) => `  if (n === ${i}) return ${i}`).join(
      '\n',
    )
    const source = `export function branchy(n: number) {\n${branches}\n  return -1\n}\n`
    const ruleIds = await ruleIdsFor(source, 'src/components/ui/threshold-probe.tsx')
    expect(ruleIds).not.toContain('complexity')
  })
})
