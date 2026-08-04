import { describe, expect, it } from 'vitest'

import type { Project, ProjectType, Ticket } from './domain'
import {
  isBacklogTicket,
  selectBacklogTickets,
  selectSprintTickets,
  selectTicketList,
} from './backlog'

/** A ticket with only the fields this rule reads. `sprint_id` is always stated. */
function ticket(fields: Partial<Ticket> & Pick<Ticket, 'id' | 'sprint_id'>): Ticket {
  return { number: 1, status: 'todo', type: 'story', ...fields } as Ticket
}

/** A project with only the field this rule reads, as `board.test.ts` builds one. */
function project(project_type: ProjectType): Pick<Project, 'project_type'> {
  return { project_type }
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

/**
 * SPRIN-83 review finding. The pairing with `selectBoardScope` is the whole point, so every
 * test here names the state the OTHER tab would be in — a ticket carrying a `sprint_id` on a
 * project without sprints is the one input on which the two selectors could disagree, and it
 * is therefore in every fixture below rather than in one case bolted on at the end.
 */
describe('selectTicketList', () => {
  const rows = [
    ticket({ id: 't1', sprint_id: null }),
    ticket({ id: 't2', sprint_id: 's1' }),
    ticket({ id: 't3', sprint_id: null }),
  ]

  it('is the backlog on a project with sprints', () => {
    expect(selectTicketList(project('scrum'), rows).map((t) => t.id)).toEqual(['t1', 't3'])
  })

  it('is EVERY ticket on a project without sprints, including one carrying a sprint_id', () => {
    // The defect this selector exists for: `selectBoardScope` ignores `sprint_id` on this
    // project type, so a board showing 't2' beside a list hiding it is two tabs disagreeing
    // about the same ticket. Asserting the ids rather than the length — a list of the right
    // SIZE built from the wrong tickets would pass a length check.
    expect(selectTicketList(project('kanban'), rows).map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('preserves the incoming order on both project types (listTickets orders by number)', () => {
    const unordered = [
      ticket({ id: 't3', sprint_id: null, number: 3 }),
      ticket({ id: 't1', sprint_id: null, number: 1 }),
    ]
    // Selects and filters, never sorts — the same contract as the two selectors it delegates to.
    expect(selectTicketList(project('scrum'), unordered).map((t) => t.id)).toEqual(['t3', 't1'])
    expect(selectTicketList(project('kanban'), unordered).map((t) => t.id)).toEqual(['t3', 't1'])
  })

  it("copies rather than returning the caller's array, so the shell's list cannot be mutated", () => {
    expect(selectTicketList(project('kanban'), rows)).not.toBe(rows)
  })

  it('returns an empty list for no tickets, on either project type', () => {
    expect(selectTicketList(project('scrum'), [])).toEqual([])
    expect(selectTicketList(project('kanban'), [])).toEqual([])
  })
})

describe('selectSprintTickets', () => {
  it('keeps only the tickets in the given sprint', () => {
    const rows = [
      ticket({ id: 't1', sprint_id: 's1' }),
      ticket({ id: 't2', sprint_id: null }),
      ticket({ id: 't3', sprint_id: 's1' }),
    ]
    expect(selectSprintTickets(rows, 's1').map((t) => t.id)).toEqual(['t1', 't3'])
  })

  it('excludes backlog tickets (sprint_id: null)', () => {
    const rows = [ticket({ id: 't1', sprint_id: null })]
    expect(selectSprintTickets(rows, 's1')).toEqual([])
  })

  it("excludes another sprint's tickets", () => {
    const rows = [ticket({ id: 't1', sprint_id: 's2' })]
    expect(selectSprintTickets(rows, 's1')).toEqual([])
  })

  it('preserves the incoming order (listTickets orders by number)', () => {
    const rows = [
      ticket({ id: 't3', sprint_id: 's1', number: 3 }),
      ticket({ id: 't1', sprint_id: 's1', number: 1 }),
    ]
    expect(selectSprintTickets(rows, 's1').map((t) => t.id)).toEqual(['t3', 't1'])
  })

  it('returns an empty list for a sprint with no tickets', () => {
    expect(selectSprintTickets([], 's1')).toEqual([])
  })
})
