import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'

import { CadenceSettings } from './CadenceSettings'

describe('CadenceSettings (SPRIN-94)', () => {
  it('states the cadence under its own heading', () => {
    render(<CadenceSettings cadence={{ sprint_length_weeks: 2, sprint_start_weekday: 1 }} />)

    // Scoped to the section, not a bare getByText: an unscoped query says the text exists
    // somewhere and nothing about where. SPRIN-65's points badge moved outside its button
    // and all twelve of its tests stayed green.
    const section = screen.getByRole('region', { name: /sprint cadence/i })
    expect(within(section).getByText('2 weeks, starting Monday')).toBeInTheDocument()
  })

  it('renders the cadence it is given, not a fixed default', () => {
    render(<CadenceSettings cadence={{ sprint_length_weeks: 1, sprint_start_weekday: 4 }} />)

    const section = screen.getByRole('region', { name: /sprint cadence/i })
    expect(within(section).getByText('1 week, starting Thursday')).toBeInTheDocument()
  })

  it('says the cadence is not editable yet', () => {
    render(<CadenceSettings cadence={{ sprint_length_weeks: 2, sprint_start_weekday: 1 }} />)

    const section = screen.getByRole('region', { name: /sprint cadence/i })
    // Read-only in this story. A button appearing here before SPRIN-97 ships its write
    // path would be a control that cannot work.
    expect(within(section).queryByRole('button')).not.toBeInTheDocument()
  })
})
