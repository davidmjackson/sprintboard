import { supabase } from './supabase'
import { isProjectRole } from './domain'
import type {
  AddMemberResult,
  ProjectMemberWithProfile,
  ProjectRole,
  RemoveMemberResult,
  SetMemberRoleResult,
} from './domain'
import type { Tables } from './database.types'

/**
 * The columns `listProjectMembers` reads, NAMED — not a bare `.select()`.
 *
 * Same rule as `project-fields.ts`: a no-arg select plus an unchecked cast let SPRIN-86
 * ship a user-visible defect, because the first reader of a new column found `undefined`
 * and nothing went red. `project-members.test.ts` asserts this exact string reaches
 * PostgREST.
 */
const MEMBER_COLUMNS = 'project_id, user_id, role, created_at'

/**
 * The profile columns the members list needs, and no more.
 *
 * `email` and `display_name` are the whole disclosure this list makes, and both are only
 * readable because `profiles_read` resolves to CO-MEMBERSHIP (SPRIN-105). Widening this
 * select widens what a project member learns about their co-members, so it is spelled out
 * here rather than left to a `*`.
 */
const PROFILE_COLUMNS = 'id, email, display_name'

/**
 * Reject a row whose `role` is not one this client understands.
 *
 * `ProjectMember` narrows the column's `string` to `ProjectRole`, and a bare
 * `as ProjectMember` would make that narrowing a lie the moment the database holds a value
 * the union does not — the drift an unchecked cast hides, and the reason
 * `project-fields.ts` carries the same guard. A widened `project_members_role_check` is
 * exactly how that would arrive.
 *
 * Throwing means the failure surfaces as a failed read, which the settings section renders
 * honestly, rather than as a member whose role badge is blank halfway down the list.
 */
function toRole(row: Tables<'project_members'>): ProjectRole {
  if (!isProjectRole(row.role)) {
    throw new Error(`Unrecognised project role: ${row.role}`)
  }
  return row.role
}

/**
 * One project's members, each joined to the profile of the person it names.
 *
 * **TWO READS, JOINED HERE, AND THAT IS NOT A MISSED OPTIMISATION.** PostgREST can only
 * embed across a foreign key it can see, and `project_members.user_id` references
 * `auth.users`, NOT `profiles` — measured from `pg_constraint`. There is no fk between
 * these two tables for PostgREST to follow, so `project_members(*, profiles(*))` does not
 * resolve and never has. Adding one purely to enable the embed would put a public-schema
 * fk onto a table in `auth`, which is not a change this story makes casually.
 *
 * **A MEMBER WITH NO READABLE PROFILE IS KEPT, NOT DROPPED**, and the difference is
 * user-visible. An inner-join shape would silently shorten the list — so an admin could
 * remove someone they can see while a row they cannot see stays behind, and the last-admin
 * guard would appear to fire for no reason. Such a row renders by id instead. This is a
 * real state rather than a hypothetical: `profiles_read` is scoped to co-membership, and
 * `handle_new_user` populates `profiles` on signup, so a row inserted by any other route
 * has no profile at all.
 *
 * THROWS rather than resolving to `[]` on error, mirroring every other list read in this
 * codebase: `[]` is indistinguishable from "this project has one member", which is never
 * true — every project has at least an admin — so an empty array from this function would
 * be a state the schema forbids being rendered as if it were ordinary.
 */
export async function listProjectMembers(projectId: string): Promise<ProjectMemberWithProfile[]> {
  const { data, error } = await supabase
    .from('project_members')
    .select(MEMBER_COLUMNS)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .order('user_id', { ascending: true })

  if (error) throw new Error(error.message)
  const rows = data ?? []
  if (rows.length === 0) return []

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select(PROFILE_COLUMNS)
    .in(
      'id',
      rows.map((row) => row.user_id),
    )

  if (profileError) throw new Error(profileError.message)
  const byId = new Map((profiles ?? []).map((profile) => [profile.id, profile]))

  return rows.map((row) => ({
    ...row,
    role: toRole(row),
    email: byId.get(row.user_id)?.email ?? null,
    display_name: byId.get(row.user_id)?.display_name ?? null,
  }))
}

