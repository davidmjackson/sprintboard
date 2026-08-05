import { describe, expect, it } from 'vitest'

import { STATUS_CATEGORIES } from './domain'
import { AddStatusSchema, RenameStatusSchema, WipLimitSchema } from './status-schemas'

describe('AddStatusSchema', () => {
  it('accepts a name and a category', () => {
    expect(
      AddStatusSchema.safeParse({ name: 'Ready for QA', category: 'in_progress' }).success,
    ).toBe(true)
  })

  it('trims, so surrounding space cannot smuggle a name past the length rule', () => {
    const parsed = AddStatusSchema.parse({ name: '  Ready  ', category: 'todo' })
    expect(parsed.name).toBe('Ready')
  })

  it('rejects a name that is empty after trimming', () => {
    expect(AddStatusSchema.safeParse({ name: '   ', category: 'todo' }).success).toBe(false)
  })

  // 40 is project_statuses_name_nonempty's `length(name) <= 40`. Pinned AT the boundary:
  // 40 passes, 41 fails. A one-sided test would not notice an off-by-one.
  it('accepts exactly 40 characters and rejects 41', () => {
    expect(AddStatusSchema.safeParse({ name: 'a'.repeat(40), category: 'todo' }).success).toBe(true)
    expect(AddStatusSchema.safeParse({ name: 'a'.repeat(41), category: 'todo' }).success).toBe(
      false,
    )
  })

  it('rejects a category outside the three the check constraint allows', () => {
    expect(AddStatusSchema.safeParse({ name: 'QA', category: 'blocked' }).success).toBe(false)
  })

  // The three the check constraint DOES allow, read off the shared constant rather than
  // re-listed: a fourth category added to `STATUS_CATEGORIES` without the database's check
  // agreeing would sail through a hand-written list here.
  it('accepts every category in STATUS_CATEGORIES', () => {
    for (const category of STATUS_CATEGORIES) {
      expect(AddStatusSchema.safeParse({ name: 'QA', category }).success).toBe(true)
    }
  })

  // A name with no alphanumeric character has no derivable slug, so the write would fail with
  // the not-user-correctable `unknown` tag and the form would show generic retry copy for a
  // name the user could trivially fix. Validation belongs at the edge that can explain itself.
  it('rejects a name with no derivable slug, ON THE NAME FIELD', () => {
    const result = AddStatusSchema.safeParse({ name: '!!!', category: 'todo' })

    expect(result.success).toBe(false)
    // The path is what makes it a FIELD-level message rather than a form-level one — a
    // form-level issue would render as the same generic banner this rule exists to avoid.
    expect(result.error?.issues.map((i) => i.path)).toContainEqual(['name'])
    expect(result.error?.issues.map((i) => i.message).join(' ')).toMatch(/a–z or 0–9/)
  })

  /**
   * The names the rule ACTUALLY refuses, and the reason its wording had to change.
   *
   * `slugForName` derives the slug from ASCII `[a-z0-9]` alone, so a name written in any other
   * script has nothing to derive from and is refused — while plainly consisting of letters. The
   * message used to read "Use at least one letter or number in the name", which is simply untrue
   * of `完了` and tells the user nothing they can act on. Making these names WORK is a scope
   * change (the slug rule is a database check constraint); saying what is required is not.
   */
  it.each(['完了', 'Проверка', 'ß'])('refuses %s, whose slug would be empty', (name) => {
    const result = AddStatusSchema.safeParse({ name, category: 'todo' })

    expect(result.success).toBe(false)
    // The copy names the character set, not "letters" — the whole point of the rewording.
    expect(result.error?.issues.map((i) => i.message).join(' ')).toMatch(/a–z or 0–9/)
  })

  // The mirror, and the one with teeth: a leading digit is a LEGITIMATE name that
  // `slugForName` now prefixes rather than refusing. Rejecting it here would re-create the
  // defect one layer up.
  it('accepts a name that starts with a digit', () => {
    expect(AddStatusSchema.safeParse({ name: '2026 Review', category: 'todo' }).success).toBe(true)
    expect(AddStatusSchema.safeParse({ name: '3rd Party Blocked', category: 'todo' }).success).toBe(
      true,
    )
  })
})

