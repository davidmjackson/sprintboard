import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addProjectMemberByEmail,
  listProjectMembers,
  removeProjectMember,
  roleOf,
  setProjectMemberRole,
} from './project-members'
import type { ProjectMemberWithProfile } from './domain'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))

// The two chains this module issues, plus three RPCs:
//
//   listProjectMembers, read 1: from('project_members').select().eq().order().order()
//   listProjectMembers, read 2: from('profiles').select().in()
//   the three writes:           rpc(name, args)
//
// TWO reads, not one, because there is no foreign key PostgREST can embed across --
// `project_members.user_id` references `auth.users`, not `profiles`. The mock mirrors that
// shape deliberately: if someone "optimises" the module into a single embedded select, these
// mocks stop matching and the tests go red rather than silently exercising a chain the module
// no longer issues.
//
// Each chain gets its OWN link functions rather than sharing one `select`, for the reason
// `project-fields.test.ts` spells out: the two `.select()` calls diverge immediately (one
// returns `{ eq }`, the other `{ in: ... }`), so a shared mock could only be one of them.
//
// TWO `.order()` links, each with its own mock, so a test can say WHICH sort key it saw and
// in what order. `created_at` alone is a timestamptz with no uniqueness, so two rows created
// in the same tick would tie and PostgREST would order them arbitrarily; `user_id` breaks
// every tie. Sharing one `order` mock would make that tie-breaker invisible.
const orderUser = vi.fn()
const orderCreated = vi.fn(() => ({ order: orderUser }))
const eqMembers = vi.fn(() => ({ order: orderCreated }))
const selectMembers = vi.fn(() => ({ eq: eqMembers }))

const inProfiles = vi.fn()
const selectProfiles = vi.fn(() => ({ in: inProfiles }))

function mockMembers(data: unknown[] | null, error: { message: string } | null = null) {
  orderUser.mockResolvedValue({ data, error })
}

function mockProfiles(data: unknown[] | null, error: { message: string } | null = null) {
  inProfiles.mockResolvedValue({ data, error })
}

const MEMBER_ROWS = [
  { project_id: 'p1', user_id: 'u1', role: 'admin', created_at: '2026-08-01T00:00:00Z' },
  { project_id: 'p1', user_id: 'u2', role: 'member', created_at: '2026-08-02T00:00:00Z' },
]

const PROFILE_ROWS = [
  { id: 'u1', email: 'admin@example.com', display_name: 'Ada' },
  { id: 'u2', email: 'member@example.com', display_name: null },
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(supabase.from).mockImplementation(((table: string) =>
    table === 'profiles'
      ? { select: selectProfiles }
      : { select: selectMembers }) as unknown as typeof supabase.from)
  mockMembers(MEMBER_ROWS)
  mockProfiles(PROFILE_ROWS)
})

describe('listProjectMembers', () => {
  it('joins each membership row to its profile', async () => {
    const members = await listProjectMembers('p1')

    expect(members).toEqual([
      {
        project_id: 'p1',
        user_id: 'u1',
        role: 'admin',
        created_at: '2026-08-01T00:00:00Z',
        email: 'admin@example.com',
        display_name: 'Ada',
      },
      {
        project_id: 'p1',
        user_id: 'u2',
        role: 'member',
        created_at: '2026-08-02T00:00:00Z',
        email: 'member@example.com',
        display_name: null,
      },
    ])
  })

  it('names the columns it reads, on BOTH reads', () => {
    // A bare `.select()` plus an unchecked cast is what let SPRIN-86 ship a user-visible
    // defect. Asserting the exact string is what makes a silent narrowing go red.
    return listProjectMembers('p1').then(() => {
      expect(selectMembers).toHaveBeenCalledWith('project_id, user_id, role, created_at')
      expect(selectProfiles).toHaveBeenCalledWith('id, email, display_name')
    })
  })

  it('scopes the read to the project and sorts by a TOTAL key', async () => {
    await listProjectMembers('p1')

    expect(eqMembers).toHaveBeenCalledWith('project_id', 'p1')
    expect(orderCreated).toHaveBeenCalledWith('created_at', { ascending: true })
    expect(orderUser).toHaveBeenCalledWith('user_id', { ascending: true })
  })

  it('asks for exactly the user ids it read, and no others', async () => {
    await listProjectMembers('p1')

    expect(inProfiles).toHaveBeenCalledWith('id', ['u1', 'u2'])
  })

  it('KEEPS a member whose profile is not readable, rendering by id', async () => {
    // The important negative. An inner-join shape would silently shorten the list, so an
    // admin could remove someone they can see while a row they cannot see stayed behind --
    // and the last-admin guard would then appear to fire for no reason.
    mockProfiles([PROFILE_ROWS[0]])

    const members = await listProjectMembers('p1')

    expect(members).toHaveLength(2)
    expect(members[1]).toMatchObject({ user_id: 'u2', email: null, display_name: null })
  })

  it('does not issue the profile read at all when there are no members', async () => {
    mockMembers([])

    expect(await listProjectMembers('p1')).toEqual([])
    expect(selectProfiles).not.toHaveBeenCalled()
  })

  it('THROWS on a failed member read rather than resolving to an empty list', async () => {
    mockMembers(null, { message: 'boom' })

    await expect(listProjectMembers('p1')).rejects.toThrow('boom')
  })

  it('THROWS on a failed profile read too, not just the first read', async () => {
    mockProfiles(null, { message: 'profiles exploded' })

    await expect(listProjectMembers('p1')).rejects.toThrow('profiles exploded')
  })

  it('THROWS on a role the client does not understand', async () => {
    // A widened `project_members_role_check` is exactly how this arrives. Without the
    // guard the cast would make `ProjectRole` a lie and the badge would render blank.
    mockMembers([{ ...MEMBER_ROWS[0], role: 'owner' }])

    await expect(listProjectMembers('p1')).rejects.toThrow('Unrecognised project role: owner')
  })
})

