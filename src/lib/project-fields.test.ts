import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  countTicketsHoldingField,
  createProjectField,
  deleteProjectField,
  listProjectFields,
  renameProjectField,
} from './project-fields'
import type { ProjectField } from './domain'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// The five chains this module issues:
//
//   listProjectFields:        from().select().eq().order().order()
//   createProjectField:       from().insert().select().single()
//   renameProjectField:       from().update().eq().select().single()
//   deleteProjectField:       from().delete().eq().select()
//   countTicketsHoldingField: from().select().eq()          — on ticket_field_values
//
// Each chain gets its OWN link functions rather than sharing one `select`/`eq`. The chains
// diverge after the same method name — `.select()` returns `{ eq }` when it starts a read and
// `{ single }` when it terminates a write — so a shared mock could only return one of them,
// and a test asserting on it could not say which call it saw.
//
// TWO `.order()` links on the read, not one, and each gets its own mock so a test can say
// WHICH sort key it saw and in what order they were applied. Sharing one `order` mock would
// make `(created_at, slug)` and `(slug, created_at)` indistinguishable — and the second key is
// the tie-breaker that makes the sequence total, so losing it is precisely the defect worth
// catching.
const orderSlug = vi.fn()
const orderCreated = vi.fn(() => ({ order: orderSlug }))
const eq = vi.fn(() => ({ order: orderCreated }))
const select = vi.fn(() => ({ eq }))

const single = vi.fn()
const selectInsert = vi.fn(() => ({ single }))
const insert = vi.fn(() => ({ select: selectInsert }))
const selectUpdate = vi.fn(() => ({ single }))
const eqUpdate = vi.fn(() => ({ select: selectUpdate }))
const update = vi.fn(() => ({ eq: eqUpdate }))

function mockRows(data: unknown[] | null, error: { message: string } | null = null) {
  orderSlug.mockResolvedValue({ data, error })
}

function mockWrite(data: unknown, error: { code?: string; message?: string } | null = null) {
  single.mockResolvedValue({ data, error })
}

const ROWS = [
  {
    id: 'f1',
    project_id: 'p1',
    slug: 'customer_ref',
    name: 'Customer ref',
    type: 'text',
    created_at: '2026-08-05T10:00:00Z',
  },
  {
    id: 'f2',
    project_id: 'p1',
    slug: 'due',
    name: 'Due',
    type: 'date',
    created_at: '2026-08-05T11:00:00Z',
  },
]

beforeEach(() => {
  vi.mocked(supabase.from)
    .mockReset()
    .mockReturnValue({ select, insert, update } as never)
  select.mockClear()
  eq.mockClear()
  orderCreated.mockClear()
  orderSlug.mockClear()

  single.mockReset()
  selectInsert.mockClear()
  insert.mockClear()
  selectUpdate.mockClear()
  eqUpdate.mockClear()
  update.mockClear()
})

