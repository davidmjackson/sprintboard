import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createProjectStatus,
  deleteBlockReason,
  deleteProjectStatus,
  doneSlugs,
  initialSlug,
  listProjectStatuses,
  removeStatus,
  renameProjectStatus,
  reorderProjectStatuses,
  slugForName,
  statusName,
  statusOptions,
  ticketCountsByStatus,
  uniqueSlugForName,
} from './project-statuses'
import type { ProjectStatus } from './domain'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))

// Each PostgREST chain gets its OWN link functions rather than sharing one `select`/`eq`.
// The chains diverge after the same method name — `.select()` returns `{ eq }` when it
// starts a read and `{ single }` when it terminates a write — so a shared mock could only
// return one of them, and a test asserting on it could not say which call it saw.
//
//   listProjectStatuses:   from().select().eq().order()
//   createProjectStatus:   from().insert().select().single()
//   renameProjectStatus:   from().update().eq().select().single()
//   deleteProjectStatus:   from().delete().eq().select()
//   ticketCountsByStatus:  from().select().eq().eq()   (on the 'tickets' table, not this one)
const order = vi.fn()
const eq = vi.fn(() => ({ order }))
const select = vi.fn(() => ({ eq }))

const single = vi.fn()
const selectInsert = vi.fn(() => ({ single }))
const insert = vi.fn(() => ({ select: selectInsert }))
const selectUpdate = vi.fn(() => ({ single }))
const eqUpdate = vi.fn(() => ({ select: selectUpdate }))
const update = vi.fn(() => ({ eq: eqUpdate }))

const selectDelete = vi.fn()
const eqDelete = vi.fn(() => ({ select: selectDelete }))
const del = vi.fn(() => ({ eq: eqDelete }))

// ticketCountsByStatus queries 'tickets', a different table from every other function in this
// module, so supabase.from() dispatches on the table name rather than returning one fixed chain.
const eqStatus = vi.fn()
const eqProject = vi.fn(() => ({ eq: eqStatus }))
const selectCount = vi.fn(() => ({ eq: eqProject }))

beforeEach(() => {
  order.mockReset()
  eq.mockReset()
  eq.mockReturnValue({ order })
  select.mockReset()
  select.mockReturnValue({ eq })

  single.mockReset()
  selectInsert.mockReset()
  selectInsert.mockReturnValue({ single })
  insert.mockReset()
  insert.mockReturnValue({ select: selectInsert })
  selectUpdate.mockReset()
  selectUpdate.mockReturnValue({ single })
  eqUpdate.mockReset()
  eqUpdate.mockReturnValue({ select: selectUpdate })
  update.mockReset()
  update.mockReturnValue({ eq: eqUpdate })

  selectDelete.mockReset()
  eqDelete.mockReset()
  eqDelete.mockReturnValue({ select: selectDelete })
  del.mockReset()
  del.mockReturnValue({ eq: eqDelete })

  eqStatus.mockReset()
  eqProject.mockReset()
  eqProject.mockReturnValue({ eq: eqStatus })
  selectCount.mockReset()
  selectCount.mockReturnValue({ eq: eqProject })

  vi.mocked(supabase.from).mockReset()
  vi.mocked(supabase.from).mockImplementation(
    (table: string) =>
      (table === 'tickets'
        ? { select: selectCount }
        : { select, insert, update, delete: del }) as never,
  )
  vi.mocked(supabase.rpc).mockReset()
})

/**
 * The three unique constraints `project_statuses` can raise a 23505 on, and the sentence
 * Postgres wraps them in. MEASURED against the live database on 2026-08-01 by provoking each
 * one in turn: the code is `23505`, `details` and `hint` are both null, and the constraint
 * name appears ONLY inside `message`. That is why the client parses `message` — there is no
 * other channel — and it is pinned live in `rls.integration.test.ts` so the sentence cannot
 * rot underneath this mapping.
 */
const NAME = 'project_statuses_project_name_unique'
const SLUG = 'project_statuses_project_slug_unique'
const POSITION = 'project_statuses_project_position_unique'

function uniqueViolation(constraint: string): string {
  return `duplicate key value violates unique constraint "${constraint}"`
}

/** Deliberately NOT in position order, and NOT the seeded four: a fixture that already
 *  looks like the answer cannot prove the code produced it. */
