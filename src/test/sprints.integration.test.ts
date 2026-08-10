// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import type { ProjectStatus } from '@/lib/domain'
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

  /**
   * SPRIN-95 AC1 — the DATABASE rejects an end date before its start, not only the client's
   * zod `refine`. The CONSTRAINT NAME is asserted, not just the SQLSTATE: `sprints_status_check`
   * also lives on this table, so a bare 23514 would pass on a violation this test is not about.
   * Same discipline as projects.integration.test.ts's SPRIN-94 range tests.
   */
  it('rejects a sprint that ends before it starts (sprints_end_not_before_start -> 23514)', async () => {
    const { data, error } = await a
      .from('sprints')
      .insert({
        project_id: projectId,
        name: 'Backwards',
        start_date: '2026-08-03T00:00:00.000Z',
        end_date: '2026-07-20T00:00:00.000Z',
      })
      .select('id')
      .single()

    expect(data).toBeNull()
    expect(error?.code).toBe('23514')
    expect(error?.message).toContain('sprints_end_not_before_start')
  })

  /**
   * SPRIN-95 AC2 — a same-day sprint is legal, so the constraint is `>=` and not `>`. A
   * regression guard on the constraint's reach: it is legal before the migration too, and it is
   * what would catch a `>` shipped by mistake.
   */
  it('accepts a sprint whose start and end are the same instant (SPRIN-95 AC2)', async () => {
    // A date NO other test in this file writes. It used to be '2026-07-20T00:00:00.000Z',
    // which is exactly the start_date the "round-trips a UTC-midnight date" test above
    // inserts into this same project — so retargeting the re-read below at that row left
    // `expect(row.start_date).toBe(day)` still passing, and half the re-read discriminated
    // against nothing. A re-read is only evidence if it can name the row it did NOT find.
    const day = '2026-09-14T00:00:00.000Z'
    const { data, error } = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Same day', start_date: day, end_date: day })
      .select('id')
      .single()

    expect(error).toBeNull()

    // Re-read through a SECOND query rather than trusting the row the insert echoed back: an
    // insert that returned its own input would satisfy a bare `expect(error).toBeNull()`.
    const { data: row, error: readErr } = await a
      .from('sprints')
      .select('start_date, end_date')
      .eq('id', data!.id)
      .single()

    expect(readErr).toBeNull()
    expect(new Date(row!.start_date!).toISOString()).toBe(day)
    expect(new Date(row!.end_date!).toISOString()).toBe(day)
  })

  /**
   * SPRIN-95 AC3 — `end_date >= start_date` is NULL when either side is null, and a CHECK
   * passes on NULL, so a half-dated sprint stays legal in both directions. (Neither date set is
   * already covered by "only a name" above.)
   *
   * WHAT THIS GUARDS, stated as narrowly as it is true: that nobody later adds a `not null` to
   * either column. Both are nullable today, and a `not null` on either would earn 23502 on one
   * of these two inserts.
   *
   * WHAT IT DOES NOT GUARD, though this docblock used to claim it did: "the constraint being
   * written without a needless null branch". No insert can tell those two forms apart —
   * `null >= x` and `(null >= x or null is null or x is null)` BOTH cause a CHECK to pass, so
   * this test is green either way. Only reading the constraint's own definition discriminates,
   * which is what the migration's `pg_get_constraintdef` assertion does.
   */
  it('accepts either date alone — a null end or a null start (SPRIN-95 AC3)', async () => {
    const day = '2026-07-20T00:00:00.000Z'
    const startOnly = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Start only', start_date: day })
      .select('id')
      .single()
    const endOnly = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'End only', end_date: day })
      .select('id')
      .single()

    expect(startOnly.error).toBeNull()
    expect(endOnly.error).toBeNull()

    // Re-read both rows, for the same reason AC2 does.
    const { data: rows, error } = await a
      .from('sprints')
      .select('id, start_date, end_date')
      .in('id', [startOnly.data!.id, endOnly.data!.id])

    expect(error).toBeNull()
    expect(rows).toHaveLength(2)
    const byId = new Map(rows!.map((r) => [r.id, r]))
    expect(new Date(byId.get(startOnly.data!.id)!.start_date!).toISOString()).toBe(day)
    expect(byId.get(startOnly.data!.id)!.end_date).toBeNull()
    expect(byId.get(endOnly.data!.id)!.start_date).toBeNull()
    expect(new Date(byId.get(endOnly.data!.id)!.end_date!).toISOString()).toBe(day)
  })

  /**
   * SPRIN-95 — the path where the constraint actually EARNS ITS KEEP: the only one of the four
   * with no client-side guard standing in front of it.
   *
   * Every other SPRIN-95 test here is an INSERT, and an insert is the path the client's zod
   * `refine` already guards: `CreateSprintDialog` never issues the request, so no UI reaches the
   * constraint that way. **PostgREST plainly does** — the AC1 test three tests above sends a
   * backwards insert straight through it and collects its 23514, which is the whole reason that
   * test can exist. An earlier draft of this docblock said the insert path was "unreachable",
   * flatly contradicting the test above it; the true claim is narrower and is about the UI.
   *
   * An UPDATE has no UI edge at all, which is the difference. Measured on the live database 2026-08-10,
   * `pg_class.relacl` for `public.sprints` is `authenticated=arwdDxtm` — the `w` is table-wide
   * UPDATE — and `sprints_owner` is a single `for all` policy, so any authenticated user can
   * PATCH `start_date`/`end_date` on their own sprint straight through PostgREST. There is no
   * edit-sprint UI and therefore no `refine` anywhere in the way. This is the half of
   * "validate at both edges" that has no other edge.
   *
   * The re-read is the second half of the claim: a refused write must leave the row exactly as
   * it was, not apply and then complain. `expect(error).not.toBeNull()` alone cannot tell those
   * apart.
   */
  it('rejects an UPDATE that moves the end date before the start (SPRIN-95)', async () => {
    const start = '2026-10-05T00:00:00.000Z'
    const end = '2026-10-19T00:00:00.000Z'
    const created = await a
      .from('sprints')
      .insert({ project_id: projectId, name: 'Editable', start_date: start, end_date: end })
      .select('id')
      .single()
    // Positive control: a valid, dated row really is there to update. Without it a broken
    // insert would make the rejection below meaningless.
    expect(created.error).toBeNull()

    const { error } = await a
      .from('sprints')
      .update({ end_date: '2026-09-28T00:00:00.000Z' })
      .eq('id', created.data!.id)

    expect(error?.code).toBe('23514')
    expect(error?.message).toContain('sprints_end_not_before_start')

    const { data: row, error: readErr } = await a
      .from('sprints')
      .select('start_date, end_date')
      .eq('id', created.data!.id)
      .single()

    expect(readErr).toBeNull()
    expect(new Date(row!.start_date!).toISOString()).toBe(start)
    expect(new Date(row!.end_date!).toISOString()).toBe(end)
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
    /** The project's terminal statuses, derived from the LIVE seeded rows by the SAME
     *  `doneSlugs` the app uses — not a hand-written `new Set(['done'])`. SPRIN-77 made
     *  "terminal" a category question, and this suite is the only place the resulting
     *  PostgREST `not.in.(…)` filter is ever sent to a real database. */
    let terminalSlugs: ReadonlySet<string>

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

      // Read the rows `seed_project_statuses()` actually wrote and derive the terminal set
      // through the real helper, so this suite proves the CATEGORY rule against the live
      // vocabulary rather than restating the slug the seed happens to use.
      const { doneSlugs } = await import('@/lib/project-statuses')
      const { data: statusRows, error: statusErr } = await a
        .from('project_statuses')
        .select()
        .eq('project_id', projectId)
      if (statusErr) throw statusErr
      terminalSlugs = doneSlugs((statusRows ?? []) as ProjectStatus[])
      // The seed contract, asserted here because everything below depends on it: exactly one
      // seeded status is categorised `done`, and an empty set would silently turn every
      // "Done tickets are retained" assertion into a vacuous pass.
      expect([...terminalSlugs]).toEqual(['done'])

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
        // For B the precondition read matches ZERO rows (`sprints_owner` scopes it through the
        // owned project), so startSprint returns 'unknown' having written nothing at all —
        // never 'already_active' and never 'stale', either of which would confirm A's sprint
        // exists. The write path below it is never reached.
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

      const result = await completeSprint(id, terminalSlugs)
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

    // SPRIN-77's empty-set branch, and the only place it can be proven. A project with no
    // done-category status has nothing terminal, so `completeSprint` OMITS its status filter
    // rather than emitting `not.in.()` — which is malformed SQL. A unit test asserting
    // "`not` was not called" cannot tell a correctly omitted filter from one PostgREST would
    // have rejected; only a real request can.
    it('returns EVERY ticket to the backlog when the caller names no terminal status', async () => {
      const id = await newFutureSprint('Nothing terminal')
      expect((await startSprint(id)).ok).toBe(true) // positive control

      const doneId = await ticketInSprint(id, 'done')

      const result = await completeSprint(id, new Set())
      expect(result.ok).toBe(true)

      // The 'done'-SLUGGED ticket came back too: the caller's set is the only rule, and this
      // project's set is empty. Its status is untouched — completing never rewrites a status.
      const { data: done } = await a
        .from('tickets')
        .select('sprint_id, status')
        .eq('id', doneId)
        .single()
      expect(done!.sprint_id).toBeNull()
      expect(done!.status).toBe('done')
    }, 30_000)

    it("rejects completing another user's sprint: RLS scopes both writes, no cross-tenant mutation", async () => {
      const id = await newFutureSprint('Cross-tenant complete')
      await startSprint(id)
      const todoId = await ticketInSprint(id, 'todo')

      const asB = RLS_USERS.B
      await appClient.auth.signInWithPassword({ email: asB.email!, password: asB.password! })
      try {
        // The precondition read matches zero rows for B, so completeSprint now returns
        // 'unknown' before ANY write — strictly better than before, when the ticket move ran
        // and was filtered to zero rows by RLS. 'unknown' never leaks existence.
        const result = await completeSprint(id, terminalSlugs)
        expect(result).toEqual({ ok: false, error: 'unknown' })
      } finally {
        const asA = RLS_USERS.A
        await appClient.auth.signInWithPassword({ email: asA.email!, password: asA.password! })
      }

      // Re-read as A: the sprint is still active AND its ticket unmoved — proof that B's call
      // left the database exactly where it found it. The bulk update never even ran for B: the
      // precondition read is the gate now, and it matched zero rows before either write.
      const { data: s } = await a.from('sprints').select('status').eq('id', id).single()
      expect(s!.status).toBe('active')
      const { data: t } = await a.from('tickets').select('sprint_id').eq('id', todoId).single()
      expect(t!.sprint_id).toBe(id)
    }, 30_000)

    it('refuses to restart a completed sprint: no resurrection', async () => {
      // The headline defect, at the database. `sprints_one_active_per_project` constrains
      // `status = 'active'` ONLY, so with no other active sprint nothing here stops the flip —
      // before the guard this call returned ok:true and a completed sprint went live again,
      // having already returned its incomplete tickets to the backlog.
      const id = await newFutureSprint('Resurrect')
      expect((await startSprint(id)).ok).toBe(true)
      expect((await completeSprint(id, terminalSlugs)).ok).toBe(true) // positive control: really complete

      const result = await startSprint(id)
      expect(result).toEqual({ ok: false, error: 'stale' })

      const { data, error } = await a.from('sprints').select('status').eq('id', id).single()
      expect(error).toBeNull()
      expect(data!.status).toBe('complete')
    }, 30_000)

    it('refuses to complete a future sprint and leaves its tickets attached', async () => {
      // AC2 proven at the database, not at a mock. The ticket move runs before the status
      // flip, so a guard in the wrong place would strip this ticket's sprint_id and only
      // then fail — the assertion below is what catches that.
      const id = await newFutureSprint('Never started')
      const todoId = await ticketInSprint(id, 'todo')

      const result = await completeSprint(id, terminalSlugs)
      expect(result).toEqual({ ok: false, error: 'stale' })

      const { data: s } = await a.from('sprints').select('status').eq('id', id).single()
      expect(s!.status).toBe('future')
      const { data: t } = await a.from('tickets').select('sprint_id').eq('id', todoId).single()
      expect(t!.sprint_id).toBe(id)
    }, 30_000)
  },
)
