import { describe, expect, it } from 'vitest'

import type { Ticket } from './domain'
import { isBacklogTicket, selectBacklogTickets } from './backlog'

/** A ticket with only the fields this rule reads. `sprint_id` is always stated. */
function ticket(fields: Partial<Ticket> & Pick<Ticket, 'id' | 'sprint_id'>): Ticket {
  return { number: 1, status: 'todo', type: 'story', ...fields } as Ticket
}

describe('isBacklogTicket', () => {
  it('is true for a ticket with no sprint', () => {
    expect(isBacklogTicket(ticket({ id: 't1', sprint_id: null }))).toBe(true)
  })

  it('is false for a ticket in a sprint', () => {
    expect(isBacklogTicket(ticket({ id: 't1', sprint_id: 's1' }))).toBe(false)
  })

  it('is false for a DONE ticket in a sprint (S5.1 AC: sprint history is not backlog)', () => {
    // The rule is `sprint_id is null`, NOT "anything outside the active sprint" — the
    // latter would drag every past sprint's Done tickets back in and contradict S6.4.
    expect(isBacklogTicket(ticket({ id: 't1', sprint_id: 's-past', status: 'done' }))).toBe(false)
  })

  it('is true for a DONE ticket with no sprint', () => {
    // Status is irrelevant to the rule. Done-but-never-sprinted is still backlog.
    expect(isBacklogTicket(ticket({ id: 't1', sprint_id: null, status: 'done' }))).toBe(true)
  })
})

describe('selectBacklogTickets', () => {
  it('keeps only the tickets with no sprint', () => {
    const rows = [
      ticket({ id: 't1', sprint_id: null }),
      ticket({ id: 't2', sprint_id: 's1' }),
      ticket({ id: 't3', sprint_id: null }),
    ]
    expect(selectBacklogTickets(rows).map((t) => t.id)).toEqual(['t1', 't3'])
  })

  it('preserves the incoming order (listTickets orders by number)', () => {
    const rows = [
      ticket({ id: 't3', sprint_id: null, number: 3 }),
      ticket({ id: 't1', sprint_id: null, number: 1 }),
    ]
    // The rule filters, it never sorts — the shell's number order is the backlog order.
    expect(selectBacklogTickets(rows).map((t) => t.id)).toEqual(['t3', 't1'])
  })

  it('returns an empty list when every ticket is in a sprint', () => {
    const rows = [ticket({ id: 't1', sprint_id: 's1' }), ticket({ id: 't2', sprint_id: 's2' })]
    expect(selectBacklogTickets(rows)).toEqual([])
  })

  it('returns an empty list for no tickets', () => {
    expect(selectBacklogTickets([])).toEqual([])
  })
})