describe('listProjectFields', () => {
  it("reads the project's own field rows", async () => {
    mockRows(ROWS)

    await expect(listProjectFields('p1')).resolves.toEqual(ROWS)

    expect(supabase.from).toHaveBeenCalledWith('project_fields')
    expect(eq).toHaveBeenCalledWith('project_id', 'p1')
  })

  /**
   * The class-closing assertion, and the reason this module names its columns at all.
   *
   * `listProjectStatuses` uses a bare `.select()` and SPRIN-86 measured the consequence: as
   * the first reader of `wip_limit`, narrowing that select left the whole suite green while
   * the board rendered `· limit undefined`. `project-statuses.test.ts`'s mock is
   * argument-agnostic (`vi.fn(() => ({ eq }))`), so it cannot see a narrowing at all.
   *
   * Asserting the EXACT string, not a substring: a substring match (`expect.stringContaining
   * ('type')`) would survive dropping `created_at`, which is one of the two sort keys.
   */
  it('names every column it reads, so a silent narrowing goes red', async () => {
    mockRows(ROWS)

    await listProjectFields('p1')

    expect(select).toHaveBeenCalledWith('id, project_id, slug, name, type, created_at')
  })

  it('orders by created_at and breaks ties on slug, in that order', async () => {
    mockRows(ROWS)

    await listProjectFields('p1')

    expect(orderCreated).toHaveBeenCalledWith('created_at', { ascending: true })
    expect(orderSlug).toHaveBeenCalledWith('slug', { ascending: true })
  })

  it('throws rather than resolving to an empty list when the read fails', async () => {
    mockRows(null, { message: 'permission denied for table project_fields' })

    // `[]` is what a project with no custom fields legitimately returns, and that is the
    // COMMON case here — so a read that swallowed its error into `[]` would render "No custom
    // fields yet." over a failure, which is S4.6's defect on the surface most prone to it.
    await expect(listProjectFields('p1')).rejects.toThrow(/Could not load custom fields/)
  })

  it('resolves to an empty list when the project genuinely has none', async () => {
    mockRows([])

    await expect(listProjectFields('p1')).resolves.toEqual([])
  })

  /**
   * The narrowing in `ProjectField` is a CLAIM about what the database returns, and a bare
   * `as ProjectField` would make it a lie the moment the column holds a value the union does
   * not. That is reachable rather than hypothetical: widening the CHECK constraint is a
   * one-line migration, and a client compiled before it would meet the new value.
   */
  it('rejects a row whose type is not one this client understands', async () => {
    mockRows([{ ...ROWS[0], type: 'checkbox' }])

    await expect(listProjectFields('p1')).rejects.toThrow(/Unrecognised custom field type/)
  })

  it('accepts every type the domain declares', async () => {
    mockRows([
      { ...ROWS[0], slug: 'a', type: 'text' },
      { ...ROWS[0], slug: 'b', type: 'paragraph' },
      { ...ROWS[0], slug: 'c', type: 'number' },
      { ...ROWS[0], slug: 'd', type: 'date' },
      { ...ROWS[0], slug: 'e', type: 'select' },
    ])

    await expect(listProjectFields('p1')).resolves.toHaveLength(5)
  })
})

/**
 * The ONE unique constraint `project_fields` can raise a 23505 on, and the sentence Postgres
 * wraps it in. There is deliberately no name-uniqueness constraint on this table — AC2
 * requires two same-named fields to both succeed — so unlike `project_statuses` there is no
 * `'duplicate'` tag to reach and no user-correctable 23505 at all.
 */
const SLUG_UNIQUE = 'project_fields_project_slug_unique'

function uniqueViolation(constraint: string): string {
  return `duplicate key value violates unique constraint "${constraint}"`
}

/**
 * Deliberately a name whose slug is NOT its lowercasing: `'Customer ref'` derives
 * `customer_ref`, so a test that reads `slug` where it meant `name` (or the reverse) shows a
 * visible difference. A fixture like `{ name: 'Due', slug: 'due' }` makes the two columns
 * indistinguishable — this repo broke three tests that way in SPRIN-87, and AC2 and AC3 are
 * both ABOUT telling `name` and `slug` apart.
 */
const EXISTING = [
  { id: 'f1', project_id: 'p1', slug: 'customer_ref', name: 'Customer ref', type: 'text' },
] as unknown as ProjectField[]

const CREATED = {
  id: 'f2',
  project_id: 'p1',
  slug: 'customer_ref_2',
  name: 'Customer ref',
  type: 'text',
  created_at: '2026-08-06T10:00:00Z',
}

