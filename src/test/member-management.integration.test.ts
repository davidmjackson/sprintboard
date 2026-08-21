// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import {
  adminClient,
  anonClient,
  assertServiceRoleOrExplain,
  hasServiceRoleKey,
  signInWithCredentials,
} from './supabase-clients'

assertServiceRoleOrExplain()

/**
 * SPRIN-102 -- membership is managed by three SECURITY DEFINER RPCs, and by nothing else.
 *
 * The story moves every write on `project_members` behind `add_project_member_by_email`,
 * `set_project_member_role` and `remove_project_member`, then revokes INSERT, UPDATE,
 * DELETE and TRUNCATE from `authenticated`. So this file has to prove two different
 * things, and proving only the first is the tempting half-job:
 *
 *   1. The RPCs do what the ACs say, INCLUDING refusing a non-admin.
 *   2. There is no OTHER way in. A suite that only exercised the RPCs would stay green if
 *      the revoke were dropped and the old direct writes came back.
 *
 * THE ORDERING PROPERTY IS THE SECURITY PROPERTY, and it gets its own test rather than
 * being assumed from the code. `add_project_member_by_email` checks the caller is an admin
 * BEFORE it reads `p_email`. If those two statements were swapped the function would still
 * refuse every non-admin -- every authorisation test below would stay green -- while
 * having become an email-enumeration oracle for the whole internet. The only way to see
 * the difference from outside is to call it as a NON-admin twice, once with a registered
 * address and once with an unregistered one, and require the two failures to be
 * IDENTICAL. That is `does not leak whether an address is registered` below.
 *
 * THE 42501 DISCRIMINATION RULE. A 42501 on this table now has two possible authors: the
 * privilege layer (the revoke) and an RLS policy (the three write policies, kept as
 * defence in depth). The codes are identical and the MESSAGES are not, so every negative
 * here matches the message too. `permission denied for table project_members` is the
 * privilege layer; `violates row-level security policy` is RLS. A test that matched the
 * code alone could not tell which control refused, and would stay green if the one it
 * meant to prove were deleted.
 *
 * REMOVED-MEMBER COVERAGE LIVES HERE, carried from SPRIN-100 and deliberately not deferred
 * to SPRIN-103. Every negative assertion in `board-membership.integration.test.ts` comes
 * from a caller who was NEVER a member, and a never-member cannot detect the staleness
 * class: implement removal as a soft delete that `app_auth.is_project_member` forgets to
 * filter, or cache membership anywhere, and a removed member keeps full board access while
 * all seventeen of those tests stay green. Since SPRIN-100 that access is read AND write
 * over every ticket and sprint in the project, so the blast radius is the whole board.
 *
 * WHY THIS SUITE CREATES ITS OWN USERS rather than using the long-lived A and B: Vitest
 * runs test FILES in parallel against one shared live database, and
 * `project-members.integration.test.ts` makes A and B co-members of a shared project in
 * its own `beforeAll`. Fresh throwaway users sidestep the interference entirely. It also
 * keeps this file to THREE sign-ins; a full `npm test` already sits near the free-tier
 * GoTrue ceiling, so a suite that signed in per test would be a flake generator.
 *
 * EVERY ASSERTION IS SCOPED to a fixture this file created, with one deliberate exception
 * noted at its own test. Under a membership model an unscoped select is a whole-table
 * invariant whose answer depends on every concurrently running suite.
 *
 * A NOTE ON A SIBLING THIS STORY HAD TO CHANGE. `project-members.integration.test.ts`
 * asserted, whole-database, that every project has EXACTLY one admin, and its comment
 * named this story as the thing that would violate it. That assertion is now narrowed to
 * AT LEAST one: a second admin stops being a leak and becomes the feature, because
 * `set_project_member_role` promotes to `admin` on purpose and the last-admin guard is
 * only reachable with two of them. The property that survives -- every project has an
 * admin -- is exactly what this story's guard enforces, so it is a stronger statement
 * about this code than the cardinality check ever was.
 */
