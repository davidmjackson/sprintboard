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
 * SPRIN-99 -- the four CONFIG tables are governed by MEMBERSHIP, and by ROLE.
 *
 * `project_statuses`, `project_fields` and `project_field_options` become
 * member-READ / admin-WRITE: every member of a project reads its vocabulary and its
 * custom-field definitions, and only an `admin` reconfigures them.
 * `ticket_field_values` becomes member on ALL FOUR verbs -- setting a custom field's
 * VALUE on a ticket is daily board work, while defining the FIELD is the administrative
 * act. That asymmetry is the story, so it is asserted on both sides rather than assumed.
 *
 * THE TWO ASSERTION SHAPES, and getting them the wrong way round is the classic failure:
 *
 *   * RLS FILTERS on USING and RAISES on WITH CHECK. A refused INSERT is a thrown 42501.
 *     A refused UPDATE or DELETE comes back as `{ data: [], error: null }` -- a write that
 *     changed nothing, indistinguishable from one that changed everything unless the row
 *     COUNT is checked. So every zero-row assertion below is paired with a SERVICE-ROLE
 *     READ-BACK proving the row is genuinely intact rather than merely un-returned.
 *   * A policy that hides everything from everyone passes every negative test. So every
 *     negative is paired with a POSITIVE control: the same statement, succeeding for the
 *     caller who is meant to be allowed it.
 *
 * THE COLUMN-GRANT TRAP, which is sharper on these tables than anywhere else in the repo.
 * `authenticated` holds NO table-level UPDATE on any of the four (measured 2026-08-21:
 * `project_statuses` relacl `authenticated=ardDxtm`, the other three `authenticated=rdDxtm`).
 * The writable surface is COLUMN grants: `name, category, position, wip_limit` on
 * project_statuses, `name` alone on project_fields, `label` alone on project_field_options,
 * and all seven payload columns on ticket_field_values. A negative row-count assertion is
 * only honest on a column the role may actually UPDATE -- on any other column the privilege
 * layer raises 42501 BEFORE RLS is consulted, and the test silently measures the grant
 * instead of the policy. Every negative UPDATE below writes one of those granted columns.
 *
 * FOR THE SAME REASON every 42501 assertion pairs the CODE with a MESSAGE match naming
 * row-level security. On these tables a 42501 has two possible authors -- a missing grant
 * and a WITH CHECK violation -- and the code alone cannot tell them apart.
 *
 * WHY THIS SUITE CREATES ITS OWN USERS instead of using the long-lived A and B. Vitest runs
 * test FILES in parallel against one shared live database, and
 * `project-members.integration.test.ts` makes A and B co-members of a shared project in its
 * own `beforeAll`. Fresh throwaway users sidestep all of it.
 *
 * WHY M CREATES A PROJECT OF THEIR OWN. `app_auth.is_project_admin` has no `owner_id`
 * branch: a project's creator is an admin only because the SECURITY DEFINER trigger
 * `seed_project_admin` inserts them an admin membership row. M therefore holds `admin`
 * SOMEWHERE, which is what makes the scoping block below mean anything -- an
 * `is_project_admin` that ignored its `p_project_id` argument entirely would pass every
 * other test in this file, because M would be an admin nowhere at all.
 *
 * NO SECOND ADMIN IS EVER ADDED TO A PROJECT. `project-members.integration.test.ts` asserts
 * a whole-DATABASE invariant that every project has EXACTLY ONE admin; a second `admin` row
 * anywhere, even transiently, turns that sibling suite red for reasons nothing in its own
 * diff explains. M joins A's project as a plain `member`, and every other membership row in
 * play is one `seed_project_admin` created for a project's own creator.
 *
 * EVERY ASSERTION IS SCOPED to a fixture this file created. Under a membership model an
 * unscoped select is a whole-table invariant whose answer depends on every concurrently
 * running suite. The single deliberate exception is the anonymous read at the foot, and its
 * docblock says why it is safe.
 *
 * GATING: on `SUPABASE_SERVICE_ROLE_KEY`, because this suite creates its own users and needs
 * a client that bypasses RLS for the fixture and for the read-backs.
 * `assertServiceRoleOrExplain()` above, called at module load, is what stops a missing key
 * reporting this suite green by skipping it in CI. Removing that call removes a control.
 */
const PASSWORD = 'password123'

function freshEmail(tag: string): string {
  return `sprin99-${tag}-${crypto.randomUUID()}@example.com`
}

/** `projects_owner_key_unique` is per OWNER, and A creates two projects. */
const usedKeys = new Set<string>()

