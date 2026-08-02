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

/**
 * A unique, schema-legal project key per run, so a failed cleanup cannot collide.
 *
 * THREE random characters, not two. `projects_key_format` allows `^[A-Z][A-Z0-9]{1,3}$`,
 * so two picks used a 1,296-key space where 46,656 was available — a 36x entropy loss for
 * nothing, in the one suite whose teardown had already been observed to leak projects into
 * the shared database. It duly collided on `projects_owner_key_unique` during SPRIN-77,
 * against a leaked project from an earlier run, and read as a mysterious 23505 on a branch
 * whose code was fine.
 *
 * `sprints.integration.test.ts` already used three. This was the outlier, not the pattern.
 *
 * Entropy is the second line of defence here, never the first: the teardown below deletes
 * every fixture project BEFORE its first assertion precisely so leaked rows do not
 * accumulate. This only bounds the damage when that fails anyway.
 */
function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `T${pick()}${pick()}${pick()}`
}

/**
 * Awaits a PostgREST call and turns a THROWN error into the `{ data, error }` shape
 * the call would otherwise have returned. For teardown only.
 *
 * supabase-js reports API failures in `error` rather than by throwing, but the
 * transport underneath it can still reject — CLAUDE.md documents an
 * `AuthRetryableFetchError` / `status: 0` / `ECONNRESET` flake on this very database.
 * In a teardown that is not a reported failure but a LEAK: the throw propagates out
 * of the hook, every later `delete` is skipped, and the fixtures it would have
 * removed stay in the shared database with nothing left that can reach them.
 * Wrapping each step lets the hook complete its cleanup and then report what went
 * wrong, instead of choosing one over the other.
 */