describe('the three write RPCs', () => {
  it('adds by email, passing the address through UNNORMALISED', async () => {
    // Trimming and lowercasing happen inside the function so every caller normalises
    // identically. Doing it here as well would be a second implementation of one rule.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: 'added', error: null } as never)

    expect(await addProjectMemberByEmail('p1', '  Ada@Example.COM  ', 'member')).toBe('added')
    expect(supabase.rpc).toHaveBeenCalledWith('add_project_member_by_email', {
      p_project_id: 'p1',
      p_email: '  Ada@Example.COM  ',
      p_role: 'member',
    })
  })

  it('returns the tag for an address nobody has registered', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: 'no_such_user', error: null } as never)

    expect(await addProjectMemberByEmail('p1', 'nobody@example.com', 'member')).toBe('no_such_user')
  })

  it('sets a role', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: 'updated', error: null } as never)

    expect(await setProjectMemberRole('p1', 'u2', 'admin')).toBe('updated')
    expect(supabase.rpc).toHaveBeenCalledWith('set_project_member_role', {
      p_project_id: 'p1',
      p_user_id: 'u2',
      p_role: 'admin',
    })
  })

  it('returns last_admin RATHER THAN THROWING, because it is an outcome to explain', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: 'last_admin', error: null } as never)

    expect(await setProjectMemberRole('p1', 'u1', 'member')).toBe('last_admin')
    expect(await removeProjectMember('p1', 'u1')).toBe('last_admin')
  })

  it('removes a member', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: 'removed', error: null } as never)

    expect(await removeProjectMember('p1', 'u2')).toBe('removed')
    expect(supabase.rpc).toHaveBeenCalledWith('remove_project_member', {
      p_project_id: 'p1',
      p_user_id: 'u2',
    })
  })

  it('THROWS when the RPC itself fails, on all three', async () => {
    // A transport or privilege failure is NOT one of the tags. Collapsing the two would
    // let `permission denied` render as an ordinary "not a member" message.
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: { message: 'nope' } } as never)

    await expect(addProjectMemberByEmail('p1', 'a@b.c', 'member')).rejects.toThrow('nope')
    await expect(setProjectMemberRole('p1', 'u2', 'admin')).rejects.toThrow('nope')
    await expect(removeProjectMember('p1', 'u2')).rejects.toThrow('nope')
  })
})

describe('roleOf', () => {
  const MEMBERS = [
    { user_id: 'u1', role: 'admin' },
    { user_id: 'u2', role: 'member' },
  ] as ProjectMemberWithProfile[]

  it("finds the signed-in user's own role", () => {
    expect(roleOf(MEMBERS, 'u1')).toBe('admin')
    expect(roleOf(MEMBERS, 'u2')).toBe('member')
  })

  it('returns null for someone who holds no row', () => {
    expect(roleOf(MEMBERS, 'u3')).toBeNull()
  })

  it('returns null rather than guessing when the user id is not known yet', () => {
    // The auth context resolves asynchronously, so `undefined` is a real state on first
    // render. Defaulting it to anything else would offer admin controls to nobody in
    // particular for one frame.
    expect(roleOf(MEMBERS, undefined)).toBeNull()
  })
})
