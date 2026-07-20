import { describe, expect, it } from 'vitest'

import type { Sprint } from './domain'
import { selectActiveSprint } from './board'

/** A sprint with only the field this rule reads. `status` is always stated. */
function sprint(fields: Partial<Sprint> & Pick<Sprint, 'id' | 'status'>): Sprint {
  return { name: 'Sprint', project_id: 'p1', ...fields } as Sprint
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
