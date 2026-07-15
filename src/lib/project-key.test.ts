import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { deriveProjectKey, isValidProjectKey, PROJECT_KEY_PATTERN } from './project-key'

describe('isValidProjectKey', () => {
  it.each(['SP', 'SPR', 'A1', 'AB12', 'Z9Z9'])('accepts %s', (k) => {
    expect(isValidProjectKey(k)).toBe(true)
  })

  it.each([
    ['A', 'too short (1 char)'],
    ['ABCDE', 'too long (5 chars)'],
    ['sp', 'lowercase'],
    ['1AB', 'starts with a digit'],
    ['A-B', 'non-alphanumeric'],
    ['', 'empty'],
  ])('rejects %s (%s)', (k) => {
    expect(isValidProjectKey(k)).toBe(false)
  })

  it('mirrors the live database projects_key_format constraint', () => {
    // Read the actual DDL, not a copy of the string — a hardcoded literal here would
    // stay green while a widened `projects_key_format` (e.g. for Rung 3) let the DB
    // and client diverge. This is the same drift guard domain.test.ts applies to the
    // check-constraint enums. (domain.test.ts also fails on any appended ALTER TABLE,
    // which would otherwise let the create-table regex read here go stale.)
    const schemaPath = join(
      import.meta.dirname,
      '..',
      '..',
      'docs',
      'sprintboard_phase1_schema.sql',
    )
    const schema = readFileSync(schemaPath, 'utf8')
    const match = /projects_key_format check \(key ~ '([^']*)'\)/.exec(schema)
    expect(match?.[1], 'projects_key_format check constraint not found in schema').toBeDefined()
    expect(PROJECT_KEY_PATTERN.source).toBe(match![1])
  })
})

describe('deriveProjectKey', () => {
  it('takes the first characters of a single-word name', () => {
    expect(deriveProjectKey('Sprintboard')).toBe('SPR')
  })

  it('takes the initials of a multi-word name', () => {
    expect(deriveProjectKey('My Cool Project')).toBe('MCP')
  })

  it('ignores punctuation and extra whitespace when splitting words', () => {
    expect(deriveProjectKey('  the-quick brown ')).toBe('TQB')
  })

  it('strips a leading digit so the key starts with a letter', () => {
    expect(deriveProjectKey('project x2')).toBe('PX')
  })

  it('keeps the letters of a digit-led single word rather than dropping them', () => {
    expect(deriveProjectKey('0123abc')).toBe('ABC')
  })

  it('caps initials at four characters', () => {
    expect(deriveProjectKey('one two three four five')).toBe('OTTF')
  })

  it('returns empty for a name with no alphanumerics', () => {
    expect(deriveProjectKey('  —  ')).toBe('')
  })

  it('suggests a valid key for a normal name', () => {
    expect(isValidProjectKey(deriveProjectKey('Sprintboard'))).toBe(true)
    expect(isValidProjectKey(deriveProjectKey('My Cool Project'))).toBe(true)
  })
})