const ROWS = [
  { slug: 'shipped', name: 'Shipped', category: 'done', position: 3 },
  { slug: 'triage', name: 'Triage', category: 'todo', position: 1 },
] as unknown as ProjectStatus[]

describe('listProjectStatuses', () => {
  it('reads this project only, ordered by position ascending', async () => {
    order.mockResolvedValue({ data: ROWS, error: null })

    await expect(listProjectStatuses('p1')).resolves.toEqual(ROWS)

    expect(supabase.from).toHaveBeenCalledWith('project_statuses')
    expect(eq).toHaveBeenCalledWith('project_id', 'p1')
    expect(order).toHaveBeenCalledWith('position', { ascending: true })
  })

  it('THROWS on error rather than resolving to [] — [] would read as "no statuses"', async () => {
    order.mockResolvedValue({ data: null, error: { message: 'boom' } })

    await expect(listProjectStatuses('p1')).rejects.toThrow(/Could not load statuses/)
  })
})

describe('statusName', () => {
  it('returns the row name for a known slug', () => {
    expect(statusName(ROWS, 'triage')).toBe('Triage')
  })

  // AC4. The fallback is the slug itself: never empty, never undefined, always identifying.
  it('falls back to the slug itself for a status it has never seen', () => {
    expect(statusName(ROWS, 'mystery')).toBe('mystery')
  })

  it('falls back when the list is empty, rather than throwing', () => {
    expect(statusName([], 'triage')).toBe('triage')
  })
})

describe('statusOptions', () => {
  it('maps the rows in the order given, without resorting them', () => {
    expect(statusOptions(ROWS, 'triage')).toEqual([
      { slug: 'shipped', name: 'Shipped' },
      { slug: 'triage', name: 'Triage' },
    ])
  })

  // A <select> whose value matches no <option> renders BLANK, and the next change event
  // would move the ticket somewhere the user never chose.
  it('appends the current status when it is not in the list, so the select stays controlled', () => {
    expect(statusOptions(ROWS, 'mystery')).toEqual([
      { slug: 'shipped', name: 'Shipped' },
      { slug: 'triage', name: 'Triage' },
      { slug: 'mystery', name: 'mystery' },
    ])
  })

  it('does not duplicate the current status when it IS in the list', () => {
    expect(statusOptions(ROWS, 'shipped')).toHaveLength(2)
  })
})

describe('slugForName', () => {
  it('lowercases and joins words with underscores', () => {
    expect(slugForName('Ready For QA')).toBe('ready_for_qa')
  })

  it('collapses runs of punctuation and strips the edges', () => {
    expect(slugForName('  Ready -- for  QA!! ')).toBe('ready_for_qa')
  })

  it('truncates to the 30 characters the slug_format check allows', () => {
    // The DB check is ^[a-z][a-z0-9_]{0,29}$ — 30 characters total.
    const slug = slugForName('a'.repeat(50))
    expect(slug).toHaveLength(30)
  })

  // Truncation must not leave a trailing underscore-run that the strip would have removed.
  it('does not end in an underscore after truncating', () => {
    expect(slugForName('abcdefghijklmnopqrstuvwxyzabc def')).not.toMatch(/_$/)
  })

  // "2026 Review" and "3rd Party Blocked" are entirely plausible status names, and the DB's
  // slug_format check wants a leading letter. The slug is machine identity and is NEVER shown
  // to a user, so a prefix costs nothing while rejecting the name costs a legitimate one.
  it('prefixes s_ when the derived slug would not start with a letter', () => {
    expect(slugForName('2026 Review')).toBe('s_2026_review')
    expect(slugForName('3rd Party Blocked')).toBe('s_3rd_party_blocked')
  })

  // The prefix must fit INSIDE the 30 the check allows, not push the slug past it.
  it('keeps the s_ prefix inside the 30-character limit', () => {
    const slug = slugForName(`9${'a'.repeat(50)}`)
    expect(slug).toHaveLength(30)
    expect(slug).toMatch(/^s_9a+$/)
  })

  // null is now reserved for the ONE case a prefix cannot rescue: nothing to prefix.
  it('returns null only when the name has no alphanumeric character at all', () => {
    expect(slugForName('!!!')).toBeNull()
    expect(slugForName('   ')).toBeNull()
    expect(slugForName('')).toBeNull()
  })

  /**
   * The characters that would break `completeSprint`'s filter, pinned by name.
   *
   * `src/lib/sprints.ts` builds a PostgREST filter by string-joining slugs into
   * `.not('status','in','(a,b)')`, and its docblock says that is safe BECAUSE slugs cannot
   * contain a comma, paren or quote. The database's `project_statuses_slug_format` check is the
   * real control and is pinned live — but this module mirrors that rule client-side, and the
   * mirror was free to drift: widening BOTH gates here to admit a comma left all 765 unit tests
   * green, with `slugForName('a,b')` returning `'a,b'` — the exact separator that filter uses.
   *
   * The cases above use `!`, `-`, spaces and digits, none of which is a separator. This asserts
   * the dangerous characters specifically, so the mirror cannot drift silently. On drift the
   * database still refuses the write, but with a 23514 — which is not a 23505, so `writeError`
   * returns `'unknown'` and the user gets generic retry copy for a name they could trivially fix.
   */
  it.each([',', ')', '(', "'", '"', '\\'])(
    'never emits %j, which would break the sprint-completion filter',
    (char) => {
      expect(slugForName(`qa${char}b`)).toBe('qa_b')
      expect(slugForName(`${char}${char}qa`)).toBe('qa')
    },
  )
})

