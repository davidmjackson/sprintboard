// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminClient, assertServiceRoleOrExplain, hasServiceRoleKey } from './supabase-clients'
import { PgSession, assertDbUrlOrExplain, hasDbUrl, waitUntilBlocked } from './pg-sessions'

assertServiceRoleOrExplain()
assertDbUrlOrExplain()

/**
 * SPRIN-107 — the last-admin guard holds under CONCURRENT callers, not just sequential ones.
 *
 * `member-management.integration.test.ts` already pins every sequential contract of the
 * three membership RPCs, and it stayed green through the whole of the defect this file
 * exists for. That is not a gap in it: no sequence of PostgREST requests can express the
 * bug, because the window is between two statements INSIDE one transaction and PostgREST
 * never lends the caller a transaction. Proving this needed a different instrument, which
 * is `pg-sessions.ts` — read its header for why two raw sessions, and why nothing here is
 * a race in the flaky sense.
 *
 * WHAT THE DEFECT WAS. `remove_project_member` read the target's role UNLOCKED, and took
 * its `for update` lock only inside `if v_current = 'admin'`. So removing a plain member
 * took no lock at all, and the DELETE that followed carried no `role` predicate. A member
 * promoted to sole admin in that window was deleted straight past the guard, leaving the
 * project with ZERO admins — unadministerable and, since SPRIN-101 routed
 * `projects_admin_delete` through `app_auth.is_project_admin` too, undeletable by any
 * authenticated user. SPRIN-102's migration asserted in prose that "no path through these
 * three functions can empty a project". This file is that sentence made executable.
 *
 * WHY THE ASSERTION IS AN ADMIN COUNT AND NOT A RETURN TAG. The tag is checked too, because
 * it is the documented contract, but the invariant under test is a property of the DATA:
 * every project has at least one admin. Written the other way round — assert `last_admin`
 * and stop — the test would pass against a fix that returned the right word while still
 * deleting the row.
 *
 * BOTH TESTS FAIL CLOSED ON A LOST INTERLEAVING. If `waitUntilBlocked` cannot observe the
 * second session parked on the lock it throws rather than proceeding, so a run that failed
 * to establish the interleaving reports as an error and never as a pass. A concurrency test
 * that quietly degrades into a sequential one is the failure mode this guards.
 */
const PASSWORD = 'password123'

function freshEmail(tag: string): string {
  return `sprin107-${tag}-${crypto.randomUUID()}@example.com`
}

interface Fixture {
  projectId: string
  ownerId: string
  otherId: string
}