const PASSWORD = 'password123'

function freshEmail(tag: string): string {
  return `sprin102-${tag}-${crypto.randomUUID()}@example.com`
}

/** An address no account holds. Generated, never a literal, so it cannot go stale. */
function unregisteredEmail(): string {
  return `sprin102-ghost-${crypto.randomUUID()}@example.com`
}

/** `projects_owner_key_unique` is per OWNER, and A creates four projects. */
const usedKeys = new Set<string>()

function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  let key = `T${pick()}${pick()}${pick()}`
  while (usedKeys.has(key)) key = `T${pick()}${pick()}${pick()}`
  usedKeys.add(key)
  return key
}

/** Turns a thrown transport error into the `{ data, error }` shape. Teardown only. */
async function settled<T>(call: PromiseLike<T>): Promise<T | { data: null; error: Error }> {
  try {
    return await call
  } catch (cause) {
    return { data: null, error: cause instanceof Error ? cause : new Error(String(cause)) }
  }
}

function fixtureRow<T>(
  result: { data: T; error: { message: string } | null },
  what: string,
): NonNullable<T> {
  if (result.error) throw new Error(`Fixture: could not ${what}: ${result.error.message}`)
  if (result.data === null) throw new Error(`Fixture: ${what} returned no row`)
  return result.data as NonNullable<T>
}

function fixtureOk(result: { error: { message: string } | null }, what: string): void {
  if (result.error) throw new Error(`Fixture: could not ${what}: ${result.error.message}`)
}

const INSUFFICIENT_PRIVILEGE = '42501'
const INVALID_PARAMETER = '22023'
/** The PRIVILEGE layer's refusal -- the revoke this story applies. */
const PRIVILEGE_REFUSAL = /permission denied for table project_members/
/** An RLS refusal, which on this table would now mean the revoke had been undone. */
const RLS_REFUSAL = /violates row-level security policy/

