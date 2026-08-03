import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TicketSprintField } from './TicketSprintField'
import type { Sprint, Ticket } from '@/lib/domain'

const base: Ticket = {
  id: 't1',
  project_id: 'p1',
  key: 'MP-1',
  number: 1,
  summary: 'Wire the board',
  type: 'story',
  status: 'todo',
  description: null,
  assignee_id: null,
  story_points: null,
  acceptance_criteria: null,
  labels: [],
  sprint_id: null,
  parent_epic_id: null,
  context: null,
  deliverables: [],
  is_blocked: false,
  blocked_reason: null,
  blocked_since: null,
  created_at: '2026-07-15T00:00:00Z',
  updated_at: '2026-07-15T00:00:00Z',
}

const sprints: Sprint[] = [
  {
    id: 's1',
    project_id: 'p1',
    name: 'Hardening push',
    goal: null,
    status: 'active',
    start_date: null,
    end_date: null,
    created_at: '2026-07-15T00:00:00Z',
  },
]

/**
 * SPRIN-82 AC3. This component exists so that ONE file owns the answer to "does this
 * project have sprints at all", and these tests are about that decision — the picker's own
 * behaviour (the backlog entry, the unavailable-value fallback, the disabled-until-loaded
 * rule) is pinned where it always was, in `TicketDetailDialog.test.tsx`, which drives the
 * real sidebar and was NOT edited when the picker moved here. An unedited suite passing is
 * the evidence the extraction changed no behaviour.
 *
 * Every absence assertion below carries its positive control IN THE SAME TEST, by
 * rerendering the identical element with only `hasSprints` flipped. That is deliberate and
 * it is not ceremony: "no sprint picker in the document" is equally true of a component
 * that threw, of a fixture that never rendered, and of a props change that broke the
 * `TicketReferenceSelect` import — all of which would make this suite green while the
 * Kanban rule was doing nothing at all. Flipping one flag on an otherwise byte-identical
 * render is the only shape where the absence can only be caused by the flag.
 */
describe('TicketSprintField', () => {
  it('renders the sprint picker when the project has sprints', () => {
    render(
      <TicketSprintField
        ticket={base}
        sprints={sprints}
        sprintsPhase="loaded"
        commit={vi.fn()}
        hasSprints
      />,
    )

    const picker = screen.getByRole('combobox', { name: 'sprint' })
    expect(picker).toBeInTheDocument()
    // Not merely present: it is the real picker, populated from the sprints handed in, with
    // the domain's word for "no sprint" — so a stub that rendered an empty <select> fails.
    expect(within(picker).getByRole('option', { name: /Hardening push/ })).toBeInTheDocument()
    expect(within(picker).getByRole('option', { name: 'Backlog' })).toBeInTheDocument()
  })

  it('renders nothing when the project has no sprints', () => {
    const props = {
      ticket: base,
      sprints,
      sprintsPhase: 'loaded' as const,
      commit: vi.fn(),
    }

    // The positive control, first and in this same test: with the flag on, this exact
    // element renders the picker.
    const { rerender, container } = render(<TicketSprintField {...props} hasSprints />)
    expect(screen.getByRole('combobox', { name: 'sprint' })).toBeInTheDocument()

    // Only the flag changes.
    rerender(<TicketSprintField {...props} hasSprints={false} />)
    expect(screen.queryByRole('combobox', { name: 'sprint' })).not.toBeInTheDocument()
    // …and nothing at all is left behind: not a stray label, not an empty wrapper that
    // would still take a row of the Details panel's gap-4 stack.
    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('Sprint')).not.toBeInTheDocument()
  })

  it('renders the picker when the flag is omitted entirely', () => {
    // The default is the whole reason the conditional lives in this file: `TicketDetailDialog`
    // is at 10 of 10 cyclomatic and a destructuring default there costs a point (measured),
    // so the prop travels down undefined from any caller that does not set it — every one of
    // the 52 standalone renders in `TicketDetailDialog.test.tsx` included. "Absent means show
    // it" is stated once, here.
    render(
      <TicketSprintField ticket={base} sprints={sprints} sprintsPhase="loaded" commit={vi.fn()} />,
    )

    expect(screen.getByRole('combobox', { name: 'sprint' })).toBeInTheDocument()
  })

  it('commits a sprint change through the picker', async () => {
    // The move carried the wiring, not just the markup: a picker that renders but no longer
    // reaches `commit` would satisfy every assertion above.
    const commit = vi.fn().mockResolvedValue(true)
    render(
      <TicketSprintField ticket={base} sprints={sprints} sprintsPhase="loaded" commit={commit} />,
    )

    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'sprint' }), 's1')

    expect(commit).toHaveBeenCalledWith({ sprint_id: 's1' })
  })

  it('disables the picker until the sprint list has actually loaded', () => {
    // The rule that moved with the code: `sprints` is `[]` while loading AND after a failed
    // read, so an enabled picker over an empty list would offer only "Backlog" and one click
    // would quietly unsprint the ticket.
    const { rerender } = render(
      <TicketSprintField ticket={base} sprints={[]} sprintsPhase="loading" commit={vi.fn()} />,
    )
    expect(screen.getByRole('combobox', { name: 'sprint' })).toBeDisabled()

    rerender(
      <TicketSprintField ticket={base} sprints={sprints} sprintsPhase="loaded" commit={vi.fn()} />,
    )
    expect(screen.getByRole('combobox', { name: 'sprint' })).toBeEnabled()
  })
})