describe('createProjectField', () => {
  /**
   * AC2, first half. The slug is DERIVED from the name rather than typed, and the payload is
   * asserted EXACTLY rather than with `objectContaining`.
   *
   * The exactness is the security half: `authenticated` holds INSERT on
   * (project_id, slug, name, type) and nothing else, so an extra `created_at` or `id` is a
   * 42501 against the live database — somewhere a mocked-client unit test never goes.
   * `objectContaining` would pass with either of them present.
   */
  it('inserts exactly the four granted columns, with a slug derived from the name', async () => {
    mockWrite(CREATED)

    await createProjectField({ projectId: 'p1', name: 'Customer ref', type: 'text', existing: [] })

    expect(supabase.from).toHaveBeenCalledWith('project_fields')
    expect(insert).toHaveBeenCalledWith({
      project_id: 'p1',
      slug: 'customer_ref',
      name: 'Customer ref',
      type: 'text',
    })
  })

  /**
   * THE READ-BACK GUARD, ON THE WRITE PATH — added on a review finding.
   *
   * `FIELD_COLUMNS`'s docblock claimed "`project-fields.test.ts` asserts this exact string
   * reaches PostgREST, which is what makes a silent narrowing go red rather than ship." That
   * was true of ONE of its three call sites. Narrowing this write's `.select()` to `'id'`
   * survived the entire 1031-test suite, while the IDENTICAL narrowing on the read path killed
   * the read's own test — so the harness could see the class and simply was not pointed here.
   *
   * It is not cosmetic on a write. The returned row is what `ProjectShell` APPENDS to its
   * list: drop `created_at` and the new row carries an `undefined` sort key; drop `type` and
   * `toProjectField` throws, which on this path surfaces as an unhandled rejection and a form
   * that silently does nothing.
   */
  it('names every column it reads back after the insert', async () => {
    mockWrite(CREATED)

    await createProjectField({ projectId: 'p1', name: 'Ship by', type: 'date', existing: [] })

    expect(selectInsert).toHaveBeenCalledWith('id, project_id, slug, name, type, created_at')
  })

  /**
   * AC2, the half that distinguishes this table from `project_statuses`. Two fields may share
   * a NAME — there is no name-uniqueness constraint, deliberately — so the second add must
   * reach the database and must carry a DIFFERENT slug. A client that refused the duplicate
   * name, or that sent `customer_ref` twice, both fail this.
   */
  it('gives a second field of the SAME name a distinct slug', async () => {
    mockWrite(CREATED)

    const result = await createProjectField({
      projectId: 'p1',
      name: 'Customer ref',
      type: 'date',
      existing: EXISTING,
    })

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'customer_ref_2', name: 'Customer ref' }),
    )
    expect(result.ok).toBe(true)
  })

  it('sends the type it was given', async () => {
    mockWrite(CREATED)

    await createProjectField({
      projectId: 'p1',
      name: 'Renewal date',
      type: 'date',
      existing: EXISTING,
    })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ type: 'date' }))
  })

  // Trimming lives in `AddFieldSchema` too, but the schema binds the FORM and this function's
  // contract has to hold for every caller. A direct caller sending '  Customer ref  ' would
  // otherwise store a name whose surrounding space the database's `btrim(name) <> ''` check
  // tolerates — a stored name nobody chose, and one whose derived slug the trim also changes.
  it('trims the name it sends', async () => {
    mockWrite(CREATED)

    await createProjectField({
      projectId: 'p1',
      name: '  Customer ref  ',
      type: 'text',
      existing: [],
    })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ name: 'Customer ref' }))
  })

  // NO REQUEST AT ALL, not a request that fails. Sending a null slug would earn a check
  // violation naming `slug` — a column the user has never seen and cannot correct — and the
  // form would show generic retry copy for a name they could trivially fix.
  it('fails WITHOUT a request when the name yields no legal slug', async () => {
    const result = await createProjectField({
      projectId: 'p1',
      name: '!!!',
      type: 'text',
      existing: [],
    })

    expect(result).toEqual({ ok: false, error: 'unknown' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  // A name starting with a digit is legitimate and must REACH the database rather than be
  // refused client-side: `slugForName` prefixes it rather than returning null.
  it('sends a request for a name that starts with a digit', async () => {
    mockWrite(CREATED)

    await createProjectField({
      projectId: 'p1',
      name: '2026 budget code',
      type: 'number',
      existing: [],
    })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ slug: 's_2026_budget_code' }))
  })

  it('returns the database row on success', async () => {
    mockWrite(CREATED)

    await expect(
      createProjectField({ projectId: 'p1', name: 'Customer ref', type: 'text', existing: [] }),
    ).resolves.toEqual({ ok: true, value: CREATED })
  })

  /**
   * The row comes back through `toProjectField`, not a bare `as ProjectField`. The narrowing
   * from the column's `string` to `CustomFieldType` is a CLAIM about what the database
   * returned, and a cast would make it a lie the moment a widened CHECK constraint let a
   * sixth type through. Unreachable on this path today — the type inserted came from the
   * union — so it is a schema-drift assertion rather than a user-facing outcome, which is
   * why it THROWS rather than collapsing into the `'unknown'` tag and its retry copy.
   */
  it('rejects a returned row whose type is not one this client understands', async () => {
    mockWrite({ ...CREATED, type: 'checkbox' })

    await expect(
      createProjectField({ projectId: 'p1', name: 'Customer ref', type: 'text', existing: [] }),
    ).rejects.toThrow(/Unrecognised custom field type/)
  })

  /**
   * THE tag that is not `'duplicate'`, and the reason copying `StatusSettings` wholesale
   * would put a false sentence on screen.
   *
   * `project_fields` has no name-uniqueness constraint, so a 23505 here can only mean the
   * client's `existing` list was older than the database's and the slug it derived was not
   * collision-free after all. Retrying the same submit reproduces it forever; reloading is
   * the only remedy — which is exactly what `'stale'` means everywhere else in this codebase.
   */
  it('maps a slug collision to stale, because the list was old — not to duplicate', async () => {
    mockWrite(null, { code: '23505', message: uniqueViolation(SLUG_UNIQUE) })

    await expect(
      createProjectField({ projectId: 'p1', name: 'Customer ref', type: 'text', existing: [] }),
    ).resolves.toEqual({ ok: false, error: 'stale' })
  })

  // An ALLOW-LIST on the constraint name, not "any 23505 is stale". A constraint added by a
  // later story collapses to the generic retry copy rather than to a confident sentence
  // telling the user to reload for something a reload will not fix.
  it('maps a 23505 from an unrecognised constraint to unknown', async () => {
    mockWrite(null, { code: '23505', message: uniqueViolation('project_fields_something_else') })

    await expect(
      createProjectField({ projectId: 'p1', name: 'Customer ref', type: 'text', existing: [] }),
    ).resolves.toEqual({ ok: false, error: 'unknown' })
  })

  /**
   * The SQLSTATE gate, pinned separately from the message gate. The test above supplies a
   * message with no known constraint in it, so it reaches `'unknown'` whether or not the code
   * is consulted — it pins "any other MESSAGE", not "any other ERROR". This is the one input
   * that can tell them apart: a known constraint name carried by a NON-unique SQLSTATE.
   * Nothing produces that shape today; it is a probe for the gate, not a scenario.
   */
  it('consults the SQLSTATE, not just the message: the slug constraint under 23514 is unknown', async () => {
    mockWrite(null, { code: '23514', message: uniqueViolation(SLUG_UNIQUE) })

    await expect(
      createProjectField({ projectId: 'p1', name: 'Customer ref', type: 'text', existing: [] }),
    ).resolves.toEqual({ ok: false, error: 'unknown' })
  })

  // 42501 is what a wrongly-shaped payload earns — an ungranted column, or the RLS insert
  // policy refusing another tenant's project_id. Neither is user-correctable, so both get the
  // generic tag rather than a sentence about a name or a reload.
  it('maps a permission refusal to unknown', async () => {
    mockWrite(null, { code: '42501', message: 'permission denied for table project_fields' })

    await expect(
      createProjectField({ projectId: 'p1', name: 'Customer ref', type: 'text', existing: [] }),
    ).resolves.toEqual({ ok: false, error: 'unknown' })
  })
})

