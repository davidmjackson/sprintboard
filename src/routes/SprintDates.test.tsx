import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SprintDates } from './SprintDates'
import type { Sprint } from '@/lib/domain'

const sprint = {
  id: 's1',
  status: 'active',
  name: 'Sprint 1',
  project_id: 'p1',
  start_date: null,
  end_date: null,
} as Sprint

describe('SprintDates', () => {
  it('shows both dates, en-dash separated, when both are set', () => {
    render(
      <SprintDates
        sprint={
          {
            ...sprint,
            start_date: '2026-07-20T00:00:00+00:00',
            end_date: '2026-08-03T00:00:00+00:00',
          } as Sprint
        }
      />,
    )
    expect(screen.getByText('2026-07-20 – 2026-08-03')).toBeInTheDocument()
  })

  // Reachable in the real app: `sprint-schemas.ts` makes `startDate` and `endDate`
  // independently optional, so a sprint can have a start with no end.
  it('shows a placeholder for the missing end date when only start is set', () => {
    render(
      <SprintDates
        sprint={{ ...sprint, start_date: '2026-07-20T00:00:00+00:00', end_date: null } as Sprint}
      />,
    )
    expect(screen.getByText('2026-07-20 – —')).toBeInTheDocument()
  })

  // The other direction of the same independently-optional pair.
  it('shows a placeholder for the missing start date when only end is set', () => {
    render(
      <SprintDates
        sprint={{ ...sprint, start_date: null, end_date: '2026-08-03T00:00:00+00:00' } as Sprint}
      />,
    )
    expect(screen.getByText('— – 2026-08-03')).toBeInTheDocument()
  })

  it('shows an honest "No dates set" when neither is set', () => {
    render(<SprintDates sprint={sprint} />)
    expect(screen.getByText('No dates set')).toBeInTheDocument()
  })
})
