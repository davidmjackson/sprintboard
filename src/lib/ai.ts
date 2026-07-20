import { supabase } from './supabase'
import { getEnv } from './env'
import type { TicketType } from './domain'

/** A single AI-proposed child work item. `type` is a non-epic ticket type; `rationale`
 *  is display-only in R2.0 (a forward-nod to R2.1 traceability). */
export type DecomposeProposal = {
  title: string
  description: string
  type: Exclude<TicketType, 'epic'>
  rationale: string
}

export type DecomposeResult =
  | { ok: true; proposals: DecomposeProposal[] }
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
    const body = (await resp.json()) as { proposals?: DecomposeProposal[] }
    if (!Array.isArray(body?.proposals)) return { ok: false, error: 'request_failed' }
    return { ok: true, proposals: body.proposals }
  } catch {
    return { ok: false, error: 'request_failed' }
  }
}
