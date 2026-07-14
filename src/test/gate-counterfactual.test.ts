import { describe, expect, it } from 'vitest'

/**
 * Deliberately failing. Exists for exactly one push, to prove that a red `verify`
 * check blocks the merge button rather than merely colouring it red. Reverted in
 * the next commit — see docs/superpowers/plans/2026-07-14-s1.5-ci-pipeline.md.
 */
describe('the CI gate', () => {
  it('blocks a merge when a test fails', () => {
    expect('this test must fail').toBe('and the merge must be blocked')
  })
})
