import { describe, expect, it } from 'vitest'

import { selectMatchingTickets } from './ticket-search'
import type { Ticket } from './domain'

function ticket(fields: Partial<Ticket>): Ticket {
  return { key: 'MP-1', summary: 'Wire the board', ...fields } as Ticket
}

const TICKETS = [
  ticket({ key: 'MP-1', summary: 'Wire the board' }),
  ticket({ key: 'MP-2', summary: 'Fix the LOGIN redirect' }),
  ticket({ key: 'MP-13', summary: 'Add sprint burndown' }),
]

describe('selectMatchingTickets', () => {
  it('returns everything for an empty query', () => {
    const result = selectMatchingTickets(TICKETS, '')
    expect(result).toHaveLength(3)
    expect(result.map((t) => t.key)).toEqual(['MP-1', 'MP-2', 'MP-13'])
    expect(result).not.toBe(TICKETS)
  })

  it('returns everything for a whitespace-only query', () => {
    const result = selectMatchingTickets(TICKETS, '   ')
    expect(result).toHaveLength(3)
    expect(result.map((t) => t.key)).toEqual(['MP-1', 'MP-2', 'MP-13'])
    expect(result).not.toBe(TICKETS)
  })

  it('matches the summary case-insensitively', () => {
    const found = selectMatchingTickets(TICKETS, 'LOGIN')
    expect(found.map((t) => t.key)).toEqual(['MP-2'])
  })

  it('matches a full key', () => {
    const found = selectMatchingTickets(TICKETS, 'mp-2')
    expect(found.map((t) => t.key)).toEqual(['MP-2'])
  })

  it('matches a partial key, so MP-1 also matches MP-13', () => {
    const found = selectMatchingTickets(TICKETS, 'MP-1')
    expect(found.map((t) => t.key)).toEqual(['MP-1', 'MP-13'])
  })

  it('ignores surrounding whitespace in the query', () => {
    expect(selectMatchingTickets(TICKETS, '  burndown  ')).toHaveLength(1)
  })

  it('returns an empty array when nothing matches', () => {
    expect(selectMatchingTickets(TICKETS, 'zzz')).toEqual([])
  })

  it('preserves the given order and does not mutate the input', () => {
    const input = [...TICKETS]
    const found = selectMatchingTickets(input, 'MP')
    expect(found.map((t) => t.key)).toEqual(['MP-1', 'MP-2', 'MP-13'])
    expect(input).toHaveLength(3)
  })
})
