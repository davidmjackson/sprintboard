import { useState } from 'react'

import { decomposeEpic, type CoverageGap, type DecomposeProposal, type ScopeCreep } from './ai'
import { createTicket } from './tickets'
import { parseDeliverables } from './deliverables'
import type { Ticket } from './domain'

/**
 * The Rung 2 AI decomposition trace for one epic — the proposal list, the traceability
 * signals computed against it, and the two async operations that fill and drain it. Kept
 * apart from the components that render it (the ticket detail dialog) so each file stays
 * single-purpose.
 *
 * `ticket` is nullable because the dialog's `if (!ticket) return null` sits AFTER every
 * hook call, and hooks cannot be called conditionally — so both operations guard inside
 * themselves, exactly as they did when they lived in the dialog.
 */

/** The five values that together make up ONE decomposition trace: they are computed by a
 *  single `decomposeEpic` call, against a single snapshot of the epic's deliverables, and
 *  are therefore only ever valid or invalid together. */
export type DecompositionTrace = {
  proposals: DecomposeProposal[] | null
  selected: Set<number>
  coverageGaps: CoverageGap[]
  scopeCreep: ScopeCreep[]
  estimateTotal: number
}

/** The setters behind a `DecompositionTrace`, passed to the module-level async operations
 *  as one bag so each takes a single argument object (`max-params`). */
type TraceSetters = {
  setProposals: (value: DecomposeProposal[] | null) => void
  setSelected: (value: Set<number>) => void
  setCoverageGaps: (value: CoverageGap[]) => void
  setScopeCreep: (value: ScopeCreep[]) => void
  setEstimateTotal: (value: number) => void
}

type TraceState = {
  trace: DecompositionTrace
  set: TraceSetters
  toggle: (index: number, on: boolean) => void
  reset: () => void
}

/** The trace's own state, with the two synchronous operations that own it. Split out from
 *  `useDecomposition` so `reset` sits next to the five setters it is defined in terms of. */
function useDecompositionTrace(): TraceState {
  // AI decomposition (epic only). `proposals === null` is "not decomposed yet" (shows the
  // button); once set, it shows the proposal list until accepted or discarded.
  const [proposals, setProposals] = useState<DecomposeProposal[] | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [coverageGaps, setCoverageGaps] = useState<CoverageGap[]>([])
  const [scopeCreep, setScopeCreep] = useState<ScopeCreep[]>([])
  const [estimateTotal, setEstimateTotal] = useState(0)

  function toggle(index: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (on) next.add(index)
      else next.delete(index)
      return next
    })
  }

  /** Drop the whole decomposition trace in one place. Called on a successful deliverables
   *  write (the write shifts the `covers` indices this was computed against), on accept,
   *  and on Discard — three call sites that previously repeated these five setters, where
   *  forgetting one would leave a chip naming the wrong deliverable. Deliberately does NOT
   *  clear `aiError`: an AI error survives a deliverables write today. */
  function reset() {
    setProposals(null)
    setSelected(new Set())
    setCoverageGaps([])
    setScopeCreep([])
    setEstimateTotal(0)
  }

  const trace = { proposals, selected, coverageGaps, scopeCreep, estimateTotal }
  const set = { setProposals, setSelected, setCoverageGaps, setScopeCreep, setEstimateTotal }
  return { trace, set, toggle, reset }
}

type RunDecomposeArgs = {
  ticket: Ticket | null
  set: TraceSetters
  setDecomposing: (value: boolean) => void
  setAiError: (value: string | null) => void
}

async function runDecomposition({ ticket, set, setDecomposing, setAiError }: RunDecomposeArgs) {
  if (!ticket) return
  setDecomposing(true)
  setAiError(null)
  const result = await decomposeEpic({
    summary: ticket.summary,
    context: ticket.context ?? '',
    deliverables: parseDeliverables(ticket.deliverables),
  })
  setDecomposing(false)
  if (!result.ok) {
    setAiError(
      result.error === 'unauthenticated'
        ? 'Your session expired — sign in again.'
        : 'Could not reach the AI service. Is it running?',
    )
    return
  }
  set.setProposals(result.proposals)
  set.setCoverageGaps(result.coverage_gaps)
  set.setScopeCreep(result.scope_creep)
  set.setEstimateTotal(result.estimate_total)
  set.setSelected(new Set(result.proposals.map((_, i) => i)))
}

/** `reset` is the FUNCTION, not the five setter calls: it must run at continuation time,
 *  after the last create has resolved. */
type AcceptProposalsArgs = {
  ticket: Ticket | null
  trace: DecompositionTrace
  reset: () => void
  setAccepting: (value: boolean) => void
  setAiError: (value: string | null) => void
  onTicketsCreated?: (tickets: Ticket[]) => void
}

async function acceptProposals(args: AcceptProposalsArgs) {
  const { ticket, trace, reset, setAccepting, setAiError, onTicketsCreated } = args
  const { proposals, selected } = trace
  if (!ticket || !proposals) return
  setAccepting(true)
  setAiError(null)
  const created: Ticket[] = []
  for (const [i, p] of proposals.entries()) {
    if (!selected.has(i)) continue
    const result = await createTicket({
      projectId: ticket.project_id,
      summary: p.title,
      type: p.type,
      description: p.description,
      parentEpicId: ticket.id,
      ...(p.estimate != null ? { storyPoints: p.estimate } : {}),
    })
    if (result.ok) created.push(result.ticket)
  }
  setAccepting(false)
  if (created.length > 0) onTicketsCreated?.(created)
  // Always clear the panel after an attempt: a re-click must never re-create a ticket
  // that already succeeded (duplicate writes). Successful children are already on the
  // board via onTicketsCreated; on partial failure the user re-runs decomposition.
  reset()
  if (created.length < selected.size) {
    setAiError(
      'Some tickets could not be created. The ones that succeeded were added to the backlog.',
    )
  }
}

export type Decomposition = DecompositionTrace & {
  toggle: (index: number, on: boolean) => void
  decomposing: boolean
  accepting: boolean
  aiError: string | null
  runDecompose: () => Promise<void>
  acceptSelected: () => Promise<void>
  reset: () => void
}

type UseDecompositionArgs = {
  ticket: Ticket | null
  onTicketsCreated?: (tickets: Ticket[]) => void
}

export function useDecomposition({
  ticket,
  onTicketsCreated,
}: UseDecompositionArgs): Decomposition {
  const { trace, set, toggle, reset } = useDecompositionTrace()
  const [decomposing, setDecomposing] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  function runDecompose() {
    return runDecomposition({ ticket, set, setDecomposing, setAiError })
  }
  function acceptSelected() {
    return acceptProposals({ ticket, trace, reset, setAccepting, setAiError, onTicketsCreated })
  }

  return { ...trace, toggle, reset, decomposing, accepting, aiError, runDecompose, acceptSelected }
}
