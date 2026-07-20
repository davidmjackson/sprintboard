// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import {
  assertCredentialsOrExplain,
  hasRlsCredentials,
  RLS_USERS,
  signIn,
  userId,
} from './supabase-clients'

assertCredentialsOrExplain()

/**
 * S6.1 — the sprint-creation contract `createSprint` relies on, proven live: the `status`
 * column defaults to `'future'` (the AC, owned by the database rather than the client),
 * optional fields really are optional, and a cross-tenant insert is rejected. Uses the
 * signed-in RLS user, since sprint inserts are owner-scoped through the project.
 */
function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `S${pick()}${pick()}${pick()}`
}

describe.skipIf(!hasRlsCredentials)('S6.1 sprint-creation contract', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let projectId: string

  beforeAll(async () => {
    a = await signIn('A')
    userAId = await userId(a)
    b = await signIn('B')
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Sprint contract', key: runKey() })
      .select()
      .single()
    if (error) throw error
    projectId = data!.id
  }, 30_000)

  afterAll(async () => {
    // Deleting the project cascades to its sprints (sprints.project_id on delete cascade).
    await a.from('projects').delete().eq('id', projectId)
  }, 30_000)

  it('defaults status to future when the client does not send it', async () => {
    const { data, error } = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Default status' })
      .select()
      .single()

    expect(error).toBeNull()
    // The AC, proven at the database. `createSprint` never sends status, so this default
    // is the only thing making a new sprint 'future'.
    expect(data!.status).toBe('future')
  })

  it('accepts a sprint with only a name — goal and dates are optional', async () => {
    const { data, error } = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Bare sprint' })
      .select()
      .single()

    expect(error).toBeNull()
    expect(data!.goal).toBeNull()
    expect(data!.start_date).toBeNull()
    expect(data!.end_date).toBeNull()
  })

  it('round-trips a UTC-midnight date as the same calendar day', async () => {
    const { data, error } = await a
      .from('sprints')
      .insert({
        project_id: projectId,
        name: 'Dated sprint',
        start_date: '2026-07-20T00:00:00.000Z',
        end_date: '2026-08-03T00:00:00.000Z',
      })
      .select()
      .single()

    expect(error).toBeNull()
    expect(new Date(data!.start_date!).toISOString().slice(0, 10)).toBe('2026-07-20')
    expect(new Date(data!.end_date!).toISOString().slice(0, 10)).toBe('2026-08-03')
  })

  it('allows two sprints with the same name — names are labels, not identifiers', async () => {
    // This is what makes count-based auto-naming safe: a collision is cosmetic.
    await a.from('sprints').insert({ project_id: projectId, name: 'Twin' })
    const { error } = await a.from('sprints').insert({ project_id: projectId, name: 'Twin' })

    expect(error).toBeNull()
  })

  it("rejects user B inserting a sprint into user A's project", async () => {
    const { error } = await b
      .from('sprints')
      .insert({ project_id: projectId, name: 'Cross-tenant' })
      .select()
      .single()

    // RLS rejects the write outright (42501), rather than filtering it — an insert has no
    // rows to filter. Paired with the positive controls above, which prove A *can* insert.
    expect(error?.code).toBe('42501')
  })

  it("does not leak user A's sprints to user B", async () => {
    // RLS filters selects, it does not raise — so count rows, never trust a missing error.
    const { data, error } = await b.from('sprints').select().eq('project_id', projectId)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })
})

/**
 * S6.3/S6.4 — starting and completing a sprint, proven live. Drives the app's `startSprint`
 * and `completeSprint` (the functions the Start/Complete buttons call), signed in through the
 * module-scope `supabase` singleton as user A — the same object the browser uses. Every
 * assertion is a re-read through `a`, a different client, so a function that merely echoed its
 * input back would not pass. `afterEach` wipes the project's tickets and sprints so each test
 * starts from zero, with no order dependency between them. Folded into one block, rather than
 * a second `describe` with its own `beforeAll`, to keep sign-ins down against the live-suite
 * auth rate-limit.
 */
