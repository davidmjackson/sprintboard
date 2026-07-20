import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TicketCard } from './TicketCard'
import type { Ticket } from '@/lib/domain'

const ticket = { id: 't1', key: 'MP-1', type: 'story', summary: 'Wire the board' } as Ticket

describe('TicketCard', () => {
  it('calls onOpen when clicked', async () => {
    const onOpen = vi.fn()
    render(<TicketCard ticket={ticket} onOpen={onOpen} />)
    await userEvent.click(screen.getByRole('button', { name: /wire the board/i }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('shows a Blocked marker when the ticket is blocked', () => {
    render(<TicketCard ticket={{ ...ticket, is_blocked: true } as Ticket} />)
    expect(screen.getByText(/blocked/i)).toBeInTheDocument()
  })

  it('shows no Blocked marker when the ticket is not blocked', () => {
    render(<TicketCard ticket={{ ...ticket, is_blocked: false } as Ticket} />)
    expect(screen.queryByText(/blocked/i)).not.toBeInTheDocument()
  })

  it('is draggable and fires onDragStart when a drag begins (S7.2)', () => {
    const onDragStart = vi.fn()
    render(<TicketCard ticket={ticket} onDragStart={onDragStart} />)
    const card = screen.getByRole('button', { name: /wire the board/i })
    expect(card).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(card)
    expect(onDragStart).toHaveBeenCalledTimes(1)
  })

  it('is not draggable when no onDragStart is given (backlog / non-board usage)', () => {
    render(<TicketCard ticket={ticket} onOpen={vi.fn()} />)
    expect(screen.getByRole('button', { name: /wire the board/i })).toHaveAttribute(
      'draggable',
      'false',
    )
  })
})