function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  let key = `C${pick()}${pick()}${pick()}`
  while (usedKeys.has(key)) key = `C${pick()}${pick()}${pick()}`
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

/** Postgres "insufficient privilege". Always asserted alongside the RLS message -- see above. */
const INSUFFICIENT_PRIVILEGE = '42501'
const RLS_REFUSAL = /violates row-level security policy/

/** `seed_project_statuses` seeds exactly these four slugs, sorted. */
const SEEDED_SLUGS = ['done', 'in_progress', 'in_review', 'todo']
/** The seeded name of the `done` row -- the read-back value for every refused rename. */
const DONE_NAME = 'Done'

const TEXT_FIELD_NAME = 'Customer ref'
const SELECT_FIELD_NAME = 'Severity'
const OPTION_LABEL = 'High'
const OWNER_STATUS_NAME = 'Owner column'
const OWNER_VALUE = 'Set by the admin'

describe.skipIf(!hasServiceRoleKey)('SPRIN-99 config tables resolve to membership', () => {
  const admin = hasServiceRoleKey ? adminClient() : (undefined as never)
  const createdUserIds: string[] = []

  /** Creates the project, so `seed_project_admin` makes them its sole admin. */
  let aClient: SupabaseClient<Database>
  let aId: string
  /** Added to A's project as a plain `member`. Reads the config, writes none of it. */
  let mClient: SupabaseClient<Database>
  let mId: string
  /** Belongs to no project at all. */
  let sClient: SupabaseClient<Database>

  let projectId: string
  /** A SECOND project A owns and M is NOT in -- separates "member here" from "member anywhere". */
  let otherProjectId: string
  /** M's OWN project, where M is the admin. Without it, admin-scoping is untestable. */
  let mProjectId: string

  let doneStatusId: string
  /** An extra status A created: renamed and then deleted by A as the positive controls. */
  let ownerStatusId: string
  let textFieldId: string
  let selectFieldId: string
  let optionSlug: string
  /** A's ticket, holding A's `ticket_field_values` row. Never written by anyone else. */
  let ticketId: string
  /** A second ticket, left free for M's own value row. */
  let memberTicketId: string

  // `@/lib/tickets` imports `./supabase`, which calls `getEnv()` at MODULE scope -- a static
  // import here would throw at file-load time whenever the environment is missing, turning
  // this file's loud, deliberate skip into a hard error. Imported lazily in beforeAll, the
  // same reasoning as board-membership.integration.test.ts.
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

  async function createProject(input: {
    client: SupabaseClient<Database>
    ownerId: string
    name: string
  }): Promise<string> {
    const { data, error } = await input.client
      .from('projects')
      .insert({ owner_id: input.ownerId, name: input.name, key: runKey() })
      .select('id')
      .single()
    if (error) throw new Error(`Fixture: could not create "${input.name}": ${error.message}`)
    return data.id
  }

  async function ownerTicket(summary: string): Promise<string> {
    const { data, error } = await aClient
      .from('tickets')
      .insert(ticketInsertPayload({ project_id: projectId, summary }))
      .select('id')
      .single()
    if (error) throw new Error(`Fixture: could not create "${summary}": ${error.message}`)
    return data.id
  }

  async function seededStatusId(slug: string): Promise<string> {
    const { data, error } = await admin
      .from('project_statuses')
      .select('id')
      .eq('project_id', projectId)
      .eq('slug', slug)
      .single()
    if (error) throw new Error(`Fixture: no seeded "${slug}" status: ${error.message}`)
    return data.id
  }

  /** The `done` row as the service role sees it -- the read-back for every refused write. */
  async function doneRow(): Promise<{ id: string; name: string } | null> {
    const { data } = await admin
      .from('project_statuses')
      .select('id, name')
      .eq('id', doneStatusId)
      .maybeSingle()
    return data
  }

  beforeAll(async () => {
    ;({ ticketInsertPayload } = await import('@/lib/tickets'))

    const aEmail = freshEmail('a')
    const mEmail = freshEmail('m')
    const sEmail = freshEmail('s')

    aId = await createUser(aEmail, 'Admin A')
    mId = await createUser(mEmail, 'Member M')
    await createUser(sEmail, 'Stranger S')

    aClient = await signInWithCredentials(aEmail, PASSWORD)
    mClient = await signInWithCredentials(mEmail, PASSWORD)
    sClient = await signInWithCredentials(sEmail, PASSWORD)
    // The ids come from the admin API's own response, so there is no `auth.getUser()` here
    // and no second auth round-trip per user. ~14 of those once tripped GoTrue's rate
    // limiter and produced a bare null-`id` TypeError in a beforeAll.

    projectId = await createProject({ client: aClient, ownerId: aId, name: 'SPRIN-99 config' })
    otherProjectId = await createProject({
      client: aClient,
      ownerId: aId,
      name: 'SPRIN-99 out of reach',
    })
    mProjectId = await createProject({ client: mClient, ownerId: mId, name: "SPRIN-99 M's own" })

    // M joins as a plain member, written with the SERVICE-ROLE client on purpose: using A's
    // client would build the fixture out of `members_admin_insert`, a policy a SIBLING suite
    // exists to prove. A fixture must not be built out of the thing under test.
    const join = await admin
      .from('project_members')
      .insert({ project_id: projectId, user_id: mId, role: 'member' })
    if (join.error) throw new Error(`Fixture: could not add M as a member: ${join.error.message}`)

    doneStatusId = await seededStatusId('done')

    const ownerStatus = await aClient
      .from('project_statuses')
      .insert({
        project_id: projectId,
        slug: 'a_extra',
        name: OWNER_STATUS_NAME,
        category: 'in_progress',
        position: 5,
      })
      .select('id')
      .single()
    if (ownerStatus.error)
      throw new Error(`Fixture: could not add A's status: ${ownerStatus.error.message}`)
    ownerStatusId = ownerStatus.data.id

    const textField = await aClient
      .from('project_fields')
      .insert({ project_id: projectId, slug: 'customer_ref', name: TEXT_FIELD_NAME, type: 'text' })
      .select('id')
      .single()
    if (textField.error)
      throw new Error(`Fixture: could not add the text field: ${textField.error.message}`)
    textFieldId = textField.data.id

    const selectField = await aClient
      .from('project_fields')
      .insert({ project_id: projectId, slug: 'severity', name: SELECT_FIELD_NAME, type: 'select' })
      .select('id')
      .single()
    if (selectField.error)
      throw new Error(`Fixture: could not add the select field: ${selectField.error.message}`)
    selectFieldId = selectField.data.id

    optionSlug = 'high'
    const option = await aClient.from('project_field_options').insert({
      project_id: projectId,
      field_id: selectFieldId,
      slug: optionSlug,
      label: OPTION_LABEL,
      position: 1,
    })
    if (option.error) throw new Error(`Fixture: could not add the option: ${option.error.message}`)

    ticketId = await ownerTicket("A's ticket")
    memberTicketId = await ownerTicket("M's ticket")

    // A's own value row, so the stranger's zero-row UPDATE and DELETE below have a target
    // that exists independently of whether M's own write path works.
    const value = await aClient.from('ticket_field_values').insert({
      ticket_id: ticketId,
      project_id: projectId,
      field_id: textFieldId,
      field_type: 'text',
      value_text: OWNER_VALUE,
    })
    if (value.error) throw new Error(`Fixture: could not add A's value: ${value.error.message}`)
  }, 60_000)

  afterAll(async () => {
    if (!hasServiceRoleKey) return
    // Deletes FIRST, before anything that could throw. Deleting the users cascades their
    // projects, and each project cascades its statuses, fields, options, tickets and value
    // rows. A teardown assertion that fails before the delete strands fixture rows in the
    // shared database, which has already cost this project ten orphaned projects.
    const failures: string[] = []
    for (const id of createdUserIds) {
      const { error } = await settled(admin.auth.admin.deleteUser(id))
      if (error) failures.push(`${id}: ${error.message}`)
    }
    if (failures.length > 0) {
      throw new Error(`Failed to delete ${failures.length} test user(s):\n${failures.join('\n')}`)
    }
  }, 60_000)

  /**
   * THE LIVE REGRESSION THIS STORY FIXES. Before the migration a member sees ZERO statuses,
   * so the board renders no columns at all for anyone who is not the owner -- the known
   * consequence CLAUDE.md records against SPRIN-101. These two tests are what turn green
   * when the migration lands.
   */
  describe('a member reads the configuration of a project they do not own', () => {
    it('reads every status of the project, not just the ones they created', async () => {
      const { data, error } = await mClient
        .from('project_statuses')
        .select('id, slug')
        .eq('project_id', projectId)

      expect(error).toBeNull()
      const slugs = [...(data ?? [])].map((row) => row.slug).sort()
      // The four seeded by `seed_project_statuses`, plus the one A added in the fixture.
      expect(slugs).toEqual([...SEEDED_SLUGS, 'a_extra'].sort())

      // ... and the member sees exactly what is there, rather than a filtered subset that
      // happens to contain the slugs asserted above.
      const asService = await admin
        .from('project_statuses')
        .select('id')
        .eq('project_id', projectId)
      expect([...(data ?? [])].map((r) => r.id).sort()).toEqual(
        [...(asService.data ?? [])].map((r) => r.id).sort(),
      )
    }, 30_000)

    it('reads the field definitions and their options', async () => {
      const fields = await mClient
        .from('project_fields')
        .select('id, name')
        .eq('project_id', projectId)
      expect(fields.error).toBeNull()
      expect([...(fields.data ?? [])].map((row) => row.name).sort()).toEqual(
        [TEXT_FIELD_NAME, SELECT_FIELD_NAME].sort(),
      )

      const options = await mClient
        .from('project_field_options')
        .select('slug, label')
        .eq('project_id', projectId)
      expect(options.error).toBeNull()
      expect(options.data).toEqual([{ slug: optionSlug, label: OPTION_LABEL }])
    }, 30_000)
  })

  /**
   * READ IS BROADER THAN WRITE HERE, ON PURPOSE, and that is the whole point of the story:
   * the member above can SEE all of this and may change none of it. The opposite shape holds
   * on the board tables, where a single `for all` policy keeps read and write co-extensive
   * because `completeSprint`'s guard depends on it. Do not harmonise the two.
   */
  describe('a member is refused every configuration write', () => {
    it('is refused a status insert, and the refusal RAISES', async () => {
      const { error } = await mClient.from('project_statuses').insert({
        project_id: projectId,
        slug: 'm_denied',
        name: 'Planted by a member',
        category: 'todo',
        position: 90,
      })

      // INSERT is governed by WITH CHECK, which raises rather than filtering. The message
      // match matters: `authenticated` DOES hold table-level INSERT on this table
      // (relacl `authenticated=ardDxtm`), so a 42501 naming a privilege instead of a policy
      // would mean the grant moved, not that the policy held.
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(RLS_REFUSAL)

      const after = await admin
        .from('project_statuses')
        .select('id')
        .eq('project_id', projectId)
        .eq('slug', 'm_denied')
      expect(after.data).toEqual([])

      // POSITIVE CONTROL: the identical statement from the project's ADMIN succeeds, so the
      // refusal above is about the caller's ROLE and not about the payload.
      const asAdmin = await aClient
        .from('project_statuses')
        .insert({
          project_id: projectId,
          slug: 'a_inserted',
          name: 'Planted by the admin',
          category: 'todo',
          position: 91,
        })
        .select('slug')
      expect(asAdmin.error).toBeNull()
      expect(asAdmin.data).toEqual([{ slug: 'a_inserted' }])
    }, 30_000)

    it('changes zero rows renaming a status', async () => {
      // `name` is one of the four columns `authenticated` may UPDATE on this table, so a
      // zero-row result measures the POLICY. On `slug` or `is_initial` the privilege layer
      // would raise 42501 first and this assertion would be about the grant instead.
      const refused = await mClient
        .from('project_statuses')
        .update({ name: 'Renamed by a member' })
        .eq('id', doneStatusId)
        .select('id')

      // UPDATE is governed by USING, which FILTERS. `error === null` on its own is exactly
      // what a successful cross-tenant write returns too -- the row COUNT is the assertion.
      expect(refused.error).toBeNull()
      expect(refused.data).toEqual([])

      // The row is genuinely intact, not merely un-returned.
      expect(await doneRow()).toEqual({ id: doneStatusId, name: DONE_NAME })

      // POSITIVE CONTROL: the admin's rename returns the row it changed.
      const renamed = await aClient
        .from('project_statuses')
        .update({ name: 'Owner column renamed' })
        .eq('id', ownerStatusId)
        .select('name')
      expect(renamed.error).toBeNull()
      expect(renamed.data).toEqual([{ name: 'Owner column renamed' }])
    }, 30_000)

    it('changes zero rows deleting a status', async () => {
      const refused = await mClient
        .from('project_statuses')
        .delete()
        .eq('id', doneStatusId)
        .select('id')
      expect(refused.error).toBeNull()
      expect(refused.data).toEqual([])
      expect(await doneRow()).toEqual({ id: doneStatusId, name: DONE_NAME })

      // POSITIVE CONTROL: the admin deletes a status the admin created, and it is gone from
      // the service-role read as well -- a DELETE that returned a row while leaving it in
      // place would be the worst of both worlds.
      const deleted = await aClient
        .from('project_statuses')
        .delete()
        .eq('id', ownerStatusId)
        .select('id')
      expect(deleted.error).toBeNull()
      expect(deleted.data).toEqual([{ id: ownerStatusId }])

      const gone = await admin.from('project_statuses').select('id').eq('id', ownerStatusId)
      expect(gone.data).toEqual([])
    }, 30_000)

    it('is refused a field insert and an option insert, and both RAISE', async () => {
      const field = await mClient
        .from('project_fields')
        .insert({ project_id: projectId, slug: 'm_field', name: 'Planted', type: 'text' })
      expect(field.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(field.error?.message).toMatch(RLS_REFUSAL)

      const option = await mClient.from('project_field_options').insert({
        project_id: projectId,
        field_id: selectFieldId,
        slug: 'm_option',
        label: 'Planted',
        position: 90,
      })
      expect(option.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(option.error?.message).toMatch(RLS_REFUSAL)

      const fieldsAfter = await admin
        .from('project_fields')
        .select('id')
        .eq('project_id', projectId)
        .eq('slug', 'm_field')
      expect(fieldsAfter.data).toEqual([])

      const optionsAfter = await admin
        .from('project_field_options')
        .select('slug')
        .eq('field_id', selectFieldId)
        .eq('slug', 'm_option')
      expect(optionsAfter.data).toEqual([])

      // POSITIVE CONTROLS: the same two statements from the admin land.
      const asAdminField = await aClient
        .from('project_fields')
        .insert({
          project_id: projectId,
          slug: 'a_field',
          name: 'Added by the admin',
          type: 'text',
        })
        .select('slug')
      expect(asAdminField.error).toBeNull()
      expect(asAdminField.data).toEqual([{ slug: 'a_field' }])

      const asAdminOption = await aClient
        .from('project_field_options')
        .insert({
          project_id: projectId,
          field_id: selectFieldId,
          slug: 'low',
          label: 'Low',
          position: 2,
        })
        .select('slug')
      expect(asAdminOption.error).toBeNull()
      expect(asAdminOption.data).toEqual([{ slug: 'low' }])
    }, 30_000)

    it('changes zero rows renaming a field or an option', async () => {
      // `name` on project_fields and `label` on project_field_options are the ONLY columns
      // `authenticated` may UPDATE on those two tables. Writing any other one would 42501 at
      // the privilege layer and measure the grant rather than the policy.
      const field = await mClient
        .from('project_fields')
        .update({ name: 'Renamed by a member' })
        .eq('id', textFieldId)
        .select('id')
      expect(field.error).toBeNull()
      expect(field.data).toEqual([])

      const option = await mClient
        .from('project_field_options')
        .update({ label: 'Renamed by a member' })
        .eq('field_id', selectFieldId)
        .eq('slug', optionSlug)
        .select('slug')
      expect(option.error).toBeNull()
      expect(option.data).toEqual([])

      const fieldIntact = await admin
        .from('project_fields')
        .select('name')
        .eq('id', textFieldId)
        .single()
      expect(fieldIntact.data).toEqual({ name: TEXT_FIELD_NAME })

      const optionIntact = await admin
        .from('project_field_options')
        .select('label')
        .eq('field_id', selectFieldId)
        .eq('slug', optionSlug)
        .single()
      expect(optionIntact.data).toEqual({ label: OPTION_LABEL })

      // POSITIVE CONTROLS on the very same rows and the very same columns.
      const asAdminField = await aClient
        .from('project_fields')
        .update({ name: TEXT_FIELD_NAME })
        .eq('id', textFieldId)
        .select('id')
      expect(asAdminField.data).toEqual([{ id: textFieldId }])

      const asAdminOption = await aClient
        .from('project_field_options')
        .update({ label: OPTION_LABEL })
        .eq('field_id', selectFieldId)
        .eq('slug', optionSlug)
        .select('slug')
      expect(asAdminOption.data).toEqual([{ slug: optionSlug }])
    }, 30_000)
  })

  /**
   * ticket_field_values IS THE ONE THAT WIDENS TO THE MEMBER, on every verb. If this block
   * is green while the block above is also green, the story's asymmetry holds; if a future
   * edit "harmonises" the four tables to one shape, exactly one of the two blocks goes red.
   */
  describe('a member sets, updates and clears a ticket field value', () => {
    it('writes the whole value lifecycle on a ticket they did not create', async () => {
      const set = await mClient
        .from('ticket_field_values')
        .insert({
          ticket_id: memberTicketId,
          project_id: projectId,
          field_id: textFieldId,
          field_type: 'text',
          value_text: 'Set by the member',
        })
        .select('value_text')
      expect(set.error).toBeNull()
      expect(set.data).toEqual([{ value_text: 'Set by the member' }])

      const updated = await mClient
        .from('ticket_field_values')
        .update({ value_text: 'Edited by the member' })
        .eq('ticket_id', memberTicketId)
        .eq('field_id', textFieldId)
        .select('value_text')
      expect(updated.error).toBeNull()
      expect(updated.data).toEqual([{ value_text: 'Edited by the member' }])

      // Clearing a custom field is the ABSENCE of the row, never a row of nulls -- so the
      // member needs DELETE as well, and the service-role read is what proves it happened.
      const cleared = await mClient
        .from('ticket_field_values')
        .delete()
        .eq('ticket_id', memberTicketId)
        .eq('field_id', textFieldId)
        .select('ticket_id')
      expect(cleared.error).toBeNull()
      expect(cleared.data).toEqual([{ ticket_id: memberTicketId }])

      const gone = await admin
        .from('ticket_field_values')
        .select('ticket_id')
        .eq('ticket_id', memberTicketId)
      expect(gone.data).toEqual([])
    }, 30_000)

    it('reads the value rows of the project', async () => {
      const { data, error } = await mClient
        .from('ticket_field_values')
        .select('ticket_id, value_text')
        .eq('project_id', projectId)

      expect(error).toBeNull()
      expect(data).toEqual([{ ticket_id: ticketId, value_text: OWNER_VALUE }])
    }, 30_000)
  })

  describe('a stranger sees nothing and touches nothing', () => {
    it('sees zero rows on all four tables', async () => {
      const statuses = await sClient
        .from('project_statuses')
        .select('id')
        .eq('project_id', projectId)
      expect(statuses.error).toBeNull()
      expect(statuses.data).toEqual([])

      const fields = await sClient.from('project_fields').select('id').eq('project_id', projectId)
      expect(fields.error).toBeNull()
      expect(fields.data).toEqual([])

      const options = await sClient
        .from('project_field_options')
        .select('slug')
        .eq('project_id', projectId)
      expect(options.error).toBeNull()
      expect(options.data).toEqual([])

      const values = await sClient
        .from('ticket_field_values')
        .select('ticket_id')
        .eq('project_id', projectId)
      expect(values.error).toBeNull()
      expect(values.data).toEqual([])

      // POSITIVE CONTROL. Without it, a fixture that was never created -- or a sign-in that
      // silently produced an anon client -- passes all four assertions above. A is used
      // rather than M so this stays a statement about the STRANGER even before the
      // migration widens the member's read.
      const asAdmin = await aClient
        .from('project_statuses')
        .select('id')
        .eq('project_id', projectId)
      expect(asAdmin.data?.length).toBeGreaterThan(0)
    }, 30_000)

    it('is refused every insert, and each refusal RAISES', async () => {
      const status = await sClient.from('project_statuses').insert({
        project_id: projectId,
        slug: 's_denied',
        name: 'Planted by a stranger',
        category: 'todo',
        position: 92,
      })
      expect(status.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(status.error?.message).toMatch(RLS_REFUSAL)

      const field = await sClient
        .from('project_fields')
        .insert({ project_id: projectId, slug: 's_field', name: 'Planted', type: 'text' })
      expect(field.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(field.error?.message).toMatch(RLS_REFUSAL)

      const option = await sClient.from('project_field_options').insert({
        project_id: projectId,
        field_id: selectFieldId,
        slug: 's_option',
        label: 'Planted',
        position: 92,
      })
      expect(option.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(option.error?.message).toMatch(RLS_REFUSAL)

      // WITH CHECK fires BEFORE foreign-key validation, so this is refused by the policy
      // rather than by tfv_ticket_fk -- which is why the message match is asserted.
      const value = await sClient.from('ticket_field_values').insert({
        ticket_id: memberTicketId,
        project_id: projectId,
        field_id: textFieldId,
        field_type: 'text',
        value_text: 'Planted by a stranger',
      })
      expect(value.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(value.error?.message).toMatch(RLS_REFUSAL)
    }, 30_000)

    it('changes zero rows updating or deleting anything', async () => {
      const renamed = await sClient
        .from('project_statuses')
        .update({ name: 'Hijacked' })
        .eq('id', doneStatusId)
        .select('id')
      expect(renamed.error).toBeNull()
      expect(renamed.data).toEqual([])

      const fieldRenamed = await sClient
        .from('project_fields')
        .update({ name: 'Hijacked' })
        .eq('id', textFieldId)
        .select('id')
      expect(fieldRenamed.error).toBeNull()
      expect(fieldRenamed.data).toEqual([])

      const valueEdited = await sClient
        .from('ticket_field_values')
        .update({ value_text: 'Hijacked' })
        .eq('ticket_id', ticketId)
        .eq('field_id', textFieldId)
        .select('ticket_id')
      expect(valueEdited.error).toBeNull()
      expect(valueEdited.data).toEqual([])

      const statusDeleted = await sClient
        .from('project_statuses')
        .delete()
        .eq('id', doneStatusId)
        .select('id')
      expect(statusDeleted.error).toBeNull()
      expect(statusDeleted.data).toEqual([])

      const valueDeleted = await sClient
        .from('ticket_field_values')
        .delete()
        .eq('ticket_id', ticketId)
        .eq('field_id', textFieldId)
        .select('ticket_id')
      expect(valueDeleted.error).toBeNull()
      expect(valueDeleted.data).toEqual([])

      // Every row is genuinely intact, read with the client that bypasses RLS.
      expect(await doneRow()).toEqual({ id: doneStatusId, name: DONE_NAME })

      const fieldIntact = await admin
        .from('project_fields')
        .select('name')
        .eq('id', textFieldId)
        .single()
      expect(fieldIntact.data).toEqual({ name: TEXT_FIELD_NAME })

      const valueIntact = await admin
        .from('ticket_field_values')
        .select('value_text')
        .eq('ticket_id', ticketId)
        .eq('field_id', textFieldId)
        .single()
      expect(valueIntact.data).toEqual({ value_text: OWNER_VALUE })
    }, 30_000)
  })

  /**
   * BOTH SCOPES, AND NEITHER IS OPTIONAL.
   *
   * Every negative above is written from S, who belongs to NO project at all, or from M, who
   * holds `member` and never `admin`. So all of them are satisfied by a predicate that merely
   * asks "is this caller a member of anything?" or "does this caller hold admin anywhere?".
   *
   * Two mutations, stated exactly so they can be re-run:
   *
   *   1. `is_project_member` ignoring p_project_id -- killed by M reading and writing NOTHING
   *      in otherProjectId while holding membership of projectId.
   *   2. `is_project_admin` ignoring p_project_id -- killed by M, who IS an admin (of
   *      mProjectId, seeded by `seed_project_admin`), still being refused every configuration
   *      write in projectId. M holding admin SOMEWHERE is what makes that test non-vacuous,
   *      and the positive control below is what proves M holds it.
   */
  describe('membership and the admin role are both scoped to one project', () => {
    it('gives a member of one project no reach into another project at all', async () => {
      const statuses = await mClient
        .from('project_statuses')
        .select('id')
        .eq('project_id', otherProjectId)
      expect(statuses.error).toBeNull()
      expect(statuses.data).toEqual([])

      const other = await admin
        .from('project_statuses')
        .select('id, name')
        .eq('project_id', otherProjectId)
        .eq('slug', 'done')
        .single()

      const renamed = await mClient
        .from('project_statuses')
        .update({ name: 'Reached across' })
        .eq('id', other.data!.id)
        .select('id')
      expect(renamed.error).toBeNull()
      expect(renamed.data).toEqual([])

      // POSITIVE CONTROLS: the rows exist and are intact; the second project is reachable by
      // somebody; and M's own membership still works, so this is not a member whose access
      // simply broke.
      const intact = await admin
        .from('project_statuses')
        .select('name')
        .eq('id', other.data!.id)
        .single()
      expect(intact.data).toEqual({ name: DONE_NAME })

      const asOwner = await aClient
        .from('project_statuses')
        .select('id')
        .eq('project_id', otherProjectId)
      expect(asOwner.data?.length).toBeGreaterThan(0)
    }, 30_000)

    it('gives an admin of one project no configuration write on another', async () => {
      const foreign = await mClient.from('project_statuses').insert({
        project_id: otherProjectId,
        slug: 'm_across',
        name: 'Planted across',
        category: 'todo',
        position: 93,
      })
      expect(foreign.error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(foreign.error?.message).toMatch(RLS_REFUSAL)

      // POSITIVE CONTROL, and the load-bearing one: the identical statement in M's OWN
      // project succeeds, so M really does hold `admin` -- and every "M is refused" assertion
      // in this file is therefore about the project, not about M lacking the role entirely.
      const own = await mClient
        .from('project_statuses')
        .insert({
          project_id: mProjectId,
          slug: 'm_own',
          name: 'Planted at home',
          category: 'todo',
          position: 5,
        })
        .select('slug')
      expect(own.error).toBeNull()
      expect(own.data).toEqual([{ slug: 'm_own' }])
    }, 30_000)
  })

  /**
   * reorder_project_statuses IS THE ONE SECURITY INVOKER FUNCTION ON THESE TABLES.
   *
   * It runs as the CALLER, so its UPDATE is filtered by whatever policy is live on
   * `project_statuses` -- there is no definer bypass to hide a broken predicate. It writes
   * `position` alone, which is one of the four columns `authenticated` may UPDATE, so a
   * zero-row result from it measures the POLICY.
   *
   * The member case runs FIRST, deliberately: if the admin reorder ran first, a member call
   * that silently re-applied the SAME ordering would return rows it did not change and the
   * read-back would agree with itself.
   */
  describe('reorder_project_statuses obeys the same admin boundary', () => {
    async function slugsByPosition(): Promise<string[]> {
      const { data } = await admin
        .from('project_statuses')
        .select('slug, position')
        .eq('project_id', projectId)
        .order('position', { ascending: true })
      return [...(data ?? [])].map((row) => row.slug)
    }

    it('returns zero rows for a member and moves nothing', async () => {
      const before = await slugsByPosition()
      const { data, error } = await mClient.rpc('reorder_project_statuses', {
        p_project_id: projectId,
        p_slugs: [...before].reverse(),
      })

      expect(error).toBeNull()
      expect(data).toEqual([])
      // The reversal was a real change, so an unchanged order is evidence rather than a
      // no-op agreeing with itself.
      expect(await slugsByPosition()).toEqual(before)
    }, 30_000)

    it('reorders for an admin', async () => {
      const before = await slugsByPosition()
      const wanted = [...before].reverse()
      const { data, error } = await aClient.rpc('reorder_project_statuses', {
        p_project_id: projectId,
        p_slugs: wanted,
      })

      expect(error).toBeNull()
      expect(data?.length).toBe(wanted.length)
      expect(await slugsByPosition()).toEqual(wanted)
    }, 30_000)
  })

  /**
   * THE ANON SHAPE, WHICH IS PROTECTING PRODUCTION AND NOT JUST A POLICY.
   *
   * All four of these tables grant `anon` SELECT (measured 2026-08-21: `anon=rDxtm`, and
   * `anon=arDxtm` on project_statuses, which additionally holds an unused INSERT). Policy
   * expressions are evaluated as the CALLING role, and `anon` holds neither USAGE on schema
   * `app_auth` nor EXECUTE on its functions. So WITHOUT `to authenticated` on the sixteen
   * new policies, an anonymous read stops returning an empty array and starts raising
   * `permission denied for schema app_auth` (42501).
   *
   * That is the SPRIN-100 rule, and what it protects is the cron-job.org keepalive: it does
   * an anonymous GET expecting `200 []`, its failure email is the only monitoring, and the
   * free tier pauses the project after ~7 days -- at which point a paused database blocks
   * EVERY merge, including the one that would fix it.
   *
   * So the assertion is on the SHAPE -- `error: null` with `data: []`, the RLS filter -- and
   * NOT merely on "anon sees no rows". A 42501 also returns no rows, and an assertion written
   * that way would stay green through exactly the regression it exists to detect.
   *
   * UNSCOPED ON PURPOSE, and the only unscoped read in this file. Elsewhere an unscoped
   * select is a whole-table invariant that races every concurrent suite; here it cannot be,
   * because `anon` matches no policy on any row of these tables regardless of what else is
   * running. It is also the shape the cron itself uses.
   */
  describe('an anonymous caller is filtered, never errored', () => {
    it('returns error null and an empty array on all four config tables', async () => {
      const anon = anonClient()

      const statuses = await anon.from('project_statuses').select('id').limit(1)
      expect(statuses.error).toBeNull()
      expect(statuses.data).toEqual([])

      const fields = await anon.from('project_fields').select('id').limit(1)
      expect(fields.error).toBeNull()
      expect(fields.data).toEqual([])

      const options = await anon.from('project_field_options').select('slug').limit(1)
      expect(options.error).toBeNull()
      expect(options.data).toEqual([])

      const values = await anon.from('ticket_field_values').select('ticket_id').limit(1)
      expect(values.error).toBeNull()
      expect(values.data).toEqual([])

      // POSITIVE CONTROL: the rows anon cannot see do exist. Without this, a database with
      // no statuses in it at all passes every assertion above.
      const asAdmin = await aClient
        .from('project_statuses')
        .select('id')
        .eq('project_id', projectId)
      expect(asAdmin.data?.length).toBeGreaterThan(0)
    }, 30_000)
  })
})
