import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TicketDecompositionPanel } from './TicketDecompositionPanel'
import type { DecomposeProposal } from '@/lib/ai'
import type { Decomposition } from '@/lib/ticket-decomposition'

const proposal = (title: string): DecomposeProposal => ({
  title,
  description: 'Do the thing',
  type: 'story',
  rationale: 'Because the epic says so',
  covers: [0],
  estimate: 3,
  estimate_reason: 'One screen, no new tables',
})

/** The panel renders a whole `Decomposition`; every function here is a spy because these
 *  tests are about the JSX wiring, not the hook. `selected` holds index 1 only, so proposal
 *  #1 starts un-ticked and proposal #2 starts ticked — one of each to click. */
function decomposition(overrides: Partial<Decomposition> = {}): Decomposition {
  return {
    proposals: [proposal('Wire the board'), proposal('Ship the API')],
    selected: new Set([1]),
    coverageGaps: [],
    scopeCreep: [],
    estimateTotal: 6,
    toggle: vi.fn(),
    decomposing: false,
    accepting: false,
    aiError: null,
    runDecompose: vi.fn(() => Promise.resolve()),
    acceptSelected: vi.fn(() => Promise.resolve()),
    reset: vi.fn(),
    ...overrides,
  }
}

// The checkbox and the Discard button were the only two pieces of this panel's wiring that
// no test touched: `toggle` and `reset` are covered at the hook level, so a mis-transcribed
// handler here (`!e.target.checked`, or Discard pointing at the wrong function) stayed green.
describe('TicketDecompositionPanel', () => {
  it('toggles a proposal on when ticked and off when un-ticked, by index', async () => {
    const toggle = vi.fn()
    render(
      <TicketDecompositionPanel
        decomposition={decomposition({ toggle })}
        items={['Ship the v2 API']}
      />,
    )

    await userEvent.click(screen.getByRole('checkbox', { name: /wire the board \(#1\)/i }))
    expect(toggle).toHaveBeenCalledWith(0, true)

    await userEvent.click(screen.getByRole('checkbox', { name: /ship the api \(#2\)/i }))
    expect(toggle).toHaveBeenCalledWith(1, false)
  })

  it('resets the whole trace when Discard is clicked', async () => {
    const reset = vi.fn()
    render(
      <TicketDecompositionPanel
        decomposition={decomposition({ reset })}
        items={['Ship the v2 API']}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /discard/i }))
    expect(reset).toHaveBeenCalledTimes(1)
  })
})
