import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import type {
  ProjectMemberWithProfile,
  ProjectRole,
  RemoveMemberResult,
  SetMemberRoleResult,
} from '@/lib/domain'
import { PROJECT_ROLES, PROJECT_ROLE_LABELS } from '@/lib/domain'
import { AddMemberSchema, type AddMemberValues } from '@/lib/member-schemas'
import {
  addProjectMemberByEmail,
  removeProjectMember,
  setProjectMemberRole,
} from '@/lib/project-members'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { GENERIC_CREATE_ERROR } from './CreateDialog'
import { FormRootError, selectClass, SubmitButton } from './form-primitives'
import { LoadFailure } from './LoadFailure'
import type { ReadPhase } from '@/lib/project-reads'

/**
 * What each non-success tag from the three RPCs means IN WORDS.
 *
 * Every one of these is an ORDINARY OUTCOME rather than an error, which is why the RPCs
 * return a tag instead of raising: the caller did nothing wrong and retrying the identical
 * request would produce the identical answer. Mapping them to the generic "please try again"
 * copy would invite exactly that retry.
 *
 * `no_such_user` is the disclosure boundary this story accepted, stated carefully. It tells a
 * project admin that an address is not registered — which is a real oracle, bounded to
 * admins by the RPC's authorisation-first ordering — and it deliberately says nothing about
 * anyone who IS registered. Do not "improve" it into "that person has not signed up yet":
 * that phrasing asserts something about a person, where this asserts something about an
 * address the admin already typed.
 */
const ADD_MESSAGES: Record<
  Exclude<Awaited<ReturnType<typeof addProjectMemberByEmail>>, 'added'>,
  string
> = {
  already_member: 'That person is already a member of this project.',
  no_such_user: 'No account is registered with that email address.',
}

/**
 * The last-admin refusal, in words, and the reason it is phrased as a next action.
 *
 * A project with no admin cannot be reconfigured OR deleted by anyone (`projects_admin_update`
 * and `projects_admin_delete` both resolve to `app_auth.is_project_admin`), so this guard is
 * what stands between a mis-click and a permanently stranded project. The sentence names the
 * way out — promote someone first — because "this is not allowed" leaves a user who genuinely
 * wants to hand over with nowhere to go.
 */
const LAST_ADMIN =
  'A project must always have at least one admin. Promote another member first, then try again.'

const NOT_A_MEMBER = 'That person is no longer a member of this project. Refresh to see the list.'

/**
 * One project's members, and — for an admin — the controls to change them (SPRIN-102).
 *
 * **`role` DECIDES WHAT THIS SECTION OFFERS, NEVER WHAT THE USER MAY DO.** Every write it
 * gates is independently enforced by `app_auth.is_project_admin` inside the RPC, and since
 * SPRIN-102 there is no direct write path to `project_members` at all — `authenticated` holds
 * no insert, update or delete privilege on the table. So a member who forged a request past
 * this component reaches a 42501, not a write. Treating this gate as the security boundary,
 * rather than as a way to avoid showing someone a control that would refuse them, is the
 * mistake to avoid; it is the same relationship `StatusSettings` has to the config policies.
 *
 * **Read-only for a non-admin rather than hidden.** Who else is on the project is ordinary
 * information for anyone working on it — `members_read` already lets every member read every
 * row — so hiding the list would conceal something the database freely returns while
 * protecting nothing.
 *
 * It carries its OWN phase, like `CustomFieldSettings` and unlike `CadenceSettings`: a failed
 * members read shows its own failure instead of blanking the tab, and a healthy members list
 * is not hidden by an unrelated statuses failure.
 */
export function MemberSettings({
  projectId,
  members,
  phase,
  role,
  currentUserId,
  onRetry,
  onChanged,
}: {
  projectId: string
  members: readonly ProjectMemberWithProfile[]
  phase: ReadPhase
  role: ProjectRole | null
  currentUserId: string | undefined
  onRetry: () => void
  onChanged: () => void
}) {
  return (
    <section aria-labelledby="member-settings-heading" className="flex flex-col gap-3">
      <h2 id="member-settings-heading" className="text-lg font-semibold">
        Members
      </h2>

      {phase === 'failed' ? (
        <LoadFailure resource="members" onRetry={onRetry} />
      ) : phase !== 'loaded' ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : (
        <>
          <MemberList
            projectId={projectId}
            members={members}
            isAdmin={role === 'admin'}
            currentUserId={currentUserId}
            onChanged={onChanged}
          />
          {role === 'admin' && <AddMemberForm projectId={projectId} onAdded={onChanged} />}
        </>
      )}
    </section>
  )
}

/**
 * How a member is named in the list.
 *
 * Falls back through display name, then email, then the raw user id — and the id fallback is
 * the one that matters. `profiles_read` is scoped to co-membership and `handle_new_user` only
 * populates `profiles` on signup, so a membership row whose profile is unreadable is a real
 * state. `listProjectMembers` deliberately KEEPS such a row rather than dropping it, and this
 * is what renders it: an admin has to be able to see and remove a member they cannot name.
 */
