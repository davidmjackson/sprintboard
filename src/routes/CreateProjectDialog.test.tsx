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
})
