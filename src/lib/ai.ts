import { supabase } from './supabase'
import { getEnv } from './env'
import type { TicketType } from './domain'

/** A single AI-proposed child work item. `covers` is the 0-based indices of the epic's
 *  deliverables this item serves (R2.1 traceability). */
export type DecomposeProposal = {
  title: string
  description: string
  type: Exclude<TicketType, 'epic'>
  rationale: string
  covers: number[]
}

/** A deliverable no proposal covers. */
export type CoverageGap = { index: number; deliverable: string }
/** A proposal tied to no listed deliverable (soft "review scope" signal). */
export type ScopeCreep = { proposal_index: number; title: string }

export type DecomposeResult =
  | {
      ok: true
      proposals: DecomposeProposal[]
      coverage_gaps: CoverageGap[]
      scope_creep: ScopeCreep[]
    }
  | { ok: false; error: 'unauthenticated' | 'request_failed' }

/**
 * Ask the local AI service to decompose an epic. Sends the epic's context/deliverables
 * (already loaded client-side) plus the current Supabase JWT — the service verifies the
 * token and never touches the database. Persistence is the caller's job, via createTicket.
 */
export async function decomposeEpic(epic: {
  summary: string
  context: string
  deliverables: string[]
}): Promise<DecomposeResult> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { ok: false, error: 'unauthenticated' }

  let resp: Response
  try {
    resp = await fetch(`${getEnv().VITE_AI_API_URL}/decompose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ epic }),
    })
  } catch {
    return { ok: false, error: 'request_failed' }
  }

  if (!resp.ok) return { ok: false, error: 'request_failed' }
  try {
    const body = (await resp.json()) as {
      proposals?: DecomposeProposal[]
      coverage_gaps?: CoverageGap[]
      scope_creep?: ScopeCreep[]
    }
    if (!Array.isArray(body?.proposals)) return { ok: false, error: 'request_failed' }
    // Defensive defaults: a forward-compatible service that omitted the trace fields (or
    // a proposal's covers) still decomposes — the panel just shows no trace.
    const proposals = body.proposals.map((p) => ({
      ...p,
      covers: Array.isArray(p?.covers) ? p.covers : [],
    }))
    return {
      ok: true,
      proposals,
      coverage_gaps: Array.isArray(body?.coverage_gaps) ? body.coverage_gaps : [],
      scope_creep: Array.isArray(body?.scope_creep) ? body.scope_creep : [],
    }
  } catch {
    return { ok: false, error: 'request_failed' }
  }
}