describe('uniqueSlugForName', () => {
  it('returns the plain slug when nothing has taken it', () => {
    expect(uniqueSlugForName('To Do', ['done'])).toBe('to_do')
  })

  // Two DIFFERENT names can derive to ONE slug ("To Do" / "To-Do"), and the
  // duplicate-NAME index does not catch that — these are different names.
  it('suffixes until free when a different name already took the slug', () => {
    expect(uniqueSlugForName('To-Do', ['to_do'])).toBe('to_do_2')
    expect(uniqueSlugForName('To-Do', ['to_do', 'to_do_2'])).toBe('to_do_3')
  })

  it('keeps the suffixed slug inside the 30-character limit', () => {
    const taken = ['a'.repeat(30)]
    const slug = uniqueSlugForName('a'.repeat(50), taken)
    expect(slug!.length).toBeLessThanOrEqual(30)
  })

  // The prefixed slug is a real slug like any other, so it collides and suffixes like one.
  it('suffixes a prefixed slug too when it is already taken', () => {
    expect(uniqueSlugForName('2026 Review', ['s_2026_review'])).toBe('s_2026_review_2')
  })

  it('returns null when the name has no derivable slug at all', () => {
    expect(uniqueSlugForName('!!!', [])).toBeNull()
  })
})

describe('doneSlugs', () => {
  it('selects exactly the rows whose category is done, by slug', () => {
    const rows = [
      { slug: 'triage', category: 'todo' },
      { slug: 'shipped', category: 'done' },
      { slug: 'live', category: 'done' },
    ] as unknown as ProjectStatus[]
    expect(doneSlugs(rows)).toEqual(new Set(['shipped', 'live']))
  })

  // The empty set is a REAL state, not an error: a project with nothing terminal has
  // nothing complete, so every ticket is incomplete. sprints.ts depends on this.
  it('returns an empty set when no status is terminal', () => {
    const rows = [{ slug: 'triage', category: 'todo' }] as unknown as ProjectStatus[]
    expect(doneSlugs(rows).size).toBe(0)
  })

  // The slug 'done' is NOT what makes a status terminal — the category is. A renamed or
  // re-categorised row must follow the category, which is the whole point of this story.
  it('ignores a status whose SLUG is done but whose category is not', () => {
    const rows = [{ slug: 'done', category: 'in_progress' }] as unknown as ProjectStatus[]
    expect(doneSlugs(rows).size).toBe(0)
  })
})

