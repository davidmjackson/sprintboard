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
})
