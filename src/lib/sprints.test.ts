import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  completeSprint,
  createSprint,
  defaultSprintName,
  listSprints,
  startSprint,
} from './sprints'
import type { Sprint, Ticket } from './domain'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// createSprint: from('sprints').insert(...).select().single()
// listSprints:  from('sprints').select().eq(...).order(...)
// guard read:   from('sprints').select('status').eq('id', ...).single()
// startSprint:  from('sprints').update(...).eq('id',...).eq('status',...).select().single()
const single = vi.fn()
const order = vi.fn()
const guardSingle = vi.fn()
const eq = vi.fn(() => ({ order, single: guardSingle }))
const select = vi.fn(() => ({ eq }))
// Typed through the signature rather than a named parameter, so `insert.mock.calls[0][0]`
// is the real insert body without declaring an argument the stub never uses.
const insert = vi.fn<
  (payload: Record<string, unknown>) => { select: () => { single: typeof single } }
>(() => ({ select: () => ({ single }) }))
const updateSingle = vi.fn()
const updateSelect = vi.fn(() => ({ single: updateSingle }))
const updateEq: ReturnType<typeof vi.fn> = vi.fn(() => ({
  eq: updateEq,
  select: updateSelect,
}))
const update = vi.fn<(patch: Record<string, unknown>) => { eq: typeof updateEq }>(() => ({
  eq: updateEq,
}))

beforeEach(() => {
  single.mockReset()
  order.mockReset()
  guardSingle.mockReset()
  eq.mockReset()
  eq.mockReturnValue({ order, single: guardSingle })
  select.mockReset()
  select.mockReturnValue({ eq })
  insert.mockReset()
  insert.mockReturnValue({ select: () => ({ single }) })
  updateSingle.mockReset()
  updateSelect.mockReset().mockReturnValue({ single: updateSingle })
  updateEq.mockReset().mockReturnValue({ eq: updateEq, select: updateSelect })
  update.mockReset().mockReturnValue({ eq: updateEq })
  vi.mocked(supabase.from).mockReset()
  vi.mocked(supabase.from).mockReturnValue({
    insert,
    select,
    update,
  } as unknown as ReturnType<typeof supabase.from>)
})

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 's1',
    project_id: 'p1',
    name: 'Sprint 1',
    goal: null,
    status: 'future',
    start_date: null,
    end_date: null,
    created_at: '2026-07-16T00:00:00+00:00',
    ...overrides,
  }
}

describe('defaultSprintName', () => {
  it('names the first sprint Sprint 1', () => {
    expect(defaultSprintName([])).toBe('Sprint 1')
  })

  it('numbers off the count of existing sprints', () => {
    expect(defaultSprintName([sprint(), sprint({ id: 's2' })])).toBe('Sprint 3')
  })

  it('ignores what the existing sprints are actually called', () => {
    // Numbering is count-based, not parsed from names: names are labels, not identifiers,
    // and `sprints` has no unique constraint on name, so a collision is cosmetic.
    expect(defaultSprintName([sprint({ name: 'Hardening push' })])).toBe('Sprint 2')
  })
})