describe('createProjectStatus', () => {
  const existing = [
    { slug: 'todo', name: 'To Do', category: 'todo', position: 1 },
    { slug: 'done', name: 'Done', category: 'done', position: 2 },
  ] as unknown as ProjectStatus[]

  it('appends at max(position) + 1 so an add never reorders the board', async () => {
    single.mockResolvedValue({ data: { slug: 'qa' }, error: null })

    await createProjectStatus({ projectId: 'p1', name: 'QA', category: 'in_progress', existing })

    expect(supabase.from).toHaveBeenCalledWith('project_statuses')
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'p1', slug: 'qa', name: 'QA', position: 3 }),
    )
  })

  // NOT list length + 1. A project whose positions are 1,2,5 must not produce another 5 —
  // and `existing.length + 1` would, which is exactly the reduce this kills.
  it('appends past a GAP in the positions rather than colliding with the last row', async () => {
    single.mockResolvedValue({ data: { slug: 'qa' }, error: null })
    const gappy = [
      { slug: 'todo', position: 1 },
      { slug: 'done', position: 9 },
    ] as unknown as ProjectStatus[]

    await createProjectStatus({ projectId: 'p1', name: 'QA', category: 'todo', existing: gappy })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ position: 10 }))
  })

  // A project with no statuses at all still has to land on a LEGAL position:
  // project_statuses_position_positive requires >= 1, so the seed of the reduce is 0, not -1.
  it('starts at position 1 when the project has no statuses yet', async () => {
    single.mockResolvedValue({ data: { slug: 'qa' }, error: null })

    await createProjectStatus({ projectId: 'p1', name: 'QA', category: 'todo', existing: [] })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ position: 1 }))
  })

  // The slug must dodge the slugs ALREADY in the project, not just be well-formed: two
  // different names ("Done" and "done!") derive to one slug and would earn a raw 23505.
  it('derives a slug that avoids the ones the project has already taken', async () => {
    single.mockResolvedValue({ data: { slug: 'done_2' }, error: null })

    await createProjectStatus({ projectId: 'p1', name: 'Done!', category: 'done', existing })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ slug: 'done_2' }))
  })

  it('sends the category it was given', async () => {
    single.mockResolvedValue({ data: { slug: 'qa' }, error: null })
    await createProjectStatus({ projectId: 'p1', name: 'QA', category: 'in_progress', existing })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ category: 'in_progress' }))
  })

  // is_initial is sent EXPLICITLY, not left to the column default: the default is the thing
  // SPRIN-80 changes, and this row must not silently follow it.
  it('sends is_initial false explicitly', async () => {
    single.mockResolvedValue({ data: { slug: 'qa' }, error: null })
    await createProjectStatus({ projectId: 'p1', name: 'QA', category: 'in_progress', existing })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ is_initial: false }))
  })

  it('returns the database row on success', async () => {
    single.mockResolvedValue({ data: { slug: 'qa', name: 'QA' }, error: null })
    await expect(
      createProjectStatus({ projectId: 'p1', name: 'QA', category: 'todo', existing }),
    ).resolves.toEqual({ ok: true, value: { slug: 'qa', name: 'QA' } })
  })

  it('maps a duplicate NAME to duplicate, so the form can point at the name field', async () => {
    single.mockResolvedValue({
      data: null,
      error: { code: '23505', message: uniqueViolation(NAME) },
    })
    await expect(
      createProjectStatus({ projectId: 'p1', name: 'Done', category: 'todo', existing }),
    ).resolves.toEqual({ ok: false, error: 'duplicate' })
  })

  // Two DIFFERENT names can derive to one slug, and the client's own de-duplication loses
  // that race against another tab. The user still fixes it by choosing a different name, so
  // it shares the name tag.
  it('maps a duplicate SLUG to duplicate as well', async () => {
    single.mockResolvedValue({
      data: null,
      error: { code: '23505', message: uniqueViolation(SLUG) },
    })
    await expect(
      createProjectStatus({ projectId: 'p1', name: 'Done!', category: 'todo', existing }),
    ).resolves.toEqual({ ok: false, error: 'duplicate' })
  })

  /**
   * THE ONE THAT DISTINGUISHES THE TWO CONSTRAINTS. `position` is computed as `max+1` from a
   * client-held list nothing refetches, so two tabs on one project both compute the same next
   * position and the second collides — on a 23505 that has nothing to do with the name. Mapped
   * to `duplicate` it told the user "that name already exists" about a name that is unique, and
   * retrying reproduced it forever. A test asserting only `23505 -> duplicate` is exactly the
   * one that cannot tell them apart.
   */
  it('maps a duplicate POSITION to stale, not to duplicate', async () => {
    single.mockResolvedValue({
      data: null,
      error: { code: '23505', message: uniqueViolation(POSITION) },
    })
    await expect(
      createProjectStatus({ projectId: 'p1', name: 'Blocked', category: 'todo', existing }),
    ).resolves.toEqual({ ok: false, error: 'stale' })
  })

  // A 23505 naming a constraint this client does not know about is NOT a duplicate name. The
  // mapping is an allow-list, so an unrecognised one gets the generic retry copy rather than a
  // confident sentence about the wrong column.
  it('maps a 23505 from an unrecognised constraint to unknown', async () => {
    single.mockResolvedValue({
      data: null,
      error: {
        code: '23505',
        message: uniqueViolation('project_statuses_one_initial_per_project'),
      },
    })
    await expect(
      createProjectStatus({ projectId: 'p1', name: 'Start', category: 'todo', existing }),
    ).resolves.toEqual({ ok: false, error: 'unknown' })
  })

  it('maps any other error to unknown', async () => {
    single.mockResolvedValue({ data: null, error: { code: '08006', message: 'boom' } })
    await expect(
      createProjectStatus({ projectId: 'p1', name: 'QA', category: 'todo', existing }),
    ).resolves.toEqual({ ok: false, error: 'unknown' })
  })

  /**
   * The SQLSTATE gate, pinned separately from the message gate.
   *
   * The test above supplies a message with no constraint name in it, so it reaches `'unknown'`
   * whether or not the code is consulted — it pins "any other MESSAGE", not "any other ERROR".
   * Deleting `error.code !== UNIQUE_VIOLATION` from `writeError` left the whole suite green.
   *
   * This is the one input that can tell them apart: a constraint name from the allow-list
   * carried by a NON-unique SQLSTATE. Nothing produces that shape today — it is a probe for the
   * gate, not a scenario — and that is exactly why it has to be constructed deliberately.
   */
  it('consults the SQLSTATE, not just the message: a known constraint under 23514 is unknown', async () => {
    single.mockResolvedValue({
      data: null,
      error: { code: '23514', message: uniqueViolation(POSITION) },
    })
    await expect(
      createProjectStatus({ projectId: 'p1', name: 'QA', category: 'todo', existing }),
    ).resolves.toEqual({ ok: false, error: 'unknown' })
  })

  it('fails WITHOUT a request when the name yields no legal slug', async () => {
    const result = await createProjectStatus({
      projectId: 'p1',
      name: '!!!',
      category: 'todo',
      existing,
    })
    expect(result).toEqual({ ok: false, error: 'unknown' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  // A name starting with a digit is legitimate and must REACH the database, not be refused
  // client-side: `slugForName` prefixes it rather than returning null.
  it('sends a request for a name that starts with a digit', async () => {
    single.mockResolvedValue({ data: { slug: 's_2026_review' }, error: null })

    await createProjectStatus({
      projectId: 'p1',
      name: '2026 Review',
      category: 'todo',
      existing,
    })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ slug: 's_2026_review' }))
  })

  // Trimming lives in the zod schema, but the schema is only the FORM's edge. A direct caller
  // sending '  QA  ' would otherwise store a name whose surrounding space the DB's
  // `btrim(name) <> ''` check tolerates and whose `lower(btrim(name))` unique index ignores —
  // the right outcome reached by luck. The property has to hold for every caller.
  it('trims the name it sends', async () => {
    single.mockResolvedValue({ data: { slug: 'qa' }, error: null })

    await createProjectStatus({ projectId: 'p1', name: '  QA  ', category: 'todo', existing })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ name: 'QA' }))
  })
})

