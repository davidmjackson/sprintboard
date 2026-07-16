import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LoadFailure } from './LoadFailure'

describe('LoadFailure', () => {
  it('renders the given message with role="alert"', () => {
    render(<LoadFailure message="Could not load tickets." onRetry={vi.fn()} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not load tickets.')
  })

  it('renders a Retry button', () => {
    render(<LoadFailure message="Could not load tickets." onRetry={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('calls onRetry exactly once when Retry is clicked', async () => {
    const onRetry = vi.fn()
    const user = userEvent.setup()
    render(<LoadFailure message="Could not load tickets." onRetry={onRetry} />)

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
