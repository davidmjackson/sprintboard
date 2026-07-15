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

  it('mirrors the database projects_key_format constraint exactly', () => {
    // If this string drifts from the schema, the DB will reject keys the client
    // accepted (or vice-versa). Kept identical on purpose.
    expect(PROJECT_KEY_PATTERN.source).toBe('^[A-Z][A-Z0-9]{1,3}$')
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
