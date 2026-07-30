import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'

/** Crash copy, keyed by a CLOSED union — same shape and same reason as `LoadFailure`'s
 *  `FAILURE_COPY`. Adding a scope means adding a case here, which is the review moment
 *  we want. Kept above the docblock below so that block anchors to `CrashFallback`. */
const CRASH_COPY: Record<'app' | 'tab', string> = {
  app: 'Something went wrong.',
  tab: 'Something went wrong displaying this view.',
}

/** The action button's label, keyed by the same closed union as `CRASH_COPY` — kept as a
 *  neighbouring `Record` rather than folded into it, so the two concerns (what happened,
 *  what the button does) stay independently editable. `app`'s `onRetry` is a full page
 *  reload (see `App.tsx`), not a subtree re-render, so its label says so; `tab`'s `onRetry`
 *  really does re-render the subtree in place, so "Try again" still fits there. */
const ACTION_COPY: Record<'app' | 'tab', string> = {
  app: 'Reload page',
  tab: 'Try again',
}

/**
 * What a contained crash looks like. Deliberately takes a `scope`, NOT a message — it has
 * no way to receive the error, because `ErrorBoundary` never puts one in state. See that
 * component's docblock for why that is a security decision rather than a stylistic one.
 *
 * `role="alert"` sits on the message, not the wrapper, so a screen reader announces the
 * sentence and nothing else in the block. Mirrors `LoadFailure`.
 */
export function CrashFallback({ scope, onRetry }: { scope: 'app' | 'tab'; onRetry: () => void }) {
  return (
    <div className="border-destructive/50 flex min-h-40 flex-col items-center justify-center gap-3 rounded-lg border border-dashed">
      <p role="alert" className="text-destructive text-sm">
        {CRASH_COPY[scope]}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {ACTION_COPY[scope]}
      </Button>
    </div>
  )
}

type Props = { children: ReactNode; fallback: (reset: () => void) => ReactNode }
type State = { crashed: boolean }

/**
 * Catches a render throw in its subtree and swaps in `fallback` instead of letting React
 * unmount the whole tree. A class component because React has no hook equivalent.
 *
 * **State holds a boolean, never the error, and `fallback` receives only `reset`.** That is
 * load-bearing: `listTickets`/`listSprints` reject with `Could not load tickets:
 * ${error.message}` — raw PostgREST text that can name columns, policies or schema
 * internals. Passing the error to `fallback` would reopen the channel `LoadFailure` closed
 * by refusing a `message: string` prop, and `<CrashFallback message={err.message} />` would
 * compile clean. With no error in state there is nothing to render. Do not "improve" this by
 * surfacing the message.
 *
 * Catches **render** errors only — not event handlers, effects, or promise rejections.
 * That covers the case this was built for (`formatSprintDate` throws during render) and is
 * not a general safety net.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { crashed: false }

  // Takes no parameter: React calls this with the thrown error, but the signature
  // deliberately does not accept it, so there is nowhere to put it even by accident.
  static getDerivedStateFromError(): State {
    return { crashed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Render error contained by an ErrorBoundary:', error, info.componentStack)
  }

  render() {
    if (this.state.crashed) {
      return this.props.fallback(() => this.setState({ crashed: false }))
    }
    return this.props.children
  }
}
