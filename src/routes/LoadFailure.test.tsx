import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LoadFailure } from './LoadFailure'

describe('LoadFailure', () => {
  // The copy lives in the component, so these pin the resource→sentence mapping rather than
  // a message the caller passed in. A caller can no longer choose the words — which is the
  // point: a raw PostgREST error string has no route to `role="alert"`.
  it('renders the tickets copy with role="alert"', () => {
    render(<LoadFailure resource="tickets" onRetry={vi.fn()} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not load tickets.')
  })

  it('renders the sprints copy with role="alert"', () => {
    render(<LoadFailure resource="sprints" onRetry={vi.fn()} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not load sprints.')
  })

  it('renders a Retry button', () => {
    render(<LoadFailure resource="tickets" onRetry={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('calls onRetry exactly once when Retry is clicked', async () => {
    const onRetry = vi.fn()
    const user = userEvent.setup()
    render(<LoadFailure resource="tickets" onRetry={onRetry} />)

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
