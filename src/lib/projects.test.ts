import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SPRINT_CADENCE_COLUMNS } from './domain'
import { createProject, listProjects, updateProjectCadence } from './projects'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// createProject calls from('projects').insert(...).select().single();
// listProjects calls from('projects').select().order(...);
// updateProjectCadence calls from('projects').update(...).eq('id', …).select()  <- TERMINAL.
//
// The update chain gets its OWN links past `.update()` rather than reusing `select` above.
// The two `.select()`s are different calls that happen to share a name — one starts a read and
// returns `{ order }`, the other TERMINATES a write and resolves `{ data, error }` — so a
// shared mock could only be one of them, and a test asserting on it could not say which call
// it saw. Same reasoning as the comment at the top of `project-statuses.test.ts`.
const single = vi.fn()
const order = vi.fn()
// The insert payload itself, captured — the row `createProject` builds is the whole
// contract with the database, and a mock that only returns a chain proves nothing
// about what was sent. SPRIN-81 carries `project_type` through here.
const insert = vi.fn()
// Likewise for the update, where the captured payload is a SECURITY property and not only a
// contract: `authenticated` holds UPDATE on the two cadence columns and nothing else, so any
// extra key is a 42501 no mocked client can see.
const update = vi.fn()
const eqUpdate = vi.fn()
const selectUpdate = vi.fn()
beforeEach(() => {
  single.mockReset()
  order.mockReset()
  insert.mockReset()
  update.mockReset()
  eqUpdate.mockReset()
  selectUpdate.mockReset()
  vi.mocked(supabase.from).mockReturnValue({
    insert: (row: unknown) => {
      insert(row)
      return { select: () => ({ single }) }
    },
    select: () => ({ order }),
    update: (row: unknown) => {
      update(row)
      return {
        eq: (column: string, value: unknown) => {
          eqUpdate(column, value)
          return { select: selectUpdate }
        },
      }
    },
  } as unknown as ReturnType<typeof supabase.from>)
})

const input = { ownerId: 'u1', name: 'My Project', key: 'MP', projectType: 'scrum' } as const

describe('createProject', () => {
  it('returns the created project on success', async () => {
    const project = {
      id: 'p1',
      owner_id: 'u1',
      name: 'My Project',
      key: 'MP',
      project_type: 'scrum',
    }
    single.mockResolvedValue({ data: project, error: null })

    const result = await createProject(input)

    expect(result).toEqual({ ok: true, project })
  })

  /**
   * The type the caller chose has to survive the trip into the row, and nothing else
   * in the suite would notice if it did not: the success test above asserts what comes
   * BACK, which is whatever the mock was told to resolve with, not what was sent.
   *
   * Deliberately no "defaults to scrum" case: `projectType` has no TypeScript default.
   * The column's `NOT NULL DEFAULT 'scrum'` is the single source of that decision, and
   * a client-side default would be a second one that could drift from it.
   */
  it.each([{ projectType: 'kanban' as const }, { projectType: 'scrum' as const }])(
    'sends project_type: $projectType in the insert',
    async ({ projectType }) => {
      single.mockResolvedValue({ data: { id: 'p1' }, error: null })

      await createProject({ ...input, projectType })

      expect(insert).toHaveBeenCalledWith({
        owner_id: 'u1',
        name: 'My Project',
        key: 'MP',
        project_type: projectType,
      })
    },
  )

  it('maps a unique-violation (23505) to a duplicate_key result', async () => {
    single.mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value' },
    })

    expect(await createProject(input)).toEqual({ ok: false, error: 'duplicate_key' })
  })

  it('maps any other error to unknown', async () => {
    single.mockResolvedValue({ data: null, error: { code: '23514', message: 'check violation' } })

    expect(await createProject(input)).toEqual({ ok: false, error: 'unknown' })
  })
})

