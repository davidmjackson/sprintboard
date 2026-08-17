import { supabase } from './supabase'
import type { Ticket, TicketBlockUpdate, TicketInsert, TicketType, TicketUpdate } from './domain'
import type { TablesInsert } from './database.types'

/**
 * THE ONE PLACE in the repo that bridges `TicketInsert` (where `status` is optional,
 * because `resolve_initial_ticket_status()` fills it when the caller omits it — see
 * `TicketInsert`'s docblock in `domain.ts`) and the generated `TablesInsert<'tickets'>`
 * (where `status` is required, because SPRIN-80 dropped the column's `DEFAULT` and a
 * generated type cannot see a trigger). `.insert()` is typed off the generated
 * `Database`, so a `satisfies TicketInsert` on the argument does not help — the error is
 * on the argument itself, not on some intermediate value.
 *
 * A cast is unavoidable here; the design goal is that there is exactly ONE of them,
 * named and easy to find, rather than one scattered `as never` per call site — each of
 * which would silently swallow a future, real type error the same way this one does.
 * Every `tickets` insert in this file and in the integration suites routes through this
 * function for that reason, even the ones that do send `status`.
 */
export function ticketInsertPayload(input: TicketInsert): TablesInsert<'tickets'> {
  return input as TablesInsert<'tickets'>
}

/**
 * Create a ticket in a project.
 *
 * The `key` and `number` are assigned by the `assign_ticket_key` BEFORE INSERT
 * trigger, atomically and race-safely — so we never send them (the `TicketInsert`
 * type forbids it). `status` is omitted here too, so `resolve_initial_ticket_status()`
 * fills it from the project's initial `project_statuses` row — needing no code change
 * now that statuses are per-project rows: the trigger resolves against this project's
 * rows through the composite `tickets_status_fk` rather than against a global check
 * constraint. That is the whole point of keying the fk on the slug — no ticket row, and
 * no insert path, had to change. `tickets` has no `owner_id`; the `tickets_owner` RLS
 * policy scopes writes through the caller's MEMBERSHIP of the project (SPRIN-100), so a
 * cross-tenant insert is rejected by the database, not by this function. A failure is not
 * user-correctable (no per-field unique constraint reachable here), so the error result is
 * a single `'unknown'`. `parentEpicId`
 * is optional and set when a ticket is created under an epic; the composite fk
 * `tickets_epic_fk` keeps the parent in the same project, which holds because the caller
 * passes the epic's own project id.
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
  parentEpicId?: string
}): Promise<CreateTicketResult> {
  // `ticketInsertPayload`'s parameter type binds the write to the guard type (Omit
  // key/number, optional status), so a future edit that adds `key` or `number` here
  // fails to compile at the call site — making the "unrepresentable from the client"
  // guarantee structural, not just a doc.
  const { data, error } = await supabase
    .from('tickets')
    .insert(
      ticketInsertPayload({
        project_id: input.projectId,
        summary: input.summary,
        type: input.type,
        description: input.description ?? null,
        story_points: input.storyPoints ?? null,
        labels: input.labels ?? [],
        acceptance_criteria: input.acceptanceCriteria ?? null,
        parent_epic_id: input.parentEpicId ?? null,
      }),
    )
    .select()
    .single()

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, ticket: data as Ticket }
}

/**
 * The tickets of one project, number-ordered.
 *
 * The `project_id` filter is required, not optional: `tickets_owner` RLS scopes the select
 * to the caller's project memberships, but a caller belongs to many projects — without the
 * filter this returns every one of their projects' tickets. SPRIN-100 made that set
 * strictly wider (membership, not ownership), so the filter matters more than it used to.
 *
 * This throws rather than resolving to `[]` on error, and that is load-bearing: `[]` is
 * indistinguishable from "this project has no tickets", so a caller handed one cannot tell a
 * failed read from an empty one. That is not hypothetical — it is exactly the defect S4.6
 * removed, where a paused database rendered as "Nothing in the backlog." Only a rejection
 * carries the fact of failure; `ProjectShell`'s `.catch()` turns it into `phase: 'failed'`.
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

/**
 * Update a ticket's editable fields. `key`, `number`, `id`, `project_id` and the
 * timestamps are excluded by `TicketUpdate`, so the immutable and trigger-owned columns
 * cannot be sent. `updated_at` is refreshed by the `tickets_set_updated_at` trigger, so
 * the returned row carries the new timestamp. RLS (`tickets_owner`) scopes the write
 * through a project the caller is a MEMBER of: a cross-tenant update matches zero rows,
 * `.single()` then errors, and we report the single non-user-correctable `'unknown'`.
 */
export type UpdateTicketResult = { ok: true; ticket: Ticket } | { ok: false; error: 'unknown' }

export async function updateTicket(id: string, patch: TicketUpdate): Promise<UpdateTicketResult> {
  const { data, error } = await supabase
    .from('tickets')
    .update(patch)
    .eq('id', id)
    .select()
    .single()

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, ticket: data as Ticket }
}

