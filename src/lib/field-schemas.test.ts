import { describe, expect, it } from 'vitest'

import { CUSTOM_FIELD_TYPES } from './domain'
import { AddFieldSchema, RenameFieldSchema, AddOptionSchema, RenameOptionSchema } from './field-schemas'

describe('AddFieldSchema', () => {
  it('accepts a name and a type', () => {
    expect(AddFieldSchema.safeParse({ name: 'Customer ref', type: 'text' }).success).toBe(true)
  })

  it('trims, so surrounding space cannot smuggle a name past the length rule', () => {
    const parsed = AddFieldSchema.parse({ name: '  Customer ref  ', type: 'text' })
    expect(parsed.name).toBe('Customer ref')
  })

  // AC4, client edge. `project_fields_name_nonempty` is `btrim(name) <> ''`, so a
  // whitespace-only name is refused by the database too — this is the edge that can say why.
  it.each(['', '   ', '\t\n'])('rejects %o as empty after trimming', (name) => {
    expect(AddFieldSchema.safeParse({ name, type: 'text' }).success).toBe(false)
  })

  // 40 is `project_fields_name_nonempty`'s `length(name) <= 40`. Pinned AT the boundary: 40
  // passes, 41 fails. A one-sided test would not notice an off-by-one in either direction.
  it('accepts exactly 40 characters and rejects 41', () => {
    expect(AddFieldSchema.safeParse({ name: 'a'.repeat(40), type: 'text' }).success).toBe(true)
    expect(AddFieldSchema.safeParse({ name: 'a'.repeat(41), type: 'text' }).success).toBe(false)
  })

  it('rejects a type outside the five the check constraint allows', () => {
    expect(AddFieldSchema.safeParse({ name: 'Customer ref', type: 'checkbox' }).success).toBe(false)
  })

  // Read off the shared constant rather than re-listed: a sixth type added to
  // `CUSTOM_FIELD_TYPES` without the database's check agreeing would sail through a
  // hand-written list here, and this schema is what decides whether it is addable.
  it('accepts every type in CUSTOM_FIELD_TYPES', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      expect(AddFieldSchema.safeParse({ name: 'Customer ref', type }).success).toBe(true)
    }
  })

  /**
   * A name with no derivable slug has no legal `slug` to insert, so `createProjectField`
   * refuses it with the not-user-correctable `unknown` tag and the form would show generic
   * retry copy for something the user could trivially fix. Validation belongs at the edge
   * that can explain itself.
   */
  it('rejects a name with no derivable slug, ON THE NAME FIELD', () => {
    const result = AddFieldSchema.safeParse({ name: '!!!', type: 'text' })

    expect(result.success).toBe(false)
    // The path is what makes it a FIELD-level message rather than a form-level one — a
    // form-level issue renders as the same generic banner this rule exists to avoid.
    expect(result.error?.issues.map((i) => i.path)).toContainEqual(['name'])
    expect(result.error?.issues.map((i) => i.message).join(' ')).toMatch(/a–z or 0–9/)
  })

  /**
   * The names the rule ACTUALLY refuses, and why its wording names the character set.
   *
   * `slugForName` derives from ASCII `[a-z0-9]` alone, so a name in any other script has
   * nothing to derive from and is refused — while plainly consisting of letters. "Use at
   * least one letter or number" is simply untrue of `参照番号`, and tells the user nothing
   * they can act on. Same measured reasoning as `status-schemas.ts`, which is why this
   * message is worded the same way rather than softened.
   */
  it.each(['参照番号', 'Ссылка', 'ß'])('refuses %s, whose slug would be empty', (name) => {
    const result = AddFieldSchema.safeParse({ name, type: 'text' })

    expect(result.success).toBe(false)
    expect(result.error?.issues.map((i) => i.message).join(' ')).toMatch(/a–z or 0–9/)
  })

  // The mirror, and the one with teeth: `slugForName` PREFIXES a name whose slug would not
  // start with a letter rather than refusing it, so a leading digit is a legitimate field
  // name. Rejecting it here would re-create one layer up the defect that prefix removed.
  it('accepts a name that starts with a digit', () => {
    expect(AddFieldSchema.safeParse({ name: '2026 budget code', type: 'number' }).success).toBe(
      true,
    )
  })

  // Two fields may share a name — `project_fields` carries NO name-uniqueness constraint,
  // deliberately (AC2), so there is nothing for this schema to refuse and no `DUPLICATE_NAME`
  // sentence to import from `status-schemas`. Stated as a test because the absence is the
  // decision: copying the status form wholesale is what would break AC2.
  it('carries no uniqueness rule — the same name parses twice', () => {
    expect(AddFieldSchema.safeParse({ name: 'Customer ref', type: 'text' }).success).toBe(true)
    expect(AddFieldSchema.safeParse({ name: 'Customer ref', type: 'date' }).success).toBe(true)
  })
})

describe('RenameFieldSchema', () => {
  it('applies the same name rule', () => {
    expect(RenameFieldSchema.safeParse({ name: '' }).success).toBe(false)
    expect(RenameFieldSchema.safeParse({ name: '   ' }).success).toBe(false)
    expect(RenameFieldSchema.safeParse({ name: 'a'.repeat(41) }).success).toBe(false)
    expect(RenameFieldSchema.safeParse({ name: 'Customer reference' }).success).toBe(true)
  })

  // The rename form has no type control. Sending one must not be able to smuggle a type
  // change through a call site that only means to rename — and `type` is not even granted
  // as an UPDATE column, so it would be a 42501 rather than a silent success.
  it('does not carry a type through', () => {
    const parsed = RenameFieldSchema.parse({ name: 'Customer reference', type: 'date' })
    expect(parsed).toEqual({ name: 'Customer reference' })
  })

  // Deliberately NOT Add's slug rule. A rename never re-derives the slug — that is the whole
  // point of the name/slug division — so a name with no derivable slug is perfectly storable
  // on an existing row, and refusing it would be a constraint the database does not have.
  it('accepts a name with no derivable slug, because a rename never touches the slug', () => {
    expect(RenameFieldSchema.safeParse({ name: '!!!' }).success).toBe(true)
  })
})

describe('AddOptionSchema', () => {
  it('trims the label', () => {
    expect(AddOptionSchema.parse({ label: '  High  ' })).toEqual({ label: 'High' })
  })

  it('refuses an empty label', () => {
    const result = AddOptionSchema.safeParse({ label: '   ' })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Give the option a label')
  })

  it('refuses a label over 40 characters, matching pfo_label_nonempty', () => {
    const result = AddOptionSchema.safeParse({ label: 'x'.repeat(41) })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toBe('Keep the label to 40 characters or fewer')
  })

  it('refuses a label with no derivable slug, which Rename accepts', () => {
    expect(AddOptionSchema.safeParse({ label: '参照' }).success).toBe(false)
    expect(RenameOptionSchema.safeParse({ label: '参照' }).success).toBe(true)
  })
})
