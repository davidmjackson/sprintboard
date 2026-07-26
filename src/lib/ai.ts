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
  /** AI story-point estimate on the Scrum scale; null when the service omitted it. */
  estimate: number | null
  /** One-line justification of the size (R2.2). */
  estimate_reason: string
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
      estimate_total: number
    }
  | { ok: false; error: 'unauthenticated' | 'request_failed' }

/** The epic fields the service needs. Already loaded client-side by the caller. */
type EpicInput = { summary: string; context: string; deliverables: string[] }

/** The caller's Supabase JWT, or null when there is no session. */
async function accessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession()
  return data.session?.access_token ?? null
}

/**
 * POST the epic to the service. Null on any transport failure OR a non-2xx status —
 * the caller cannot distinguish them and reports `request_failed` either way.
 */
async function postDecompose(token: string, epic: EpicInput): Promise<Response | null> {
  try {
    const resp = await fetch(`${getEnv().VITE_AI_API_URL}/decompose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ epic }),
    })
    return resp.ok ? resp : null
  } catch {
    return null
  }
}

/**
 * Defensive defaults for one proposal: a forward-compatible service that omitted the
 * trace fields (or a proposal's `covers`) still decomposes — the panel just shows no
 * trace. The server sanitises (dedupes) `covers`, but a malformed or forward service
 * could still send duplicates, which would produce duplicate React keys in the chip
 * list, so dedupe here too.
 */
function normaliseProposal(p: DecomposeProposal): DecomposeProposal {
  return {
    ...p,
    covers: Array.isArray(p?.covers) ? [...new Set(p.covers)] : [],
    estimate: typeof p?.estimate === 'number' ? p.estimate : null,
    estimate_reason: typeof p?.estimate_reason === 'string' ? p.estimate_reason : '',
  }
}

/** Parse a successful response, or null when the body is unusable. */
async function parseDecomposeBody(resp: Response): Promise<DecomposeResult | null> {
  try {
    const body = (await resp.json()) as {
      proposals?: DecomposeProposal[]
      coverage_gaps?: CoverageGap[]
      scope_creep?: ScopeCreep[]
      estimate_total?: number
    }
    // Removing this guard is NOT observable, and that is worth saying so nobody deletes
    // it expecting a red test: a non-array `proposals` would then throw on `.map` and be
    // caught below, producing the identical `request_failed`. Verified by mutation. It
    // stays because reaching the right answer via a deliberate check beats reaching it via
    // an exception — the catch is a backstop for the unforeseen, not the design.
    if (!Array.isArray(body?.proposals)) return null
    return {
      ok: true,
      proposals: body.proposals.map(normaliseProposal),
      coverage_gaps: Array.isArray(body?.coverage_gaps) ? body.coverage_gaps : [],
      scope_creep: Array.isArray(body?.scope_creep) ? body.scope_creep : [],
      estimate_total: typeof body?.estimate_total === 'number' ? body.estimate_total : 0,
    }
  } catch {
    return null
  }
}

/**
 * Ask the local AI service to decompose an epic. Sends the epic's context/deliverables
 * (already loaded client-side) plus the current Supabase JWT — the service verifies the
 * token and never touches the database. Persistence is the caller's job, via createTicket.
 *
 * Three phases, each of which can fail: get a token, post, parse. Only the first is
 * distinguishable to the caller; everything downstream is `request_failed`, deliberately,
 * because the UI has one recovery path for all of it.
 */
export async function decomposeEpic(epic: EpicInput): Promise<DecomposeResult> {
  const token = await accessToken()
  if (!token) return { ok: false, error: 'unauthenticated' }

  const resp = await postDecompose(token, epic)
  if (!resp) return { ok: false, error: 'request_failed' }

  return (await parseDecomposeBody(resp)) ?? { ok: false, error: 'request_failed' }
}