/**
 * Delete a ticket by id. RLS (`tickets_owner`, `FOR ALL`) scopes the delete through a
 * project the caller is a MEMBER of, so a cross-tenant delete matches ZERO rows rather
 * than raising. We
 * `.select()` the deleted rows and treat an empty result set as a failure — a delete that
 * removed nothing is not a success. Deleting a parent epic nulls its children's
 * `parent_epic_id` (the `tickets_epic_fk` `on delete set null`), and `project_counters` is
 * untouched, so ticket numbers are never reused. A failure is not user-correctable here.
 */
export type DeleteTicketResult = { ok: true } | { ok: false; error: 'unknown' }

export async function deleteTicket(id: string): Promise<DeleteTicketResult> {
  const { data, error } = await supabase.from('tickets').delete().eq('id', id).select()

  if (error) return { ok: false, error: 'unknown' }
  if (!data || data.length === 0) return { ok: false, error: 'unknown' }
  return { ok: true }
}

export const BLOCK_REASON_MAX = 500

/**
 * The app-layer "a reason is required to block" rule (S4.4 AC), and the single
 * client-side validator for a block reason. The database backstops the *required* half
 * via `tickets_blocked_coherent` — a block with a null reason raises `23514` — but a
 * check constraint has no message, so this is where the user-facing rule and the max
 * length live. Returns the TRIMMED reason on success (leading/trailing space is not a
 * reason). Both edges are covered per CLAUDE.md; the max is client-only (no DB length
 * check on `blocked_reason`, mirroring `summary`).
 */
export type BlockReasonResult = { ok: true; value: string } | { ok: false; message: string }

export function parseBlockReason(raw: string): BlockReasonResult {
  const trimmed = raw.trim()
  if (trimmed.length < 1) return { ok: false, message: 'A reason is required to block a ticket' }
  if (trimmed.length > BLOCK_REASON_MAX)
    return { ok: false, message: `Keep the reason to ${BLOCK_REASON_MAX} characters or fewer` }
  return { ok: true, value: trimmed }
}

/**
 * Block a ticket, requiring a reason. Sends only `{ is_blocked: true, blocked_reason }`
 * (a `TicketBlockUpdate`); the `sync_blocked_fields` trigger stamps `blocked_since`, so
 * the reconciled row we return carries the server timestamp — never guess it client-side.
 * The reason is validated here first: an invalid one never reaches the database and is
 * reported as `invalid_reason` with a message. RLS (`tickets_owner`) scopes the write
 * through a project the caller is a MEMBER of, so a cross-tenant block matches zero rows,
 * `.single()` then errors, and we report `'unknown'`. Blocking does NOT change `status`: a
 * blocked ticket stays in its board column (S4.4 AC), it is a flag, never a column.
 */
export type BlockTicketResult =
  | { ok: true; ticket: Ticket }
  | { ok: false; error: 'invalid_reason'; message: string }
  | { ok: false; error: 'unknown' }

export async function blockTicket(id: string, reason: string): Promise<BlockTicketResult> {
  const parsed = parseBlockReason(reason)
  if (!parsed.ok) return { ok: false, error: 'invalid_reason', message: parsed.message }

  const { data, error } = await supabase
    .from('tickets')
    .update({ is_blocked: true, blocked_reason: parsed.value } satisfies TicketBlockUpdate)
    .eq('id', id)
    .select()
    .single()

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, ticket: data as Ticket }
}

/**
 * Unblock a ticket. Sends only `{ is_blocked: false }`; the `sync_blocked_fields` trigger
 * clears both `blocked_reason` and `blocked_since` (S4.4 AC), keeping the three fields
 * coherent — so we never send the nulls ourselves. Same RLS scoping and `'unknown'`
 * mapping as `blockTicket`.
 */
export type UnblockTicketResult = { ok: true; ticket: Ticket } | { ok: false; error: 'unknown' }

export async function unblockTicket(id: string): Promise<UnblockTicketResult> {
  const { data, error } = await supabase
    .from('tickets')
    .update({ is_blocked: false } satisfies TicketBlockUpdate)
    .eq('id', id)
    .select()
    .single()

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, ticket: data as Ticket }
}

/** Same rule as `CreateTicketDialog`'s zod schema (`^\d{0,3}$`, "Whole numbers only") —
 *  the edit path has no `<form>`/zod, so it re-validates the same shape by hand. Empty
 *  means "no estimate" (→ null); a non-negative whole number of up to 3 digits (→
 *  Number); anything else (negative, decimal, non-numeric) is rejected. */
export function parseStoryPoints(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim()
  if (trimmed === '') return { ok: true, value: null }
  if (!/^\d{0,3}$/.test(trimmed)) return { ok: false }
  return { ok: true, value: Number(trimmed) }
}

/** Same rule as `CreateTicketDialog`'s zod schema for `summary`
 *  (`.trim().min(1).max(200)`) — the edit path has no `<form>`/zod, so it re-validates
 *  the same shape by hand. `summary text not null` accepts `''`, so without this a
 *  cleared or whitespace-only summary would persist and produce an untitled row.
 *  Returns the TRIMMED value on success. */
export function parseSummary(
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const trimmed = raw.trim()
  if (trimmed.length < 1) return { ok: false, message: 'Summary is required' }
  if (trimmed.length > 200)
    return { ok: false, message: 'Keep the summary to 200 characters or fewer' }
  return { ok: true, value: trimmed }
}