describe('RenameStatusSchema', () => {
  it('applies the same name rule', () => {
    expect(RenameStatusSchema.safeParse({ name: '' }).success).toBe(false)
    expect(RenameStatusSchema.safeParse({ name: 'In QA' }).success).toBe(true)
  })

  // The rename form has no category field. Sending one must not be able to smuggle a
  // category change through a call site that only means to rename.
  it('does not carry a category through', () => {
    const parsed = RenameStatusSchema.parse({ name: 'In QA', category: 'done' })
    expect(parsed).toEqual({ name: 'In QA' })
  })

  // Deliberately NOT Add's slug rule. A rename never re-derives the slug — that is the whole
  // point of the name/slug division — so a name with no derivable slug is perfectly storable
  // on an existing row. Copying Add's `.refine` here would refuse a rename the database
  // accepts and the foreign key never notices.
  it('accepts a name with no derivable slug, because a rename never touches the slug', () => {
    expect(RenameStatusSchema.safeParse({ name: '!!!' }).success).toBe(true)
  })
})

describe('WipLimitSchema', () => {
  /**
   * The client edge of validate-at-both-edges. The set this accepts is exactly the set the
   * database accepts — `project_statuses_wip_limit_positive` (`> 0`) plus the column's own
   * `int` type. Anything wider earns the user an error they cannot act on: a fractional
   * value is a 22P02 from the type, an out-of-range one a 22003.
   */
  it.each([
    ['', null],
    ['   ', null],
    ['1', 1],
    ['3', 3],
    ['007', 7],
    ['2147483647', 2147483647],
  ])('parses %o to %o', (input, expected) => {
    const result = WipLimitSchema.safeParse(input)
    expect(result.success).toBe(true)
    expect(result.data).toBe(expected)
  })

  // Trimming happens BEFORE the digit check, so surrounding whitespace cannot smuggle a
  // non-digit past the rule and cannot turn a valid number into a rejected one either.
  it('trims surrounding whitespace before parsing the digits', () => {
    const result = WipLimitSchema.safeParse('  5  ')
    expect(result.success).toBe(true)
    expect(result.data).toBe(5)
  })

  it('refuses 0 with a message that says what empty means', () => {
    const result = WipLimitSchema.safeParse('0')
    expect(result.success).toBe(false)
    expect(result.error!.issues[0]!.message).toBe(
      'A limit must be at least 1. Leave it empty for no limit.',
    )
  })

  it.each(['-1', '1.5', 'abc', '1e3', '+5'])('refuses %o as not a whole number', (input) => {
    const result = WipLimitSchema.safeParse(input)
    expect(result.success).toBe(false)
    expect(result.error!.issues[0]!.message).toBe(
      'Use a whole number, or leave it empty for no limit.',
    )
  })

  /**
   * The boundary, both sides. int4's ceiling is the column's own limit, not a product
   * decision — one past it is a 22003 the user cannot act on, so the schema refuses it
   * here where it can explain itself. The literal is deliberately absent from the copy:
   * 2147483647 is noise to a person.
   */
  it('refuses one past int4 max', () => {
    const result = WipLimitSchema.safeParse('2147483648')
    expect(result.success).toBe(false)
    expect(result.error!.issues[0]!.message).toBe('That limit is too large.')
  })

  // The three messages must be genuinely distinct, not two labels sharing one string — a
  // test that only checked "it failed" would pass even if all three collapsed into one.
  it('gives 0, -1 and one-past-int4-max three DIFFERENT messages', () => {
    const zero = WipLimitSchema.safeParse('0')
    const negative = WipLimitSchema.safeParse('-1')
    const tooLarge = WipLimitSchema.safeParse('2147483648')

    const messages = [zero, negative, tooLarge].map((r) => r.error!.issues[0]!.message)
    expect(new Set(messages).size).toBe(3)
  })
})
