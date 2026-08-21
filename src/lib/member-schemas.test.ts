import { describe, expect, it } from 'vitest'

import { AddMemberSchema } from './member-schemas'
import { PROJECT_ROLES } from './domain'

describe('AddMemberSchema', () => {
  it('accepts a registered-looking address and either role', () => {
    for (const role of PROJECT_ROLES) {
      expect(AddMemberSchema.safeParse({ email: 'ada@example.com', role }).success).toBe(true)
    }
  })

  it('refuses an empty address with the required message, not the format one', () => {
    const result = AddMemberSchema.safeParse({ email: '', role: 'member' })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Email is required')
  })

  it('refuses something that is not an address', () => {
    const result = AddMemberSchema.safeParse({ email: 'not-an-address', role: 'member' })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Enter a valid email address')
  })

  it('does NOT lowercase the address -- that decision belongs to the RPC alone', () => {
    // Case is the half that is a real DECISION: profiles_email_key is case-sensitive, and a
    // case-insensitive match could pick the wrong one of two rows. The RPC owns it so every
    // caller inherits one implementation.
    const result = AddMemberSchema.safeParse({ email: 'Ada@Example.COM', role: 'admin' })

    expect(result.success).toBe(true)
    expect(result.data?.email).toBe('Ada@Example.COM')
  })

  it('DOES trim, because trimming cannot disagree with the RPC', () => {
    // btrim of an already-trimmed string is the same string, so this is idempotent rather
    // than a second implementation of a rule. Without it, `.email()` rejects an address
    // pasted with a trailing space -- which is how addresses ordinarily arrive.
    const result = AddMemberSchema.safeParse({ email: '  ada@example.com  ', role: 'member' })

    expect(result.success).toBe(true)
    expect(result.data?.email).toBe('ada@example.com')
  })

  it('still refuses an address that is only whitespace', () => {
    expect(AddMemberSchema.safeParse({ email: '   ', role: 'member' }).success).toBe(false)
  })

  it('refuses a role outside the domain vocabulary', () => {
    expect(AddMemberSchema.safeParse({ email: 'ada@example.com', role: 'owner' }).success).toBe(
      false,
    )
  })

  it('accepts EVERY role the domain lists, so the picker and the schema cannot diverge', () => {
    // Derived from PROJECT_ROLES rather than spelled out: a third role added to the union
    // is accepted here automatically, which is the point of building the enum from it.
    // Hard-coding the pair would make this test pass while the new role was refused.
    for (const role of PROJECT_ROLES) {
      expect(AddMemberSchema.shape.role.safeParse(role).success).toBe(true)
    }
  })
})