describe('renameProjectField', () => {
  const RENAMED = { ...CREATED, slug: 'customer_ref', name: 'Customer reference' }

  /**
   * AC3, at this layer: the payload is asserted EXACTLY, so `name` is provably the only key
   * sent. That is a security property rather than tidiness — `authenticated` holds UPDATE on
   * `name` alone, so a patch carrying `slug` is refused by Postgres with a 42501 before any
   * policy is consulted, and `satisfies ProjectFieldUpdate` is what makes the wrong write a
   * compile error instead of a live-database-only failure. `objectContaining` would pass with
   * `slug` present, which is the whole defect.
   */
  it('updates ONLY name — the slug is story 5s identity and is not client-writable', async () => {
    mockWrite(RENAMED)

    await renameProjectField('f1', 'Customer reference')

    expect(supabase.from).toHaveBeenCalledWith('project_fields')
    expect(update).toHaveBeenCalledWith({ name: 'Customer reference' })
    expect(eqUpdate).toHaveBeenCalledWith('id', 'f1')
  })

  it('returns the database row on success, with its slug untouched', async () => {
    mockWrite(RENAMED)

    await expect(renameProjectField('f1', 'Customer reference')).resolves.toEqual({
      ok: true,
      value: RENAMED,
    })
  })

  // The rename half of the read-back guard — see `createProjectField`'s equivalent for why
  // narrowing this survived the whole suite while the same narrowing on the read went red.
  it('names every column it reads back after the rename', async () => {
    mockWrite(RENAMED)

    await renameProjectField('f1', 'Target ship date')

    expect(selectUpdate).toHaveBeenCalledWith('id, project_id, slug, name, type, created_at')
  })

  // Same reasoning as createProjectField's trim: the schema binds the form, this function's
  // contract binds every caller.
  it('trims the name it sends', async () => {
    mockWrite(RENAMED)

    await renameProjectField('f1', '  Customer reference  ')

    expect(update).toHaveBeenCalledWith({ name: 'Customer reference' })
  })

  // Shares `writeError` with the insert, and a shared mapping exercised through only one call
  // site is a mapping nobody has checked on the other. A rename cannot realistically collide
  // on the slug — it does not send one — but the branch is reachable and must not be silently
  // dead.
  it('maps a slug collision to stale here too', async () => {
    mockWrite(null, { code: '23505', message: uniqueViolation(SLUG_UNIQUE) })

    await expect(renameProjectField('f1', 'Customer reference')).resolves.toEqual({
      ok: false,
      error: 'stale',
    })
  })

  it('maps any other error to unknown', async () => {
    mockWrite(null, { code: '42501', message: 'permission denied for column slug' })

    await expect(renameProjectField('f1', 'Customer reference')).resolves.toEqual({
      ok: false,
      error: 'unknown',
    })
  })

  /**
   * `.single()` on a row RLS filtered away errors rather than returning `data: null,
   * error: null`, so a rename of another tenant's field — or one another tab deleted — comes
   * back as a refusal rather than a silent no-op. Pinned because the guarantee is INCIDENTAL
   * (it comes from `.single()`, not from a row-count check), and a later author dropping
   * `.single()` for `.select()` alone would turn a zero-row write into `{ ok: true }`.
   */
  it('reports a write that matched no row as a failure, not a success', async () => {
    mockWrite(null, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows' })

    await expect(renameProjectField('f1', 'Customer reference')).resolves.toEqual({
      ok: false,
      error: 'unknown',
    })
  })
})

// The delete chain gets its OWN link functions, for the reason the header comment states: this
// `.eq()` terminates in a bare `.select('id')` rather than in `.order()` or `.select().single()`,
// so a mock shared with either other chain could only ever return one of those shapes and a test
// asserting on it could not say which call it saw. Mirrors `project-field-options.test.ts`.
const delSelect = vi.fn()
const delEq = vi.fn(() => ({ select: delSelect }))
const del = vi.fn(() => ({ eq: delEq }))

describe('deleteProjectField', () => {
  beforeEach(() => {
    delSelect.mockReset()
    delEq.mockClear()
    del.mockClear()
    vi.mocked(supabase.from).mockReturnValue({ delete: del } as never)
  })

  it('filters on the field id and asks for the deleted rows back', async () => {
    delSelect.mockResolvedValue({ data: [{ id: 'f1' }], error: null })

    await deleteProjectField('f1')

    expect(supabase.from).toHaveBeenCalledWith('project_fields')
    expect(delEq).toHaveBeenCalledWith('id', 'f1')
    // The returned rows are what makes the zero-row check possible at all.
    expect(delSelect).toHaveBeenCalledWith('id')
  })

  /**
   * RLS FILTERS a delete rather than raising on it, so another tenant's row — or one another tab
   * already removed — comes back as `error: null` with NO rows. Without the explicit count this
   * resolves `{ ok: true }` and the UI removes a row the database still holds.
   */
  it('reports a zero-row delete as stale rather than as success', async () => {
    delSelect.mockResolvedValue({ data: [], error: null })

    await expect(deleteProjectField('f1')).resolves.toEqual({ ok: false, error: 'stale' })
  })

  // A `null` data with no error is the same fact as an empty array here, and `?? []` is the only
  // thing standing between it and a `TypeError` on `.length`.
  it('reports a null row set as stale too', async () => {
    delSelect.mockResolvedValue({ data: null, error: null })

    await expect(deleteProjectField('f1')).resolves.toEqual({ ok: false, error: 'stale' })
  })

  it('reports a query failure as unknown', async () => {
    delSelect.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } })

    await expect(deleteProjectField('f1')).resolves.toEqual({ ok: false, error: 'unknown' })
  })

  it('resolves ok when exactly one row was removed', async () => {
    delSelect.mockResolvedValue({ data: [{ id: 'f1' }], error: null })

    await expect(deleteProjectField('f1')).resolves.toEqual({ ok: true, value: undefined })
  })
})

