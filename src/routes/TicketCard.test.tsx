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

  it('shows the block reason on the marker for hover (S7.3 AC1)', () => {
    render(
      <TicketCard
        ticket={{ ...ticket, is_blocked: true, blocked_reason: 'waiting on API' } as Ticket}
      />,
    )
    expect(screen.getByText(/blocked/i)).toHaveAttribute('title', 'Blocked: waiting on API')
  })

  it('shows a plain Blocked title when a blocked ticket has no reason', () => {
    render(<TicketCard ticket={{ ...ticket, is_blocked: true, blocked_reason: null } as Ticket} />)
    expect(screen.getByText(/blocked/i)).toHaveAttribute('title', 'Blocked')
  })

  it('opens via the keyboard: Enter on the focused card (the keyboard route to the dialog)', async () => {
    const onOpen = vi.fn()
    render(<TicketCard ticket={ticket} onOpen={onOpen} />)
    const card = screen.getByRole('button', { name: /wire the board/i })
    card.focus()
    expect(card).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('is reachable by Tab (the card is a real button, not a clickable div)', async () => {
    render(<TicketCard ticket={ticket} onOpen={vi.fn()} />)
    await userEvent.tab()
    const focused = screen.getByRole('button', { name: /wire the board/i })
    expect(focused).toHaveFocus()
    // A `role="button"` div passes the assertion above too (jsdom honours the ARIA role
    // in getByRole), so the name's claim ("a real button") is only true once the element
    // itself is checked, not just its accessible role.
    expect(focused.tagName).toBe('BUTTON')
  })

  it('shows the story points with a screen-reader unit (SPRIN-65 AC1)', () => {
    render(<TicketCard ticket={{ ...ticket, story_points: 5 } as Ticket} />)
    expect(screen.getByText('5')).toBeInTheDocument()
    expect(screen.getByText(/story points/i)).toBeInTheDocument()
    // The whole point of the `sr-only` unit over an `aria-label`: it must join the
    // *button's* accessible name, not just exist as isolated text somewhere on the page.
    expect(screen.getByRole('button', { name: /story points/i })).toBeInTheDocument()
  })

  // 0 is a real estimate. A falsy guard would hide this badge, silently turning an
  // estimated-at-zero ticket into an unestimated one.
  it('shows a 0-point estimate rather than hiding it', () => {
    render(<TicketCard ticket={{ ...ticket, story_points: 0 } as Ticket} />)
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText(/story points/i)).toBeInTheDocument()
  })

  // Negative control. Its positive control is the two tests above: they prove the
  // `/story points/i` text exists to be missing, so this assertion cannot pass
  // merely because the string was never rendered anywhere.
  it('shows no points badge for an unestimated ticket', () => {
    render(<TicketCard ticket={{ ...ticket, story_points: null } as Ticket} />)
    expect(screen.queryByText(/story points/i)).not.toBeInTheDocument()
  })
})
