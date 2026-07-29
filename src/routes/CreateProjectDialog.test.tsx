import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CreateProjectDialog } from './CreateProjectDialog'
import { createProject } from '@/lib/projects'

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ session: {}, user: { id: 'u1' }, loading: false }),
}))
vi.mock('@/lib/projects', () => ({ createProject: vi.fn() }))

const mockCreate = vi.mocked(createProject)

async function openDialog() {
  const user = userEvent.setup()
  render(<CreateProjectDialog />)
  await user.click(screen.getByRole('button', { name: 'New project' }))
  await screen.findByRole('dialog')
  return user
}

beforeEach(() => mockCreate.mockReset())

describe('CreateProjectDialog', () => {
  it('suggests a key derived from the name', async () => {
    const user = await openDialog()
    await user.type(screen.getByLabelText('Name'), 'Sprintboard')
    expect(screen.getByLabelText('Key')).toHaveValue('SPR')
  })

  it('stops suggesting a key once the user edits it', async () => {
    const user = await openDialog()
    await user.type(screen.getByLabelText('Key'), 'ab') // uppercased on input
    expect(screen.getByLabelText('Key')).toHaveValue('AB')
    await user.type(screen.getByLabelText('Name'), 'Sprintboard')
    expect(screen.getByLabelText('Key')).toHaveValue('AB') // not overwritten
  })

  it('blocks an invalid key and does not hit the API', async () => {
    const user = await openDialog()
    await user.type(screen.getByLabelText('Name'), 'X') // derives key "X" — 1 char, invalid
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(await screen.findByText(/Key must be/)).toBeInTheDocument()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('requires a name', async () => {
    const user = await openDialog()
    await user.type(screen.getByLabelText('Key'), 'ABC')
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(await screen.findByText('Project name is required')).toBeInTheDocument()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates the project and closes on success', async () => {
    mockCreate.mockResolvedValue({ ok: true, project: { id: 'p1' } as never })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Name'), 'Sprintboard')
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({ ownerId: 'u1', name: 'Sprintboard', key: 'SPR' }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('surfaces a duplicate key as a field error and stays open', async () => {
    mockCreate.mockResolvedValue({ ok: false, error: 'duplicate_key' })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Name'), 'Sprintboard')
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(await screen.findByText(/already have a project with this key/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  /**
   * SPRIN-51. `CreateDialog` hands `onSubmit` a generation-guarded `setError`, and this
   * call site must use it rather than reaching for `form.setError` directly. Nothing in
   * the type system enforces that — reverting either call here leaves every other test in
   * the repo green, and reverting only the `key` branch keeps `setError` bound so even
   * `no-unused-vars` stays quiet. This test is the whole control.
   *
   * It is the highest-traffic stale path in the app: the duplicate-key failure, in the one
   * dialog that also carries `keyEdited` state across a reopen.
   */
  it('paints no stale duplicate-key error onto a draft opened after the submit was abandoned', async () => {
    let release: (v: { ok: false; error: 'duplicate_key' }) => void = () => {}
    mockCreate.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }) as never,
    )
    const user = userEvent.setup()
    render(<CreateProjectDialog />)

    await user.click(screen.getByRole('button', { name: 'New project' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Name'), 'Sprintboard')
    await user.click(screen.getByRole('button', { name: 'Create project' }))
    await screen.findByRole('button', { name: 'Creating…' })

    // Abandoned mid-flight, then reopened for something unrelated.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'New project' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Name'), 'Another Project')

    release({ ok: false, error: 'duplicate_key' })

    // The rejection belongs to a submit the user already walked away from. It must not
    // land on this draft — which is for a different project and a different key.
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('Another Project'))
    expect(screen.queryByText(/already have a project with this key/)).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