/**
 * Add a member by email address (SPRIN-102 AC2/AC4/AC5).
 *
 * Calls a `SECURITY DEFINER` RPC because this is the one question the policy layer
 * deliberately refuses to answer: resolving an address belonging to someone the caller
 * shares no project with yet. `profiles_read` is scoped to co-membership, so a client-side
 * lookup would return nothing and the add would report `no_such_user` for every stranger —
 * which is the whole feature. **Do not "simplify" this into a select plus an insert.**
 * There is no insert privilege to use, and the lookup would not resolve.
 *
 * The RPC checks the caller is an admin BEFORE it reads the address, so a non-admin cannot
 * use it to test whether an address is registered. That ordering is the security property;
 * it is argued in full in the migration header.
 *
 * The email is passed as the user typed it. Trimming and lowercasing happen INSIDE the
 * function (`lower(btrim(p_email))`) so that every caller — this one, a future admin tool,
 * psql — normalises identically. Doing it here as well would be a second implementation of
 * one rule, which is how the two drift apart.
 */
export async function addProjectMemberByEmail(
  projectId: string,
  email: string,
  role: ProjectRole,
): Promise<AddMemberResult> {
  const { data, error } = await supabase.rpc('add_project_member_by_email', {
    p_project_id: projectId,
    p_email: email,
    p_role: role,
  })

  if (error) throw new Error(error.message)
  return data as AddMemberResult
}

/**
 * Promote or demote a member (SPRIN-102 AC2), refusing to demote a project's last admin.
 *
 * Returns `last_admin` rather than throwing, because it is an ordinary outcome the UI must
 * explain rather than an error: the admin has to promote someone else first. The guard
 * lives in the RPC, under a row lock — two admins demoting each other concurrently would
 * otherwise both pass a count of 2 and leave zero admins behind.
 */
export async function setProjectMemberRole(
  projectId: string,
  userId: string,
  role: ProjectRole,
): Promise<SetMemberRoleResult> {
  const { data, error } = await supabase.rpc('set_project_member_role', {
    p_project_id: projectId,
    p_user_id: userId,
    p_role: role,
  })

  if (error) throw new Error(error.message)
  return data as SetMemberRoleResult
}

/**
 * Remove a member (SPRIN-102 AC2), refusing to remove a project's last admin.
 *
 * Removing YOURSELF is permitted and is the ordinary way an admin hands over: promote a
 * second admin, then remove your own row. Refusal applies to the last admin whoever they
 * are, rather than special-casing the caller.
 */
export async function removeProjectMember(
  projectId: string,
  userId: string,
): Promise<RemoveMemberResult> {
  const { data, error } = await supabase.rpc('remove_project_member', {
    p_project_id: projectId,
    p_user_id: userId,
  })

  if (error) throw new Error(error.message)
  return data as RemoveMemberResult
}

/**
 * The role the signed-in user holds in this project, or `null` if they hold none.
 *
 * Derived from the list the section has already read rather than from a second query: every
 * member can read every membership row of a project they belong to (`members_read`), so the
 * answer is already in hand. A dedicated round trip would be a second source of truth for
 * the same fact.
 *
 * **This decides what the UI OFFERS, never what the user may DO.** Every write it gates is
 * independently enforced by `app_auth.is_project_admin` inside the RPC, which is the actual
 * control. Treating this as the boundary — rather than as a way to avoid showing someone a
 * button that would refuse them — is the mistake to avoid.
 */
export function roleOf(
  members: readonly ProjectMemberWithProfile[],
  userId: string | undefined,
): ProjectRole | null {
  if (userId === undefined) return null
  return members.find((member) => member.user_id === userId)?.role ?? null
}
