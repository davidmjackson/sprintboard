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
  // `@/lib/tickets` imports `./supabase`, which calls `getEnv()` at MODULE scope — a
  // static import here would throw at file-load time whenever the environment is
  // missing, turning this file's loud, deliberate skip into a hard error. Imported
  // lazily in beforeAll instead, same reasoning as `tickets.integration.test.ts`'s
  // `updateTicket`.
  let ticketInsertPayload: typeof import('@/lib/tickets').ticketInsertPayload

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
    ;({ ticketInsertPayload } = await import('@/lib/tickets'))

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
      .insert(ticketInsertPayload({ project_id: projectA, summary: "A's ticket" }))
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
      // project in the SHARED live database, where nothing could reach them afterwards —
      // at the time, project_statuses had no DELETE policy at all. Five orphaned pairs
      // accumulated before anyone looked. SPRIN-80 has since added a DELETE policy, so a
      // stranded STATUS is now reachable in principle; the stranded PROJECT is not, because
      // no later run signs in as the owner that created it. An assertion in teardown is a
      // REPORT; the delete is an OBLIGATION, and the obligation goes first.
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
      // Where new tickets land. SPRIN-80 removed tickets.status's column default and made
      // resolve_initial_ticket_status read this flag instead, so this row IS the starting
      // column now rather than merely agreeing with a literal that sat beside it.
      expect(data!.find((s) => s.is_initial)!.slug).toBe('todo')
    })

    /**
     * Deliberately reads the fixture ticket rather than inserting another one:
     * the "B cannot INSERT a ticket" test below counts A's tickets as its
     * did-nothing-land control, so an extra insert here would break it from a
     * distance. That coupling is why this asserts rather than creates.
     *
     * The two were reunited by SPRIN-80. `tickets.status` USED TO carry the bare literal
     * `default 'todo'` alongside the `is_initial` flag, so this test would once have passed
     * even if `is_initial` had been seeded on `done`. That default is gone: the column has
     * none, and resolve_initial_ticket_status fills an omitted status from the project's
     * `is_initial` row. So the value below now comes from the same place the seeding test
     * above asserts, and a mis-seeded flag lands here.
     */
    it('a ticket resolves to todo from the seeded is_initial status', async () => {
      const { data, error } = await a.from('tickets').select('status').eq('id', ticketA).single()
      expect(error).toBeNull()
      // Still 'todo', but for a THIRD reason: not a check constraint (SPRIN-79 removed it),
      // and no longer a column default (SPRIN-80 removed that) — a BEFORE INSERT trigger
      // reading is_initial, with tickets_status_fk keeping the result honest.
      expect(data!.status).toBe('todo')
    })

    it('assign_ticket_key increments — the second ticket is KEY-2, not KEY-1', async () => {
      const { data, error } = await a
        .from('tickets')
        .insert(ticketInsertPayload({ project_id: projectA, summary: 'Second' }))
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

    /**
     * `projects` IS DELIBERATELY ABSENT FROM THIS TEST, and it used to be the first line.
     *
     * SPRIN-82 revoked the table-wide UPDATE privilege on `projects` from `authenticated`
     * (docs/migrations/sprin-82-projects-immutable.sql), so B's update no longer returns
     * an empty result set — it returns 42501 with `data === null`, and the row count this
     * test is built on stops existing.
     *
     * The tempting repair — change `[]` to `null`, or assert the error — is the WRONG one
     * and was rejected explicitly. That line would then pass because of the GRANT, so
     * dropping the `projects_owner` policy would no longer redden it: two controls on one
     * write, and the assertion can no longer tell you which one is holding. `sprints` and
     * `tickets` stay because they still hold table-wide UPDATE, so they still genuinely
     * exercise RLS *filtering*, which is what this describe block's comment says it is
     * about.
     *
     * WHERE THE COVERAGE WENT. `projects` keeps its cross-tenant coverage for SELECT (the
     * test directly above) and DELETE (the test two below) here, and for INSERT via the
     * spoofed-`owner_id` 42501 case in `src/test/projects.integration.test.ts`. Nothing was
     * dropped, because there is no longer any UPDATE privilege for RLS to filter — the
     * assertion removed was not covering a hole, it was covering a verb that no longer
     * reaches the policy at all. The privilege refusal
     * itself is asserted, owner-side, in `src/test/projects.integration.test.ts`
     * ("refuses the owner's own project_type UPDATE"): owner rather than stranger, because
     * a stranger was already blocked by the policy and would prove nothing about the grant.
     *
     * ⚠ PUT THIS LINE BACK THE DAY ANY COLUMN OF `projects` BECOMES UPDATABLE — and the
     * "rename a project" story the migration anticipates is exactly that day. The argument
     * above holds only while `projects` carries NO update privilege at all. The moment a
     * story runs `grant update (name) on projects to authenticated`, UPDATE reaches the
     * policy again for that column, `projects_owner` is load-bearing for it, and B renaming
     * A's project is a live cross-tenant write with no assertion anywhere in this repo
     * against it. The owner-side 42501 test does NOT cover it and will not notice: a COLUMN
     * grant leaves `project_type` ungranted, so that test stays green while this hole opens.
     * Nothing goes red to ask for this. Restore it in the same shape `sprints` and `tickets`
     * use below — `b.from('projects').update({ name: 'pwned' }).eq('id', projectA).select()`,
     * asserting `[]` — because at that point RLS filtering is once again what is holding, so
     * a row count is once again the honest assertion. The same obligation is recorded above
     * the revoke in `docs/sprintboard_phase1_schema.sql` and in
     * `docs/migrations/sprin-82-projects-immutable.sql`.
     */
    it('B cannot UPDATE any of it', async () => {
      const sprint = await b.from('sprints').update({ name: 'pwned' }).eq('id', sprintA).select()
      const ticket = await b.from('tickets').update({ summary: 'pwned' }).eq('id', ticketA).select()

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
        .insert(ticketInsertPayload({ project_id: projectA, summary: 'planted by B' }))
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
      const anon = anonClient()
      const { data, error } = await anon.from('project_statuses').select('id')
      expect(error).toBeNull()
      expect(data).toEqual([])

      const asA = await a.from('project_statuses').select('id').eq('project_id', projectA)
      expect(asA.data).toHaveLength(4) // positive control: the rows do exist

      // AND ANON HOLDS NO DELETE PRIVILEGE, which is a DIFFERENT guard from the empty read
      // above and had no coverage at all. ALTER DEFAULT PRIVILEGES had granted `anon`
      // table-level DELETE on this table (measured against relacl); SPRIN-80 revoked it in
      // the same migration that opened DELETE to the owner. Without the revoke, RLS would
      // be the only thing standing between an unauthenticated caller and this table for
      // that verb — and RLS FILTERS rather than raising, so its failure mode is silent.
      // 42501 is the privilege refusing before any policy is consulted; a zero-row delete
      // with `error === null` would be the revoke having been undone.
      const wiped = await anon.from('project_statuses').delete().eq('project_id', projectA).select()
      expect(wiped.data).toBeNull()
      expect(wiped.error!.code).toBe('42501') // OBSERVED: permission denied for table.

      const survivors = await a.from('project_statuses').select('id').eq('project_id', projectA)
      expect(survivors.data).toHaveLength(4)
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
        .insert(ticketInsertPayload({ project_id: proj!.id, summary: 'rides the cascade' }))
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
   * status strands the tickets sitting on it and deleting `todo` permanently broke ticket
   * creation, because tickets.status defaulted to the bare literal 'todo'. SPRIN-80 owns
   * deletion: it added the fourth policy, replaced that default with an `is_initial`
   * lookup, and guarded the delete with a trigger and a foreign key.
   *
   * KEEP THE FOUR POLICIES APART — BUT NO TEST IN THIS FILE ENFORCES THAT, and an earlier
   * version of this docblock said one did. All four predicates are identical, so a single
   * `for all` policy behaves identically through PostgREST: INSERT ignores USING, UPDATE
   * gets both, SELECT and DELETE get USING. PostgREST cannot read pg_policy, so no Vitest
   * test can see policy SHAPE at all. The only pin is the post-state assertion in
   * `docs/migrations/sprin-80-status-deletes.sql`, which runs when a human re-applies that
   * file, never in CI. What the tests below DO cover is behaviour: who can delete what,
   * and what the guards refuse.
   *
   * UPDATE is narrowed a second time, by PRIVILEGE rather than by policy: the
   * table-level grant is revoked and re-granted on (name, category, position) alone,
   * so `slug` — the fk target of tickets_status_fk — and `is_initial` cannot move.
   * A policy cannot express that, so no policy test can catch its loss.
   *
   * WHY ITS OWN PROJECTS. Every test here writes, and when this block was written there
   * was no DELETE policy at all, so a status planted in the shared fixture project could
   * never be removed again. SPRIN-80 added one, but the reasoning survives it: these
   * projects are still dropped whole in afterAll, because the cascade removes the counter,
   * sprint and tickets too and nothing else in this suite is signed in as their owner. It
   * also keeps `projectA` and
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
     * SPRIN-85 AC2 and AC3, and the POSITIVE CONTROL for the widened grant. Every refusal
     * below is evidence only if this passes: if `wip_limit` had been left out of the
     * rewritten grant, this is the test that says so, and nothing else would.
     *
     * Written as set-then-read-back-then-clear rather than three tests, because AC2 is
     * literally "persists across a reload" — a second, separate SELECT is what a reload is.
     */
    it('the owner can set, re-read and clear a wip_limit', async () => {
      const set = await a
        .from('project_statuses')
        .update({ wip_limit: 3 })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(set.error).toBeNull()
      expect(set.data).toHaveLength(1)

      // AC2: a FRESH read, which is what "persists across a reload" means.
      const reread = await a
        .from('project_statuses')
        .select('slug, wip_limit')
        .eq('project_id', wp1)
        .eq('slug', 'qa')
      expect(reread.data).toEqual([{ slug: 'qa', wip_limit: 3 }])

      // AC3: empty clears to null, and null is stored as null rather than 0.
      const cleared = await a
        .from('project_statuses')
        .update({ wip_limit: null })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select('slug, wip_limit')
      expect(cleared.error).toBeNull()
      expect(cleared.data).toEqual([{ slug: 'qa', wip_limit: null }])
    })

    /**
     * SPRIN-85 AC4, the DATABASE half — and it is TWO mechanisms with two SQLSTATEs, which
     * is why they are asserted separately rather than as one "the database refuses it".
     *
     *   0 and -1 parse fine as integers and are refused by the CHECK      -> 23514
     *   1.5 never reaches the check; the COLUMN TYPE refuses it            -> 22P02
     *
     * A test asserting one code for all three would be asserting something false, and would
     * go green if the check constraint were dropped entirely (the type would still catch
     * 1.5, and 0 would then be stored happily).
     */
    it.each([0, -1])('the database refuses a wip_limit of %i', async (value) => {
      const { error } = await a
        .from('project_statuses')
        .update({ wip_limit: value })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(error!.code).toBe('23514') // OBSERVED: project_statuses_wip_limit_positive.
    })

    it('the database refuses a fractional wip_limit', async () => {
      const { error } = await a
        .from('project_statuses')
        .update({ wip_limit: 1.5 } as never)
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(error!.code).toBe('22P02') // OBSERVED: invalid input syntax for type integer.
    })

    /**
     * NOT AN AC — and in scope anyway. SPRIN-85's migration RESTATES the whole column list
     * in one grant, so a typo silently DROPS a column. Three of the four have a live
     * witness: `name` in the rename above, `position` through the reorder RPC (which is
     * SECURITY INVOKER and so writes as the caller), and `wip_limit` in the test above.
     *
     * `category` had NONE — it is only ever written on INSERT in this suite — so dropping
     * it from the rewritten grant would have shipped green. This closes the last
     * unwitnessed column of the exact control this story rewrites.
     */
    it('the owner can recategorise a status', async () => {
      const { data, error } = await a
        .from('project_statuses')
        .update({ category: 'done' })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select('slug, category')
      expect(error).toBeNull()
      expect(data).toEqual([{ slug: 'qa', category: 'done' }])

      // Put it back: the tests in this block run in order and share the `qa` row, and a
      // later reorder test counts on the vocabulary it was given.
      await a
        .from('project_statuses')
        .update({ category: 'in_progress' })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
    })

    /**
     * Fix round 1, finding 1. The grant SPRIN-85 widened is to the ROLE `authenticated`, not
     * to a project — B holds the identical column-UPDATE privilege on `qa` that A does. The
     * only thing narrowing a write to the owner is `statuses_owner_update`'s RLS, and until
     * now nothing in this file exercised `project_statuses` with a direct cross-tenant
     * `.update()` — every existing stranger case above is INSERT, DELETE or the reorder RPC.
     *
     * RLS FILTERS an UPDATE rather than raising on it, so B's call returns `error: null,
     * data: []` — the row count is the only signal, never `error`. Paired with A's own write
     * to the SAME row succeeding straight after: without that pairing, a fixture that refuses
     * everything would look identical to a working policy. Covers `wip_limit` (the column
     * this story granted) and `name` (pre-existing), in one call each.
     */
    it("a stranger cannot UPDATE A's status row directly; the owner still can", async () => {
      const asStranger = await b
        .from('project_statuses')
        .update({ wip_limit: 9, name: 'Hijacked' })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(asStranger.error).toBeNull()
      expect(asStranger.data).toEqual([]) // OBSERVED: RLS filters, it does not raise.

      const asOwner = await a
        .from('project_statuses')
        .update({ wip_limit: 7, name: 'In QA' })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(asOwner.error).toBeNull()
      expect(asOwner.data).toHaveLength(1)

      // Re-read as A: neither B's wip_limit nor B's name landed, and A's own write did.
      const reread = await a
        .from('project_statuses')
        .select('slug, name, wip_limit')
        .eq('project_id', wp1)
        .eq('slug', 'qa')
      expect(reread.data).toEqual([{ slug: 'qa', name: 'In QA', wip_limit: 7 }])

      // Restore: the wip_limit tests above left this row at null, and later tests in this
      // block share it.
      await a
        .from('project_statuses')
        .update({ wip_limit: null })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
    })

    /**
     * Fix round 1, finding 2(b). `anon` holds ZERO column-level UPDATE privileges on this
     * table — measured against `pg_attribute.attacl` while writing the migration's post-state
     * check (finding 2(a), in the migration file). This is the live guard for that: a
     * PRIVILEGE refusal is 42501 with `data === null`, a different shape from RLS's silent
     * empty-array filter, because the grant refuses the statement before any policy runs.
     * Paired with the owner's own write to the same row for the same reason as above.
     */
    it('an anonymous caller cannot UPDATE project_statuses at all', async () => {
      const { data, error } = await anonClient()
        .from('project_statuses')
        .update({ wip_limit: 9 })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(data).toBeNull()
      expect(error!.code).toBe('42501') // OBSERVED: permission denied for table project_statuses.

      const asOwner = await a
        .from('project_statuses')
        .update({ wip_limit: 5 })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
        .select()
      expect(asOwner.error).toBeNull()
      expect(asOwner.data).toHaveLength(1)

      // Restore: later tests in this block share this row and expect wip_limit null.
      await a
        .from('project_statuses')
        .update({ wip_limit: null })
        .eq('project_id', wp1)
        .eq('slug', 'qa')
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
    it('the owner can delete their OWN status; a stranger still cannot touch qa', async () => {
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

      const asOwner = await a.from('project_statuses').delete().eq('id', added!.id).select()
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

    /**
     * POSITIVE CONTROL, first: every refusal below only means something if this passes.
     *
     * WHAT THIS TEST DOES NOT PROVE: AC3. Two earlier versions claimed it did, and neither
     * claim survived. AC3 — "after a status is deleted, no ticket references a status that
     * no longer exists" — is STRUCTURALLY guaranteed here rather than independently
     * observable, because the only status this design will ever delete is an EMPTY one. The
     * stranded-row query below therefore returns [] whatever `tickets_status_fk` is set to.
     * The second attempt added the bystander ticket and said a misconfigured fk would damage
     * it; that is disprovable and was rejected on review — the delete targets `qa`, so
     * CASCADE or SET NULL could only ever touch rows keyed (project_id, 'qa'), and the
     * bystander is keyed (project_id, 'todo'). AC3's real guard is the 23503 refusal test
     * below, where a ticket DOES sit on the status being deleted. See its docblock.
     *
     * WHAT IT DOES PROVE, which is worth keeping: the delete removes exactly its own row and
     * nothing else in the project. The bystander pins that an over-broad delete — a policy or
     * a filter matching more than the targeted id — cannot pass unnoticed, and it sits on a
     * DIFFERENT status deliberately, so it does not trigger the fk refusal that is the next
     * test's subject.
     */
    it('deletes an EMPTY status and touches no other row in the project (AC1)', async () => {
      const { data: added } = await a
        .from('project_statuses')
        .insert({
          project_id: dp,
          slug: 'qa',
          name: 'Ready for QA',
          category: 'in_progress',
          position: 9,
        })
        .select()
        .single()

      const { data: bystander } = await a
        .from('tickets')
        .insert(
          ticketInsertPayload({ project_id: dp, summary: 'Bystander on todo', type: 'story' }),
        )
        .select('id, status')
        .single()
      expect(bystander!.status).toBe('todo') // not 'qa': the delete below must not touch it

      try {
        const { data, error } = await a
          .from('project_statuses')
          .delete()
          .eq('id', added!.id)
          .select()
        expect(error).toBeNull()
        expect(data).toHaveLength(1)

        // Nothing is left pointing at the removed slug. Read through adminClient(), which
        // bypasses RLS, so a row cannot hide behind a policy — but note this is the query
        // the docblock calls structurally satisfied: `qa` was empty before the delete, so
        // [] is the only answer it can give. It is kept as the cheap shape of the claim,
        // NOT as its evidence.
        const { data: stranded } = await adminClient()
          .from('tickets')
          .select('id')
          .eq('project_id', dp)
          .eq('status', 'qa')
        expect(stranded).toHaveLength(0)

        // THE ASSERTION THAT EARNS ITS PLACE: nothing was collateral. The bystander is still
        // there, still on 'todo'.
        const { data: survivor } = await adminClient()
          .from('tickets')
          .select('status')
          .eq('id', bystander!.id)
        expect(survivor).toHaveLength(1)
        expect(survivor![0]!.status).toBe('todo')
      } finally {
        // The next test counts on `dp` holding only the ticket IT creates.
        const cleared = await settled(a.from('tickets').delete().eq('id', bystander!.id).select())
        expect(cleared.error).toBeNull()
        expect(cleared.data).toHaveLength(1)
      }
    })

    /**
     * THIS IS WHERE AC3 IS ENFORCED — "after a status is deleted, no ticket references a
     * status that no longer exists" — and it is the only place it can be. Under this design
     * an occupied status is never deleted at all, so the property is upheld by REFUSAL, not
     * by cleanup: the fk is `on delete no action`, and the refusal IS the mechanism.
     *
     * Which is why the two assertions below are one claim in two halves and neither may be
     * dropped. The 23503 says the delete was refused; the survivor says the ticket is still
     * there AND still on `todo`. Set `tickets_status_fk` to `on delete cascade` and the first
     * half goes quiet (no error at all) while the second finds no row; set it to `set null`
     * and the ticket survives pointing at nothing. Both mutations are visible from here and
     * from nowhere else in this suite.
     */
    it('REFUSES to delete a status holding tickets, and that ticket survives intact (AC2, AC3, AC5)', async () => {
      const { data: t } = await a
        .from('tickets')
        .insert(ticketInsertPayload({ project_id: dp, summary: 'Sits on todo', type: 'story' }))
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

      // The interrupted-delete path: the ticket is still there, still on its status…
      const { data: survivor } = await adminClient()
        .from('tickets')
        .select('status')
        .eq('id', t!.id)
        .single()
      expect(survivor!.status).toBe('todo')

      // …and the status it points at is still there to point at. Read through adminClient()
      // so a surviving row cannot be mistaken for one hidden by a policy.
      const { data: stillThere } = await adminClient()
        .from('project_statuses')
        .select('id')
        .eq('id', todo!.id)
      expect(stillThere).toHaveLength(1)

      await a.from('tickets').delete().eq('id', t!.id)
    })

    it('REFUSES to delete the last remaining status (AC4)', async () => {
      const solo = await throwawayProject('Only one status left')
      try {
        const { data: rows } = await a
          .from('project_statuses')
          .select('id, is_initial')
          .eq('project_id', solo)
        const keep = rows!.find((r) => r.is_initial)!
        for (const r of rows!.filter((r) => r.id !== keep.id)) {
          await a.from('project_statuses').delete().eq('id', r.id)
        }

        const { error } = await a.from('project_statuses').delete().eq('id', keep.id).select()
        expect(error?.code).toBe('SB001')

        const { data: left } = await a.from('project_statuses').select('id').eq('project_id', solo)
        expect(left).toHaveLength(1)
      } finally {
        // DELETE FIRST, ASSERT AFTERWARDS. An unasserted teardown that silently removes
        // zero rows leaks the project into the SHARED live database, where nothing can
        // reach it again — the failure mode that stranded ten fixture projects once
        // already. settled() keeps a teardown failure from masking the real one above.
        const gone = await settled(a.from('projects').delete().eq('id', solo).select())
        expect(gone.error).toBeNull()
        expect(gone.data).toHaveLength(1)
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
        const expected = rows!
          .filter((r) => r.id !== wasInitial.id)
          .sort((x, y) => x.position - y.position)[0]!

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
          .insert(ticketInsertPayload({ project_id: p, summary: 'After promotion', type: 'story' }))
          .select('status')
          .single()
        expect(fresh!.status).toBe(expected.slug)
      } finally {
        // DELETE FIRST, ASSERT AFTERWARDS — see the note in the AC4 test above. This one
        // also carries a ticket, so a silent zero-row teardown strands more than a project.
        const gone = await settled(a.from('projects').delete().eq('id', p).select())
        expect(gone.error).toBeNull()
        expect(gone.data).toHaveLength(1)
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

  /**
   * SPRIN-90 — the project_fields table (epic SPRIN-71, custom fields).
   *
   * Story 1 is READ-ONLY by design: the migration grants `authenticated` SELECT and
   * UPDATE(name), and nothing else. So every fixture row here is created through
   * adminClient(), which uses the service_role key and bypasses both RLS and the grants.
   * That is the only way to get rows onto a table the app role cannot insert into — and it
   * is the honest way, because it does not quietly widen the privilege under test.
   *
   * WHAT IS NOT ASSERTED HERE, AND WHY. There is no "B cannot INSERT another tenant's field"
   * test. `authenticated` holds no INSERT at all, so such a write is refused by the missing
   * GRANT before `fields_owner_insert` is ever consulted — and a revoked grant and an RLS
   * WITH CHECK violation BOTH raise 42501. With nobody holding INSERT there is no positive
   * control able to tell those two apart, so the test would pass with the policy deleted
   * outright. Story 2 grants INSERT and proves the policy there, where a refusal is
   * attributable. Asserting it now would be a control that cannot fail.
   */
  describe('a project can define custom fields, owner-scoped (SPRIN-90)', () => {
    let fieldA: string

    beforeAll(async () => {
      const { data, error } = await adminClient()
        .from('project_fields')
        .insert([
          { project_id: projectA, slug: 'customer_ref', name: 'Customer ref', type: 'text' },
          { project_id: projectB, slug: 'squad', name: 'Squad', type: 'select' },
        ])
        .select('id, project_id')
      if (error) throw new Error(`Fixture: could not seed project_fields: ${error.message}`)
      fieldA = data!.find((r) => r.project_id === projectA)!.id
    })

    // ---- AC3: the type vocabulary is enforced by the DATABASE, not only by zod ----

    it('accepts every type the client declares, and rejects one it does not', async () => {
      // The positive half first, so the rejection below cannot pass because inserts are
      // broken generally. Uses adminClient for the same reason as the fixture.
      const ok = await adminClient()
        .from('project_fields')
        .insert({ project_id: projectA, slug: 'notes_long', name: 'Notes', type: 'paragraph' })
        .select('id')
      expect(ok.error).toBeNull()
      expect(ok.data).toHaveLength(1)

      const bad = await adminClient()
        .from('project_fields')
        .insert({ project_id: projectA, slug: 'is_urgent', name: 'Urgent', type: 'checkbox' })
        .select('id')

      // 23514 is check_violation. Asserting the CONSTRAINT NAME too, not just the SQLSTATE:
      // `message` is the only channel PostgREST exposes for constraint identity, and without
      // it this passes on ANY check failing — including the slug-format one, which a typo in
      // the fixture would trip.
      expect(bad.error?.code).toBe('23514')
      expect(bad.error?.message).toMatch(/project_fields_type_check/)
    })

    it('rejects a slug that is not a legal identifier', async () => {
      const { error } = await adminClient()
        .from('project_fields')
        .insert({ project_id: projectA, slug: 'Customer Ref', name: 'Customer ref', type: 'text' })

      expect(error?.code).toBe('23514')
      expect(error?.message).toMatch(/project_fields_slug_format/)
    })

    // ---- AC4: slug and type are IMMUTABLE, and that is a column privilege ----

    /**
     * The whole point of this test is the POSITIVE CONTROL in it.
     *
     * A blanket row-level refusal — no UPDATE privilege at all, or an RLS policy that denies
     * everything — would make the two refusals below pass while proving nothing about
     * COLUMN-level grants. The `name` update on the SAME ROW is what separates "this column
     * is not writable" from "this row is not writable".
     *
     * Type immutability is not a tidiness rule: story 3's ticket_field_values carries a
     * denormalised copy of `type` so its "the populated column matches the type" CHECK can be
     * written at all, and that copy is sound ONLY while the original cannot change.
     *
     * `name` is the ONLY writable column, so this test walks **all five** of the others —
     * `project_id`, `slug`, `type`, `created_at`, `id`. Each refusal protects a different
     * property, and the exhaustiveness is the point: a test naming only the two "interesting"
     * columns leaves the grant free to widen anywhere else in silence.
     *
     * **`project_id` is the one it is easiest to leave out and the worst one to lose.** It is
     * the tenancy column. `authenticated` holds INSERT on it but not UPDATE, so the GRANT is
     * the only thing preventing a field being MOVED between projects —
     * `fields_owner_update`'s WITH CHECK refuses a move to a project you do not own, but
     * permits a move between two you DO. `AssertProjectFieldUpdateColumns` is exhaustive on
     * the client, and a raw PostgREST call bypasses it entirely. SPRIN-75 widens "own" to
     * "member of", which widens the blast radius with it.
     *
     * An earlier version of this docblock said "all four of the others" and walked four. There
     * are five. That is how the tenancy column came to be the missing one.
     */
    it('refuses UPDATE to every column but name, while name updates on the same row', async () => {
      // SPRIN-91 widened this test on a security review's finding, then widened it again on a
      // re-review: the INSERT side of the ordering rule was pinned below while the UPDATE side
      // was not, and the first widening then walked four of the five columns.
      //
      // A TABLE rather than five hand-written blocks, so a sixth column is one row and cannot
      // be "the one somebody forgot". Each entry carries a legal value for its column type —
      // a malformed one would earn 22P02 before the privilege check and pass this test for the
      // wrong reason.
      const forbidden = [
        { column: 'project_id', patch: { project_id: projectB } },
        { column: 'slug', patch: { slug: 'moved' } },
        { column: 'type', patch: { type: 'number' } },
        { column: 'created_at', patch: { created_at: '2000-01-01T00:00:00Z' } },
        { column: 'id', patch: { id: '00000000-0000-4000-8000-000000000002' } },
      ]

      for (const { column, patch } of forbidden) {
        const refused = await a.from('project_fields').update(patch).eq('id', fieldA)
        // The MESSAGE as well as the code, on every one of them. 42501 has two possible
        // authors here — the column privilege and `fields_owner_update`'s USING clause — and
        // `project_id` is precisely where they diverge: A owns this row, so RLS lets the
        // update through and only the missing GRANT refuses it. Asserting the code alone would
        // let a future RLS-shaped refusal masquerade as the privilege this test is about.
        expect(refused.error?.code, `${column} should be refused`).toBe('42501')
        expect(refused.error?.message, `${column} should be a privilege refusal`).toMatch(
          /permission denied/,
        )
      }

      const name = await a
        .from('project_fields')
        .update({ name: 'Customer reference' })
        .eq('id', fieldA)
        .select('id, slug, type, name')
      expect(name.error).toBeNull()
      expect(name.data).toHaveLength(1)
      expect(name.data![0]).toMatchObject({
        name: 'Customer reference',
        slug: 'customer_ref',
        type: 'text',
      })
    })

    // ---- AC5: read isolation. RLS FILTERS on USING — it does not raise ----

    it("B sees none of A's custom fields, while A sees its own", async () => {
      // UNFILTERED reads in both directions. `fields_owner_read` reaches project_fields
      // through an EXISTS on projects; delete its correlating clause and the predicate
      // becomes "does this caller own any project at all", which compiles and leaks every
      // row to every user who owns one. A `.eq('project_id', …)` read would not catch that.
      const asB = await b.from('project_fields').select('project_id')
      expect(asB.error).toBeNull()
      expect(asB.data!.filter((r) => r.project_id === projectA)).toEqual([])
      // Positive control INSIDE the same read: B does see its own, so an empty result cannot
      // mean the read was simply broken.
      expect(asB.data!.filter((r) => r.project_id === projectB)).toHaveLength(1)

      const asA = await a.from('project_fields').select('project_id')
      expect(asA.error).toBeNull()
      expect(asA.data!.filter((r) => r.project_id === projectB)).toEqual([])
      expect(asA.data!.filter((r) => r.project_id === projectA).length).toBeGreaterThan(0)
    })

    it("B cannot UPDATE A's field, even on the one writable column", async () => {
      // RLS FILTERS an UPDATE rather than raising, so the tell is the ROW COUNT, not an
      // error. Asserting `error` alone would pass on a policy that matched every row.
      const { data, error } = await b
        .from('project_fields')
        .update({ name: 'Hijacked' })
        .eq('id', fieldA)
        .select()
      expect(error).toBeNull()
      expect(data).toHaveLength(0)

      const { data: intact } = await adminClient()
        .from('project_fields')
        .select('name')
        .eq('id', fieldA)
      expect(intact![0]?.name).not.toBe('Hijacked')
    })

    /**
     * ALTER DEFAULT PRIVILEGES grants `anon` full DML on every new table in `public` —
     * measured against pg_default_acl (anon=arwdDxtm), not assumed. This migration revoked
     * insert/update/delete and deliberately left SELECT.
     *
     * anon reads zero rows because `auth.uid()` is NULL, NOT because no policy covers it:
     * all four policies are created without a `TO` clause, so they apply to `public`, which
     * includes anon (verified against pg_policies). Stating that precisely matters — the
     * wrong explanation would let someone add a public-sharing SELECT policy believing anon
     * was excluded structurally.
     *
     * The three halves fail DIFFERENTLY and a test must pick the right shape for each: a
     * privilege refusal is 42501 with `data === null`, whereas an RLS filter is
     * `error: null, data: []`. Asserting the wrong one passes for the wrong reason.
     */
    it('an anonymous caller reads nothing and cannot write at all', async () => {
      const anon = anonClient()

      const read = await anon.from('project_fields').select('id')
      expect(read.error).toBeNull()
      expect(read.data).toEqual([]) // RLS filtering, not a privilege error

      const write = await anon
        .from('project_fields')
        .insert({ project_id: projectA, slug: 'sneaky', name: 'Sneaky', type: 'text' })
      // 42501 ALONE CANNOT SAY WHICH CONTROL REFUSED THIS. Because fields_owner_insert also
      // applies to anon (roles = {public}) and its EXISTS is false for a NULL auth.uid(), a
      // WITH CHECK violation raises 42501 too — so the code alone would stay green if a later
      // migration handed INSERT back to anon, which is exactly the fat-fingered-role-list
      // mistake the documented REVOKE-cascade invites. `permission denied` is emitted by the
      // privilege check; an RLS refusal says "violates row-level security policy" instead.
      expect(write.error?.code).toBe('42501')
      expect(write.error?.message).toMatch(/permission denied/)

      const del = await anon.from('project_fields').delete().eq('id', fieldA)
      expect(del.error?.code).toBe('42501')

      // Positive control: the rows the anon read could not see do exist.
      const { data: exists } = await adminClient()
        .from('project_fields')
        .select('id')
        .eq('id', fieldA)
      expect(exists).toHaveLength(1)
    })

    /**
     * NARROWED by SPRIN-91, not deleted, and the distinction matters.
     *
     * This test was written to pin story 1's no-INSERT/no-DELETE state so that stories 2 and 6
     * could not widen the privilege silently — "deny by default, widen visibly". Migration B
     * grants INSERT, so the INSERT half did its job and went red; it is replaced below by
     * assertions that prove the policy the grant makes reachable.
     *
     * The DELETE half stays exactly as it was. It is story 6's tripwire and deleting the whole
     * test would throw it away — which is the easy, tidy-looking mistake here, since the test's
     * name no longer matches half its body.
     */
    it('an authenticated owner still holds no DELETE on their own fields', async () => {
      const del = await a.from('project_fields').delete().eq('id', fieldA)
      expect(del.error?.code).toBe('42501')
      // The MESSAGE too, applying the same standard this story insists on for the INSERT
      // proof. A owns this row, so RLS could not be the author of a 42501 here and the code
      // alone is unambiguous today — but it stops being unambiguous the moment story 6 grants
      // DELETE, and then this test must fail for the RIGHT reason or not at all.
      expect(del.error?.message).toMatch(/permission denied/)
    })

    // ---- SPRIN-91: the INSERT grant, and the policy it finally makes provable ----

    /**
     * THE DEBT STORY 1 RECORDED AND COULD NOT PAY.
     *
     * With INSERT revoked, a cross-tenant insert died on the missing GRANT before
     * `fields_owner_insert` was ever consulted — and a revoked grant and an RLS WITH CHECK
     * violation BOTH raise 42501. There was no positive control able to separate them, so the
     * test would have passed with the policy deleted outright. Story 1 declined to ship a
     * control that could not fail. Migration B grants INSERT, which is what makes the refusal
     * attributable, so this test is only possible now.
     *
     * TWO things make it real, and neither is optional:
     *
     *   the MESSAGE — 42501 alone cannot say which control refused the write. The privilege
     *   check emits `permission denied`; an RLS refusal says `violates row-level security
     *   policy`. Asserting the code alone would stay green if a later migration revoked INSERT
     *   again, reporting a policy pass for a write the policy never saw. This is the same
     *   discrimination the anon test above makes, in the opposite direction.
     *
     *   the POSITIVE CONTROL — B inserting into B's OWN project, on the SAME client, in the
     *   SAME test. Without it, a migration that failed to grant INSERT at all would leave the
     *   cross-tenant assertion green for exactly the wrong reason, which is the hole story 1
     *   refused to ship.
     */
    it("B cannot INSERT a field into A's project, but can into its own", async () => {
      const crossTenant = await b
        .from('project_fields')
        .insert({ project_id: projectA, slug: 'planted', name: 'Planted', type: 'text' })
      expect(crossTenant.error?.code).toBe('42501')
      expect(crossTenant.error?.message).toMatch(/row-level security policy/)
      // Not the OTHER 42501. If this ever matches, the grant is gone and the assertion above
      // is proving nothing about the policy.
      expect(crossTenant.error?.message).not.toMatch(/permission denied/)

      const ownProject = await b
        .from('project_fields')
        .insert({ project_id: projectB, slug: 'own_field', name: 'Own field', type: 'number' })
        .select('id')

      // CLEANED UP BEFORE THE ASSERTIONS, not after — this file's own recorded lesson, and it
      // is not pedantry: an `expect` that throws skips everything below it, so a cleanup placed
      // after the assertions is exactly the cleanup that does not run on the day it matters.
      // Removed through adminClient because B holds no DELETE.
      //
      // Leaving projectB with the one field its fixture created is what keeps the
      // read-isolation test above (which asserts that count EXACTLY) independent of this one.
      // It currently runs first, but a test that silently depends on file order is a trap for
      // whoever reorders the file next.
      const plantedId = ownProject.data?.[0]?.id
      if (plantedId) await adminClient().from('project_fields').delete().eq('id', plantedId)

      expect(ownProject.error).toBeNull()
      expect(ownProject.data).toHaveLength(1)
    })

    /**
     * The grant is on FOUR COLUMNS, not on the table — and without this test that is
     * indistinguishable from a table-wide grant.
     *
     * `created_at` is withheld because it is the SORT KEY: the epic design makes
     * (created_at, slug) the field order with no `position` column standing behind it, so a
     * writable created_at is a writable sort order. `id` is withheld because nothing in the
     * app has any reason to choose a primary key. Both are defaults, so withholding them costs
     * the client nothing.
     *
     * The permitted insert comes FIRST, so a refusal below cannot pass because inserts are
     * broken generally — the same positive-control discipline as everywhere else in this file.
     */
    it('refuses an insert that supplies created_at or id, while the same row without them succeeds', async () => {
      const permitted = await a
        .from('project_fields')
        .insert({ project_id: projectA, slug: 'granted_cols', name: 'Granted', type: 'date' })
        .select('id')
      expect(permitted.error).toBeNull()
      expect(permitted.data).toHaveLength(1)

      const withTimestamp = await a.from('project_fields').insert({
        project_id: projectA,
        slug: 'forged_order',
        name: 'Forged order',
        type: 'text',
        // A value far enough in the past to sort ahead of every real row, which is exactly
        // what the withheld column prevents.
        created_at: '2000-01-01T00:00:00Z',
      })
      expect(withTimestamp.error?.code).toBe('42501')
      expect(withTimestamp.error?.message).toMatch(/permission denied/)

      const withId = await a.from('project_fields').insert({
        id: '00000000-0000-4000-8000-000000000001',
        project_id: projectA,
        slug: 'forged_id',
        name: 'Forged id',
        type: 'text',
      })
      expect(withId.error?.code).toBe('42501')
      expect(withId.error?.message).toMatch(/permission denied/)
    })

    /**
     * AC4's DATABASE edge. The client half lives in `field-schemas.test.ts`; this is the second
     * edge CLAUDE.md requires, and it is asserted through the APP ROLE rather than adminClient()
     * so it exercises the privilege the app actually holds.
     *
     * The constraint NAME is asserted, not just the SQLSTATE: `project_fields_slug_format` is
     * also a 23514 on this table, so a fixture typo would otherwise pass this test while
     * proving nothing about names.
     */
    it('refuses an empty, whitespace-only or over-length name', async () => {
      // POSITIVE CONTROL FIRST, matching the sibling test above rather than trailing the
      // refusals: a control that only runs once everything else has already passed cannot
      // report the one condition it exists to report.
      //
      // BE PRECISE ABOUT THE MECHANISM, because an earlier draft of this comment got it
      // backwards and a fix resting on a false reason is one the next author will undo.
      // Postgres evaluates CHECK constraints in `ExecConstraints()` BEFORE the tuple reaches
      // index insertion, so an empty name on an already-taken slug still raises
      // 23514/`project_fields_name_nonempty`, never 23505. The refusals below would therefore
      // have passed on a colliding slug; it is the CONTROL that would have failed, correctly
      // naming the collision. So the reorder does not rescue the refusals from a misleading
      // 23505 — it puts the assertion that can DIAGNOSE a collision ahead of three that cannot.
      // `name_edge_2` for the refusals is then defensive rather than necessary.
      const ok = await a
        .from('project_fields')
        .insert({ project_id: projectA, slug: 'name_edge', name: 'Name edge', type: 'text' })
        .select('id')
      expect(ok.error).toBeNull()
      expect(ok.data).toHaveLength(1)

      // A DIFFERENT slug for the refusals, now that `name_edge` is taken by the control.
      for (const name of ['', '   ', 'x'.repeat(41)]) {
        const { error } = await a
          .from('project_fields')
          .insert({ project_id: projectA, slug: 'name_edge_2', name, type: 'text' })
        expect(error?.code).toBe('23514')
        // The constraint NAME, not just the SQLSTATE: `project_fields_slug_format` is also a
        // 23514 on this table, so a typo in the slug above would otherwise pass this test
        // while proving nothing whatsoever about names.
        expect(error?.message).toMatch(/project_fields_name_nonempty/)
      }
    })

    /**
     * AC3, at the database edge: a rename changes `name` and leaves `slug` alone.
     *
     * The slug is read back BY VALUE through adminClient(), not merely asserted to have
     * survived the update. `renameProjectField` sends `{ name }` alone, so a defect that also
     * sent `slug` would be refused by the column grant and show up as a failed write — but a
     * defect in the DERIVATION (a rename that re-derives the slug and sends both) is invisible
     * unless the stored slug is compared to what it was before.
     */
    it('a rename leaves the slug exactly as it was', async () => {
      const created = await a
        .from('project_fields')
        .insert({ project_id: projectA, slug: 'delivery_date', name: 'Ship by', type: 'date' })
        .select('id, slug')
      expect(created.error).toBeNull()
      const { id, slug } = created.data![0]!
      // The fixture's name does NOT lowercase to its slug — 'Ship by' derives 'ship_by', not
      // 'delivery_date'. A fixture where the two are equal cannot tell a read of one from a
      // read of the other, which is the confound SPRIN-87 broke three times.
      expect(slug).toBe('delivery_date')

      const renamed = await a
        .from('project_fields')
        .update({ name: 'Target ship date' })
        .eq('id', id)
        .select('id')
      expect(renamed.error).toBeNull()
      expect(renamed.data).toHaveLength(1)

      const { data: after } = await adminClient()
        .from('project_fields')
        .select('name, slug')
        .eq('id', id)
      expect(after![0]).toMatchObject({ name: 'Target ship date', slug: 'delivery_date' })
    })
  })

  /**
   * SPRIN-88 — ticket_field_values (epic SPRIN-71, story 3).
   *
   * **This block is the evidence for the story's central design argument, not decoration.**
   * The migration grants `authenticated` UPDATE on ALL EIGHT columns rather than on the four
   * value columns alone, because PostgREST compiles `.upsert(row)` into
   * `INSERT … ON CONFLICT DO UPDATE SET c = excluded.c` for every column in the payload and
   * Postgres demands UPDATE privilege on each — so a narrow grant would let the FIRST write to
   * a field succeed and every later one fail with 42501. The story therefore declines to use
   * the grant as the control and rests on the constraints instead. That is either right or it
   * is a tenancy hole, and it cannot be settled by reading, so every constraint it leans on is
   * exercised below.
   *
   * **The type→column mapping is restated LITERALLY here rather than imported from
   * `VALUE_COLUMN`.** Importing the client's own map would make this test agree with the code
   * by construction: a map that routed `paragraph` to the wrong column would generate a
   * "wrong" case that the database happily accepted, and the suite would stay green on exactly
   * the defect it exists to catch. These literals encode what the CHECK CONSTRAINT says.
   *
   * All of it lives in this file rather than half in `tickets.integration.test.ts` so the CI
   * tripwire gap stays at seven files, and because `projectA`, `projectB` and `ticketA` are
   * already here — the cross-tenant cases need two tenants, which only this fixture has.
   */
  describe("a ticket carries values for its project's custom fields (SPRIN-88)", () => {
    /** Field ids in project A, one per type, keyed by type. */
    const fieldOf: Record<string, string> = {}
    /** A field belonging to project B — the other tenant — for the AC5 cases. */
    let fieldInB: string

    /**
     * The five arms of `tfv_one_value_matching_type`, each with a column that IS right for the
     * type and one that is not. The wrong column is a different one for `number` and `date`
     * than for the rest, so no single "always writes value_text" defect satisfies them all.
     */
    const CASES = [
      {
        type: 'text',
        slug: 'tfv_ref',
        right: { value_text: 'ACME-1' },
        wrong: { value_number: 1 },
      },
      {
        type: 'paragraph',
        slug: 'tfv_notes',
        right: { value_text: 'Two\nlines' },
        wrong: { value_number: 1 },
      },
      {
        type: 'number',
        slug: 'tfv_tier',
        right: { value_number: -2.5 },
        wrong: { value_text: 'x' },
      },
      {
        type: 'date',
        slug: 'tfv_target',
        right: { value_date: '2026-08-07' },
        wrong: { value_text: 'x' },
      },
      {
        type: 'select',
        slug: 'tfv_band',
        right: { value_option: 'red' },
        wrong: { value_number: 1 },
      },
    ] as const

    beforeAll(async () => {
      const { data, error } = await a
        .from('project_fields')
        .insert(
          CASES.map((c) => ({
            project_id: projectA,
            slug: c.slug,
            name: `SPRIN-88 ${c.type}`,
            type: c.type,
          })),
        )
        .select('id, type')
      if (error) throw new Error(`Fixture: could not seed SPRIN-88 fields: ${error.message}`)
      for (const row of data!) fieldOf[row.type] = row.id

      // Owned by B, so it is a genuinely foreign field rather than one A merely does not use.
      const other = await b
        .from('project_fields')
        .insert({ project_id: projectB, slug: 'tfv_foreign', name: 'B only', type: 'text' })
        .select('id')
        .single()
      if (other.error) throw new Error(`Fixture: could not seed B's field: ${other.error.message}`)
      fieldInB = other.data.id
    })

    // ---- AC4: the value must be in the column its type calls for ----

    for (const c of CASES) {
      it(`stores a ${c.type} value in its own column and refuses it in another`, async () => {
        // NEGATIVE FIRST, so the positive below cannot be what makes it pass — then POSITIVE,
        // so the refusal cannot be an insert that was broken for some unrelated reason. Either
        // half alone is a test that passes with the constraint dropped or with the table
        // unwritable; the pair is what makes this attributable.
        const refused = await a.from('ticket_field_values').insert({
          ticket_id: ticketA,
          project_id: projectA,
          field_id: fieldOf[c.type]!,
          field_type: c.type,
          ...c.wrong,
        })

        // 23514 is check_violation. The CONSTRAINT NAME is asserted too, because `message` is
        // the only channel PostgREST exposes for constraint identity and three different
        // constraints on this table can refuse a row.
        expect(refused.error?.code).toBe('23514')
        expect(refused.error?.message).toMatch(/tfv_one_value_matching_type/)

        const accepted = await a
          .from('ticket_field_values')
          .insert({
            ticket_id: ticketA,
            project_id: projectA,
            field_id: fieldOf[c.type]!,
            field_type: c.type,
            ...c.right,
          })
          .select('field_id')
        expect(accepted.error).toBeNull()
        expect(accepted.data).toHaveLength(1)

        // Leaves the table as it found it: the PK is (ticket_id, field_id) and later tests
        // insert against the same pair, so a surviving row would turn their inserts into 23505
        // and report a constraint failure that has nothing to do with what they assert.
        await a
          .from('ticket_field_values')
          .delete()
          .eq('ticket_id', ticketA)
          .eq('field_id', fieldOf[c.type]!)
      })
    }

    it('refuses a row with NO value and a row with TWO', async () => {
      // The two edges of the same constraint. "No value" is what makes AC3's delete-to-clear
      // structural rather than stylistic: a row of nulls is not representable, so the client
      // could not clear by writing null even if it wanted to.
      const none = await a.from('ticket_field_values').insert({
        ticket_id: ticketA,
        project_id: projectA,
        field_id: fieldOf.text!,
        field_type: 'text',
      })
      expect(none.error?.code).toBe('23514')
      expect(none.error?.message).toMatch(/tfv_one_value_matching_type/)

      const two = await a.from('ticket_field_values').insert({
        ticket_id: ticketA,
        project_id: projectA,
        field_id: fieldOf.text!,
        field_type: 'text',
        value_text: 'ACME-1',
        value_number: 1,
      })
      expect(two.error?.code).toBe('23514')
      expect(two.error?.message).toMatch(/tfv_one_value_matching_type/)
    })

    // ---- The carried field_type must be the definition's own ----

    it("refuses a field_type that is not the definition's", async () => {
      // `tfv_type_fk (field_id, field_type)` references `project_fields (id, type)`. The row
      // below satisfies the CHECK — field_type 'number' with value_number set is internally
      // consistent — so this isolates the foreign key: the only thing wrong is that the field
      // is a `text` one. This is what makes `field_type` immutable in practice despite the
      // grant allowing it to be written.
      const { error } = await a.from('ticket_field_values').insert({
        ticket_id: ticketA,
        project_id: projectA,
        field_id: fieldOf.text!,
        field_type: 'number',
        value_number: 1,
      })

      expect(error?.code).toBe('23503')
      expect(error?.message).toMatch(/tfv_type_fk/)
    })

    // ---- AC5: a ticket in project A cannot hold project B's field ----

    it("refuses another project's field on this project's ticket", async () => {
      // `field_type` is set to B's field's own type ('text'), so `tfv_type_fk` is SATISFIED and
      // the only failing constraint is `tfv_field_fk (field_id, project_id)`. Without that
      // care two constraints could refuse this row and the name assertion would be reporting
      // whichever fired first.
      const { error } = await a.from('ticket_field_values').insert({
        ticket_id: ticketA,
        project_id: projectA,
        field_id: fieldInB,
        field_type: 'text',
        value_text: 'cross-tenant',
      })

      expect(error?.code).toBe('23503')
      expect(error?.message).toMatch(/tfv_field_fk/)
    })

    /**
     * The mirror of AC5, isolating `tfv_ticket_fk` — and the ONE case that has to stay inside
     * a single tenant, which is the finding this test was rewritten for.
     *
     * **RLS's `WITH CHECK` is evaluated BEFORE foreign keys are validated.** The first draft
     * pointed this row at project B (`project_id: projectB`, `ticket_id: ticketA`) reasoning
     * that only the ticket would then be foreign. CI disagreed and returned **42501, not
     * 23503**: `tfv_owner_insert` tests ownership through `project_id` alone, so a row claiming
     * another tenant's project is refused by the policy and the foreign key is never reached.
     * A cross-TENANT row therefore cannot isolate any foreign key on this table at all.
     *
     * That reframes what the composite fk actually buys, and it is worth stating precisely
     * because the story's tenancy argument rests on it. Against another TENANT, RLS is the
     * defence and it fires first. `tfv_ticket_fk` defends the case RLS cannot see: the SAME
     * owner, two of their OWN projects, a value row pointing at a ticket from the wrong one.
     * That is the row this test builds, and it is a mistake the app could genuinely make.
     */
    it("refuses a ticket from another of the owner's own projects", async () => {
      const elsewhere = await throwawayProject('SPRIN-88 foreign ticket')
      try {
        const other = await a
          .from('tickets')
          .insert(ticketInsertPayload({ project_id: elsewhere, summary: 'Somewhere else' }))
          .select('id')
          .single()
        expect(other.error).toBeNull()

        // `project_id` stays A's own, so `tfv_owner_insert` is SATISFIED and cannot be what
        // refuses this — the point the 42501 above taught. The field is A's field in projectA,
        // so `tfv_field_fk` is satisfied too. The ticket is the only thing that does not belong.
        const { error } = await a.from('ticket_field_values').insert({
          ticket_id: other.data!.id,
          project_id: projectA,
          field_id: fieldOf.text!,
          field_type: 'text',
          value_text: 'wrong project',
        })

        expect(error?.code).toBe('23503')
        expect(error?.message).toMatch(/tfv_ticket_fk/)
      } finally {
        // Cleaned up here rather than left to teardown, which only deletes projectA and
        // projectB — five throwaway projects from earlier blocks already leak into the shared
        // database, and this suite's own history (five orphaned pairs) is why that matters.
        // In a `finally` so a failed assertion above cannot strand a sixth.
        await a.from('projects').delete().eq('id', elsewhere)
      }
    })

    // ---- RLS: a new table with new policies, on a two-tenant fixture ----

    describe("user B cannot reach user A's values", () => {
      let planted: string

      beforeAll(async () => {
        planted = fieldOf.text!
        const { error } = await a.from('ticket_field_values').insert({
          ticket_id: ticketA,
          project_id: projectA,
          field_id: planted,
          field_type: 'text',
          value_text: 'A-only',
        })
        if (error) throw new Error(`Fixture: could not seed A's value: ${error.message}`)
      })

      afterAll(async () => {
        await a
          .from('ticket_field_values')
          .delete()
          .eq('ticket_id', ticketA)
          .eq('field_id', planted)
      })

      it("A can read the row, and B's unfiltered read returns none of it", async () => {
        // The positive control is A's read, and it is REQUIRED: `tfv_owner_read` FILTERS rather
        // than raising, so B seeing `[]` is indistinguishable from the row not existing, from
        // the table being empty, or from the seed having silently failed.
        const asA = await a
          .from('ticket_field_values')
          .select('value_text')
          .eq('ticket_id', ticketA)
        expect(asA.error).toBeNull()
        expect(asA.data).toHaveLength(1)
        expect(asA.data![0]!.value_text).toBe('A-only')

        // UNFILTERED, so this asks what B can see of the whole table rather than what B can see
        // of a row it names — a policy that leaked every tenant's values would still pass a
        // read narrowed by `.eq('ticket_id', ticketA)` only by accident.
        const asB = await b.from('ticket_field_values').select('ticket_id')
        expect(asB.error).toBeNull()
        expect(asB.data).toEqual([])
      })

      it("B cannot INSERT a value onto A's ticket", async () => {
        const { error } = await b.from('ticket_field_values').insert({
          ticket_id: ticketA,
          project_id: projectA,
          field_id: planted,
          field_type: 'text',
          value_text: 'pwned',
        })

        // 42501 here is unambiguously the POLICY, not a missing grant — `authenticated` holds
        // INSERT on all eight columns and grants are role-wide rather than row-wide, so B has
        // exactly the privilege A used to seed this row. That is the discrimination a bare
        // "expect 42501" would skip: the two controls share a SQLSTATE.
        expect(error?.code).toBe('42501')
      })

      it("B's UPDATE matches no row, and A's value is untouched", async () => {
        const attempt = await b
          .from('ticket_field_values')
          .update({ value_text: 'pwned' })
          .eq('ticket_id', ticketA)
          .select()

        // FILTERED, not refused — `tfv_owner_update`'s USING clause hides the row, so this is
        // a successful update of zero rows. Counting them is the assertion; `error` being null
        // here is the expected outcome and proves nothing on its own.
        expect(attempt.error).toBeNull()
        expect(attempt.data).toEqual([])

        const after = await adminClient()
          .from('ticket_field_values')
          .select('value_text')
          .eq('ticket_id', ticketA)
        expect(after.data![0]!.value_text).toBe('A-only')
      })

      it("B's DELETE matches no row, and the row survives", async () => {
        const attempt = await b
          .from('ticket_field_values')
          .delete()
          .eq('ticket_id', ticketA)
          .select()
        expect(attempt.error).toBeNull()
        expect(attempt.data).toEqual([])

        // Read back through adminClient, which bypasses RLS: as A this would also return the
        // row, but as a check it could not tell "survived" from "hidden from B and visible to
        // A" if the delete had partially applied.
        const after = await adminClient()
          .from('ticket_field_values')
          .select('field_id')
          .eq('ticket_id', ticketA)
        expect(after.data).toHaveLength(1)
      })

      it('an anonymous caller can neither read nor write values', async () => {
        const anon = anonClient()

        // The policies carry no TO clause, so they cover `anon` as well — and `anon` holds
        // SELECT on this table. The read is therefore FILTERED to nothing rather than refused.
        const read = await anon.from('ticket_field_values').select('field_id')
        expect(read.error).toBeNull()
        expect(read.data).toEqual([])

        // The write is refused by the missing GRANT before any policy is consulted: the
        // migration gives `anon` no INSERT. A different author of the same SQLSTATE from the
        // case above, which is why both are asserted rather than one standing in for both.
        const write = await anon.from('ticket_field_values').insert({
          ticket_id: ticketA,
          project_id: projectA,
          field_id: planted,
          field_type: 'text',
          value_text: 'pwned',
        })
        expect(write.error?.code).toBe('42501')
      })
    })

    // ---- AC2/AC3 at the database edge ----

    it('a value survives being read back, and clearing REMOVES the row', async () => {
      const seed = await a
        .from('ticket_field_values')
        .insert({
          ticket_id: ticketA,
          project_id: projectA,
          field_id: fieldOf.number!,
          field_type: 'number',
          value_number: -2.5,
        })
        .select('value_number')
      expect(seed.error).toBeNull()
      // Round-tripped as a NUMBER, not as the digits. `numeric` arrives over PostgREST as a
      // JS number here, which is what `fieldValueText` stringifies for the control.
      expect(seed.data![0]!.value_number).toBe(-2.5)

      const cleared = await a
        .from('ticket_field_values')
        .delete()
        .eq('ticket_id', ticketA)
        .eq('field_id', fieldOf.number!)
        .select('field_id')
      expect(cleared.error).toBeNull()
      expect(cleared.data).toHaveLength(1)

      // Absence of the ROW, not a row of nulls — which is the only representation the check
      // constraint permits, and the reason `clearTicketFieldValue` is a delete.
      const after = await adminClient()
        .from('ticket_field_values')
        .select('field_id')
        .eq('ticket_id', ticketA)
        .eq('field_id', fieldOf.number!)
      expect(after.data).toEqual([])
    })

    it('deleting a field cascades its values away', async () => {
      // `tfv_field_fk` and `tfv_type_fk` both point at project_fields and BOTH cascade on
      // delete — deliberately, because two foreign keys to one table with different delete
      // actions resolve in RI trigger name order, which is luck. This is that pair executed
      // rather than catalogued.
      const doomed = await a
        .from('project_fields')
        .insert({ project_id: projectA, slug: 'tfv_doomed', name: 'Doomed', type: 'text' })
        .select('id')
        .single()
      expect(doomed.error).toBeNull()

      const seeded = await a.from('ticket_field_values').insert({
        ticket_id: ticketA,
        project_id: projectA,
        field_id: doomed.data!.id,
        field_type: 'text',
        value_text: 'goes with it',
      })
      expect(seeded.error).toBeNull()

      // Through adminClient: `authenticated` holds no DELETE on project_fields until story 6.
      const removed = await adminClient()
        .from('project_fields')
        .delete()
        .eq('id', doomed.data!.id)
        .select('id')
      expect(removed.error).toBeNull()
      expect(removed.data).toHaveLength(1)

      const orphans = await adminClient()
        .from('ticket_field_values')
        .select('field_id')
        .eq('field_id', doomed.data!.id)
      expect(orphans.data).toEqual([])
    })
  })
})