describe('renameProjectStatus', () => {
  it('updates ONLY name — slug is the fk target and is not client-writable', async () => {
    single.mockResolvedValue({ data: { slug: 'qa', name: 'In QA' }, error: null })

    await renameProjectStatus('s1', 'In QA')

    expect(supabase.from).toHaveBeenCalledWith('project_statuses')
    expect(update).toHaveBeenCalledWith({ name: 'In QA' })
    expect(eqUpdate).toHaveBeenCalledWith('id', 's1')
  })

  it('returns the database row on success', async () => {
    single.mockResolvedValue({ data: { slug: 'qa', name: 'In QA' }, error: null })
    await expect(renameProjectStatus('s1', 'In QA')).resolves.toEqual({
      ok: true,
      value: { slug: 'qa', name: 'In QA' },
    })
  })

  it('maps a duplicate NAME to duplicate', async () => {
    single.mockResolvedValue({
      data: null,
      error: { code: '23505', message: uniqueViolation(NAME) },
    })
    await expect(renameProjectStatus('s1', 'Done')).resolves.toEqual({
      ok: false,
      error: 'duplicate',
    })
  })

  // A rename sends `name` alone, so it cannot collide on position — but it shares `writeError`
  // with the insert, and a shared mapping that only ever gets exercised through one call site
  // is a mapping nobody has checked on the other.
  it('maps a duplicate POSITION to stale here too', async () => {
    single.mockResolvedValue({
      data: null,
      error: { code: '23505', message: uniqueViolation(POSITION) },
    })
    await expect(renameProjectStatus('s1', 'Done')).resolves.toEqual({ ok: false, error: 'stale' })
  })

  it('maps any other error to unknown', async () => {
    single.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } })
    await expect(renameProjectStatus('s1', 'Done')).resolves.toEqual({
      ok: false,
      error: 'unknown',
    })
  })

  // Same reasoning as createProjectStatus's trim test: '  Done  ' passes the DB's
  // `btrim(name) <> ''` check and then collides with 'Done' on the `lower(btrim(name))` unique
  // index — a correct outcome the caller reached by luck rather than by design.
  it('trims the name it sends', async () => {
    single.mockResolvedValue({ data: { slug: 'qa', name: 'In QA' }, error: null })

    await renameProjectStatus('s1', '  In QA  ')

    expect(update).toHaveBeenCalledWith({ name: 'In QA' })
  })
})