function memberName(member: ProjectMemberWithProfile): string {
  return member.display_name ?? member.email ?? member.user_id
}

function MemberList({
  projectId,
  members,
  isAdmin,
  currentUserId,
  onChanged,
}: {
  projectId: string
  members: readonly ProjectMemberWithProfile[]
  isAdmin: boolean
  currentUserId: string | undefined
  onChanged: () => void
}) {
  return (
    <ul className="flex flex-col gap-2">
      {members.map((member) => (
        <li
          key={member.user_id}
          className="flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2"
        >
          <span className="flex-1 text-sm">
            {memberName(member)}
            {member.user_id === currentUserId && (
              <span className="text-muted-foreground"> (you)</span>
            )}
          </span>

          {isAdmin ? (
            <MemberControls projectId={projectId} member={member} onChanged={onChanged} />
          ) : (
            <span className="text-muted-foreground text-sm">
              {PROJECT_ROLE_LABELS[member.role]}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * The admin's per-member controls: a role picker and a Remove button.
 *
 * **Neither control is disabled for the last admin, and that is deliberate.** The obvious
 * alternative — grey out Remove on the only admin — would put a second copy of the guard in
 * the client, where it would have to re-derive "is this the last admin" from a list that may
 * already be stale. Letting the RPC answer keeps ONE implementation of the rule, in the place
 * that holds the row lock, and turns a race into an explained refusal rather than a wrong
 * button state. The message it produces names the way out.
 *
 * `busy` disables both controls during a write so a double-click cannot issue two RPCs, and
 * `message` renders whatever tag came back. A successful write calls `onChanged`, which
 * refetches — there is no local mirror of the list to get wrong, the same discipline
 * `CadenceSettings` uses for the cadence.
 */
function MemberControls({
  projectId,
  member,
  onChanged,
}: {
  projectId: string
  member: ProjectMemberWithProfile
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function run(action: () => Promise<SetMemberRoleResult | RemoveMemberResult>) {
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      if (result === 'updated' || result === 'removed' || result === 'unchanged') {
        onChanged()
        return
      }
      setMessage(result === 'last_admin' ? LAST_ADMIN : NOT_A_MEMBER)
    } catch {
      setMessage(GENERIC_CREATE_ERROR)
    } finally {
      setBusy(false)
    }
  }

  const name = memberName(member)

  return (
    <>
      <label className="sr-only" htmlFor={`role-${member.user_id}`}>
        Role for {name}
      </label>
      <select
        id={`role-${member.user_id}`}
        className={`${selectClass} w-32`}
        value={member.role}
        disabled={busy}
        onChange={(event) =>
          void run(() =>
            setProjectMemberRole(projectId, member.user_id, event.target.value as ProjectRole),
          )
        }
      >
        {PROJECT_ROLES.map((role) => (
          <option key={role} value={role}>
            {PROJECT_ROLE_LABELS[role]}
          </option>
        ))}
      </select>

      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void run(() => removeProjectMember(projectId, member.user_id))}
      >
        Remove {name}
      </Button>

      {message !== null && (
        <p role="alert" className="text-destructive w-full text-sm">
          {message}
        </p>
      )}
    </>
  )
}

/**
 * The add-a-member form (AC2), shown only to an admin.
 *
 * The address is trimmed by the schema and handed to the RPC with its CASE untouched. That
 * split is deliberate: trimming is idempotent, so it cannot disagree with `btrim`, while
 * lowercasing is a real decision about which of two case-differing rows to match and stays
 * in the function where every caller inherits one implementation. A
 * successful add resets the form and refetches; every other tag is reported at FORM level
 * rather than on the email field, because `already_member` and `no_such_user` are statements
 * about the outcome rather than about the field's format — a message under the input invites
 * the user to correct an address that may be perfectly correct.
 */
function AddMemberForm({ projectId, onAdded }: { projectId: string; onAdded: () => void }) {
  const form = useForm<AddMemberValues>({
    resolver: zodResolver(AddMemberSchema),
    defaultValues: { email: '', role: 'member' },
  })

  async function onSubmit(values: AddMemberValues) {
    try {
      const result = await addProjectMemberByEmail(projectId, values.email, values.role)
      if (result === 'added') {
        form.reset()
        onAdded()
        return
      }
      form.setError('root', { message: ADD_MESSAGES[result] })
    } catch {
      form.setError('root', { message: GENERIC_CREATE_ERROR })
    }
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-wrap items-start gap-3"
        noValidate
      >
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem className="min-w-56 flex-1">
              <FormLabel>Email address</FormLabel>
              <FormControl>
                <Input type="email" placeholder="person@example.com" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="role"
          render={({ field }) => (
            <FormItem className="w-32">
              <FormLabel>Role</FormLabel>
              <FormControl>
                <select className={selectClass} {...field}>
                  {PROJECT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {PROJECT_ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <SubmitButton label="Add member" pendingLabel="Adding…" className="mt-6" />
        <div className="w-full">
          <FormRootError />
        </div>
      </form>
    </Form>
  )
}
