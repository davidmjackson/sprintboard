import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TicketDetailDialog } from './TicketDetailDialog'
import type { Ticket } from '@/lib/domain'
import * as tickets from '@/lib/tickets'

vi.mock('@/lib/tickets', async (orig) => ({ ...(await orig<typeof tickets>()), updateTicket: vi.fn() }))
const updateTicket = vi.mocked(tickets.updateTicket)

const base: Ticket = {
  id: 't1', project_id: 'p1', key: 'MP-1', number: 1, summary: 'Wire the board',
  type: 'story', status: 'todo', description: null, assignee_id: null, story_points: null,
  acceptance_criteria: null, labels: [], sprint_id: null, parent_epic_id: null,
  context: null, deliverables: [], is_blocked: false, blocked_reason: null,
  blocked_since: null, created_at: '2026-07-15T00:00:00Z', updated_at: '2026-07-15T00:00:00Z',
}
const user = { id: 'user-a', email: 'a@example.com' }

beforeEach(() => updateTicket.mockReset())

describe('TicketDetailDialog', () => {
  it('shows the ticket key, summary, and status when open', () => {
    render(<TicketDetailDialog ticket={base} currentUser={user} onOpenChange={() => {}} onUpdated={() => {}} />)
    expect(screen.getByText('MP-1')).toBeInTheDocument()
    expect(screen.getByText('Wire the board')).toBeInTheDocument()
    expect(screen.getByText('To Do')).toBeInTheDocument()
  })

  it('renders nothing interactive when ticket is null', () => {
    render(<TicketDetailDialog ticket={null} currentUser={user} onOpenChange={() => {}} onUpdated={() => {}} />)
    expect(screen.queryByText('MP-1')).not.toBeInTheDocument()
  })

  it('commits an edited summary optimistically, then reconciles the persisted row', async () => {
    const onUpdated = vi.fn()
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, summary: 'Renamed', updated_at: '2026-07-15T00:01:00Z' } })
    render(<TicketDetailDialog ticket={base} currentUser={user} onOpenChange={() => {}} onUpdated={onUpdated} />)

    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    const input = screen.getByRole('textbox', { name: /summary/i })
    await userEvent.clear(input)
    await userEvent.type(input, 'Renamed{Enter}')

    // optimistic call first, reconcile call second
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2))
    expect(onUpdated.mock.calls[0]![0]).toMatchObject({ summary: 'Renamed' })
    expect(onUpdated.mock.calls[1]![0]).toMatchObject({ summary: 'Renamed', updated_at: '2026-07-15T00:01:00Z' })
    expect(updateTicket).toHaveBeenCalledWith('t1', { summary: 'Renamed' })
  })

  it('rolls back and shows an error when the save fails', async () => {
    const onUpdated = vi.fn()
    updateTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    render(<TicketDetailDialog ticket={base} currentUser={user} onOpenChange={() => {}} onUpdated={onUpdated} />)

    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    const input = screen.getByRole('textbox', { name: /summary/i })
    await userEvent.clear(input)
    await userEvent.type(input, 'Bad{Enter}')

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    // optimistic then rollback -> last call restores the original summary
    expect(onUpdated.mock.calls.at(-1)![0]).toMatchObject({ summary: 'Wire the board' })
  })

  it('does not call updateTicket when Esc cancels the edit', async () => {
    render(<TicketDetailDialog ticket={base} currentUser={user} onOpenChange={() => {}} onUpdated={() => {}} />)
    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    const input = screen.getByRole('textbox', { name: /summary/i })
    await userEvent.type(input, 'X{Escape}')
    expect(updateTicket).not.toHaveBeenCalled()
  })

  it('commits an assignee change to the current user, sending assignee_id', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, assignee_id: 'user-a' } })
    render(<TicketDetailDialog ticket={base} currentUser={user} onOpenChange={() => {}} onUpdated={() => {}} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /assignee/i }), 'user-a')
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { assignee_id: 'user-a' }))
  })

  it('lists only Unassigned and the current user as assignee options', () => {
    render(<TicketDetailDialog ticket={base} currentUser={user} onOpenChange={() => {}} onUpdated={() => {}} />)
    const options = screen.getAllByRole('option').filter((o) =>
      (o as HTMLOptionElement).closest('select')?.getAttribute('aria-label')?.match(/assignee/i))
    expect(options.map((o) => o.textContent)).toEqual(['Unassigned', 'a@example.com'])
  })
})