describe('reorderProjectStatuses', () => {
  /** What the RPC's RETURNING gives back for a reorder that actually touched every row. */
  const reordered = [
    { slug: 'done', position: 1 },
    { slug: 'todo', position: 2 },
  ]

  it('calls the RPC with the COMPLETE ordered slug list', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: reordered, error: null } as never)

    await reorderProjectStatuses('p1', ['done', 'todo'])

    expect(supabase.rpc).toHaveBeenCalledWith('reorder_project_statuses', {
      p_project_id: 'p1',
      p_slugs: ['done', 'todo'],
    })
  })

  // One RPC, never N patches: project_statuses_project_position_unique is DEFERRABLE
  // INITIALLY DEFERRED and PostgREST gives each request its own transaction, so N separate
  // `PATCH position=` calls collide on the very first swap.
  it('issues exactly one request and never a PostgREST table write', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: reordered, error: null } as never)

    await reorderProjectStatuses('p1', ['done', 'todo'])

    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  // The green-for-the-wrong-reason shape. RLS FILTERS an UPDATE rather than raising it, so a
  // cross-tenant, stale or unknown-slug reorder comes back as exactly `error: null, data: []`
  // — indistinguishable from success unless the row COUNT is checked. The RPC's RETURNING
  // supplies that count for free.
  it('reports unknown when the RPC touched FEWER rows than the slugs asked for', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never)

    await expect(reorderProjectStatuses('p1', ['done', 'todo'])).resolves.toEqual({
      ok: false,
      error: 'unknown',
    })
  })

  it('reports unknown on a partial reorder — one row of two moved', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({
      data: [{ slug: 'done', position: 1 }],
      error: null,
    } as never)

    await expect(reorderProjectStatuses('p1', ['done', 'todo'])).resolves.toEqual({
      ok: false,
      error: 'unknown',
    })
  })

  // The other side of the count check: more rows back than slugs sent means the RPC did
  // something other than what was asked, which is equally not a success.
  it('reports unknown when the RPC touched MORE rows than the slugs asked for', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: reordered, error: null } as never)

    await expect(reorderProjectStatuses('p1', ['done'])).resolves.toEqual({
      ok: false,
      error: 'unknown',
    })
  })

  // `data: null` with no error is the same no-op in a different disguise, and it must not
  // sail through the `?? []` into a success with an empty value.
  it('reports unknown when the RPC returns null data with no error', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as never)

    await expect(reorderProjectStatuses('p1', ['done'])).resolves.toEqual({
      ok: false,
      error: 'unknown',
    })
  })

  it("returns the RPC's own post-update rows, not a guess", async () => {
    const rows = [{ slug: 'done', position: 1 }]
    vi.mocked(supabase.rpc).mockResolvedValue({ data: rows, error: null } as never)
    await expect(reorderProjectStatuses('p1', ['done'])).resolves.toEqual({ ok: true, value: rows })
  })

  it('maps an error to unknown', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: { message: 'boom' } } as never)
    await expect(reorderProjectStatuses('p1', ['todo'])).resolves.toEqual({
      ok: false,
      error: 'unknown',
    })
  })
})