describe.skipIf(!hasRlsCredentials)(
  'S6.3/S6.4 sprint lifecycle via startSprint/completeSprint',
  () => {
    let a: SupabaseClient<Database>
    let userAId: string
    let projectId: string
    let appClient: typeof import('@/lib/supabase').supabase
    let startSprint: typeof import('@/lib/sprints').startSprint
    let completeSprint: typeof import('@/lib/sprints').completeSprint

    beforeAll(async () => {
      a = await signIn('A')
      userAId = await userId(a)

      const { data, error } = await a
        .from('projects')
        .insert({ owner_id: userAId, name: 'Start sprint', key: runKey() })
        .select()
        .single()
      if (error) throw error
      projectId = data!.id

      // Dynamic import: `@/lib/supabase` calls `getEnv()` at module scope, so a static import
      // would throw at module load when the env is absent, turning this file's loud skip into a
      // hard error. Inside a skipIf'd beforeAll it only runs when credentials are present.
      ;({ supabase: appClient } = await import('@/lib/supabase'))
      ;({ startSprint, completeSprint } = await import('@/lib/sprints'))

      const { email, password } = RLS_USERS.A
      const { error: authErr } = await appClient.auth.signInWithPassword({
        email: email!,
        password: password!,
      })
      if (authErr) throw authErr
    }, 30_000)

    afterEach(async () => {
      // Reset to zero sprints so each test is independent of order (one leaves an active one).
      // Tickets first: deleting a sprint only nulls sprint_id, it does not remove the ticket.
      await a.from('tickets').delete().eq('project_id', projectId)
      await a.from('sprints').delete().eq('project_id', projectId)
    }, 30_000)

    afterAll(async () => {
      // Delete first (load-bearing against the shared DB), sign out second.
      await a.from('projects').delete().eq('id', projectId)
      await appClient?.auth.signOut()
    }, 30_000)

    async function newFutureSprint(name: string): Promise<string> {
      const { data, error } = await a
        .from('sprints')
        .insert({ project_id: projectId, name, status: 'future' })
        .select()
        .single()
      if (error) throw error
      expect(data!.status).toBe('future') // a real starting point, or the transition proves nothing
      return data!.id
    }

    async function ticketInSprint(sprintId: string, status: string): Promise<string> {
      const { data, error } = await a
        .from('tickets')
        .insert({
          project_id: projectId,
          summary: `T ${status}`,
          type: 'task',
          status,
          sprint_id: sprintId,
        })
        .select()
        .single()
      if (error) throw error
      return data!.id
    }

    it('starts a future sprint: status becomes active', async () => {
      const id = await newFutureSprint('Solo')

      const result = await startSprint(id)
      expect(result.ok).toBe(true)

      const { data, error } = await a.from('sprints').select('status').eq('id', id).single()
      expect(error).toBeNull()
      expect(data!.status).toBe('active')
    }, 30_000)

    it('rejects starting a second sprint while one is active (partial unique index)', async () => {
      const first = await newFutureSprint('First')
      const second = await newFutureSprint('Second')

      // Positive control: the first start must succeed, or the rejection below is meaningless.
      const started = await startSprint(first)
      expect(started.ok).toBe(true)

      const blocked = await startSprint(second)
      expect(blocked).toEqual({ ok: false, error: 'already_active' })

      // The second sprint is untouched — rejected, not silently applied.
      const { data, error } = await a.from('sprints').select('status').eq('id', second).single()
      expect(error).toBeNull()
      expect(data!.status).toBe('future')
    }, 30_000)

    it("rejects starting another user's sprint: RLS scopes the write, no cross-tenant mutation", async () => {
      // A owns a future sprint. `startSprint` closes over the app singleton, so to drive the
      // app write path AS user B we sign that singleton in as B for the duration of the call,
      // then restore A in `finally` — the singleton's auth outlives this test otherwise.
      const id = await newFutureSprint('Cross-tenant')

      const asB = RLS_USERS.B
      await appClient.auth.signInWithPassword({ email: asB.email!, password: asB.password! })
      try {
        // `sprints_owner` scopes the UPDATE through the owned project: B's write matches ZERO
        // rows (not A's row), `.single()` then errors, and startSprint maps that to 'unknown' —
        // never 'already_active' (which would leak that the row exists), never a mutation.
        const result = await startSprint(id)
        expect(result).toEqual({ ok: false, error: 'unknown' })
      } finally {
        const asA = RLS_USERS.A
        await appClient.auth.signInWithPassword({ email: asA.email!, password: asA.password! })
      }

      // Re-read as A: the sprint is untouched — proof the cross-tenant call filtered to zero
      // rows rather than flipping A's sprint to active.
      const { data, error } = await a.from('sprints').select('status').eq('id', id).single()
      expect(error).toBeNull()
      expect(data!.status).toBe('future')
    }, 30_000)

    it('completes a sprint: status complete, incomplete tickets to backlog, Done tickets retained', async () => {
      const id = await newFutureSprint('To complete')
      const started = await startSprint(id)
      expect(started.ok).toBe(true) // positive control — an active sprint is the real precondition

      const doneId = await ticketInSprint(id, 'done')
      const todoId = await ticketInSprint(id, 'todo')

      const result = await completeSprint(id)
      expect(result.ok).toBe(true)

      // AC1: status complete.
      const { data: s } = await a.from('sprints').select('status').eq('id', id).single()
      expect(s!.status).toBe('complete')

      // AC2: the incomplete ticket returned to the backlog.
      const { data: todo } = await a.from('tickets').select('sprint_id').eq('id', todoId).single()
      expect(todo!.sprint_id).toBeNull()

      // AC3: the Done ticket kept its Done status AND its sprint history (sprint_id).
      const { data: done } = await a
        .from('tickets')
        .select('sprint_id, status')
        .eq('id', doneId)
        .single()
      expect(done!.sprint_id).toBe(id)
      expect(done!.status).toBe('done')
    }, 30_000)

    it("rejects completing another user's sprint: RLS scopes both writes, no cross-tenant mutation", async () => {
      const id = await newFutureSprint('Cross-tenant complete')
      await startSprint(id)
      const todoId = await ticketInSprint(id, 'todo')

      const asB = RLS_USERS.B
      await appClient.auth.signInWithPassword({ email: asB.email!, password: asB.password! })
      try {
        // Both statements filter to zero rows for B; the status flip's `.single()` errors →
        // 'unknown', never leaking existence, never mutating A's data.
        const result = await completeSprint(id)
        expect(result).toEqual({ ok: false, error: 'unknown' })
      } finally {
        const asA = RLS_USERS.A
        await appClient.auth.signInWithPassword({ email: asA.email!, password: asA.password! })
      }

      // Re-read as A: the sprint is still active AND its ticket unmoved — proof the bulk update
      // filtered to zero rows for B too, not just the sprint update.
      const { data: s } = await a.from('sprints').select('status').eq('id', id).single()
      expect(s!.status).toBe('active')
      const { data: t } = await a.from('tickets').select('sprint_id').eq('id', todoId).single()
      expect(t!.sprint_id).toBe(id)
    }, 30_000)
  },
)