describe.skipIf(!hasServiceRoleKey || !hasDbUrl)(
  'SPRIN-107 the last-admin guard under concurrency',
  () => {
    const admin = hasServiceRoleKey ? adminClient() : (undefined as never)
    const createdUserIds: string[] = []

    /** Parks its transaction open, holding the row lock that pins the interleaving. */
    let sessionA: PgSession
    /** Runs the call under test and blocks inside it. */
    let sessionB: PgSession
    /** Never enters `actAs`: `pg_stat_activity` hides other roles from a non-superuser, and
     *  this session also does the fixture setup and the final reads. */
    let observer: PgSession

    beforeAll(async () => {
      ;[sessionA, sessionB, observer] = await Promise.all([
        PgSession.open('a'),
        PgSession.open('b'),
        PgSession.open('obs'),
      ])
    }, 60_000)

    afterAll(async () => {
      // Sessions first: a still-open transaction would hold locks on rows the cascade below
      // has to delete, and the delete would block until the statement timeout fired.
      await Promise.all([sessionA?.end(), sessionB?.end(), observer?.end()])
      for (const id of createdUserIds) {
        await admin.auth.admin.deleteUser(id)
      }
    }, 60_000)

    async function createUser(tag: string): Promise<{ id: string; email: string }> {
      const email = freshEmail(tag)
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: tag },
      })
      if (error) throw new Error(`createUser failed for ${email}: ${error.message}`)
      const id = data.user?.id
      if (!id) throw new Error(`createUser returned no user for ${email}`)
      createdUserIds.push(id)
      return { id, email }
    }

    /**
     * A project owned by a fresh user, with a second fresh user added as `member`.
     *
     * Built through the real write paths — an INSERT as the authenticated owner, so
     * `seed_project_admin` seeds their admin row, and `add_project_member_by_email` for the
     * second user — rather than by writing `project_members` directly, which SPRIN-102
     * revoked anyway. A fixture assembled behind the controls under test can seed a state
     * the application cannot reach, and then prove something about a state that never occurs.
     */
    async function projectWithMember(tag: string): Promise<Fixture> {
      const owner = await createUser(`${tag}-owner`)
      const other = await createUser(`${tag}-other`)

      await observer.begin()
      await observer.actAs(owner.id)
      const rows = await observer.query<{ id: string }>(
        `insert into public.projects (owner_id, name, key) values ($1, $2, $3) returning id`,
        [owner.id, `SPRIN-107 ${tag}`, `C${tag.slice(0, 3).toUpperCase()}`],
      )
      const projectId = rows[0]?.id
      if (!projectId) throw new Error(`Fixture: project insert for ${tag} returned no row.`)

      const added = await observer.query<{ tag: string }>(
        `select public.add_project_member_by_email($1, $2, 'member') as tag`,
        [projectId, other.email],
      )
      if (added[0]?.tag !== 'added') {
        throw new Error(`Fixture: adding ${other.email} returned ${added[0]?.tag}.`)
      }
      await observer.commit()

      return { projectId, ownerId: owner.id, otherId: other.id }
    }

    async function adminIdsOf(projectId: string): Promise<string[]> {
      const rows = await observer.query<{ user_id: string }>(
        `select user_id from public.project_members
        where project_id = $1 and role = 'admin' order by user_id`,
        [projectId],
      )
      return rows.map((row) => row.user_id)
    }

    /**
     * SPRIN-107 REVIEW, MEDIUM. `actAs` does two things, and only one of them was defended:
     * deleting `set_config('request.jwt.claims', ...)` turned the suite red, but deleting
     * `set local role authenticated` left it GREEN. The connection authenticates as `postgres`,
     * which holds pg_read_all_data and membership of every application role, so without the role
     * switch every test here would sail through privilege checks the app is actually subject to —
     * the SPRIN-102 revoke on direct `project_members` writes, and every EXECUTE grant — and
     * would keep passing if all of them were wrong.
     *
     * This pins both halves at once, and it is deliberately the FIRST test in the file: if the
     * harness is not faithful, nothing below it means anything.
     */
    it('acts as an authenticated user, not as the superuser it connects as', async () => {
      const asConnected = await observer.query<{ role: string }>('select current_user as role')
      expect(asConnected[0]?.role).toBe('postgres')

      const impersonated = '00000000-0000-0000-0000-000000000000'
      await observer.begin()
      await observer.actAs(impersonated)
      const inside = await observer.query<{ role: string; uid: string | null }>(
        'select current_user as role, auth.uid()::text as uid',
      )
      await observer.rollback()

      expect(inside[0]?.role).toBe('authenticated')
      expect(inside[0]?.uid).toBe(impersonated)

      // `set local` means the transaction is the whole lifetime of both settings.
      const after = await observer.query<{ role: string }>('select current_user as role')
      expect(after[0]?.role).toBe('postgres')
    }, 60_000)

    it('does not delete a member who becomes the sole admin mid-removal', async () => {
      const { projectId, ownerId, otherId } = await projectWithMember('handover')

      // A begins an ordinary hand-over and does NOT commit. The promotion's UPDATE takes a
      // row lock on the other user, and holds it — this is the pin that makes the window
      // wide enough to step through, and the reason nothing here is timing-dependent.
      await sessionA.begin()
      await sessionA.actAs(ownerId)
      await sessionA.query(`select public.set_project_member_role($1, $2, 'admin')`, [
        projectId,
        otherId,
      ])

      // B starts removing the same user. It reads their COMMITTED role — still `member`,
      // because A has not committed — skips the guard branch on that basis, and then blocks
      // on A's row lock at the DELETE. Deliberately not awaited: B is parked mid-function.
      await sessionB.begin()
      await sessionB.actAs(ownerId)
      const removal = sessionB.query<{ tag: string }>(
        `select public.remove_project_member($1, $2) as tag`,
        [projectId, otherId],
      )
      await waitUntilBlocked(observer, sessionB.pid)

      // A finishes the hand-over: the owner steps down while two admins exist, so their own
      // removal passes the guard honestly. Committing releases the lock B is waiting on.
      await sessionA.query(`select public.remove_project_member($1, $2)`, [projectId, ownerId])
      await sessionA.commit()

      const tag = (await removal)[0]?.tag
      await sessionB.commit()

      // THE INVARIANT. Before the fix this read an empty array: B's DELETE carried no role
      // predicate, so it removed the user A had just made the only admin.
      expect(await adminIdsOf(projectId)).toEqual([otherId])
      expect(tag).toBe('last_admin')
    }, 60_000)

    it('does not let two admins demote each other into an adminless project', async () => {
      const { projectId, ownerId, otherId } = await projectWithMember('mutual')

      await observer.begin()
      await observer.actAs(ownerId)
      await observer.query(`select public.set_project_member_role($1, $2, 'admin')`, [
        projectId,
        otherId,
      ])
      await observer.commit()

      // Both admins step down at once. A's demotion locks every admin row in the project and
      // does not commit; B's blocks on that lock rather than reading a stale count of two.
      await sessionA.begin()
      await sessionA.actAs(ownerId)
      await sessionA.query(`select public.set_project_member_role($1, $2, 'member')`, [
        projectId,
        ownerId,
      ])

      await sessionB.begin()
      await sessionB.actAs(otherId)
      const demotion = sessionB.query<{ tag: string }>(
        `select public.set_project_member_role($1, $2, 'member') as tag`,
        [projectId, otherId],
      )
      await waitUntilBlocked(observer, sessionB.pid)

      await sessionA.commit()
      const tag = (await demotion)[0]?.tag
      await sessionB.commit()

      // This path was already sound — `set_project_member_role` takes its lock before the
      // count, so B re-evaluates against one remaining admin instead of the two it first saw.
      // It is here because SPRIN-102's migration claims it in a comment and nothing tested it,
      // and because a harness that only ever reports red proves less than one that can also
      // agree a path is safe.
      expect(await adminIdsOf(projectId)).toEqual([otherId])
      expect(tag).toBe('last_admin')
    }, 60_000)
  },
)