/** Thin wrapper over `selectDelete`, matching how `single.mockResolvedValue` stands in for the
 *  other chains above. */
function mockDelete(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  selectDelete.mockResolvedValue(result)
}

/** One count per slug, keyed the same way the code keys its Map: by slug. */
function mockCounts(counts: Record<string, number>) {
  eqStatus.mockImplementation((_col: string, slug: string) =>
    Promise.resolve({ count: counts[slug] ?? 0, error: null }),
  )
}

function mockCountError(message: string) {
  eqStatus.mockResolvedValue({ count: null, error: { message } })
}

describe('deleteProjectStatus', () => {
  it('reports has_tickets when the fk refuses the delete', async () => {
    mockDelete({ data: null, error: { code: '23503', message: 'tickets_status_fk' } })
    await expect(deleteProjectStatus('s1')).resolves.toEqual({ ok: false, error: 'has_tickets' })
  })

  it('reports last when the guard trigger refuses the delete', async () => {
    mockDelete({ data: null, error: { code: 'SB001', message: 'at least one status' } })
    await expect(deleteProjectStatus('s1')).resolves.toEqual({ ok: false, error: 'last' })
  })

  /**
   * THE ONE THAT MATTERS. RLS FILTERS a DELETE rather than raising on it, so a row that is not
   * ours comes back as exactly `error: null, data: []` — a delete that removed nothing, and
   * indistinguishable from success unless the row count is checked.
   */
  it('reports stale when the delete matched no row and did not error', async () => {
    mockDelete({ data: [], error: null })
    await expect(deleteProjectStatus('s1')).resolves.toEqual({ ok: false, error: 'stale' })
  })

  it('succeeds when exactly one row came back', async () => {
    mockDelete({ data: [{ id: 's1' }], error: null })
    await expect(deleteProjectStatus('s1')).resolves.toEqual({ ok: true, value: undefined })
  })

  it('falls back to unknown for an unrecognised error code', async () => {
    mockDelete({ data: null, error: { code: '42501', message: 'denied' } })
    await expect(deleteProjectStatus('s1')).resolves.toEqual({ ok: false, error: 'unknown' })
  })

  it('sends the delete to project_statuses, filtered by id, asking back the row count', async () => {
    mockDelete({ data: [{ id: 's1' }], error: null })

    await deleteProjectStatus('s1')

    expect(supabase.from).toHaveBeenCalledWith('project_statuses')
    expect(eqDelete).toHaveBeenCalledWith('id', 's1')
    expect(selectDelete).toHaveBeenCalledWith('id')
  })
})

describe('ticketCountsByStatus', () => {
  it('maps each status slug to its exact ticket count', async () => {
    mockCounts({ todo: 4, done: 0 })
    const counts = await ticketCountsByStatus('p1', [
      status({ id: 'a', slug: 'todo' }),
      status({ id: 'b', slug: 'done' }),
    ])
    expect(counts.get('todo')).toBe(4)
    expect(counts.get('done')).toBe(0)
  })

  it('scopes the count to the given project', async () => {
    mockCounts({ todo: 1 })
    await ticketCountsByStatus('p1', [status({ id: 'a', slug: 'todo' })])
    expect(eqProject).toHaveBeenCalledWith('project_id', 'p1')
  })

  // A failed count must not read as zero: zero unlocks the Delete button.
  it('throws when a count query fails', async () => {
    mockCountError('network down')
    await expect(
      ticketCountsByStatus('p1', [status({ id: 'a', slug: 'todo' })]),
    ).rejects.toThrow(/could not count/i)
  })

  // A MISSING count is not an error, but reading it as zero is the same inversion: zero
  // unlocks the Delete button, so a response that carries no count at all must refuse too,
  // not silently stand in for "no tickets".
  it('throws when a count query succeeds with no error but no count either', async () => {
    eqStatus.mockResolvedValue({ count: null, error: null })
    await expect(
      ticketCountsByStatus('p1', [status({ id: 'a', slug: 'todo' })]),
    ).rejects.toThrow(/could not count/i)
  })
})

function status(over: Partial<ProjectStatus> & { id: string }): ProjectStatus {
  return {
    project_id: 'p1',
    slug: over.slug ?? over.id,
    name: over.name ?? over.id,
    category: over.category ?? 'todo',
    position: over.position ?? 1,
    is_initial: over.is_initial ?? false,
    created_at: '2026-08-02T00:00:00Z',
    ...over,
  } as ProjectStatus
}

