import { describe, expect, it } from 'vitest'

import type { Sprint, Ticket } from './domain'
import { selectActiveSprint, selectBlockedTickets } from './board'

/** A sprint with only the field this rule reads. `status` is always stated. */
function sprint(fields: Partial<Sprint> & Pick<Sprint, 'id' | 'status'>): Sprint {
  return { name: 'Sprint', project_id: 'p1', ...fields } as Sprint
}

// A ticket with only the fields this rule reads. `is_blocked` is always stated.
function ticket(fields: Partial<Ticket> & Pick<Ticket, 'id' | 'is_blocked'>): Ticket {
  return {
    key: 'MP-1',
    summary: 's',
    type: 'story',
    status: 'todo',
    sprint_id: null,
    ...fields,
  } as Ticket
}

describe('selectActiveSprint', () => {
  it('returns the sprint whose status is active', () => {
    const sprints = [
      sprint({ id: 's1', status: 'future' }),
      sprint({ id: 's2', status: 'active' }),
      sprint({ id: 's3', status: 'complete' }),
    ]
    expect(selectActiveSprint(sprints)?.id).toBe('s2')
  })

  it('returns null when no sprint is active', () => {
    const sprints = [
      sprint({ id: 's1', status: 'future' }),
      sprint({ id: 's3', status: 'complete' }),
    ]
    expect(selectActiveSprint(sprints)).toBeNull()
  })

  it('returns null for an empty list', () => {
    expect(selectActiveSprint([])).toBeNull()
  })
})

describe('selectBlockedTickets', () => {
  it('returns only the blocked tickets', () => {
    const tickets = [
      ticket({ id: 't1', is_blocked: true }),
      ticket({ id: 't2', is_blocked: false }),
      ticket({ id: 't3', is_blocked: true }),
    ]
    expect(selectBlockedTickets(tickets).map((t) => t.id)).toEqual(['t1', 't3'])
  })

  it('returns an empty array when none are blocked', () => {
    expect(selectBlockedTickets([ticket({ id: 't1', is_blocked: false })])).toEqual([])
  })

  it('returns an empty array for an empty list', () => {
    expect(selectBlockedTickets([])).toEqual([])
  })
})
