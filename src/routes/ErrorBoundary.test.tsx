import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CrashFallback, ErrorBoundary } from './ErrorBoundary'

// A string no copy in this app would ever contain, standing in for the raw PostgREST
// text a rejection can carry ("... violates row-level security policy for table ...").
const CANARY = 'canary-rls-policy-detail'

function Boom({ throws }: { throws: boolean }) {
  if (throws) throw new Error(CANARY)
  return <p>child content</p>
}

function renderBoundary(throws: boolean) {
  return render(
    <ErrorBoundary fallback={(reset) => <CrashFallback scope="tab" onRetry={reset} />}>
      <Boom throws={throws} />
    </ErrorBoundary>,
  )
}

// React itself logs every caught error via console.error, so this spy is required to keep
// the run readable — and it is also how the AC6 assertion reads our own call.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('ErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    renderBoundary(false)
    expect(screen.getByText('child content')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('replaces the children with the fallback when a child throws', () => {
    renderBoundary(true)
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Something went wrong displaying this view.',
    )
    expect(screen.queryByText('child content')).not.toBeInTheDocument()
  })

  it('never renders the thrown error text', () => {
    renderBoundary(true)
    expect(screen.queryByText(new RegExp(CANARY))).not.toBeInTheDocument()
    expect(document.body.textContent).not.toContain(CANARY)
  })

  it('reports the caught error to the console', () => {
    renderBoundary(true)
    const reported = vi
      .mocked(console.error)
      .mock.calls.some((args) => String(args[0]).includes('contained by an ErrorBoundary'))
    expect(reported).toBe(true)
  })

  it('restores the children when Try again is clicked and the child no longer throws', async () => {
    const user = userEvent.setup()
    let throws = true
    function Flaky() {
      if (throws) throw new Error(CANARY)
      return <p>child content</p>
    }
    render(
      <ErrorBoundary fallback={(reset) => <CrashFallback scope="tab" onRetry={reset} />}>
        <Flaky />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()

    throws = false
    await user.click(screen.getByRole('button', { name: 'Try again' }))

    expect(screen.getByText('child content')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('uses the app-scope copy for the app scope', () => {
    render(<CrashFallback scope="app" onRetry={vi.fn()} />)
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong.')
  })
})
