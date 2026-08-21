import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { MemberSettings } from './MemberSettings'
import type { ProjectMemberWithProfile } from '@/lib/domain'
import {
  addProjectMemberByEmail,
  removeProjectMember,
  setProjectMemberRole,
} from '@/lib/project-members'

// Only the three writes are mocked. `roleOf` and everything this component reads out of
// `domain.ts` stay real, so the role picker is built from the genuine `PROJECT_ROLES` rather
// than from a fixture that could drift from it.
vi.mock('@/lib/project-members', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-members')>()),
  addProjectMemberByEmail: vi.fn(),
  removeProjectMember: vi.fn(),
  setProjectMemberRole: vi.fn(),
}))

const mockAdd = vi.mocked(addProjectMemberByEmail)
const mockRemove = vi.mocked(removeProjectMember)
const mockSetRole = vi.mocked(setProjectMemberRole)

/**
 * TWO members with DIFFERENT roles and DIFFERENT names, and both differences are load-bearing.
 *
 * Equal roles would let a crossed wire — rendering member A's role on member B's row — pass
 * every assertion. Equal names would do the same for the per-row controls, since the Remove
 * button is named after the member it removes; with both people called the same thing, a
 * button wired to the wrong row would still find a matching accessible name.
 */
const ADMIN: ProjectMemberWithProfile = {
  project_id: 'p1',
  user_id: 'u1',
  role: 'admin',
  created_at: '2026-08-01T00:00:00Z',
  email: 'ada@example.com',
  display_name: 'Ada',
}

const MEMBER: ProjectMemberWithProfile = {
  project_id: 'p1',
  user_id: 'u2',
  role: 'member',
  created_at: '2026-08-02T00:00:00Z',
  email: 'grace@example.com',
  display_name: 'Grace',
}

const MEMBERS = [ADMIN, MEMBER]

function renderSection(overrides: Partial<Parameters<typeof MemberSettings>[0]> = {}) {
  const onChanged = vi.fn()
  const onRetry = vi.fn()
  render(
    <MemberSettings
      projectId="p1"
      members={MEMBERS}
      phase="loaded"
      role="admin"
      currentUserId="u1"
      onRetry={onRetry}
      onChanged={onChanged}
      {...overrides}
    />,
  )
  return { onChanged, onRetry }
}

/** The row for one member, scoped — an unscoped query says the text exists and nothing about
 *  WHERE, which is exactly how a crossed wire survives. */
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name, { selector: 'span' }).closest('li')
  if (row === null) throw new Error(`No row for ${name}`)
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the phases', () => {
  it('renders the failure block, not an empty list, on a failed read', () => {
    const { onRetry } = renderSection({ phase: 'failed' })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load members.')
    expect(screen.queryByText('Ada')).not.toBeInTheDocument()

    return userEvent.click(screen.getByRole('button', { name: 'Retry' })).then(() => {
      expect(onRetry).toHaveBeenCalledTimes(1)
    })
  })

  it('says it is loading rather than rendering an empty membership', () => {
    // An empty list is a state the schema cannot produce -- every project has at least an
    // admin -- so rendering one would state something untrue about the project.
    renderSection({ phase: 'loading', members: [] })

    expect(screen.getByText('Loading…')).toBeInTheDocument()
  })
})

describe('what a NON-admin sees', () => {
  it('lists every member with their role, read-only', () => {
    renderSection({ role: 'member', currentUserId: 'u2' })

    expect(within(rowFor('Ada')).getByText('Admin')).toBeInTheDocument()
    expect(within(rowFor('Grace')).getByText('Member')).toBeInTheDocument()
  })

  it('offers NO control that would be refused: no add form, no picker, no remove', () => {
    renderSection({ role: 'member', currentUserId: 'u2' })

    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add member' })).not.toBeInTheDocument()
  })

  it('hides the same controls from someone with NO membership at all', () => {
    renderSection({ role: null, currentUserId: undefined })

    expect(screen.getByText('Ada')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument()
  })
})

describe('what an admin sees', () => {
  it('marks the signed-in user, and only them', () => {
    renderSection()

    expect(within(rowFor('Ada')).getByText('(you)')).toBeInTheDocument()
    expect(within(rowFor('Grace')).queryByText('(you)')).not.toBeInTheDocument()
  })

  it("gives each row a picker showing THAT row's member role", () => {
    renderSection()

    expect(within(rowFor('Ada')).getByRole('combobox')).toHaveValue('admin')
    expect(within(rowFor('Grace')).getByRole('combobox')).toHaveValue('member')
  })

  it('names a member by email when they have no display name', () => {
    renderSection({ members: [{ ...MEMBER, display_name: null }] })

    expect(screen.getByText('grace@example.com')).toBeInTheDocument()
  })

  it('names a member by ID when NEITHER profile field is readable', () => {
    // A real state: profiles_read is scoped to co-membership, so a row whose profile is
    // unreadable renders by id rather than vanishing -- an admin must be able to remove
    // someone they cannot name.
    renderSection({ members: [{ ...MEMBER, display_name: null, email: null }] })

    expect(screen.getByText('u2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove u2' })).toBeInTheDocument()
  })
})