// The count chain gets its OWN link functions: it reads `ticket_field_values`, not
// `project_fields`, and terminates in a head-count response rather than in rows.
const countEq = vi.fn()
const countSelect = vi.fn(() => ({ eq: countEq }))

describe('countTicketsHoldingField', () => {
  beforeEach(() => {
    countEq.mockReset()
    countSelect.mockClear()
    vi.mocked(supabase.from).mockReturnValue({ select: countSelect } as never)
  })

  it('counts value rows for the field without fetching them', async () => {
    countEq.mockResolvedValue({ count: 3, error: null })

    await expect(countTicketsHoldingField('f1')).resolves.toBe(3)

    expect(supabase.from).toHaveBeenCalledWith('ticket_field_values')
    // `head: true` is what keeps this a COUNT rather than a full read of every value row.
    expect(countSelect).toHaveBeenCalledWith('*', { head: true, count: 'exact' })
    expect(countEq).toHaveBeenCalledWith('field_id', 'f1')
  })

  /**
   * AC4. Zero is the value that UNLOCKS a destructive delete, so a failed count reported as zero
   * would offer a delete whose blast radius the user was told was nil.
   */
  it('THROWS on a failed read rather than resolving to zero', async () => {
    countEq.mockResolvedValue({ count: null, error: { message: 'boom' } })

    await expect(countTicketsHoldingField('f1')).rejects.toThrow(
      'Could not count tickets holding that field: boom',
    )
  })

  /**
   * PostgREST can answer without a count header. `count: null` with `error: null` would otherwise
   * flow into the component as a number and land as `0` — the one value that unlocks the delete.
   */
  it('THROWS on a MISSING count, which is not the same as a failed read', async () => {
    countEq.mockResolvedValue({ count: null, error: null })

    await expect(countTicketsHoldingField('f1')).rejects.toThrow(
      'Could not count tickets holding that field: no count',
    )
  })

  // Zero is a legitimate answer and must survive the two guards above intact — the positive
  // control for them. A guard written as `if (!count)` passes both tests above and fails this one.
  it('resolves to zero when no ticket holds a value for the field', async () => {
    countEq.mockResolvedValue({ count: 0, error: null })

    await expect(countTicketsHoldingField('f1')).resolves.toBe(0)
  })
})