describe('createSprint', () => {
  it('never sends status — the DB default owns it', async () => {
    single.mockResolvedValue({ data: sprint(), error: null })

    await createSprint({ projectId: 'p1' })

    // The guard. `status: 'active'` here would compile without SprintCreateInsert and
    // would route around S6.3's one-active-sprint index.
    expect(insert).toHaveBeenCalledWith(expect.not.objectContaining({ status: expect.anything() }))
  })

  it('auto-names a blank name and nulls the optional fields', async () => {
    single.mockResolvedValue({ data: sprint(), error: null })

    await createSprint({ projectId: 'p1' })

    expect(insert).toHaveBeenCalledWith({
      project_id: 'p1',
      name: 'Sprint 1',
      goal: null,
      start_date: null,
      end_date: null,
    })
  })

  it('numbers the auto-name off the project’s existing sprints', async () => {
    single.mockResolvedValue({ data: sprint(), error: null })

    await createSprint({ projectId: 'p1', existing: [sprint(), sprint({ id: 's2' })] })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sprint 3' }))
  })

  it('trims a supplied name and pins the dates to UTC midnight', async () => {
    single.mockResolvedValue({ data: sprint(), error: null })

    await createSprint({
      projectId: 'p1',
      name: '  Hardening push  ',
      goal: 'Ship the board',
      startDate: '2026-07-20',
      endDate: '2026-08-03',
    })

    expect(insert).toHaveBeenCalledWith({
      project_id: 'p1',
      name: 'Hardening push',
      goal: 'Ship the board',
      start_date: '2026-07-20T00:00:00.000Z',
      end_date: '2026-08-03T00:00:00.000Z',
    })
  })

  it('auto-names a whitespace-only name', async () => {
    single.mockResolvedValue({ data: sprint(), error: null })

    await createSprint({ projectId: 'p1', name: '   ' })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sprint 1' }))
  })

  it('returns the created sprint on success', async () => {
    single.mockResolvedValue({ data: sprint({ id: 'new' }), error: null })

    const result = await createSprint({ projectId: 'p1' })

    expect(result).toEqual({ ok: true, sprint: sprint({ id: 'new' }) })
  })

  it('returns an unknown error on failure', async () => {
    single.mockResolvedValue({ data: null, error: { message: 'nope' } })

    const result = await createSprint({ projectId: 'p1' })

    expect(result).toEqual({ ok: false, error: 'unknown' })
  })
})

describe('listSprints', () => {
  it('selects every column, scoped to the project, newest first', async () => {
    order.mockResolvedValue({ data: [sprint()], error: null })

    const result = await listSprints('p1')

    expect(supabase.from).toHaveBeenCalledWith('sprints')
    // The bare select() is load-bearing, so it is asserted. Narrowing it to a column list
    // would leave this suite green while every Sprint row silently lost a field — the
    // rows are cast unchecked, so a dropped column arrives `undefined`, not a type error.
    expect(select).toHaveBeenCalledWith()
    expect(eq).toHaveBeenCalledWith('project_id', 'p1')
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(result).toEqual([sprint()])
  })

  it('throws when the read fails, rather than reporting an empty project', async () => {
    order.mockResolvedValue({ data: null, error: { message: 'offline' } })

    await expect(listSprints('p1')).rejects.toThrow('Could not load sprints: offline')
  })
})