describe('initialSlug', () => {
  it('returns the slug of the initial status', () => {
    expect(
      initialSlug([status({ id: 'a' }), status({ id: 'b', is_initial: true, slug: 'triage' })]),
    ).toBe('triage')
  })

  it('returns null when no status is initial', () => {
    expect(initialSlug([status({ id: 'a' })])).toBeNull()
  })
})

describe('removeStatus', () => {
  it('drops the row and leaves the rest untouched', () => {
    const rows = [
      status({ id: 'a', position: 1, is_initial: true }),
      status({ id: 'b', position: 2 }),
    ]
    expect(removeStatus(rows, 'b')).toEqual([rows[0]])
  })

  // The promotion rule, mirroring the AFTER DELETE trigger. Pinned on BOTH sides:
  // rls.integration.test.ts asserts the DATABASE promotes by this same rule.
  it('promotes the lowest-position survivor when the initial status is removed', () => {
    const rows = [
      status({ id: 'a', position: 1, is_initial: true }),
      status({ id: 'c', position: 3 }),
      status({ id: 'b', position: 2 }),
    ]
    const next = removeStatus(rows, 'a')
    expect(next.find((s) => s.is_initial)?.id).toBe('b')
    expect(next).toHaveLength(2)
  })

  it('promotes nobody when the removed status was not initial', () => {
    const rows = [
      status({ id: 'a', position: 1, is_initial: true }),
      status({ id: 'b', position: 2 }),
    ]
    expect(removeStatus(rows, 'b').filter((s) => s.is_initial)).toHaveLength(1)
  })

  // Kills the mutation "drop the `if (!removed?.is_initial) return rest` guard": with the
  // initial status NOT at the lowest position, running the promotion unconditionally would
  // mark a SECOND row initial. Fixtures where the lowest survivor is already the initial
  // row cannot see that, because there the promotion is a no-op.
  it('promotes nobody when a non-initial status is removed and the initial one is not lowest', () => {
    const rows = [
      status({ id: 'a', position: 1 }),
      status({ id: 'b', position: 2, is_initial: true }),
      status({ id: 'c', position: 3 }),
    ]
    const next = removeStatus(rows, 'c')
    expect(next.filter((s) => s.is_initial).map((s) => s.id)).toEqual(['b'])
  })

  it('is a no-op for an id the list does not hold', () => {
    const rows = [status({ id: 'a', position: 1, is_initial: true })]
    expect(removeStatus(rows, 'nope')).toEqual(rows)
  })
})

describe('deleteBlockReason', () => {
  it('blocks the last status, and says why', () => {
    expect(deleteBlockReason(0, true)).toBe('A project must keep at least one status.')
  })

  it('blocks a status holding tickets, naming the count', () => {
    expect(deleteBlockReason(7, false)).toBe(
      'This status holds 7 tickets. Move them to another status first.',
    )
  })

  it('says "1 ticket", not "1 tickets"', () => {
    expect(deleteBlockReason(1, false)).toBe(
      'This status holds 1 ticket. Move them to another status first.',
    )
  })

  // Last-ness wins: a last status holding tickets is blocked for the reason the user
  // cannot resolve by moving tickets.
  it('reports last-ness ahead of the ticket count', () => {
    expect(deleteBlockReason(7, true)).toBe('A project must keep at least one status.')
  })

  it('returns null when the status can be deleted', () => {
    expect(deleteBlockReason(0, false)).toBeNull()
  })

  // The fix this describe block exists to pin: an UNKNOWN count (the caller has no entry for
  // this status — e.g. a failed `ticketCountsByStatus`) must block, with its own sentence, and
  // must NEVER be treated as `0` (which is the one value that unlocks this button).
  it('blocks on an unknown count, and says why — never reads it as zero', () => {
    expect(deleteBlockReason(undefined, false)).toBe(
      'Ticket counts are unavailable, so this status cannot be deleted safely.',
    )
  })

  // Last-ness wins even over "unknown": a project's only status is still un-deletable
  // regardless of whether its count could be read.
  it('reports last-ness ahead of an unknown count too', () => {
    expect(deleteBlockReason(undefined, true)).toBe('A project must keep at least one status.')
  })
})
