import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createProject, listProjects } from './projects'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))

// createProject calls from('projects').insert(...).select().single();
// listProjects calls from('projects').select().order(...).
const single = vi.fn()
const order = vi.fn()
// The insert payload itself, captured — the row `createProject` builds is the whole
// contract with the database, and a mock that only returns a chain proves nothing
// about what was sent. SPRIN-81 carries `project_type` through here.
const insert = vi.fn()
beforeEach(() => {
  single.mockReset()
  order.mockReset()
  insert.mockReset()
  vi.mocked(supabase.from).mockReturnValue({
    insert: (row: unknown) => {
      insert(row)
      return { select: () => ({ single }) }
    },
    select: () => ({ order }),
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
