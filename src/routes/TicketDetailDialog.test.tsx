import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TicketDetailDialog } from './TicketDetailDialog'
import type { Ticket } from '@/lib/domain'
import * as tickets from '@/lib/tickets'
import type { UpdateTicketResult } from '@/lib/tickets'

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

  it('preserves a concurrent field edit when an earlier save fails and rolls back only its own field', async () => {
    // Two in-flight saves, resolved manually and out of commit order, so the rollback
    // must merge against the LATEST ticket rather than a stale render-time snapshot.
    let resolveSummarySave!: (r: UpdateTicketResult) => void
    let resolvePointsSave!: (r: UpdateTicketResult) => void
    const summarySave = new Promise<UpdateTicketResult>((res) => { resolveSummarySave = res })
    const pointsSave = new Promise<UpdateTicketResult>((res) => { resolvePointsSave = res })
    updateTicket.mockImplementation((_id, patch) => {
      if (patch && 'summary' in patch) return summarySave
      if (patch && 'story_points' in patch) return pointsSave
      return Promise.resolve({ ok: true, ticket: base })
    })

    const onUpdated = vi.fn()
    // A tiny stand-in for the real parent: replaces the ticket by id on every onUpdated,
    // exactly like the app does, so the component's ticketRef sees the latest merged state.
    function Harness() {
      const [t, setT] = useState(base)
      return (
        <TicketDetailDialog
          ticket={t}
          currentUser={user}
          onOpenChange={() => {}}
          onUpdated={(next) => { setT(next); onUpdated(next) }}
        />
      )
    }
    render(<Harness />)

    // Start editing summary; commit fires updateTicket and optimistically applies, but the
    // save stays pending.
    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), 'First edit{Enter}')
    await waitFor(() => expect(screen.getByText('First edit')).toBeInTheDocument())

    // While the summary save is still pending, edit story points too — its optimistic
    // update lands on top of the (still-pending) summary edit.
    await userEvent.click(screen.getByRole('button', { name: /edit story points/i }))
    await userEvent.clear(screen.getByRole('spinbutton', { name: /story points/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /story points/i }), '5{Enter}')
    await waitFor(() =>
      expect(screen.queryByRole('spinbutton', { name: /story points/i })).not.toBeInTheDocument(),
    )

    expect(updateTicket).toHaveBeenCalledWith('t1', { summary: 'First edit' })
    expect(updateTicket).toHaveBeenCalledWith('t1', { story_points: 5 })

    // The SECOND (story points) field's save resolves and reconciles first, while the
    // FIRST (summary) save is still pending.
    resolvePointsSave({ ok: true, ticket: { ...base, story_points: 5, updated_at: '2026-07-15T00:02:00Z' } })
    await waitFor(() => expect(onUpdated.mock.calls.at(-1)![0]).toMatchObject({ story_points: 5 }))

    // NOW the summary save fails, after story points has already reconciled to 5. A
    // stale render-time-snapshot rollback would revert the WHOLE ticket (including
    // story_points, back to null) — the fix must revert only `summary`.
    resolveSummarySave({ ok: false, error: 'unknown' })
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    const latest = onUpdated.mock.calls.at(-1)![0] as Ticket
    expect(latest.summary).toBe('Wire the board') // reverted — only the failed field
    expect(latest.story_points).toBe(5) // survives — concurrent edit not clobbered
  })

  it('Esc while editing a field cancels only the field edit, not the whole dialog', async () => {
    const onOpenChange = vi.fn()
    render(<TicketDetailDialog ticket={base} currentUser={user} onOpenChange={onOpenChange} onUpdated={() => {}} />)

    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    const input = screen.getByRole('textbox', { name: /summary/i })
    await userEvent.type(input, 'Should not save{Escape}')

    expect(updateTicket).not.toHaveBeenCalled()
    // Back to view mode: the field editor is gone, the button is back.
    expect(screen.getByRole('button', { name: /edit summary/i })).toBeInTheDocument()
    // The dialog itself must not have been asked to close.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('Esc with no field being edited allows the dialog to dismiss', async () => {
    const onOpenChange = vi.fn()
    render(<TicketDetailDialog ticket={base} currentUser={user} onOpenChange={onOpenChange} onUpdated={() => {}} />)

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})
