// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { DEFAULT_PROJECT_STATUSES } from '@/lib/domain'
import {
  adminClient,
  anonClient,
  assertCredentialsOrExplain,
  hasRlsCredentials,
  hasServiceRoleKey,
  signIn,
  userId,
} from './supabase-clients'

assertCredentialsOrExplain()

/** A unique, schema-legal project key per run, so a failed cleanup cannot collide. */
function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `T${pick()}${pick()}`
}

describe.skipIf(!hasRlsCredentials)('RLS isolation between two users', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let userBId: string
  let projectA: string
  let sprintA: string
  let ticketA: string
  let keyA: string
  let ticketAKey: string
  /**
   * B owns a project purely so the status-correlation tests are not vacuous.
   *
   * `statuses_owner_read` reaches project_statuses INDIRECTLY, through an EXISTS on
   * projects. Delete the correlating clause — `p.id = project_statuses.project_id` —
   * and what remains is "does this user own ANY project", which still deparses
   * plausibly and still filters B out entirely, because B owned nothing. Every
   * B-sees-none assertion would keep passing against a policy that leaks every
   * status in the database to anyone with a project. Giving B one closes that.
   */
  let projectB: string
  let statusA: string

  beforeAll(async () => {
    a = await signIn('A')
    b = await signIn('B')
    userAId = await userId(a)
    userBId = await userId(b)

    keyA = runKey()

    const { data: project, error: pErr } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: "A's project", key: keyA })
      .select()
      .single()
    if (pErr) throw new Error(`Fixture: could not create A's project: ${pErr.message}`)
    projectA = project.id

    const { data: sprint, error: sErr } = await a
      .from('sprints')
      .insert({ project_id: projectA, name: 'Sprint 1' })
      .select()
      .single()
    if (sErr) throw new Error(`Fixture: could not create A's sprint: ${sErr.message}`)
    sprintA = sprint.id

    const { data: ticket, error: tErr } = await a
      .from('tickets')
      .insert({ project_id: projectA, summary: "A's ticket" })
      .select()
      .single()
    if (tErr) throw new Error(`Fixture: could not create A's ticket: ${tErr.message}`)
    ticketA = ticket.id
    ticketAKey = ticket.key

    // B is already signed in above, so this costs no extra sign-in — which matters,
    // because sign-ins are the fuel for the documented GoTrue rate-limit flake.
    const { data: projB, error: pbErr } = await b
      .from('projects')
      .insert({ owner_id: userBId, name: "B's project", key: runKey() })
      .select()
      .single()
    if (pbErr) throw new Error(`Fixture: could not create B's project: ${pbErr.message}`)
    projectB = projB.id

    const { data: statuses, error: stErr } = await a
      .from('project_statuses')
      .select('id, slug')
      .eq('project_id', projectA)
      .order('position')
    if (stErr) throw new Error(`Fixture: could not read A's seeded statuses: ${stErr.message}`)
    // A plural read returns `{ data: [], error: null }` when the policy filters
    // everything, so `statuses[0].id` would throw a bare
    // `TypeError: Cannot read properties of undefined` — which is very close to the
    // signature CLAUDE.md documents for the auth rate limiter, and would send whoever
    // sees it to a five-minute cooldown for what is actually a security defect.
    if (!statuses || statuses.length !== 4) {
      throw new Error(
        `Fixture: expected 4 seeded statuses for A's project, got ${statuses?.length ?? 0}. ` +
          'This is on_project_created_statuses or statuses_owner_read, NOT the auth rate ' +
          'limiter — do not re-run it.',
      )
    }
    statusA = statuses[0]!.id
  }, 30_000)

  afterAll(async () => {
    if (!hasRlsCredentials) return
    try {
      // Positive control, taken BEFORE the delete. It has to be, and it has to use
      // a role that can tell "gone" from "hidden": once the projects row is deleted,
      // statuses_owner_read's EXISTS is false for every RLS-subject role, so a
      // post-teardown read as A returns [] whether the statuses cascaded away or
      // were stranded. adminClient() bypasses RLS, so it can see the difference.
      const before = hasServiceRoleKey
        ? await adminClient().from('project_statuses').select('id').eq('project_id', projectA)
        : null
      if (before) expect(before.data).toHaveLength(4)

      // Owner-scoped RLS means each client can only delete its own rows — which
      // is exactly the guarantee under test, so cleanup is also a final
      // assertion. A silent zero-row delete here would leak a project + sprint +
      // tickets + counter row into the shared database on every run, forever.
      const { data, error } = await a.from('projects').delete().eq('id', projectA).select()
      expect(error).toBeNull()
      expect(data).toHaveLength(1)

      // The deferred fk did not block the cascade, and nothing was left behind.
      if (hasServiceRoleKey) {
        const orphans = await adminClient()
          .from('project_statuses')
          .select('id')
          .eq('project_id', projectA)
        expect(orphans.error).toBeNull()
        expect(orphans.data).toEqual([])
      }

      if (projectB) {
        const bGone = await b.from('projects').delete().eq('id', projectB).select()
        expect(bGone.error).toBeNull()
        expect(bGone.data).toHaveLength(1)
      }
    } finally {
      // Sign-outs must still happen even if the assertions above throw, and
      // must not mask whatever failure happened earlier in the suite.
      await a.auth.signOut()
      await b.auth.signOut()
    }
  }, 30_000)

  it('signs in as two distinct users', () => {
    expect(userAId).toBeTruthy()
    expect(userBId).toBeTruthy()
    expect(userAId).not.toBe(userBId)
  })

  // The signup trigger from S1.2, exercised for the first time.
  it('each user has exactly one profile row, created by handle_new_user', async () => {
    const { data, error } = await a.from('profiles').select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]!.id).toBe(userAId)
  })

  // sprintA is otherwise write-only in this file: it exists so a later task
  // (user-B isolation) can attempt to reach it. This asserts a real property
  // of the fixture (ownership + the schema's status default) rather than
  // just reading sprintA to satisfy noUnusedLocals.
  it("creates A's fixture sprint, belonging to A's project and defaulting to status 'future'", async () => {
    const { data, error } = await a
      .from('sprints')
      .select('project_id, status')
      .eq('id', sprintA)
      .single()
    expect(error).toBeNull()
    expect(data!.project_id).toBe(projectA)
    expect(data!.status).toBe('future')
  })

  describe('the S1.2 triggers, finally executed rather than merely catalogued', () => {
    it('assign_ticket_key numbered the first ticket KEY-1', () => {
      expect(ticketAKey).toBe(`${keyA}-1`)
    })

    it('create_project_counter made a counter row, and it tracks the last number', async () => {
      // Scoped to the fixture project: counters_owner's RLS returns every
      // project user A owns, not just this run's, so an unfiltered select
      // would flake (or worse, vacuously pass) against leftover projects.
      const { data, error } = await a
        .from('project_counters')
        .select('last_number')
        .eq('project_id', projectA)
      expect(error).toBeNull()
      expect(data).toHaveLength(1)
      expect(data![0]!.last_number).toBe(1)
    })

    /**
     * The primary guard on the four-column guarantee. domain.test.ts asserts that
     * the SCHEMA FILE agrees with DEFAULT_PROJECT_STATUSES, but the schema file is
     * not the database — migrations are applied by hand in the SQL editor, so a
     * value can reach production without the file ever changing. This reads what
     * actually got seeded.
     *
     * Scoped to the fixture project for the same reason the counter test above is:
     * statuses_owner_read returns every project A owns, so an unfiltered select
     * would flake against leftovers from an earlier run.
     */
    it('on_project_created_statuses seeded exactly the four board columns, in order', async () => {
      const { data, error } = await a
        .from('project_statuses')
        .select('slug, name, category, position, is_initial')
        .eq('project_id', projectA)
        .order('position')
      expect(error).toBeNull()
      expect(data).toEqual(
        DEFAULT_PROJECT_STATUSES.map((s) => ({
          slug: s.slug,
          name: s.name,
          category: s.category,
          position: s.position,
          is_initial: s.is_initial,
        })),
      )
      // Where new tickets land must equal tickets.status's column default, or
      // ticket creation and the board disagree about the starting column.
      expect(data!.find((s) => s.is_initial)!.slug).toBe('todo')
    })

    /**
     * Deliberately reads the fixture ticket rather than inserting another one:
     * the "B cannot INSERT a ticket" test below counts A's tickets as its
     * did-nothing-land control, so an extra insert here would break it from a
     * distance. That coupling is why this asserts rather than creates.
     *
     * NOTE what this does NOT prove. `tickets.status`'s default is the bare literal
     * 'todo', not a lookup on `is_initial`, so this would still pass if `is_initial`
     * were seeded on `done`. The genuine is_initial coverage is the seeding test
     * above (which asserts the flag lands on `todo`) and `domain.test.ts`'s
     * agreement check against the column default. Reuniting the two is SPRIN-80's
     * job, in the story that lets a status be deleted.
     */
    it('a ticket still defaults to todo now the check constraint is gone', async () => {
      const { data, error } = await a.from('tickets').select('status').eq('id', ticketA).single()
      expect(error).toBeNull()
      // Still 'todo', but for a NEW reason: it now resolves against a
      // project_statuses row through tickets_status_fk, not a check constraint.
      expect(data!.status).toBe('todo')
    })

    it('assign_ticket_key increments — the second ticket is KEY-2, not KEY-1', async () => {
      const { data, error } = await a
        .from('tickets')
        .insert({ project_id: projectA, summary: 'Second' })
        .select()
        .single()
      expect(error).toBeNull()
      expect(data!.key).toBe(`${keyA}-2`)
    })

    it('freeze_ticket_key refuses to let the key be rewritten', async () => {
      // Deliberately sending what TicketUpdate makes untypeable: the point is to
      // prove the DATABASE holds, not just the type. A bug in the app would send
      // exactly this.
      const forbidden = { key: 'LOL-9', number: 999 } as never

      const { data, error } = await a
        .from('tickets')
        .update(forbidden)
        .eq('id', ticketA)
        .select()
        .single()

      expect(error).toBeNull()
      expect(data!.key).toBe(ticketAKey) // unchanged
      expect(data!.number).toBe(1)
    })
  })

  describe("user B cannot reach user A's data", () => {
    // RLS FILTERS — it does not raise. An unauthorised update returns success
    // with zero rows. Asserting `error === null` would pass on a wide-open
    // database. Every assertion below counts rows.

    it('B cannot SELECT any of it', async () => {
      const project = await b.from('projects').select('id').eq('id', projectA)
      const sprint = await b.from('sprints').select('id').eq('id', sprintA)
      const ticket = await b.from('tickets').select('id').eq('id', ticketA)
      const status = await b.from('project_statuses').select('id').eq('id', statusA)

      expect(project.data).toEqual([])
      expect(sprint.data).toEqual([])
      expect(ticket.data).toEqual([])
      expect(status.data).toEqual([])

      // Positive control: A can. Without this, the three assertions above also
      // pass when the fixture was never created.
      const asA = await a.from('projects').select('id').eq('id', projectA)
      expect(asA.data).toHaveLength(1)
    })

    it('B cannot UPDATE any of it', async () => {
      const project = await b.from('projects').update({ name: 'pwned' }).eq('id', projectA).select()
      const sprint = await b.from('sprints').update({ name: 'pwned' }).eq('id', sprintA).select()
      const ticket = await b.from('tickets').update({ summary: 'pwned' }).eq('id', ticketA).select()

      expect(project.data).toEqual([])
      expect(sprint.data).toEqual([])
      expect(ticket.data).toEqual([])

      // Positive control: the same update, as A, changes exactly one row.
      const asA = await a
        .from('tickets')
        .update({ summary: 'renamed by its owner' })
        .eq('id', ticketA)
        .select()
      expect(asA.data).toHaveLength(1)
      expect(asA.data![0]!.summary).toBe('renamed by its owner')
    })

    // Every negative assertion above uses client `b`. An anonymous client would
    // also see nothing and pass all of them — proving nothing about isolation.
    // This proves B's own JWT actually reaches PostgREST: B can see exactly
    // their own profile row, and no one else's.
    it("B's requests carry B's own identity (data-plane positive control)", async () => {
      const { data, error } = await b.from('profiles').select('id')
      expect(error).toBeNull()
      expect(data).toEqual([{ id: userBId }])
    })

    it('B cannot DELETE any of it', async () => {
      const ticket = await b.from('tickets').delete().eq('id', ticketA).select()
      const sprint = await b.from('sprints').delete().eq('id', sprintA).select()
      const project = await b.from('projects').delete().eq('id', projectA).select()
      const status = await b.from('project_statuses').delete().eq('id', statusA).select()

      expect(ticket.data).toEqual([])
      expect(sprint.data).toEqual([])
      expect(project.data).toEqual([])
      expect(status.data).toEqual([])

      // Positive control: it is all still there, seen by its owner.
      const stillThere = await a.from('tickets').select('id').eq('id', ticketA)
      expect(stillThere.data).toHaveLength(1)
    })

    // WITH CHECK, not USING. The asymmetry between them is the classic RLS hole,
    // and only an INSERT can find it: a policy that filters reads but not writes
    // would let B plant rows inside A's project.
    it("B cannot INSERT a ticket into A's project", async () => {
      const { data, error } = await b
        .from('tickets')
        .insert({ project_id: projectA, summary: 'planted by B' })
        .select()

      expect(data).toBeNull()
      // OBSERVED against the live database: 42501 (RLS violation on
      // tickets_owner's WITH CHECK), not 23502. Postgres evaluates RLS before
      // table constraints, so the RLS violation fires first even though
      // assign_ticket_key (SECURITY INVOKER) would independently fail here too:
      // B's RLS makes the project_counters UPDATE match zero rows, leaving
      // `number` NULL. If a future change ever surfaced 23502 instead, that
      // would mean RLS stopped firing first — re-verify against the DB, don't
      // just widen this assertion.
      expect(error!.code).toBe('42501')

      // And nothing landed.
      const asA = await a.from('tickets').select('id').eq('project_id', projectA)
      expect(asA.data!.length).toBe(2) // the fixture ticket and the KEY-2 one
    })

    it("B cannot INSERT a sprint into A's project", async () => {
      const { data, error } = await b
        .from('sprints')
        .insert({ project_id: projectA, name: 'planted by B' })
        .select()

      expect(data).toBeNull()
      expect(error!.code).toBe('42501') // OBSERVED: sprints_owner WITH CHECK.

      // And nothing landed.
      const asA = await a.from('sprints').select('id').eq('project_id', projectA)
      expect(asA.data!.length).toBe(1) // only the fixture sprint
    })
  })

  describe('the status vocabulary is server-owned (SPRIN-79)', () => {
    /**
     * These two are the tests that kill the mutation none of the others do.
     *
     * statuses_owner_read reaches project_statuses through an EXISTS on projects.
     * Delete its correlating clause and the predicate becomes "does this caller own
     * any project at all" — which compiles, deparses plausibly, and leaks every
     * status row in the database to every user who owns a project. Because both
     * users now own one, an UNFILTERED read in each direction catches it; a
     * `.eq('id', statusA)` read would not, and neither would either test alone.
     *
     * Each carries its positive control inside the same read, so neither can pass
     * because the fixture failed to create anything.
     */
    it("A sees only A's own project statuses, never B's", async () => {
      const { data, error } = await a.from('project_statuses').select('project_id')
      expect(error).toBeNull()
      expect(data!.filter((r) => r.project_id === projectB)).toEqual([])
      expect(data!.filter((r) => r.project_id === projectA)).toHaveLength(4)
    })

    it("B sees only B's own project statuses, never A's", async () => {
      const { data, error } = await b.from('project_statuses').select('project_id')
      expect(error).toBeNull()
      expect(data!.filter((r) => r.project_id === projectA)).toEqual([])
      // Doubles as the data-plane identity control for the new table, and proves
      // the seeding trigger fired for B's project too — not just A's.
      expect(data!.filter((r) => r.project_id === projectB)).toHaveLength(4)
    })

    /**
     * The tests that pin the SELECT-only decision, and they are EXPECTED to be
     * changed by SPRIN-77 — consciously, together with the policy and the
     * migration's own `cmd = 'SELECT'` post-condition.
     *
     * Until then this is what actually replaces tickets_status_check. The fk cannot
     * do it: the fk only says a status must EXIST for the project, so a client that
     * can add rows to its own vocabulary can satisfy the fk with anything it likes.
     * The board still renders four hard-coded columns, so such a ticket would render
     * in no column and vanish. The policy is the only thing standing there.
     */
    it('even the owner cannot INSERT a status: the vocabulary is not client-writable', async () => {
      const { data, error } = await a
        .from('project_statuses')
        .insert({ project_id: projectA, slug: 'planted', name: 'Planted', position: 9 })
        .select()
      expect(data).toBeNull()
      // OBSERVED against the live database: statuses_owner_read is FOR SELECT, so no
      // INSERT policy exists and RLS denies by default with 42501. INSERT has no
      // USING clause to filter against, which is why this raises rather than
      // silently affecting zero rows the way the UPDATE and DELETE cases do.
      expect(error!.code).toBe('42501')

      const asA = await a.from('project_statuses').select('id').eq('project_id', projectA)
      expect(asA.data).toHaveLength(4) // nothing landed
    })

    it("B cannot INSERT a status into A's project either", async () => {
      const { data, error } = await b
        .from('project_statuses')
        .insert({ project_id: projectA, slug: 'planted', name: 'Planted', position: 9 })
        .select()
      expect(data).toBeNull()
      expect(error!.code).toBe('42501')

      const asA = await a.from('project_statuses').select('id').eq('project_id', projectA)
      expect(asA.data).toHaveLength(4)
    })

    it('even the owner cannot rename or delete a status', async () => {
      // No UPDATE or DELETE policy exists, so unlike INSERT these do not raise —
      // there IS a USING clause to evaluate and it is absent, so the rows are simply
      // invisible to the command. Counting rows is the only honest assertion.
      const renamed = await a
        .from('project_statuses')
        .update({ name: 'Renamed' })
        .eq('id', statusA)
        .select()
      const deleted = await a.from('project_statuses').delete().eq('id', statusA).select()
      expect(renamed.data).toEqual([])
      expect(deleted.data).toEqual([])

      // Positive control: the row is untouched, and still called what it was.
      const asA = await a.from('project_statuses').select('name').eq('id', statusA)
      expect(asA.data).toEqual([{ name: 'To Do' }])
    })

    /**
     * anonClient() performs no sign-in, so this costs the GoTrue rate limiter
     * nothing. It matters because ALTER DEFAULT PRIVILEGES grants `anon` full DML on
     * every new table in `public` — verified against pg_default_acl, not assumed —
     * so RLS is the only thing emptying this result.
     */
    it('an anonymous caller sees no statuses at all', async () => {
      const { data, error } = await anonClient().from('project_statuses').select('id')
      expect(error).toBeNull()
      expect(data).toEqual([])

      const asA = await a.from('project_statuses').select('id').eq('project_id', projectA)
      expect(asA.data).toHaveLength(4) // positive control: the rows do exist
    })

    /**
     * Proves the cascade COMPLETES and strands nothing. It does NOT prove
     * `deferrable initially deferred`, and an earlier version of this comment
     * claimed that it did.
     *
     * `delete from projects` fires one cascade per referencing fk, each running its
     * own inner DELETE whose immediate checks fire at the end of THAT statement. So
     * a non-deferrable fk survives whenever the tickets cascade happens to run
     * first — which is RI trigger OID order. Measured on this database:
     * `tickets_project_id_fkey` is 17704 and `project_statuses_project_id_fkey` is
     * 17912, so tickets go first and a NON-deferrable fk would pass this test too.
     *
     * The order only inverts on a fresh apply of docs/sprintboard_phase1_schema.sql,
     * where project_statuses must be created before tickets — and nothing in CI ever
     * does a fresh apply. Deferrability itself is asserted where it can be: the
     * migration's step-12 post-condition checks `condeferrable and condeferred` and
     * aborts the transaction otherwise. PostgREST cannot reach pg_catalog, so no
     * test in this suite can re-check it; do not add one that pretends to.
     */
    it('deleting a project cascades away its tickets and statuses together', async () => {
      const { data: proj, error: pErr } = await a
        .from('projects')
        .insert({ owner_id: userAId, name: 'Cascade order', key: runKey() })
        .select()
        .single()
      expect(pErr).toBeNull()

      const { error: tErr } = await a
        .from('tickets')
        .insert({ project_id: proj!.id, summary: 'rides the cascade' })
      expect(tErr).toBeNull()

      // The ticket references a status row that is about to be deleted by the same
      // statement. Non-deferrable, this is where 23503 would appear.
      const gone = await a.from('projects').delete().eq('id', proj!.id).select()
      expect(gone.error).toBeNull()
      expect(gone.data).toHaveLength(1)
    })
  })
})