describe('startSprint', () => {
  // Every start now passes a precondition read first: stub it to the status under test.
  function guardReturns(status: string | null, error: unknown = null) {
    guardSingle.mockResolvedValue({ data: status === null ? null : { status }, error })
  }

  it('sets status active and returns the updated sprint on success', async () => {
    guardReturns('future')
    const active = sprint({ status: 'active' })
    updateSingle.mockResolvedValue({ data: active, error: null })

    const result = await startSprint('s1')

    // The guard read itself: pins `.eq('id', ...)` against a copy-paste to `.eq('project_id',
    // ...)`, which would still pass typecheck, lint and every other unit test — only the live
    // suite would catch it. Within this describe `eq` is called only by the guard read.
    expect(eq).toHaveBeenCalledWith('id', 's1')
    expect(update).toHaveBeenCalledWith({ status: 'active' })
    expect(updateEq).toHaveBeenCalledWith('id', 's1')
    // The compare-and-swap: the update itself refuses a sprint that left `future`
    // between the read and the write. Drop this filter and this assertion goes red.
    expect(updateEq).toHaveBeenCalledWith('status', 'future')
    expect(result).toEqual({ ok: true, sprint: active })
  })

  it('refuses to start an already-active sprint and writes nothing', async () => {
    guardReturns('active')

    const result = await startSprint('s1')

    expect(result).toEqual({ ok: false, error: 'stale' })
    expect(update).not.toHaveBeenCalled()
  })

  it('refuses to start a completed sprint and writes nothing — no resurrection', async () => {
    // The headline defect. The partial unique index constrains `status = 'active'` only,
    // so with no other active sprint the database would happily flip this back to active.
    guardReturns('complete')

    const result = await startSprint('s1')

    expect(result).toEqual({ ok: false, error: 'stale' })
    expect(update).not.toHaveBeenCalled()
  })

  it('maps a failed precondition read to unknown and writes nothing', async () => {
    // Zero rows covers BOTH a deleted sprint and another owner's sprint — RLS makes them
    // indistinguishable and they must stay so. Never 'stale', which would confirm existence.
    guardReturns(null, { code: 'PGRST116' })

    const result = await startSprint('s1')

    expect(result).toEqual({ ok: false, error: 'unknown' })
    expect(update).not.toHaveBeenCalled()
  })

  it('maps a null data with no error to unknown and writes nothing (defensive branch)', async () => {
    // `.single()` in practice always pairs a zero-row match with an error, so `data: null,
    // error: null` is not reachable through Supabase today — but `requireSprintStatus` guards
    // it anyway (`if (error || !data)`). Without the `!data` half, this response would fall
    // through to `data.status` and throw an unhandled TypeError out of the button's `await`.
    guardSingle.mockResolvedValue({ data: null, error: null })

    const result = await startSprint('s1')

    expect(result).toEqual({ ok: false, error: 'unknown' })
    expect(update).not.toHaveBeenCalled()
  })

  it('maps the partial-unique-index violation (23505) to already_active', async () => {
    guardReturns('future')
    updateSingle.mockResolvedValue({ data: null, error: { code: '23505' } })

    const result = await startSprint('s2')

    expect(result).toEqual({ ok: false, error: 'already_active' })
  })

  it('maps any other error to unknown', async () => {
    guardReturns('future')
    updateSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116' } })

    const result = await startSprint('s3')

    expect(result).toEqual({ ok: false, error: 'unknown' })
  })
})

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 't1',
    project_id: 'p1',
    key: 'APP-1',
    number: 1,
    summary: 'A ticket',
    type: 'story',
    status: 'todo',
    description: null,
    assignee_id: null,
    story_points: null,
    acceptance_criteria: null,
    labels: [],
    sprint_id: 's1',
    parent_epic_id: null,
    context: null,
    deliverables: [],
    is_blocked: false,
    blocked_reason: null,
    blocked_since: null,
    created_at: '2026-07-16T00:00:00Z',
    updated_at: '2026-07-16T00:00:00Z',
    ...overrides,
  }
}