describe.skipIf(!hasServiceRoleKey)('SPRIN-102 membership is managed only by the RPCs', () => {
  const admin = hasServiceRoleKey ? adminClient() : (undefined as never)
  const createdUserIds: string[] = []

  /** Creates every project, so `seed_project_admin` makes A its sole admin. */
  let aClient: SupabaseClient<Database>
  let aId: string
  /** A plain `member` of three of A's projects. Never an admin until a test promotes them. */
  let mClient: SupabaseClient<Database>
  let mId: string
  /**
   * Registered, and a member of NOTHING. Serves two jobs that must not be confused: the
   * TARGET of every add-by-email test, and the CALLER of the "a stranger is refused" ones.
   */
  let sClient: SupabaseClient<Database>
  let sId: string
  let sEmail: string

  /** A admin, M member. Where S gets added, and where the direct-write revoke is proved. */
  let addProjectId: string
  /** A is the SOLE admin and the only member. The last-admin guard's only honest home. */
  let soloProjectId: string
  /** A admin, M member. Promotion and demotion; ends the file with TWO admins. */
  let roleProjectId: string
  /** A admin, M member, one ticket. Removal, and the removed-member staleness class. */
  let removalProjectId: string
  let removalTicketId: string

  // `@/lib/tickets` imports `./supabase`, which calls `getEnv()` at MODULE scope -- a
  // static import would throw at file-load time whenever the environment is missing,
  // turning this file's deliberate skip into a hard error.
  let ticketInsertPayload: typeof import('@/lib/tickets').ticketInsertPayload

  async function createUser(email: string, displayName: string): Promise<string> {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    })
    if (error) throw new Error(`createUser failed for ${email}: ${error.message}`)
    const id = data.user?.id
    if (!id) throw new Error(`createUser returned no user for ${email}`)
    createdUserIds.push(id)
    return id
  }

  async function createProject(name: string): Promise<string> {
    const { data, error } = await aClient
      .from('projects')
      .insert({ owner_id: aId, name, key: runKey() })
      .select('id')
      .single()
    return fixtureRow({ data, error }, `create "${name}"`).id
  }

  /**
   * Adds M as a plain member with the SERVICE-ROLE client, not through the RPC this file
   * exists to test. A fixture must not be built out of the thing under test: were
   * `add_project_member_by_email` to insert nothing at all, an RPC-built fixture would
   * leave every later test asserting against an empty project and several would still
   * pass.
   */
  async function seedMember(project: string, userId: string): Promise<void> {
    fixtureOk(
      await admin
        .from('project_members')
        .insert({ project_id: project, user_id: userId, role: 'member' }),
      'seed a member row',
    )
  }

  /** The membership rows of one project, as the service role sees them. The read-back. */
  async function membership(project: string): Promise<{ user_id: string; role: string }[]> {
    const { data } = await admin
      .from('project_members')
      .select('user_id, role')
      .eq('project_id', project)
      .order('role', { ascending: true })
    return data ?? []
  }

  async function roleOf(project: string, userId: string): Promise<string | null> {
    const { data } = await admin
      .from('project_members')
      .select('role')
      .eq('project_id', project)
      .eq('user_id', userId)
      .maybeSingle()
    return data?.role ?? null
  }

  beforeAll(async () => {
    ;({ ticketInsertPayload } = await import('@/lib/tickets'))

    const aEmail = freshEmail('a')
    const mEmail = freshEmail('m')
    sEmail = freshEmail('s')

    aId = await createUser(aEmail, 'Admin A')
    mId = await createUser(mEmail, 'Member M')
    sId = await createUser(sEmail, 'Stranger S')

    // Ids come from the admin API's own response, so there is no `auth.getUser()` here and
    // no second auth round-trip per user -- the shape that once tripped GoTrue's limiter.
    aClient = await signInWithCredentials(aEmail, PASSWORD)
    mClient = await signInWithCredentials(mEmail, PASSWORD)
    sClient = await signInWithCredentials(sEmail, PASSWORD)

    addProjectId = await createProject('SPRIN-102 add by email')
    soloProjectId = await createProject('SPRIN-102 sole admin')
    roleProjectId = await createProject('SPRIN-102 role changes')
    removalProjectId = await createProject('SPRIN-102 removal')

    await seedMember(addProjectId, mId)
    await seedMember(roleProjectId, mId)
    await seedMember(removalProjectId, mId)
    // soloProjectId deliberately gets NO second member.

    removalTicketId = fixtureRow(
      await aClient
        .from('tickets')
        .insert(ticketInsertPayload({ project_id: removalProjectId, summary: 'Board work' }))
        .select('id')
        .single(),
      'create the removal-project ticket',
    ).id
  }, 60_000)

  afterAll(async () => {
    if (!hasServiceRoleKey) return
    // Deletes FIRST, before any assertion can throw past them. Deleting the users cascades
    // their projects, and each project cascades its members, statuses and tickets. A
    // teardown that throws before the delete strands fixture rows in the shared database,
    // which has already cost this project ten orphaned projects.
    for (const id of createdUserIds) {
      await settled(admin.auth.admin.deleteUser(id))
    }
  }, 60_000)

  describe('AC2/AC4/AC5 -- adding a member by email', () => {
    it('adds a registered address as a member', async () => {
      const { data, error } = await aClient.rpc('add_project_member_by_email', {
        p_project_id: addProjectId,
        p_email: sEmail,
        p_role: 'member',
      })

      expect(error).toBeNull()
      expect(data).toBe('added')
      expect(await roleOf(addProjectId, sId)).toBe('member')
    })

    it('matches the address after trimming and lowercasing what the admin typed', async () => {
      // An admin types an address the way a human types one. The stored value is
      // GoTrue-normalised, so the normalisation has to happen on the input side.
      const { data, error } = await aClient.rpc('add_project_member_by_email', {
        p_project_id: roleProjectId,
        p_email: `  ${sEmail.toUpperCase()} `,
        p_role: 'member',
      })

      expect(error).toBeNull()
      expect(data).toBe('added')
      expect(await roleOf(roleProjectId, sId)).toBe('member')
    })

    it('AC4 -- reports an unregistered address and changes nothing', async () => {
      const before = await membership(soloProjectId)

      const { data, error } = await aClient.rpc('add_project_member_by_email', {
        p_project_id: soloProjectId,
        p_email: unregisteredEmail(),
        p_role: 'member',
      })

      expect(error).toBeNull()
      expect(data).toBe('no_such_user')
      // "Changes nothing" is the half of AC4 a tag assertion alone does not cover.
      expect(await membership(soloProjectId)).toEqual(before)
    })

    it('AC5 -- reports an existing member rather than erroring', async () => {
      const { data, error } = await aClient.rpc('add_project_member_by_email', {
        p_project_id: addProjectId,
        p_email: sEmail,
        p_role: 'member',
      })

      expect(error).toBeNull()
      expect(data).toBe('already_member')
    })

    it('does NOT promote an existing member when the add names a higher role', async () => {
      // The tempting implementation is an upsert that sets the role. AC5 asks for the add
      // to be REPORTED, and a silent promotion out of the add box is not what an admin
      // typed -- it is also a privilege escalation with no confirmation step in front of it.
      const { data, error } = await aClient.rpc('add_project_member_by_email', {
        p_project_id: addProjectId,
        p_email: sEmail,
        p_role: 'admin',
      })

      expect(error).toBeNull()
      expect(data).toBe('already_member')
      expect(await roleOf(addProjectId, sId)).toBe('member')
    })

    it('refuses a role outside the vocabulary', async () => {
      const { error } = await aClient.rpc('add_project_member_by_email', {
        p_project_id: addProjectId,
        p_email: sEmail,
        p_role: 'owner',
      })

      expect(error?.code).toBe(INVALID_PARAMETER)
    })
  })

  describe('AC3 -- only an admin may call the RPCs', () => {
    it('refuses a plain member', async () => {
      const { error } = await mClient.rpc('add_project_member_by_email', {
        p_project_id: addProjectId,
        p_email: sEmail,
        p_role: 'member',
      })

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/Only a project admin may add members/)
    })

    it('refuses a stranger', async () => {
      const { error } = await sClient.rpc('add_project_member_by_email', {
        p_project_id: soloProjectId,
        p_email: sEmail,
        p_role: 'admin',
      })

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
    })

    it('does not leak whether an address is registered', async () => {
      // THE ORDERING TEST. Swap the admin check and the email lookup in the function body
      // and every other test in this describe stays green -- the non-admin is still
      // refused. What changes is that the refusal starts DEPENDING on the address, which
      // is an enumeration oracle for anyone with an account. Two calls, one address that
      // exists and one that does not, and the failures must be indistinguishable.
      const registered = await sClient.rpc('add_project_member_by_email', {
        p_project_id: addProjectId,
        p_email: sEmail,
        p_role: 'member',
      })
      const unregistered = await sClient.rpc('add_project_member_by_email', {
        p_project_id: addProjectId,
        p_email: unregisteredEmail(),
        p_role: 'member',
      })

      expect(registered.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(unregistered.error?.code).toBe(registered.error?.code)
      expect(unregistered.error?.message).toBe(registered.error?.message)
      expect(unregistered.data).toBe(registered.data)
    })

    it('refuses a member on the role and removal RPCs too, not just on add', async () => {
      const role = await mClient.rpc('set_project_member_role', {
        p_project_id: addProjectId,
        p_user_id: sId,
        p_role: 'admin',
      })
      const removal = await mClient.rpc('remove_project_member', {
        p_project_id: addProjectId,
        p_user_id: sId,
      })

      expect(role.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(removal.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      // The row survived both refusals.
      expect(await roleOf(addProjectId, sId)).toBe('member')
    })

    it('is not callable by an anonymous request at all', async () => {
      const { error } = await anonClient().rpc('add_project_member_by_email', {
        p_project_id: addProjectId,
        p_email: sEmail,
        p_role: 'member',
      })

      // anon holds no EXECUTE, so this is refused at the privilege layer -- before the
      // function's own admin check, and before `auth.uid()` is consulted.
      expect(error).not.toBeNull()
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
    })
  })

  describe('AC2 -- changing a role', () => {
    it('promotes a member to admin', async () => {
      const { data, error } = await aClient.rpc('set_project_member_role', {
        p_project_id: roleProjectId,
        p_user_id: mId,
        p_role: 'admin',
      })

      expect(error).toBeNull()
      expect(data).toBe('updated')
      expect(await roleOf(roleProjectId, mId)).toBe('admin')
    })

    it('demotes an admin once a second one exists', async () => {
      // Depends on the promotion above, which is why it follows it: with A and M both
      // admins, demoting M is permitted and the guard must NOT fire.
      const { data, error } = await aClient.rpc('set_project_member_role', {
        p_project_id: roleProjectId,
        p_user_id: mId,
        p_role: 'member',
      })

      expect(error).toBeNull()
      expect(data).toBe('updated')
      expect(await roleOf(roleProjectId, mId)).toBe('member')
    })

    it('reports a no-op rather than pretending to write', async () => {
      const { data, error } = await aClient.rpc('set_project_member_role', {
        p_project_id: roleProjectId,
        p_user_id: mId,
        p_role: 'member',
      })

      expect(error).toBeNull()
      expect(data).toBe('unchanged')
    })

    it('reports a user who is not a member', async () => {
      const { data, error } = await aClient.rpc('set_project_member_role', {
        p_project_id: soloProjectId,
        p_user_id: mId,
        p_role: 'member',
      })

      expect(error).toBeNull()
      expect(data).toBe('not_a_member')
      expect(await roleOf(soloProjectId, mId)).toBeNull()
    })
  })

  describe('AC6 -- a project must always have an admin', () => {
    it('refuses to demote the last admin, and the row survives', async () => {
      const { data, error } = await aClient.rpc('set_project_member_role', {
        p_project_id: soloProjectId,
        p_user_id: aId,
        p_role: 'member',
      })

      expect(error).toBeNull()
      expect(data).toBe('last_admin')
      // The tag alone would pass against a function that returned it AFTER writing.
      expect(await roleOf(soloProjectId, aId)).toBe('admin')
    })

    it('refuses to remove the last admin, and the row survives', async () => {
      const { data, error } = await aClient.rpc('remove_project_member', {
        p_project_id: soloProjectId,
        p_user_id: aId,
      })

      expect(error).toBeNull()
      expect(data).toBe('last_admin')
      expect(await roleOf(soloProjectId, aId)).toBe('admin')
    })

    it('lets an admin remove THEMSELVES once a second admin exists', async () => {
      // The ordinary hand-over: promote a successor, then leave. Refusing this would make
      // the guard a rule about identity rather than about cardinality.
      const promoted = await aClient.rpc('set_project_member_role', {
        p_project_id: addProjectId,
        p_user_id: mId,
        p_role: 'admin',
      })
      expect(promoted.data).toBe('updated')

      const { data, error } = await aClient.rpc('remove_project_member', {
        p_project_id: addProjectId,
        p_user_id: aId,
      })

      expect(error).toBeNull()
      expect(data).toBe('removed')
      expect(await roleOf(addProjectId, aId)).toBeNull()
      // And the project still has an admin, which is the invariant the guard defends.
      expect(await roleOf(addProjectId, mId)).toBe('admin')
    })

    it('never leaves a project with zero members', async () => {
      // The SPRIN-101 residual, closed by construction rather than by a separate rule: an
      // admin row IS a member row, so "at least one admin" implies "at least one member",
      // and `projects_member_read`'s bootstrap disjunct can never hand a removed owner
      // their read back. Scoped to this file's four projects.
      for (const project of [addProjectId, soloProjectId, roleProjectId, removalProjectId]) {
        const rows = await membership(project)
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.some((r) => r.role === 'admin')).toBe(true)
      }
    })
  })

  describe('AC2 -- removing a member, and what removal must actually revoke', () => {
    it('POSITIVE CONTROL: the member can read the board BEFORE removal', async () => {
      // Without this, the assertion after removal proves nothing: a member who never had
      // access reads zero rows both times. This is the control that makes the next test
      // mean something.
      const { data, error } = await mClient.from('tickets').select('id').eq('id', removalTicketId)

      expect(error).toBeNull()
      expect(data).toEqual([{ id: removalTicketId }])
    })

    it('removes the member', async () => {
      const { data, error } = await aClient.rpc('remove_project_member', {
        p_project_id: removalProjectId,
        p_user_id: mId,
      })

      expect(error).toBeNull()
      expect(data).toBe('removed')
      expect(await roleOf(removalProjectId, mId)).toBeNull()
    })

    it('reports a user who was never a member', async () => {
      const { data, error } = await aClient.rpc('remove_project_member', {
        p_project_id: removalProjectId,
        p_user_id: sId,
      })

      expect(error).toBeNull()
      expect(data).toBe('not_a_member')
    })

    it('THE STALENESS CLASS: the removed member loses board READ immediately', async () => {
      const { data, error } = await mClient.from('tickets').select('id').eq('id', removalTicketId)

      // RLS FILTERS on USING, so this is an empty result and not an error.
      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('THE STALENESS CLASS: the removed member loses board WRITE immediately', async () => {
      // Read and write are co-extensive on the board tables by design, but they are
      // separate clauses of the same policy, so both are asserted. Since SPRIN-100 a
      // member could delete every ticket in the project, which is why this is not
      // satisfied by the read test above.
      const update = await mClient
        .from('tickets')
        .update({ summary: 'Written by a removed member' })
        .eq('id', removalTicketId)
        .select('id')

      // A refused UPDATE comes back as zero rows, NOT as an error -- indistinguishable
      // from a successful one unless the count is checked and the row is read back.
      expect(update.error).toBeNull()
      expect(update.data).toEqual([])

      const { data: intact } = await admin
        .from('tickets')
        .select('summary')
        .eq('id', removalTicketId)
        .single()
      expect(intact?.summary).toBe('Board work')
    })
  })

  describe('the RPCs are the ONLY write path', () => {
    it('an ADMIN cannot INSERT a membership row directly', async () => {
      const { error } = await aClient
        .from('project_members')
        .insert({ project_id: roleProjectId, user_id: sId, role: 'admin' })

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      // The PRIVILEGE layer, not RLS. If this ever matched the RLS message instead, the
      // revoke would have been undone and `members_admin_insert` would be back in front.
      expect(error?.message).toMatch(PRIVILEGE_REFUSAL)
      expect(error?.message).not.toMatch(RLS_REFUSAL)
    })

    it('an ADMIN cannot UPDATE a role directly', async () => {
      const { error } = await aClient
        .from('project_members')
        .update({ role: 'admin' })
        .eq('project_id', roleProjectId)
        .eq('user_id', mId)

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(PRIVILEGE_REFUSAL)
      expect(await roleOf(roleProjectId, mId)).toBe('member')
    })

    it('an ADMIN cannot DELETE a membership row directly', async () => {
      const { error } = await aClient
        .from('project_members')
        .delete()
        .eq('project_id', roleProjectId)
        .eq('user_id', mId)

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(PRIVILEGE_REFUSAL)
      expect(await roleOf(roleProjectId, mId)).toBe('member')
    })

    it('POSITIVE CONTROL: the same admin can still READ the membership rows', async () => {
      // Without this, every test above would pass against a table `authenticated` had lost
      // ALL access to -- including the SELECT the members list is rendered from.
      const { data, error } = await aClient
        .from('project_members')
        .select('user_id, role')
        .eq('project_id', roleProjectId)

      expect(error).toBeNull()
      expect(data?.length).toBeGreaterThan(0)
    })
  })
})
