import { describe, expect, it } from 'vitest'

import { SignupSchema, LoginSchema } from './auth-schemas'

describe('SignupSchema', () => {
  const valid = { email: 'a@example.com', password: 'password123', displayName: 'Ada' }

  it('accepts a well-formed signup', () => {
    expect(SignupSchema.safeParse(valid).success).toBe(true)
  })

  it('treats display name as optional (blank is fine, defaults to email downstream)', () => {
    expect(SignupSchema.safeParse({ ...valid, displayName: undefined }).success).toBe(true)
  })

  it('rejects an invalid email', () => {
    expect(SignupSchema.safeParse({ ...valid, email: 'notanemail' }).success).toBe(false)
  })

  it('rejects a password shorter than 8', () => {
    expect(SignupSchema.safeParse({ ...valid, password: 'short' }).success).toBe(false)
  })

  it('rejects a display name longer than 80 characters', () => {
    const result = SignupSchema.safeParse({ ...valid, displayName: 'x'.repeat(81) })
    expect(result.success).toBe(false)
    // The rule itself, not merely "some failure" — a regression loosening the cap must bite.
    expect(SignupSchema.safeParse({ ...valid, displayName: 'x'.repeat(80) }).success).toBe(true)
  })
})

describe('LoginSchema', () => {
  it('accepts any non-empty password (length is not re-checked at login)', () => {
    expect(LoginSchema.safeParse({ email: 'a@example.com', password: 'x' }).success).toBe(true)
  })

  it('rejects an empty password', () => {
    expect(LoginSchema.safeParse({ email: 'a@example.com', password: '' }).success).toBe(false)
  })
})
