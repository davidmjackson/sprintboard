import { describe, expect, it } from 'vitest'

import type { Project, ProjectStatus, ProjectType, Sprint, Ticket } from './domain'
import {
  isBoardFiltered,
  selectActiveSprint,
  selectBlockedTickets,
  selectBoardScope,
  selectColumnLimit,
  summariseColumn,
} from './board'

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

/** A project with only the field the board rule reads. */
function project(project_type: ProjectType): Pick<Project, 'project_type'> {
  return { project_type }
}

/** A status with only the field this rule reads. `wip_limit` is always stated. */
function status(wip_limit: number | null): Pick<ProjectStatus, 'wip_limit'> {
  return { wip_limit }
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

describe('selectBoardScope', () => {
  const active = sprint({ id: 's-active', status: 'active' })
  const inSprint = ticket({ id: 't1', is_blocked: false, sprint_id: 's-active' })
  const unsprinted = ticket({ id: 't2', is_blocked: false, sprint_id: null })

  describe('a project with sprints (Scrum)', () => {
    it("shows the active sprint's tickets and describes that sprint", () => {
      const scope = selectBoardScope(project('scrum'), [inSprint, unsprinted], [active])
      expect(scope.sprintScoped).toBe(true)
      expect(scope.sprint?.id).toBe('s-active')
      expect(scope.tickets.map((t) => t.id)).toEqual(['t1'])
      expect(scope.offersFilters).toBe(true)
    })

    // The board has nothing to show and nothing to filter until a sprint starts. This is
    // today's behaviour and the whole of AC5's second half.
    it('shows no tickets and offers no filters when no sprint is active', () => {
      const future = sprint({ id: 's-future', status: 'future' })
      const scope = selectBoardScope(project('scrum'), [inSprint, unsprinted], [future])
      expect(scope.sprint).toBeNull()
      expect(scope.tickets).toEqual([])
      expect(scope.offersFilters).toBe(false)
    })
  })

  describe('a project without sprints (Kanban)', () => {
    // AC1. `inSprint` carries a real sprint id and MUST still appear: the whole defect this
    // story fixes is a board that filtered it away.
    it('shows every ticket regardless of sprint_id', () => {
      const scope = selectBoardScope(project('kanban'), [inSprint, unsprinted], [])
      expect(scope.sprintScoped).toBe(false)
      expect(scope.tickets.map((t) => t.id)).toEqual(['t1', 't2'])
    })

    // AC3. Filters are offered unconditionally — there is no sprint to wait for.
    it('offers filters even with no sprints at all', () => {
      expect(selectBoardScope(project('kanban'), [], []).offersFilters).toBe(true)
    })

    // AC2, at the selector. A board whose users cannot see sprints must not describe one.
    // Unreachable today (project_type is immutable, and SPRIN-82 removed the create path),
    // so this pins the rule rather than defending against a live state.
    it('describes no sprint even when an active sprint row exists', () => {
      const scope = selectBoardScope(project('kanban'), [inSprint], [active])
      expect(scope.sprint).toBeNull()
      expect(scope.tickets.map((t) => t.id)).toEqual(['t1'])
    })
  })

  // Filtering only: the order `listTickets` returned is the order the columns render in.
  it('preserves the given ticket order and copies rather than aliases', () => {
    const input = [unsprinted, inSprint]
    const scope = selectBoardScope(project('kanban'), input, [])
    expect(scope.tickets.map((t) => t.id)).toEqual(['t2', 't1'])
    expect(scope.tickets).not.toBe(input)
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

describe('summariseColumn', () => {
  it('returns zeroes for an empty column', () => {
    expect(summariseColumn([])).toEqual({ count: 0, points: 0, unestimated: 0 })
  })

  it('counts the tickets and sums their points', () => {
    const column = [
      ticket({ id: 't1', is_blocked: false, story_points: 3 }),
      ticket({ id: 't2', is_blocked: false, story_points: 5 }),
    ]
    expect(summariseColumn(column)).toEqual({ count: 2, points: 8, unestimated: 0 })
  })

  it('treats a null estimate as 0 points and tallies it as unestimated', () => {
    const column = [
      ticket({ id: 't1', is_blocked: false, story_points: 3 }),
      ticket({ id: 't2', is_blocked: false, story_points: null }),
      ticket({ id: 't3', is_blocked: false, story_points: null }),
    ]
    expect(summariseColumn(column)).toEqual({ count: 3, points: 3, unestimated: 2 })
  })

  // The one that matters: 0 is a real estimate. A falsy check would count this
  // ticket as unestimated, which on a Scrum board is a different claim entirely.
  it('treats a 0-point ticket as ESTIMATED, contributing 0', () => {
    const column = [
      ticket({ id: 't1', is_blocked: false, story_points: 0 }),
      ticket({ id: 't2', is_blocked: false, story_points: 2 }),
    ]
    expect(summariseColumn(column)).toEqual({ count: 2, points: 2, unestimated: 0 })
  })
})

describe('isBoardFiltered', () => {
  it('is false when neither filter is on', () => {
    expect(isBoardFiltered(false, '')).toBe(false)
  })

  it('is true under the blocked-only filter alone', () => {
    expect(isBoardFiltered(true, '')).toBe(true)
  })

  it('is true under a search query alone', () => {
    expect(isBoardFiltered(false, 'MP-1')).toBe(true)
  })

  // Whitespace is not a query — `isSearchActive` trims, and this rule must not second-guess
  // it. A board showing everything must not claim to be filtered.
  it('is false when the query is only whitespace', () => {
    expect(isBoardFiltered(false, '   ')).toBe(false)
  })

  it('is true when both filters are on', () => {
    expect(isBoardFiltered(true, 'MP-1')).toBe(true)
  })
})

describe('selectColumnLimit', () => {
  it('gives a kanban column its limit when nothing is filtered', () => {
    expect(selectColumnLimit(project('kanban'), status(3), false)).toBe(3)
  })

  it('gives null when the status has no limit', () => {
    expect(selectColumnLimit(project('kanban'), status(null), false)).toBeNull()
  })

  /**
   * The gate that makes SPRIN-86 AC5 true. A CHECK body may not contain a subquery, so the
   * database WILL store a `wip_limit` on a Scrum project's status row (SPRIN-85 §3.4) — the
   * row below is one the database can really hold, not an impossible one. The project type is
   * the only thing keeping that value inert.
   */
  it('gives null on a scrum project even when the row carries a limit', () => {
    expect(selectColumnLimit(project('scrum'), status(3), false)).toBeNull()
  })

  /**
   * SPRIN-86 §5.1. The column summary describes the cards on screen; under a filter it is
   * showing fewer cards than the column holds, so it makes no WIP claim at all rather than an
   * understated one.
   */
  it('gives null while the board is filtered, limit or no limit', () => {
    expect(selectColumnLimit(project('kanban'), status(3), true)).toBeNull()
  })
})
