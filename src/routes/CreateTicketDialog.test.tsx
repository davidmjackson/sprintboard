import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CreateTicketDialog } from './CreateTicketDialog'
import { createTicket } from '@/lib/tickets'

vi.mock('@/lib/tickets', () => ({ createTicket: vi.fn() }))

const mockCreate = vi.mocked(createTicket)

async function openDialog() {
  const user = userEvent.setup()
  render(<CreateTicketDialog projectId="p1" />)
  await user.click(screen.getByRole('button', { name: 'New ticket' }))
  await screen.findByRole('dialog')
  return user
}

beforeEach(() => mockCreate.mockReset())

describe('CreateTicketDialog', () => {
  it('requires a summary', async () => {
    const user = await openDialog()
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    expect(await screen.findByText('Summary is required')).toBeInTheDocument()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('creates a ticket with parsed fields and closes on success', async () => {
    mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1' } as never })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.selectOptions(screen.getByLabelText('Type'), 'bug')
    await user.type(screen.getByLabelText('Story points'), '3')
    await user.type(screen.getByLabelText('Labels'), 'ui, urgent ,')

    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        projectId: 'p1',
        summary: 'Wire the board',
        type: 'bug',
        description: undefined,
        storyPoints: 3,
        labels: ['ui', 'urgent'],
        acceptanceCriteria: undefined,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('surfaces a failure and stays open', async () => {
    mockCreate.mockResolvedValue({ ok: false, error: 'unknown' })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })
})