describe('changing a role', () => {
  it('sends the change for the row it was made on', async () => {
    mockSetRole.mockResolvedValue('updated')
    const { onChanged } = renderSection()

    await userEvent.selectOptions(within(rowFor('Grace')).getByRole('combobox'), 'admin')

    expect(mockSetRole).toHaveBeenCalledWith('p1', 'u2', 'admin')
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('EXPLAINS the last-admin refusal instead of reporting a failure', async () => {
    // The tag is an ordinary outcome, not an error: retrying is pointless and the user needs
    // the way out, which is to promote someone first.
    mockSetRole.mockResolvedValue('last_admin')
    const { onChanged } = renderSection()

    await userEvent.selectOptions(within(rowFor('Ada')).getByRole('combobox'), 'member')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'must always have at least one admin',
    )
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('does not refetch on a refusal, so the list cannot silently appear to have changed', async () => {
    mockSetRole.mockResolvedValue('not_a_member')
    const { onChanged } = renderSection()

    await userEvent.selectOptions(within(rowFor('Grace')).getByRole('combobox'), 'admin')

    expect(await screen.findByRole('alert')).toHaveTextContent('no longer a member')
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reports a thrown RPC as a retryable failure, NOT as one of the tags', async () => {
    mockSetRole.mockRejectedValue(new Error('permission denied'))
    renderSection()

    await userEvent.selectOptions(within(rowFor('Grace')).getByRole('combobox'), 'admin')

    const alert = await screen.findByRole('alert')
    expect(alert).not.toHaveTextContent('permission denied')
  })
})

describe('removing a member', () => {
  it('removes the member whose button was pressed', async () => {
    mockRemove.mockResolvedValue('removed')
    const { onChanged } = renderSection()

    await userEvent.click(screen.getByRole('button', { name: 'Remove Grace' }))

    expect(mockRemove).toHaveBeenCalledWith('p1', 'u2')
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('lets an admin remove THEMSELVES -- the ordinary way to hand over', async () => {
    mockRemove.mockResolvedValue('removed')
    renderSection()

    await userEvent.click(screen.getByRole('button', { name: 'Remove Ada' }))

    expect(mockRemove).toHaveBeenCalledWith('p1', 'u1')
  })

  it('OFFERS the control on the last admin and lets the RPC refuse it', async () => {
    // Deliberately not disabled. A client-side copy of the guard would re-derive "is this
    // the last admin" from a possibly-stale list; letting the RPC answer keeps ONE
    // implementation of the rule, in the place that holds the row lock.
    mockRemove.mockResolvedValue('last_admin')
    renderSection({ members: [ADMIN] })

    const button = screen.getByRole('button', { name: 'Remove Ada' })
    expect(button).toBeEnabled()

    await userEvent.click(button)
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'must always have at least one admin',
    )
  })
})

describe('adding a member', () => {
  it('TRIMS the address but preserves its CASE, leaving the case decision to the RPC', async () => {
    // The two halves of `lower(btrim(...))` are split deliberately between the two edges:
    // trimming is idempotent so the client may do it, lowercasing is a real decision about
    // which of two case-differing rows to match, so only the RPC does it.
    mockAdd.mockResolvedValue('added')
    const { onChanged } = renderSection()

    await userEvent.type(screen.getByLabelText('Email address'), '  Grace@Example.COM  ')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith('p1', 'Grace@Example.COM', 'member'))
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
  })

  it('sends the chosen role, not always the default', async () => {
    mockAdd.mockResolvedValue('added')
    renderSection()

    await userEvent.type(screen.getByLabelText('Email address'), 'grace@example.com')
    await userEvent.selectOptions(screen.getByLabelText('Role'), 'admin')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))

    await waitFor(() => expect(mockAdd).toHaveBeenCalledWith('p1', 'grace@example.com', 'admin'))
  })

  it('refuses an invalid address WITHOUT a round trip', async () => {
    renderSection()

    await userEvent.type(screen.getByLabelText('Email address'), 'not-an-address')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))

    expect(await screen.findByText('Enter a valid email address')).toBeInTheDocument()
    expect(mockAdd).not.toHaveBeenCalled()
  })

  it('reports an unregistered address as a statement about the ADDRESS', async () => {
    mockAdd.mockResolvedValue('no_such_user')
    const { onChanged } = renderSection()

    await userEvent.type(screen.getByLabelText('Email address'), 'nobody@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'No account is registered with that email address.',
    )
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reports an existing member rather than appearing to do nothing', async () => {
    mockAdd.mockResolvedValue('already_member')
    renderSection()

    await userEvent.type(screen.getByLabelText('Email address'), 'grace@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('already a member')
  })

  it('clears the field on success, so the next add does not resend the last address', async () => {
    mockAdd.mockResolvedValue('added')
    renderSection()

    const field = screen.getByLabelText('Email address')
    await userEvent.type(field, 'grace@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))

    await waitFor(() => expect(field).toHaveValue(''))
  })

  it('does NOT clear the field on a refusal, so the address can be corrected', async () => {
    mockAdd.mockResolvedValue('no_such_user')
    renderSection()

    const field = screen.getByLabelText('Email address')
    await userEvent.type(field, 'typo@example.com')
    await userEvent.click(screen.getByRole('button', { name: 'Add member' }))

    await screen.findByRole('alert')
    expect(field).toHaveValue('typo@example.com')
  })
})