async function settled<T>(call: PromiseLike<T>): Promise<T | { data: null; error: Error }> {
  try {
    return await call
  } catch (cause) {
    return { data: null, error: cause instanceof Error ? cause : new Error(String(cause)) }
  }
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

  /**
   * Shared by the SPRIN-77 and SPRIN-80 blocks below — both are project-status suites
   * that need a disposable project of their own rather than reusing `projectA`, whose
   * teardown assertions (above) are written against a fixed 4-status fixture. Hoisted
   * out of SPRIN-77's `describe` to this outer scope so both siblings share one copy
   * instead of a pasted duplicate.
   */
  async function throwawayProject(name: string): Promise<string> {
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name, key: runKey() })
      .select('id')
      .single()
    if (error) throw new Error(`Fixture: could not create "${name}": ${error.message}`)
    return data.id
  }

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
        ? await settled(
            adminClient().from('project_statuses').select('id').eq('project_id', projectA),
          )
        : null

      // EVERY DELETE RUNS BEFORE THE FIRST ASSERTION, and that ordering is the whole
      // point of this shape. This hook used to `expect(before.data).toHaveLength(4)`
      // on the line above. When SPRIN-77 made statuses insertable and a test planted
      // a fifth, that expect threw — and the deletes below never ran. Each such run
      // stranded a project (plus its sprint, tickets, counter and statuses) and B's
      // project in the SHARED live database, where nothing can reach them afterwards:
      // project_statuses has no DELETE policy at all. Five orphaned pairs accumulated
      // before anyone looked. An assertion in teardown is a REPORT; the delete is an
      // OBLIGATION, and the obligation goes first.
      //
      // Owner-scoped RLS means each client can only delete its own rows — which is
      // exactly the guarantee under test, so cleanup is also a final assertion. A
      // silent zero-row delete is still a leak, so it is still asserted; just later.
      const gone = await settled(a.from('projects').delete().eq('id', projectA).select())
      const orphans = hasServiceRoleKey
        ? await settled(
            adminClient().from('project_statuses').select('id').eq('project_id', projectA),
          )
        : null
      const bGone = projectB
        ? await settled(b.from('projects').delete().eq('id', projectB).select())
        : null

      expect(gone.error).toBeNull()
      expect(gone.data).toHaveLength(1)

      // "There were rows before, and none after" — the honest property, and the one
      // that survives SPRIN-77. NOT an exact count: an owner can add statuses now, so
      // a hard-coded 4 is a standing invitation to repeat the leak described above.
      // The seeded defaults are a floor, which still fails if seeding never ran.
      if (before) {
        expect(before.error).toBeNull()
        expect(before.data!.length).toBeGreaterThanOrEqual(DEFAULT_PROJECT_STATUSES.length)
      }

      // The deferred fk did not block the cascade, and nothing was left behind.
      if (orphans) {
        expect(orphans.error).toBeNull()
        expect(orphans.data).toEqual([])
      }

      if (bGone) {
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

  describe('the status vocabulary is per-project and owner-scoped', () => {
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

  /**
   * SPRIN-77 opened `project_statuses` to the owner, and the shape of what it opened
   * is the thing worth pinning. The migration replaced ONE select-only policy with
   * THREE — select, insert, update — and deliberately no DELETE, because deleting a
   * status strands the tickets sitting on it and deleting `todo` permanently breaks
   * ticket creation (tickets.status's default is still the bare literal 'todo').
   * SPRIN-80 owns deletion. Collapsing those three back into one `for all` would look
   * like a tidy-up and would silently reopen that hole; the DELETE test below is what
   * goes red when someone tries.
   *
   * UPDATE is narrowed a second time, by PRIVILEGE rather than by policy: the
   * table-level grant is revoked and re-granted on (name, category, position) alone,
   * so `slug` — the fk target of tickets_status_fk — and `is_initial` cannot move.
   * A policy cannot express that, so no policy test can catch its loss.
   *
   * WHY ITS OWN PROJECTS. Every test here writes, and there is no DELETE policy, so a
   * status planted in the shared fixture project could never be removed again. Two
   * throwaway projects are created here and dropped whole in afterAll — the cascade
   * is the only way these rows can leave the database. It also keeps `projectA` and
   * `projectB` on exactly their seeded four, which is what the cross-tenant read tests
   * above count.
   *
   * The tests run IN ORDER and depend on each other: the first plants `qa`, the rest
   * rename it, refuse to move it, refuse to delete it, and reorder around it. That
   * coupling is deliberate — the pairing is the evidence. A refusal only means
   * something next to a success on the same row.
   */
  describe('the owner can add, rename and reorder statuses (SPRIN-77)', () => {
    let wp1: string
    let wp2: string

    beforeAll(async () => {
      wp1 = await throwawayProject('Status writes')
      wp2 = await throwawayProject('Status writes, second project')
    }, 30_000)

    afterAll(async () => {
      // DELETE FIRST, ASSERT AFTERWARDS — the same rule as the suite-level teardown,
      // and it bites harder here: these two projects are the only reachable handle on
      // every status this block writes. SPRIN-80 gave project_statuses a DELETE
      // policy, so an owner CAN now remove a status row directly — but only via the
      // owning project's client, and only while signed in as that owner. A skipped
      // cascade here would still leak the rows: `a` (this describe's fixture owner)
      // goes out of scope with the block, and nothing else in this suite is signed in
      // as the owner of `wp1`/`wp2` to reach them afterwards.
      const one = wp1 ? await settled(a.from('projects').delete().eq('id', wp1).select()) : null
      const two = wp2 ? await settled(a.from('projects').delete().eq('id', wp2).select()) : null

      expect(one?.error).toBeNull()
      expect(one?.data).toHaveLength(1)
      expect(two?.error).toBeNull()
      expect(two?.data).toHaveLength(1)
    }, 30_000)

    /**
     * THE POSITIVE CONTROL, and it comes first on purpose. Every refusal below is
     * only evidence of a guard if this passes: a broken fixture, a revoked INSERT
     * grant or a mis-scoped policy would make all of them pass while proving nothing.
     */
    it('the owner CAN insert a status into their own project', async () => {
      const { data, error } = await a
        .from('project_statuses')
        .insert({
          project_id: wp1,
          slug: 'qa',
          name: 'Ready for QA',
          category: 'in_progress',
          position: 5,
        })
        .select()
        .single()
      expect(error).toBeNull()
      expect(data!.slug).toBe('qa')
      // The column DEFAULT, not something the caller asked for — this insert never mentions
      // is_initial. It is NOT that the column is unwritable on insert: measured, `authenticated`
      // does hold INSERT on it, and only project_statuses_one_initial_per_project stops a second
      // initial status landing (its own test below). The UPDATE refusal further down is the one
      // that is a privilege.
      expect(data!.is_initial).toBe(false)

      const rows = await a.from('project_statuses').select('slug').eq('project_id', wp1)
      expect(rows.data).toHaveLength(DEFAULT_PROJECT_STATUSES.length + 1)
    })

    /**
     * WITH CHECK, not USING. statuses_owner_insert correlates the row's project_id to
     * a project the caller owns; drop that correlation and any authenticated user can
     * plant a column on anyone's board. INSERT has no USING clause to filter against,
     * which is why this RAISES 42501 rather than quietly affecting zero rows the way
     * the DELETE case does.
     */
    it("a stranger cannot insert a status into someone else's project", async () => {
      const { data, error } = await b
        .from('project_statuses')
        .insert({ project_id: wp1, slug: 'planted', name: 'Planted by B', position: 9 })
        .select()
      expect(data).toBeNull()
      expect(error!.code).toBe('42501') // OBSERVED: statuses_owner_insert's WITH CHECK.

      const asA = await a.from('project_statuses').select('slug').eq('project_id', wp1)
      expect(asA.data!.map((r) => r.slug)).not.toContain('planted')
      expect(asA.data).toHaveLength(DEFAULT_PROJECT_STATUSES.length + 1) // nothing landed
    })

    /**
     * PAIRED ON THE SAME ROW, and that pairing is the entire argument. The rename is
     * what proves the slug refusal comes from the column privilege rather than from a
     * broken fixture, a missing UPDATE policy or a row the caller cannot see — all of
     * which would refuse both halves identically.
     *
     * The refusal is a PRIVILEGE, and the obvious way to write the migration was a
     * no-op: `revoke update (slug)` cannot carve a hole in a table-level grant, so the
     * table-level UPDATE had to be revoked outright and (name, category, position)
     * granted back. This test is the client-side witness to that.
     */
    it('the owner can rename a status but cannot move its slug', async () => {
      const renamed = await a
        .from('project_statuses')
        .update({ name: 'In QA' })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(renamed.error).toBeNull()
      expect(renamed.data).toHaveLength(1)
      expect(renamed.data![0]!.name).toBe('In QA')

      const moved = await a
        .from('project_statuses')
        .update({ slug: 'qa2' })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(moved.data).toBeNull()
      expect(moved.error!.code).toBe('42501') // OBSERVED: no UPDATE privilege on slug.

      // The row kept its new name AND its old slug. Asserting both together is what
      // makes this a column restriction rather than "the update failed somehow".
      const after = await a
        .from('project_statuses')
        .select('slug, name')
        .eq('project_id', wp1)
        .eq('slug', 'qa')
      expect(after.data).toEqual([{ slug: 'qa', name: 'In QA' }])
    })

    /**
     * Deliberately clears is_initial on `todo` rather than setting it on `qa`: setting
     * it would ALSO violate project_statuses_one_initial_per_project, so the test
     * would stay green through a widened column grant. Clearing it is legal in every
     * way except the privilege, so the privilege is the only thing that can refuse it.
     * A project with zero initial statuses is SPRIN-80's state to reach deliberately,
     * not one an owner can stumble into.
     */
    it('the owner cannot change is_initial', async () => {
      const { data, error } = await a
        .from('project_statuses')
        .update({ is_initial: false })
        .eq('project_id', wp1)
        .eq('slug', 'todo')
        .select()
      expect(data).toBeNull()
      expect(error!.code).toBe('42501') // OBSERVED: no UPDATE privilege on is_initial.

      const initial = await a
        .from('project_statuses')
        .select('slug')
        .eq('project_id', wp1)
        .eq('is_initial', true)
      expect(initial.data).toEqual([{ slug: 'todo' }])
    })

    /**
     * SPRIN-80 gave `project_statuses` a DELETE policy, so "nobody can delete a
     * status — not even the owner" is no longer true and this test used to assert
     * exactly that. Only the STRANGER half survives: an owner deleting their OWN
     * status is now the feature, and five tests below this one (duplicate name,
     * position collision, same-name-in-another-project, both reorders, the
     * anonymous-RPC probe) all depend on `qa` still being in `wp1` afterwards. So
     * this test proves the owner CAN delete by giving itself a throwaway row to
     * delete rather than spending `qa` on the proof — `qa` is never touched here.
     *
     * A stranger's delete matching zero rows is still NOT an error — RLS filters the
     * row out of the command's view rather than raising, so `expect(error).toBeNull()`
     * proves nothing on its own and `expect(data).toEqual([])` proves only that
     * nothing came back. Re-selecting the whole vocabulary and finding every row
     * (including `qa`) still in place is the only honest evidence, which is why the
     * assertion below still names all five slugs in order.
     */
    it("the owner can delete their OWN status; a stranger still cannot touch qa", async () => {
      // position 99: deliberately far outside every other position this describe block
      // uses in wp1 (up to 6, for the duplicate-name probes further down), so a failed
      // delete leaving this row behind — the expected pre-migration state — cannot also
      // collide with project_statuses_project_position_unique and mask a later test's
      // assertion behind the WRONG unique-constraint name.
      const { data: added } = await a
        .from('project_statuses')
        .insert({
          project_id: wp1,
          slug: 'tmp_del',
          name: 'Temporary, deleted below',
          category: 'in_progress',
          position: 99,
        })
        .select()
        .single()

      const asOwner = await a
        .from('project_statuses')
        .delete()
        .eq('id', added!.id)
        .select()
      expect(asOwner.error).toBeNull()
      expect(asOwner.data).toHaveLength(1) // the owner's own throwaway row is really gone.

      const asStranger = await b
        .from('project_statuses')
        .delete()
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(asStranger.error).toBeNull()
      expect(asStranger.data).toEqual([])

      const survivors = await a
        .from('project_statuses')
        .select('slug')
        .eq('project_id', wp1)
        .order('position')
      expect(survivors.data!.map((r) => r.slug)).toEqual([
        ...DEFAULT_PROJECT_STATUSES.map((s) => s.slug),
        'qa',
      ])
    })

    /**
     * AC4's edge. project_statuses_project_name_unique is keyed on
     * `lower(btrim(name))`, mirroring the existing project_statuses_name_nonempty
     * check: "Done", "done" and " Done " are one name to a user, so they are one name
     * to the index. Both halves are asserted because a plain `unique (project_id,
     * name)` would let either through.
     */
    it('a duplicate status name is rejected within one project, ignoring case and padding', async () => {
      const sameCaseless = await a
        .from('project_statuses')
        .insert({
          project_id: wp1,
          slug: 'qa_lower',
          name: 'in qa',
          category: 'in_progress',
          position: 6,
        })
        .select()
      expect(sameCaseless.data).toBeNull()
      expect(sameCaseless.error!.code).toBe('23505')
      // The CONSTRAINT NAME, not just the SQLSTATE. `writeError` in project-statuses.ts can
      // only tell a duplicate name from a stale position by matching this string — PostgREST
      // returns `details` and `hint` null, so `message` is the sole channel. Without this
      // assertion a migration renaming the index degrades AC4's "A status with that name
      // already exists in this project." to generic retry copy, with the gate green. The
      // stale-position sentence was pinned from the start; this half was not, which had the
      // coverage inverted relative to which message a user is more likely to see.
      expect(sameCaseless.error!.message).toContain('project_statuses_project_name_unique')

      const samePadded = await a
        .from('project_statuses')
        .insert({
          project_id: wp1,
          slug: 'qa_padded',
          name: '  In QA  ',
          category: 'in_progress',
          position: 6,
        })
        .select()
      expect(samePadded.data).toBeNull()
      expect(samePadded.error!.code).toBe('23505')

      const rows = await a.from('project_statuses').select('slug').eq('project_id', wp1)
      expect(rows.data).toHaveLength(DEFAULT_PROJECT_STATUSES.length + 1) // neither landed
    })

    /**
     * THE CONSTRAINT `src/lib/sprints.ts` LEANS ON, and nothing asserted it existed.
     *
     * `completeSprint` builds its "not on a terminal status" filter by string-joining
     * slugs into a PostgREST `in (…)` list, and its docblock says that is safe BECAUSE
     * project_statuses_slug_format constrains every slug to `^[a-z][a-z0-9_]{0,29}$` —
     * no comma, paren or quote to escape. That was true and unpinned: drop the check
     * and a slug containing a comma silently splits the list, so extra statuses are
     * excluded from the filter and INCOMPLETE tickets stay attached to a completed
     * sprint. No unit test can see it — the client never validates a slug it read back
     * from a row. Follows projects_key_format's precedent in projects.integration.test.ts.
     *
     * Three probes, one per clause the join actually depends on: the comma is the
     * separator, the closing paren terminates the list, and a leading digit is the
     * check's `^[a-z]` anchor (which `slugForName`'s `s_` prefix exists to satisfy).
     */
    it.each([['q,a'], ['qa)'], ['1qa']])(
      'rejects the slug %s — project_statuses_slug_format is what makes the sprint filter safe',
      async (slug) => {
        const { data, error } = await a
          .from('project_statuses')
          .insert({ project_id: wp2, slug, name: `Probe ${slug}`, position: 90 })
          .select()
        expect(data).toBeNull()
        expect(error!.code).toBe('23514') // OBSERVED: check_violation.
        expect(error!.message).toContain('project_statuses_slug_format')
      },
    )

    /**
     * `is_initial` IS client-writable on INSERT — measured, not assumed:
     * `has_column_privilege('authenticated','project_statuses','is_initial','INSERT')`
     * is true, and the insert below reaches the database rather than being refused at
     * 42501 the way the UPDATE above is. The ONLY thing stopping a project from having
     * two initial statuses is the partial unique index
     * project_statuses_one_initial_per_project, and nothing asserted that either.
     *
     * Inert today (`createProjectStatus` always sends `is_initial: false`) and
     * load-bearing at SPRIN-80, which replaces tickets.status's bare `default 'todo'`
     * with an is_initial lookup — at which point "exactly one initial status" stops
     * being tidiness and becomes the thing ticket creation resolves against.
     *
     * A stranger's attempt is paired in for the second half: the WITH CHECK refuses it
     * at 42501 before the index is ever consulted, so the two guards are independently
     * evidenced rather than covering for each other.
     */
    it('cannot insert a SECOND initial status, even though is_initial is insertable', async () => {
      const { data, error } = await a
        .from('project_statuses')
        .insert({
          project_id: wp2,
          slug: 'kickoff',
          name: 'Kickoff',
          category: 'todo',
          position: 91,
          is_initial: true,
        })
        .select()
      expect(data).toBeNull()
      // NOT 42501: the column grant permits this write, the index refuses the row.
      expect(error!.code).toBe('23505')
      expect(error!.message).toContain('project_statuses_one_initial_per_project')

      // The seeded initial status is untouched, and no second one landed.
      const initial = await a
        .from('project_statuses')
        .select('slug')
        .eq('project_id', wp2)
        .eq('is_initial', true)
      expect(initial.data).toEqual([{ slug: 'todo' }])
    })

    /**
     * THE SENTENCE `project-statuses.ts` PARSES. Its `writeError` distinguishes a
     * duplicate NAME from a duplicate POSITION — two 23505s with completely different
     * remedies — and PostgREST gives it only one channel to do it on: `details` and
     * `hint` are both null here, so the constraint name lives in `message` alone.
     *
     * Without this, renaming a constraint or a PostgREST upgrade that reworded the
     * message would silently collapse every position collision back into "a status with
     * that name already exists" — the exact false statement the mapping was written to
     * remove, and one no mocked-client unit test can detect, because the unit tests
     * supply the message themselves.
     */
    it('names the violated constraint in the message, which is how the client tells them apart', async () => {
      // The LAST SEEDED position, so this collides wherever in the block it runs — a literal
      // would tie it to whatever the tests around it happen to have inserted by then. The name
      // and slug are unique in wp2, so position is the only constraint this row can violate.
      const collision = await a
        .from('project_statuses')
        .insert({
          project_id: wp2,
          slug: 'position_probe',
          name: 'Position probe',
          category: 'todo',
          position: DEFAULT_PROJECT_STATUSES.length,
        })
        .select()
      expect(collision.data).toBeNull()
      expect(collision.error!.code).toBe('23505')
      expect(collision.error!.message).toContain('project_statuses_project_position_unique')
      // And the name constraint is a DIFFERENT string, or the client could not separate them.
      expect(collision.error!.message).not.toContain('project_statuses_project_name_unique')
    })

    /**
     * The other half of AC4, and as load-bearing as the rejection: the index is scoped
     * by project_id, so the same name in a different project is legal. A project_id-less
     * index would pass the test above and silently break every second project.
     */
    it('the same status name in a DIFFERENT project is accepted', async () => {
      const { data, error } = await a
        .from('project_statuses')
        .insert({
          project_id: wp2,
          slug: 'qa',
          name: 'In QA',
          category: 'in_progress',
          position: 5,
        })
        .select()
        .single()
      expect(error).toBeNull()
      expect(data!.name).toBe('In QA')

      // And the original is still there, unchanged, in the other project.
      const first = await a
        .from('project_statuses')
        .select('name')
        .eq('project_id', wp1)
        .eq('slug', 'qa')
      expect(first.data).toEqual([{ name: 'In QA' }])
    })

    /**
     * The reorder is an RPC rather than N position PATCHes because
     * project_statuses_project_position_unique is DEFERRABLE INITIALLY DEFERRED and
     * PostgREST gives every request its own transaction — separate patches collide on
     * the first swap, with no later statement for the deferral to defer to.
     *
     * Asserting the resulting (slug, position) pairs, not just "no error", is what
     * makes this a reorder test: positions must come back DENSE 1..N in exactly the
     * order asked for, which is also the board's column order.
     */
    it('reorder_project_statuses produces the order it was asked for, dense from 1', async () => {
      const order = ['qa', 'done', 'in_review', 'in_progress', 'todo']
      const { data, error } = await a.rpc('reorder_project_statuses', {
        p_project_id: wp1,
        p_slugs: order,
      })
      expect(error).toBeNull()
      expect(data).toHaveLength(order.length)

      const rows = await a
        .from('project_statuses')
        .select('slug, position')
        .eq('project_id', wp1)
        .order('position')
      expect(rows.data).toEqual(order.map((slug, i) => ({ slug, position: i + 1 })))
    })

    /**
     * SECURITY INVOKER is the whole reason this is safe to publish as an RPC. Under
     * DEFINER the function would run as the table owner and rewrite any tenant's board
     * from a guessed project id. Asserting the order is UNCHANGED is the evidence —
     * "the call did not raise" would pass even if it had scrambled every row.
     */
    it("a stranger's reorder call changes nothing", async () => {
      const { data, error } = await b.rpc('reorder_project_statuses', {
        p_project_id: wp1,
        p_slugs: ['todo', 'done'],
      })
      expect(error).toBeNull() // B may EXECUTE it; statuses_owner_update matches no row.
      expect(data).toEqual([])

      const rows = await a
        .from('project_statuses')
        .select('slug')
        .eq('project_id', wp1)
        .order('position')
      expect(rows.data!.map((r) => r.slug)).toEqual([
        'qa',
        'done',
        'in_review',
        'in_progress',
        'todo',
      ])
    })

    /**
     * Functions are EXECUTE-to-public by default, so the migration's explicit
     * `revoke ... from public, anon` is the only thing keeping an unauthenticated
     * caller out. anonClient() performs no sign-in, so this costs the GoTrue rate
     * limiter nothing.
     */
    it('an anonymous caller cannot execute the reorder RPC', async () => {
      const { error } = await anonClient().rpc('reorder_project_statuses', {
        p_project_id: wp1,
        p_slugs: ['todo', 'done'],
      })
      expect(error).not.toBeNull()
      expect(error!.code).toBe('42501') // OBSERVED: permission denied for function.

      const rows = await a
        .from('project_statuses')
        .select('slug')
        .eq('project_id', wp1)
        .order('position')
      expect(rows.data![0]!.slug).toBe('qa') // and the order is untouched
    })
  })

  describe('the owner can delete a status, safely (SPRIN-80)', () => {
    let dp: string

    beforeAll(async () => {
      dp = await throwawayProject('Status deletes')
    }, 30_000)

    afterAll(async () => {
      const gone = dp ? await settled(a.from('projects').delete().eq('id', dp).select()) : null
      expect(gone?.error).toBeNull()
      expect(gone?.data).toHaveLength(1)
    }, 30_000)

    /** POSITIVE CONTROL, first: every refusal below only means something if this passes. */
    it('deletes an EMPTY status, and no ticket is left referencing it (AC1, AC3)', async () => {
      const { data: added } = await a
        .from('project_statuses')
        .insert({ project_id: dp, slug: 'qa', name: 'Ready for QA', category: 'in_progress', position: 9 })
        .select()
        .single()

      const { data, error } = await a
        .from('project_statuses')
        .delete()
        .eq('id', added!.id)
        .select()
      expect(error).toBeNull()
      expect(data).toHaveLength(1)

      // AC3 asserted DIRECTLY against the database, not inferred from the UI looking right.
      // adminClient() bypasses RLS, so a stranded row cannot hide behind a policy.
      const { data: stranded } = await adminClient()
        .from('tickets')
        .select('id')
        .eq('project_id', dp)
        .eq('status', 'qa')
      expect(stranded).toHaveLength(0)
    })

    it('REFUSES to delete a status holding tickets, and the tickets survive (AC2, AC5)', async () => {
      const { data: t } = await a
        .from('tickets')
        .insert({ project_id: dp, summary: 'Sits on todo', type: 'story' })
        .select()
        .single()

      const { data: todo } = await a
        .from('project_statuses')
        .select('id')
        .eq('project_id', dp)
        .eq('slug', 'todo')
        .single()

      const { error } = await a.from('project_statuses').delete().eq('id', todo!.id).select()
      expect(error?.code).toBe('23503')

      // The interrupted-delete path: the ticket is still there, still on its status.
      const { data: survivor } = await adminClient()
        .from('tickets')
        .select('status')
        .eq('id', t!.id)
        .single()
      expect(survivor!.status).toBe('todo')

      await a.from('tickets').delete().eq('id', t!.id)
    })

    it('REFUSES to delete the last remaining status (AC4)', async () => {
      const solo = await throwawayProject('Only one status left')
      try {
        const { data: rows } = await a.from('project_statuses').select('id, is_initial').eq('project_id', solo)
        const keep = rows!.find((r) => r.is_initial)!
        for (const r of rows!.filter((r) => r.id !== keep.id)) {
          await a.from('project_statuses').delete().eq('id', r.id)
        }

        const { error } = await a.from('project_statuses').delete().eq('id', keep.id).select()
        expect(error?.code).toBe('SB001')

        const { data: left } = await a.from('project_statuses').select('id').eq('project_id', solo)
        expect(left).toHaveLength(1)
      } finally {
        await a.from('projects').delete().eq('id', solo)
      }
    })

    /**
     * Pins the DATABASE's promotion rule against the same expectation `removeStatus`'s unit test
     * pins for the client's. The two derivations cannot be shared across SQL and TypeScript, so
     * this is what stops them drifting.
     *
     * GENERIC by design: it reads whichever slug is currently `is_initial` and computes the
     * expected survivor from position, rather than hard-coding `todo`/`in_progress`. That is
     * what makes it the right place to pin the PROMOTION RULE itself. The trailing ticket-insert
     * assertion here only proves the promotion is "real" (something later reads it), which is a
     * different, narrower claim than `tickets.integration.test.ts`'s "resolves a new ticket's
     * status from the promoted initial status" — that test fixes the scenario (delete `todo`,
     * expect `in_progress`) specifically so a reader can verify it against
     * `DEFAULT_PROJECT_STATUSES` without also trusting this test's own row-position query. Both
     * are kept; neither substitutes for the other.
     */
    it('promotes the lowest-position survivor when the initial status is deleted', async () => {
      const p = await throwawayProject('Promotion')
      try {
        const { data: rows } = await a
          .from('project_statuses')
          .select('id, slug, position, is_initial')
          .eq('project_id', p)
          .order('position')

        const wasInitial = rows!.find((r) => r.is_initial)!
        const expected = rows!.filter((r) => r.id !== wasInitial.id).sort((x, y) => x.position - y.position)[0]!

        const { error } = await a.from('project_statuses').delete().eq('id', wasInitial.id).select()
        expect(error).toBeNull()

        const { data: after } = await a
          .from('project_statuses')
          .select('id, slug, is_initial')
          .eq('project_id', p)
        expect(after!.filter((r) => r.is_initial)).toHaveLength(1)
        expect(after!.find((r) => r.is_initial)!.id).toBe(expected.id)

        // And the promotion is REAL: a ticket created now lands on the promoted status,
        // proving the BEFORE INSERT resolution and the AFTER DELETE promotion together.
        const { data: fresh } = await a
          .from('tickets')
          .insert({ project_id: p, summary: 'After promotion', type: 'story' })
          .select('status')
          .single()
        expect(fresh!.status).toBe(expected.slug)
      } finally {
        await a.from('projects').delete().eq('id', p)
      }
    })

    it("user B cannot delete user A's status — zero rows, and no error", async () => {
      const { data: todo } = await adminClient()
        .from('project_statuses')
        .select('id')
        .eq('project_id', dp)
        .eq('slug', 'in_review')
        .single()

      // RLS FILTERS rather than raising. The row COUNT is the only evidence.
      const { data, error } = await b.from('project_statuses').delete().eq('id', todo!.id).select()
      expect(error).toBeNull()
      expect(data).toHaveLength(0)

      const { data: still } = await adminClient()
        .from('project_statuses')
        .select('id')
        .eq('id', todo!.id)
      expect(still).toHaveLength(1)
    })
  })
})
