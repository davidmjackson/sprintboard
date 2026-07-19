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
// startSprint:  from('sprints').update(...).eq(...).select().single()
const single = vi.fn()
const order = vi.fn()
const eq = vi.fn(() => ({ order }))
const select = vi.fn(() => ({ eq }))
// Typed through the signature rather than a named parameter, so `insert.mock.calls[0][0]`
// is the real insert body without declaring an argument the stub never uses.
const insert = vi.fn<
  (payload: Record<string, unknown>) => { select: () => { single: typeof single } }
>(() => ({ select: () => ({ single }) }))
const updateSingle = vi.fn()
const updateSelect = vi.fn(() => ({ single: updateSingle }))
const updateEq = vi.fn(() => ({ select: updateSelect }))
const update = vi.fn<(patch: Record<string, unknown>) => { eq: typeof updateEq }>(() => ({
  eq: updateEq,
}))

beforeEach(() => {
  single.mockReset()
  order.mockReset()
  eq.mockReset()
  eq.mockReturnValue({ order })
  select.mockReset()
  select.mockReturnValue({ eq })
  insert.mockReset()
  insert.mockReturnValue({ select: () => ({ single }) })
  updateSingle.mockReset()
  updateSelect.mockReset().mockReturnValue({ single: updateSingle })
  updateEq.mockReset().mockReturnValue({ select: updateSelect })
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
  it('sets status active and returns the updated sprint on success', async () => {
    const active = sprint({ status: 'active' })
    updateSingle.mockResolvedValue({ data: active, error: null })

    const result = await startSprint('s1')

    expect(update).toHaveBeenCalledWith({ status: 'active' })
    expect(updateEq).toHaveBeenCalledWith('id', 's1')
    expect(result).toEqual({ ok: true, sprint: active })
  })

  it('maps the partial-unique-index violation (23505) to already_active', async () => {
    updateSingle.mockResolvedValue({ data: null, error: { code: '23505' } })

    const result = await startSprint('s2')

    expect(result).toEqual({ ok: false, error: 'already_active' })
  })

  it('maps any other error to unknown', async () => {
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
  // tickets: update({sprint_id:null}).eq('sprint_id',id).neq('status','done').select() -> {data,error}
  // sprints: update({status:'complete'}).eq('id',id).select().single()                 -> {data,error}
  const ticketsSelect = vi.fn()
  const ticketsNeq = vi.fn(() => ({ select: ticketsSelect }))
  const ticketsEq = vi.fn(() => ({ neq: ticketsNeq }))
  const ticketsUpdate = vi.fn(() => ({ eq: ticketsEq }))

  const sprintSingle = vi.fn()
  const sprintSelect = vi.fn(() => ({ single: sprintSingle }))
  const sprintEq = vi.fn(() => ({ select: sprintSelect }))
  const sprintUpdate = vi.fn(() => ({ eq: sprintEq }))

  beforeEach(() => {
    ticketsSelect.mockReset()
    ticketsNeq.mockReset().mockReturnValue({ select: ticketsSelect })
    ticketsEq.mockReset().mockReturnValue({ neq: ticketsNeq })
    ticketsUpdate.mockReset().mockReturnValue({ eq: ticketsEq })
    sprintSingle.mockReset()
    sprintSelect.mockReset().mockReturnValue({ single: sprintSingle })
    sprintEq.mockReset().mockReturnValue({ select: sprintSelect })
    sprintUpdate.mockReset().mockReturnValue({ eq: sprintEq })
    vi.mocked(supabase.from).mockReset()
    vi.mocked(supabase.from).mockImplementation(
      (table: string) =>
        (table === 'tickets'
          ? { update: ticketsUpdate }
          : { update: sprintUpdate }) as unknown as ReturnType<typeof supabase.from>,
    )
  })

  it('moves incomplete tickets to the backlog, then flips the sprint to complete', async () => {
    const moved = [ticket({ id: 't1', sprint_id: null })]
    const completed = sprint({ status: 'complete' })
    ticketsSelect.mockResolvedValue({ data: moved, error: null })
    sprintSingle.mockResolvedValue({ data: completed, error: null })

    const result = await completeSprint('s1')

    // Step 1: bulk-null only the NOT-done tickets of this sprint.
    expect(ticketsUpdate).toHaveBeenCalledWith({ sprint_id: null })
    expect(ticketsEq).toHaveBeenCalledWith('sprint_id', 's1')
    expect(ticketsNeq).toHaveBeenCalledWith('status', 'done')
    // Step 2: flip status.
    expect(sprintUpdate).toHaveBeenCalledWith({ status: 'complete' })
    expect(sprintEq).toHaveBeenCalledWith('id', 's1')
    expect(result).toEqual({ ok: true, sprint: completed, returnedTickets: moved })
  })

  it('does not flip the status if the ticket move fails (ordering is load-bearing)', async () => {
    ticketsSelect.mockResolvedValue({ data: null, error: { message: 'offline' } })

    const result = await completeSprint('s1')

    expect(sprintUpdate).not.toHaveBeenCalled()
    expect(result).toEqual({ ok: false, error: 'unknown' })
  })

  it('maps a failed status flip to unknown', async () => {
    ticketsSelect.mockResolvedValue({ data: [], error: null })
    sprintSingle.mockResolvedValue({ data: null, error: { code: 'PGRST116' } })

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: false, error: 'unknown' })
  })

  it('treats a sprint with nothing to move as success (empty returnedTickets)', async () => {
    const completed = sprint({ status: 'complete' })
    ticketsSelect.mockResolvedValue({ data: [], error: null })
    sprintSingle.mockResolvedValue({ data: completed, error: null })

    const result = await completeSprint('s1')

    expect(result).toEqual({ ok: true, sprint: completed, returnedTickets: [] })
  })
})
