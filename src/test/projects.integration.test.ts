// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import { assertCredentialsOrExplain, hasRlsCredentials, signIn, userId } from './supabase-clients'

assertCredentialsOrExplain()

/**
 * S3.1 — the database contract that `createProject` (src/lib/projects.ts) relies on,
 * proven live: an owner can insert and read back a project; the per-owner unique-key
 * constraint and the key-format check both bite. Uses the signed-in RLS user rather
 * than the app's unauthenticated singleton client, because the insert is only allowed
 * for `owner_id = auth.uid()`.
 */
function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `P${pick()}${pick()}${pick()}`
}

describe.skipIf(!hasRlsCredentials)('S3.1 project-creation contract', () => {
  let a: SupabaseClient<Database>
  let b: SupabaseClient<Database>
  let userAId: string
  let userBId: string
  const createdIds: string[] = []
  const bCreatedIds: string[] = []

  beforeAll(async () => {
    a = await signIn('A')
    userAId = await userId(a)
    b = await signIn('B')
    userBId = await userId(b)
  }, 30_000)

  afterAll(async () => {
    for (const id of bCreatedIds) await b.from('projects').delete().eq('id', id)
    for (const id of createdIds) await a.from('projects').delete().eq('id', id)
  }, 30_000)

  it('creates a project the owner can read back, defaulting project_type to scrum', async () => {
    const key = runKey()
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Contract test', key })
      .select()
      .single()

    expect(error).toBeNull()
    expect(data).toMatchObject({
      key,
      owner_id: userAId,
      name: 'Contract test',
      project_type: 'scrum',
    })
    if (data) createdIds.push(data.id)
  }, 30_000)

  /**
   * SPRIN-81 AC1/AC2. The two halves of the widened `projects_project_type_check`:
   * 'kanban' is now accepted, and the constraint still refuses everything else. Both
   * are live-only claims — `domain.test.ts` reads the schema DOC, which is applied by
   * hand, so only this suite can see what the database actually enforces.
   *
   * NOTE the cleanup placement, which deliberately differs from the tests either side:
   * they push after asserting, so a failed `expect()` aborts the body and strands the
   * project in the shared database forever. A teardown delete is an obligation; an
   * assertion is only a report. Push first.
   */
  it('creates a kanban project when project_type is supplied (SPRIN-81)', async () => {
    const key = runKey()
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Kanban contract test', key, project_type: 'kanban' })
      .select()
      .single()

    if (data) createdIds.push(data.id)

    expect(error).toBeNull()
    expect(data).toMatchObject({
      key,
      owner_id: userAId,
      name: 'Kanban contract test',
      project_type: 'kanban',
    })
  }, 30_000)

  it('rejects an unknown project_type (projects_project_type_check -> 23514)', async () => {
    // The row is pushed for cleanup even though the insert is expected to fail: if the
    // check constraint is ever dropped or widened by accident, this insert SUCCEEDS,
    // and the test that catches that must not also leak the project it created.
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Waterfall', key: runKey(), project_type: 'waterfall' })
      .select()
      .single()

    if (data) createdIds.push(data.id)

    // The code first — 23514 is "some check constraint refused this row".
    expect(error?.code).toBe('23514')

    // ...but `projects` has TWO check constraints, and 23514 does not say which one
    // fired. The original version of this test relied on the payload as the
    // discriminator: `runKey()` cannot produce a key `projects_key_format` rejects, so
    // project_type had to be the violation. That reasoning is true today and would go
    // silently false the day a third check lands on this table — the test would still
    // pass, while no longer testing project_type at all.
    //
    // So name the constraint. This asserts the constraint's NAME, not the message's
    // wording: the name is ours, it is written in the migration and the schema doc, and
    // renaming it is a deliberate act that SHOULD redden this. The prose around it
    // (`new row for relation ... violates check constraint ...`) stays unasserted,
    // because that IS Postgres's wording and not a contract.
    expect(error?.message).toContain('projects_project_type_check')
    expect(data).toBeNull()
  }, 30_000)

  /**
   * SPRIN-82 AC6 — `project_type` immutability stops being prose and becomes a database
   * control. `docs/migrations/sprin-82-projects-immutable.sql` revokes the table-wide
   * UPDATE privilege on `projects` from `authenticated` and `anon`, and grants no columns
   * back, because nothing in `src/` updates the table.
   *
   * OWNER, NOT STRANGER, and that is the entire point. `projects_owner` is `for all` on
   * `owner_id = auth.uid()`, so a stranger's UPDATE was ALWAYS filtered to zero rows — a
   * stranger-only test passes just as happily on the un-migrated database and would prove
   * nothing about this migration. The only caller who could ever have rewritten the column
   * is the row's own owner, so the owner is who this test signs in as.
   *
   * ASSERT THE CODE, NOT MERELY THAT AN ERROR EXISTS. RLS FILTERS, it does not raise: a
   * policy refusal arrives as `error === null` with zero rows. 42501 is
   * `insufficient_privilege` — the revoked grant refusing the statement outright, before
   * any policy is consulted. Only the code tells those two apart, and this whole story
   * turns on the distinction.
   *
   * …BUT THE CODE ALONE IS NOT ENOUGH, AND THAT IS WHY THE MESSAGE IS ASSERTED TOO.
   * `42501` is not one control, it is a class: the spoofed-`owner_id` test at the bottom of
   * this file asserts the identical code for a completely different refusal — an RLS
   * `WITH CHECK` violation on INSERT. Two controls, one code, forty lines apart, and a
   * reader comparing them cannot tell which is which. Postgres does distinguish them, in
   * the message, and both were MEASURED live rather than recalled:
   *
   *   revoked grant   -> `permission denied for table projects`
   *   RLS WITH CHECK  -> `new row violates row-level security policy for table "projects"`
   *
   * So each test names its own control. This is not pedantry about wording — it is what
   * makes these two tests independently falsifiable. Restore the grant and this test must
   * fail; drop `projects_owner` and the other one must fail. Without the message, a change
   * that swapped which control was doing the refusing would leave both green, and SPRIN-75
   * is a story that rewrites every policy on this table. It is the one place a policy edit
   * could start answering for a privilege, or vice versa.
   *
   * The message prose is Postgres's, not ours — unlike `projects_project_type_check` above,
   * which is a name we chose and may therefore pin whole. So this asserts a SUBSTRING that
   * names the control ('permission denied'), not the full sentence.
   *
   * NOTE WHAT DOES *NOT* STOP THIS WRITE: the type system. `TablesUpdate<'projects'>` has
   * `project_type?: string`, so the update below compiles with no cast at all. (The `as
   * never` idiom at `rls.integration.test.ts:350` is needed only because `TicketUpdate`
   * deliberately removes `key`/`number`; there is no equivalent narrowing for projects.)
   * A bug in the app would send exactly this, type-clean and lint-clean. Proving the
   * DATABASE holds is the point.
   */
  it("refuses the owner's own project_type UPDATE (revoked grant -> 42501)", async () => {
    // Push before asserting: a failed expect() aborts the body, and a teardown delete is
    // an obligation where an assertion is only a report.
    const created = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Immutable type', key: runKey() })
      .select()
      .single()

    if (created.data) createdIds.push(created.data.id)

    expect(created.error).toBeNull()
    expect(created.data!.project_type).toBe('scrum')
    const id = created.data!.id

    const { data, error } = await a
      .from('projects')
      .update({ project_type: 'kanban' })
      .eq('id', id)
      .select()

    expect(error?.code).toBe('42501')
    // Names the GRANT as the refusing control. See the docblock: the spoofed-owner_id test
    // below asserts the same 42501 for an RLS WITH CHECK violation, whose message reads
    // 'new row violates row-level security policy' instead. The code cannot tell them apart.
    expect(error?.message).toContain('permission denied')
    expect(data).toBeNull()

    // The positive control, in this same test, doing double duty: the row still reads
    // 'scrum', AND this same client can still SELECT the project. Without that second
    // half the test passes against a fixture that was never created — a refusal aimed at
    // a row that does not exist proves nothing about immutability.
    const after = await a.from('projects').select('project_type').eq('id', id)
    expect(after.error).toBeNull()
    expect(after.data).toEqual([{ project_type: 'scrum' }])
  }, 30_000)

  /**
   * SPRIN-97 AC1 — the owner CAN rewrite the two cadence columns. Migration B
   * (`docs/migrations/sprin-97-project-cadence-update.sql`) runs
   * `grant update (sprint_length_weeks, sprint_start_weekday) on projects to authenticated`,
   * the first UPDATE privilege this table has carried since SPRIN-82 revoked the table-wide
   * one.
   *
   * THIS TEST AND THE ONE DIRECTLY ABOVE IT ARE A PAIR, and neither means much alone. The
   * property is "this column set is writable and the rest of the table is not", which no
   * single assertion states: a column grant and a table grant are indistinguishable from the
   * writable side, and an un-applied migration and a correctly narrow one are
   * indistinguishable from the refused side. They fail DISJOINTLY, which is what makes the
   * pair worth its two round trips:
   *
   *   migration B never applied            -> THIS test reddens; the project_type test does not
   *   widened to `grant update on projects` -> the project_type test reddens; this one does not
   *
   * IT IS ALSO THE ONLY POSITIVE OBSERVATION THAT MIGRATION B EXISTS. Everything else this
   * story ships runs against source text or a mocked client — the AST allowlist in
   * `project-type-immutability.test.ts` reads the app's payload literal, and
   * `projects.test.ts` mocks the supabase client — so on a database where the grant was never
   * applied, every one of them stays green while the Settings form fails with 42501 for every
   * user forever. (The cross-tenant line in `rls.integration.test.ts` would redden too, since
   * a missing grant turns its `[]` into a 42501 with `data === null` — but it reddens as an
   * apparent isolation failure, which is the wrong diagnosis pointing at the wrong story.
   * This is the test whose failure names the cause.)
   *
   * OWNER, and only the owner. `projects_owner` is `for all` on `owner_id = auth.uid()`, so a
   * stranger's UPDATE is filtered to zero rows whether or not the grant exists — the mirror of
   * the argument in the docblock above, where owner-vs-stranger decides what a refusal proves.
   *
   * The payload names both columns and NOTHING else, deliberately: it is the same shape
   * `updateProjectCadence` sends, and it never writes `owner_id`, so the one thing this path
   * cannot produce is the RLS `WITH CHECK` flavour of 42501 the spoofed-owner test below
   * asserts.
   *
   * THE RE-READ IS NOT REDUNDANT. `.select()` on an UPDATE is PostgREST asking for RETURNING:
   * the statement's own account of what it did, reported before the transaction is anyone
   * else's business. A separate SELECT is what the table holds afterwards. They differ if the
   * write never commits, or if an AFTER trigger rewrites the row behind RETURNING's back —
   * and this story's whole subject is the gap between "the write was accepted" and "the value
   * is there", which is also exactly what AC2 ("still there after a reload") claims.
   */
  it('lets the owner UPDATE both cadence columns (SPRIN-97 grant -> one row)', async () => {
    // Push before asserting: a failed expect() aborts the body, and a teardown delete is
    // an obligation where an assertion is only a report.
    const created = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Cadence update', key: runKey() })
      .select('id, sprint_length_weeks, sprint_start_weekday')
      .single()

    if (created.data) createdIds.push(created.data.id)

    expect(created.error).toBeNull()
    // The starting values are asserted, not assumed, because the update below has to write
    // something DIFFERENT in both columns: a write of the value a row already holds is
    // indistinguishable from no write at all, and would pass on a database with no grant if
    // the grant ever stopped being what refuses. (The defaults themselves are SPRIN-94's
    // claim, pinned separately at the bottom of this file.)
    expect(created.data!.sprint_length_weeks).toBe(2)
    expect(created.data!.sprint_start_weekday).toBe(1)
    const id = created.data!.id

    // 3 weeks starting Thursday. Both inside the range checks — 1-4 and 1-7 — so a 23514
    // here would be a constraint regression, not this test picking an illegal value.
    const { data, error } = await a
      .from('projects')
      .update({ sprint_length_weeks: 3, sprint_start_weekday: 4 })
      .eq('id', id)
      .select()

    expect(error).toBeNull()
    // EXACTLY one row. `.eq('id', …)` is not what makes that true — a `.update()` whose
    // filter went missing would rewrite every project this user owns and still return the
    // one row this test could match against, so the length is the assertion that catches it.
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({ id, sprint_length_weeks: 3, sprint_start_weekday: 4 })

    const after = await a
      .from('projects')
      .select('sprint_length_weeks, sprint_start_weekday')
      .eq('id', id)
    expect(after.error).toBeNull()
    expect(after.data).toEqual([{ sprint_length_weeks: 3, sprint_start_weekday: 4 }])
  }, 30_000)

  it('rejects a duplicate key for the same owner (projects_owner_key_unique -> 23505)', async () => {
    const key = runKey()
    const first = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'First', key })
      .select()
      .single()
    expect(first.error).toBeNull()
    if (first.data) createdIds.push(first.data.id)

    const dup = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Dup', key })
      .select()
      .single()
    expect(dup.error?.code).toBe('23505')
  }, 30_000)

  it('rejects a key that violates the format check (projects_key_format -> 23514)', async () => {
    const { error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Bad key', key: 'toolong' })
      .select()
      .single()
    expect(error?.code).toBe('23514')
  }, 30_000)

  it('rejects a project whose owner_id is spoofed to another user (RLS -> 42501)', async () => {
    // The client sets owner_id, but the projects RLS policy's `with check
    // (owner_id = auth.uid())` is the boundary: signed in as A, you cannot create a
    // project owned by B, whatever you send. This is the security property S3.1 rests
    // on, pinned live at the feature. No row is created, so nothing to clean up.
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userBId, name: 'Spoofed', key: runKey() })
      .select()
      .single()

    expect(error?.code).toBe('42501')
    // NAMES ITS CONTROL, and this half arrived with SPRIN-82 rather than with the test.
    // Until then 42501 had exactly one meaning on this table, so the code was sufficient
    // on its own. SPRIN-82's revoke gave it a second: the owner-side project_type UPDATE
    // test above asserts the same 42501 for a REVOKED GRANT, which is a different control
    // in a different layer, refusing before any policy is consulted. Measured live, the two
    // messages are 'new row violates row-level security policy for table "projects"' and
    // 'permission denied for table projects' respectively.
    //
    // Fixing only the newer test would have left the confusion half-standing — this one
    // would still be the ambiguous member of the pair, and it is the one guarding the
    // tenant boundary. It matters most at SPRIN-75, which rewrites every policy on this
    // table to a membership check: a policy that stopped applying while a privilege picked
    // up the refusal would keep this test green and the boundary broken. Substring, not the
    // whole sentence — the prose is Postgres's, not a name this repo chose.
    expect(error?.message).toContain('row-level security policy')
    expect(data).toBeNull()
  }, 30_000)

  it("lists only the caller's own projects, never another owner's (RLS select)", async () => {
    // S3.2: the left-nav list is a plain select; RLS scopes it to the owner. Prove it
    // with two real owners — A's list contains A's project and excludes B's.
    const mine = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Mine', key: runKey() })
      .select()
      .single()
    expect(mine.error).toBeNull()
    createdIds.push(mine.data!.id)

    const theirs = await b
      .from('projects')
      .insert({ owner_id: userBId, name: 'Theirs', key: runKey() })
      .select()
      .single()
    expect(theirs.error).toBeNull()
    bCreatedIds.push(theirs.data!.id)

    const { data: list, error } = await a.from('projects').select('id')
    expect(error).toBeNull()
    const ids = (list ?? []).map((r) => r.id)
    expect(ids).toContain(mine.data!.id)
    expect(ids).not.toContain(theirs.data!.id)
  }, 30_000)

  /**
   * SPRIN-94 AC2 — every project is born with a cadence, and the DATABASE is what
   * supplies it. `createProject` sends neither column, exactly as it sends no
   * `project_type`, so a default that regressed to null or to a different number would
   * surface here and nowhere in the client.
   */
  it('defaults a new project to a two-week cadence starting Monday (SPRIN-94 AC2)', async () => {
    const key = runKey()
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Cadence default', key })
      .select('id, sprint_length_weeks, sprint_start_weekday')
      .single()

    expect(error).toBeNull()
    createdIds.push(data!.id)
    expect(data!.sprint_length_weeks).toBe(2)
    expect(data!.sprint_start_weekday).toBe(1)
  })

  /**
   * SPRIN-94 AC5, both halves. The CONSTRAINT NAME is asserted, not just the SQLSTATE:
   * `projects_key_format` and `projects_owner_key_unique` also live on this table, so a
   * bare 23514 would pass on a violation this test is not about — and `runKey()` is
   * random, so that is not hypothetical.
   */
  it('rejects a sprint length outside 1-4 (projects_sprint_length_weeks_range -> 23514)', async () => {
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Bad length', key: runKey(), sprint_length_weeks: 5 })
      .select('id')
      .single()

    expect(data).toBeNull()
    expect(error?.code).toBe('23514')
    expect(error?.message).toContain('projects_sprint_length_weeks_range')
  })

  it('rejects a start weekday outside 1-7 (projects_sprint_start_weekday_range -> 23514)', async () => {
    const { data, error } = await a
      .from('projects')
      .insert({ owner_id: userAId, name: 'Bad weekday', key: runKey(), sprint_start_weekday: 8 })
      .select('id')
      .single()

    expect(data).toBeNull()
    expect(error?.code).toBe('23514')
    expect(error?.message).toContain('projects_sprint_start_weekday_range')
  })
})