describe('listProjects', () => {
  it("returns the caller's projects", async () => {
    const projects = [
      { id: 'p1', name: 'A' },
      { id: 'p2', name: 'B' },
    ]
    order.mockResolvedValue({ data: projects, error: null })

    expect(await listProjects()).toEqual(projects)
  })

  it('returns an empty array when there are none', async () => {
    order.mockResolvedValue({ data: null, error: null })

    expect(await listProjects()).toEqual([])
  })

  it('throws on a query error', async () => {
    order.mockResolvedValue({ data: null, error: { message: 'network' } })

    await expect(listProjects()).rejects.toThrow(/Could not load projects/)
  })
})

describe('updateProjectCadence', () => {
  const CADENCE = { sprint_length_weeks: 3, sprint_start_weekday: 4 } as const
  const UPDATED = { id: 'p1', owner_id: 'u1', name: 'My Project', key: 'MP', ...CADENCE }

  /**
   * The payload, asserted EXACTLY rather than with `objectContaining`, because "and nothing
   * else" is the security half of it: `authenticated` holds UPDATE on these two columns alone,
   * so a third key is a 42501 against the live database — somewhere a mocked client never
   * goes. `objectContaining` would pass with `name` alongside them.
   *
   * The key set is compared to `SPRINT_CADENCE_COLUMNS`, not re-listed, so this test and the
   * AST guard in `project-type-immutability.test.ts` cannot come to hold different opinions
   * about which columns are writable.
   */
  it('sends exactly the two granted columns, and filters on the project id', async () => {
    selectUpdate.mockResolvedValue({ data: [UPDATED], error: null })

    await updateProjectCadence('p1', CADENCE)

    expect(update).toHaveBeenCalledWith({ sprint_length_weeks: 3, sprint_start_weekday: 4 })
    expect(Object.keys(update.mock.calls[0]![0] as object).sort()).toEqual(
      [...SPRINT_CADENCE_COLUMNS].sort(),
    )
    expect(eqUpdate).toHaveBeenCalledWith('id', 'p1')
  })

  /**
   * The row the DATABASE now holds is what comes back — not an echo of the argument. Asserted
   * with values that differ from the ones sent, so a function that returned its own input
   * would fail here rather than pass on a coincidence.
   */
  it('returns the row the database returned, not the values it was given', async () => {
    const settled = { ...UPDATED, sprint_length_weeks: 1, sprint_start_weekday: 7 }
    selectUpdate.mockResolvedValue({ data: [settled], error: null })

    expect(await updateProjectCadence('p1', CADENCE)).toEqual({ ok: true, project: settled })
  })

  /**
   * The one error code that earns its own tag. Paired with the case below on purpose: a
   * mapping that returned `'forbidden'` for every error would satisfy this test alone, so the
   * 23514 case is what proves the branch is reading `error.code` at all.
   */
  it('maps a permission denial (42501) to forbidden', async () => {
    selectUpdate.mockResolvedValue({
      data: null,
      error: { code: '42501', message: 'permission denied for table projects' },
    })

    expect(await updateProjectCadence('p1', CADENCE)).toEqual({ ok: false, error: 'forbidden' })
  })

  it('maps any other error to unknown', async () => {
    selectUpdate.mockResolvedValue({
      data: null,
      error: { code: '23514', message: 'violates check constraint' },
    })

    expect(await updateProjectCadence('p1', CADENCE)).toEqual({ ok: false, error: 'unknown' })
  })

  /**
   * A null error is NOT success. RLS filters an UPDATE rather than raising on it, so another
   * tenant's project id — or one deleted in another tab — arrives here as an empty array with
   * no error at all. Without the explicit count this reads as a write that worked, and the
   * settings section would report a cadence change that never happened.
   *
   * `'unknown'`, not `'forbidden'`: nothing was denied, the row simply is not there for this
   * caller, and generic retry copy is the honest answer.
   */
  it.each([[[]], [null]])('reports unknown when the update matched no row (%j)', async (data) => {
    selectUpdate.mockResolvedValue({ data, error: null })

    expect(await updateProjectCadence('p1', CADENCE)).toEqual({ ok: false, error: 'unknown' })
  })
})
