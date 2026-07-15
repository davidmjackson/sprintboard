import { supabase } from './supabase'
import type { Ticket, TicketType } from './domain'

/**
 * Create a ticket in a project.
 *
 * The `key` and `number` are assigned by the `assign_ticket_key` BEFORE INSERT
 * trigger, atomically and race-safely — so we never send them (the `TicketInsert`
 * type forbids it). `status` is left to the DB default `'todo'`. `tickets` has no
 * `owner_id`; the `tickets_owner` RLS policy scopes writes through the project, so a
 * cross-tenant insert is rejected by the database, not by this function. A failure is
 * not user-correctable (no per-field unique constraint reachable here), so the error
 * result is a single `'unknown'`.
 */
export type CreateTicketResult = { ok: true; ticket: Ticket } | { ok: false; error: 'unknown' }

export async function createTicket(input: {
  projectId: string
  summary: string
  type: TicketType
  description?: string
  storyPoints?: number
  labels?: string[]
  acceptanceCriteria?: string
}): Promise<CreateTicketResult> {
  const { data, error } = await supabase
    .from('tickets')
    .insert({
      project_id: input.projectId,
      summary: input.summary,
      type: input.type,
      description: input.description ?? null,
      story_points: input.storyPoints ?? null,
      labels: input.labels ?? [],
      acceptance_criteria: input.acceptanceCriteria ?? null,
    })
    .select()
    .single()

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, ticket: data as Ticket }
}

/**
 * The tickets of one project, number-ordered.
 *
 * The `project_id` filter is required, not optional: `tickets_owner` RLS scopes the
 * select to the owner, but the owner has many projects — without the filter this
 * returns every project's tickets.
 */
export async function listTickets(projectId: string): Promise<Ticket[]> {
  const { data, error } = await supabase
    .from('tickets')
    .select()
    .eq('project_id', projectId)
    .order('number', { ascending: true })

  if (error) throw new Error(`Could not load tickets: ${error.message}`)
  return (data ?? []) as Ticket[]
}
