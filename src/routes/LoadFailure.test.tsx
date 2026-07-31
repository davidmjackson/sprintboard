import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { LoadFailure } from './LoadFailure'
import type { LoadFailureResource } from './LoadFailure'
import { firstUnready } from '@/lib/project-reads'
import type { ReadPhase } from '@/lib/project-reads'

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

  it('renders the statuses copy with role="alert"', () => {
    render(<LoadFailure resource="statuses" onRetry={vi.fn()} />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not load statuses.')
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

/**
 * Type-level regression guards for the closed `resource` channel. Same COMPILE-time pattern as
 * `domain.test.ts`'s trigger-owned-columns block, and for the same reason: `@ts-expect-error`
 * fails the build when the error it expects stops happening, so unlike a docblock this cannot
 * rot into a false green. Until SPRIN-76 the control was asserted only in prose, and prose is
 * not a control.
 *
 * What it guards is documented on `LoadFailure` itself: `listTickets`, `listSprints` and
 * `listProjectStatuses` all reject with raw PostgREST text that can name columns, policies or
 * schema internals, and an open `string` channel would render that verbatim into a
 * `role="alert"`.
 *
 * TWO directions, and both are needed because either can be dissolved without the other going
 * red:
 *   - **Widening `LoadFailureResource` towards `string`** stops the negative cases erroring, so
 *     their directives become unnecessary → `TS2578: Unused '@ts-expect-error' directive`.
 *   - **Narrowing `firstUnready`'s `resource` to `string`** — or merely dropping its
 *     `extends string`, which widens `R` to `string` by inference — breaks the POSITIVE case,
 *     which carries no directive and simply has to compile. That is the direction that was
 *     genuinely broken when `BoardTab` became the first consumer, so it is not hypothetical.
 */
describe('the LoadFailure resource channel is closed at compile time', () => {
  it('accepts a resource inferred through firstUnready, unwidened', () => {
    // NO directive, on purpose: this must compile. `firstUnready<R extends string>` infers R as
    // 'tickets' | 'statuses' here and it reaches `LoadFailureResource` intact. Typed `string`,
    // or with the constraint dropped, the assignment below is an error and the build goes red.
    const unready = firstUnready([
      { resource: 'tickets', phase: 'failed' as ReadPhase },
      { resource: 'statuses', phase: 'loading' as ReadPhase },
    ])
    const resource: LoadFailureResource = unready!.resource
    render(<LoadFailure resource={resource} onRetry={vi.fn()} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load tickets.')
  })

  it('rejects a resource outside the union', () => {
    // @ts-expect-error 'projects' is not a LoadFailureResource. Adding one means adding a
    // FAILURE_COPY case, which is exactly the review moment the component's docblock describes.
    const direct: LoadFailureResource = 'projects'

    const unready = firstUnready([{ resource: 'projects', phase: 'failed' as ReadPhase }])
    // @ts-expect-error the same rejection through firstUnready: a non-union literal poisons R
    // rather than being quietly widened to `string` on its way to LoadFailure.
    const inferred: LoadFailureResource = unready!.resource

    expect([direct, inferred]).toEqual(['projects', 'projects'])
  })
})
