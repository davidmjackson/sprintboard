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

  /**
   * The test above fills neither free-text field, so both arrive as `undefined` and the
   * two are interchangeable in the create call without anything noticing — one of the
   * pre-existing gaps S9.4's mutation sweep recorded. The values here are deliberately
   * distinct and non-substitutable, so no single default satisfies both positions.
   */
  it('does not transpose description and acceptance criteria', async () => {
    mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1' } as never })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.type(screen.getByLabelText('Description'), 'DESCRIPTION-SIDE')
    await user.type(screen.getByLabelText('Acceptance criteria'), 'CRITERIA-SIDE')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'DESCRIPTION-SIDE',
          acceptanceCriteria: 'CRITERIA-SIDE',
        }),
      ),
    )
  })

  /**
   * Blank story points must reach `createTicket` as `undefined`, never `0`. A Scrum board
   * treats a 0-point ticket as estimated-at-zero, which is a different and wrong claim
   * from unestimated — and `Number('')` is `0`, so this is one keystroke away.
   */
  it('sends undefined story points when the field is left blank', async () => {
    mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1' } as never })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Summary'), 'Unestimated work')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    const sent = mockCreate.mock.calls[0]![0]
    expect(sent.storyPoints).toBeUndefined()
    expect(sent.storyPoints).not.toBe(0)
  })

  /**
   * SPRIN-51, AC3. The shell suppresses a stale `close`, but the row was still written, so
   * the parent must still be told about it or the new ticket stays invisible until a
   * refetch. This is the assertion that rules out "fixing" the stale-submit bug by
   * bailing out of the whole continuation — it lives here, not in `CreateDialog.test.tsx`,
   * because `onCreated` is this component's call to make and only a change here can drop it.
   */
  it('still notifies the parent of the created ticket when the submit resolved stale', async () => {
    let release: (v: { ok: true; ticket: { id: string } }) => void = () => {}
    mockCreate.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }) as never,
    )
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<CreateTicketDialog projectId="p1" onCreated={onCreated} />)

    await user.click(screen.getByRole('button', { name: 'New ticket' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))
    await screen.findByRole('button', { name: 'Creating…' })

    // Abandon it mid-flight, then reopen and start something else.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'New ticket' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Summary'), 'A different ticket')

    release({ ok: true, ticket: { id: 't1' } })

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 't1' }))
    // ...and the reopened draft is untouched by the resolution.
    expect(screen.getByLabelText('Summary')).toHaveValue('A different ticket')
  })
})
