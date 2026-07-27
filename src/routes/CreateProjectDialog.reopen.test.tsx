import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { CreateProjectDialog } from './CreateProjectDialog'

/**
 * `CreateProjectDialog.test.tsx` never closes and reopens the dialog, so it cannot see
 * whether `keyEdited` survives a close. This file exists to pin that specific wiring:
 * `onClosed={() => setKeyEdited(false)}` on the `<CreateDialog>` call site. Before the
 * S9.4 refactor `setKeyEdited(false)` lived inside `handleOpenChange`, in the same
 * function as the close transition itself, and could not be dropped without deleting
 * the close handler. Now it is an optional prop that a future edit could silently omit —
 * this test is the guard against that.
 */
vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ session: {}, user: { id: 'u1' }, loading: false }),
}))
vi.mock('@/lib/projects', () => ({ createProject: vi.fn() }))

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New project' }))
  await screen.findByRole('dialog')
}

describe('CreateProjectDialog — key-suggestion state across a close/reopen', () => {
  it('re-derives the key from the name after the dialog is closed and reopened', async () => {
    const user = userEvent.setup()
    render(<CreateProjectDialog />)

    await openDialog(user)
    // Edit the key directly, flipping `keyEdited` true.
    await user.type(screen.getByLabelText('Key'), 'ab')
    expect(screen.getByLabelText('Key')).toHaveValue('AB')

    // Positive control: with `keyEdited` true, typing the name no longer overwrites it.
    await user.type(screen.getByLabelText('Name'), 'Sprintboard')
    expect(screen.getByLabelText('Key')).toHaveValue('AB')

    // Close, then reopen.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await screen.findByRole('button', { name: 'New project' })
    await openDialog(user)

    // If `onClosed` fired, `keyEdited` is back to false and the suggestion resumes.
    // `deriveProjectKey` takes initials for a multi-word name: "Another Project" -> "AP".
    await user.type(screen.getByLabelText('Name'), 'Another Project')
    expect(screen.getByLabelText('Key')).toHaveValue('AP')
  })
})