describe('completeSprint', () => {
  // tickets:    update({sprint_id:null}).eq('sprint_id',id).neq('status','done').select()
  // guard read: from('sprints').select('status').eq('id', id).single()
  // sprints:    update({status:'complete'}).eq('id',id).eq('status','active').select().single()
  const ticketsSelect = vi.fn()
  const ticketsNeq = vi.fn(() => ({ select: ticketsSelect }))
  const ticketsEq = vi.fn(() => ({ neq: ticketsNeq }))
  const ticketsUpdate = vi.fn(() => ({ eq: ticketsEq }))

  const guardSingleC = vi.fn()
  const guardEq = vi.fn(() => ({ single: guardSingleC }))
  const guardSelect = vi.fn(() => ({ eq: guardEq }))

  const sprintSingle = vi.fn()
  const sprintSelect = vi.fn(() => ({ single: sprintSingle }))
  const sprintEq: ReturnType<typeof vi.fn> = vi.fn(() => ({
    eq: sprintEq,
    select: sprintSelect,
  }))
  const sprintUpdate = vi.fn(() => ({ eq: sprintEq }))

  /** Stub the precondition read. `null` status means the row was not visible. */
  function guardReturns(status: string | null, error: unknown = null) {
    guardSingleC.mockResolvedValue({ data: status === null ? null : { status }, error })
  }

  beforeEach(() => {
    ticketsSelect.mockReset()
    ticketsNeq.mockReset().mockReturnValue({ select: ticketsSelect })
    ticketsEq.mockReset().mockReturnValue({ neq: ticketsNeq })
    ticketsUpdate.mockReset().mockReturnValue({ eq: ticketsEq })
    guardSingleC.mockReset()
    guardEq.mockReset().mockReturnValue({ single: guardSingleC })
    guardSelect.mockReset().mockReturnValue({ eq: guardEq })
    sprintSingle.mockReset()
    sprintSelect.mockReset().mockReturnValue({ single: sprintSingle })
    sprintEq.mockReset().mockReturnValue({ eq: sprintEq, select: sprintSelect })
    sprintUpdate.mockReset().mockReturnValue({ eq: sprintEq })
    vi.mocked(supabase.from).mockReset()
    vi.mocked(supabase.from).mockImplementation(
      (table: string) =>
        (table === 'tickets'
          ? { update: ticketsUpdate }
          : { update: sprintUpdate, select: guardSelect }) as unknown as ReturnType<
          typeof supabase.from
        >,
    )
  })

  it('moves incomplete tickets to the backlog, then flips the sprint to complete', async () => {
    guardReturns('active')
    const moved = [ticket({ id: 't1', sprint_id: null })]
    const completed = sprint({ status: 'complete' })
    ticketsSelect.mockResolvedValue({ data: moved, error: null })
    sprintSingle.mockResolvedValue({ data: completed, error: null })

    const result = await completeSprint('s1')

    // The guard read itself: pins `.eq('id', ...)` against a copy-paste to `.eq('project_id',
    // ...)`, which would still pass typecheck, lint and every other unit test — only the live
    // suite would catch it.
    expect(guardEq).toHaveBeenCalledWith('id', 's1')
    // Step 1: bulk-null only the NOT-done tickets of this sprint.
    expect(ticketsUpdate).toHaveBeenCalledWith({ sprint_id: null })
    expect(ticketsEq).toHaveBeenCalledWith('sprint_id', 's1')
    expect(ticketsNeq).toHaveBeenCalledWith('status', 'done')
    // Step 2: flip status.
    expect(sprintUpdate).toHaveBeenCalledWith({ status: 'complete' })
    expect(sprintEq).toHaveBeenCalledWith('id', 's1')
    // Compare-and-swap on the flip: closes the window between the guard read and the write.
    expect(sprintEq).toHaveBeenCalledWith('status', 'active')
    expect(result).toEqual({ ok: true, sprint: completed, returnedTickets: moved })
  })

  it('does not flip the status if the ticket move fails (ordering is load-bearing)', async () => {
    guardReturns('active')
    ticketsSelect.mockResolvedValue({ data: null, error: { message: 'offline' } })

    const result = await completeSprint('s1')

    expect(sprintUpdate).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: 'unknown' })
  })

  it('maps a failed status flip to unknown', async () => {
    guardReturns('active')
    ticketsSelect.mockResolvedValue({ data: [], error: null })
    sprintSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116' } })

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: false, error: 'unknown' })
  })

  it('treats a sprint with nothing to move as success (empty returnedTickets)', async () => {
    guardReturns('active')
    const completed = sprint({ status: 'complete' })
    ticketsSelect.mockResolvedValue({ data: [], error: null })
    sprintSingle.mockResolvedValue({ data: completed, error: null })

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: true, sprint: completed, returnedTickets: [] })
  })

  it('refuses to complete a future sprint and moves NO tickets', async () => {
    // The assertion with teeth. The ticket move runs BEFORE the status flip, so a guard that
    // only filtered the flip would strip sprint_id from this sprint's tickets and *then*
    // report failure — worse than no guard at all.
    guardReturns('future')

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: false, error: 'stale' })
    expect(ticketsUpdate).not.toHaveBeenCalled()
    expect(sprintUpdate).not.toHaveBeenCalled()
  })

  it('refuses to re-complete an already-complete sprint and moves NO tickets', async () => {
    guardReturns('complete')

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: false, error: 'stale' })
    expect(ticketsUpdate).not.toHaveBeenCalled()
    expect(sprintUpdate).not.toHaveBeenCalled()
  })

  it('maps a failed precondition read to unknown and moves NO tickets', async () => {
    // Zero rows is a deleted sprint OR another owner's — never distinguished, never 'stale'.
    guardReturns(null, { code: 'PGRST116' })

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: false, error: 'unknown' })
    expect(ticketsUpdate).not.toHaveBeenCalled()
  })

  it('maps a null data with no error to unknown and moves NO tickets (defensive branch)', async () => {
    // Same defensive branch as `startSprint`'s equivalent test — `requireSprintStatus` is
    // shared by both functions. See that test for why `data: null, error: null` matters even
    // though `.single()` cannot produce it today.
    guardSingleC.mockResolvedValue({ data: null, error: null })

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: false, error: 'unknown' })
    expect(ticketsUpdate).not.toHaveBeenCalled()
  })
})
