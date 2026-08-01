import { supabase } from './supabase'
import { toUtcMidnight } from './sprint-dates'
import type {
  Sprint,
  SprintCreateInsert,
  SprintStatus,
  SprintStatusUpdate,
  Ticket,
  TicketUpdate,
} from './domain'

/**
 * The default name for a sprint created with the name left blank: `Sprint N`, where N is
 * the project's existing sprint count + 1.
 *
 * S6.1's AC asks for an **optional** name, but `sprints.name` is `not null` with no
 * default — so "optional" has to mean the app names it, not that the column is nullable.
 *
 * Count-based numbering is safe here and is NOT the ticket-key pattern. A ticket key is an
 * identifier, which is why `assign_ticket_key` is an atomic trigger and why keys are never
 * generated with `count(*)`. A sprint name is a **label**: `sprints` has no unique
 * constraint on it, so a race or a delete-then-create can yield two `Sprint 3`. That is
 * cosmetic and never corrupting.
 */
export function defaultSprintName(existing: readonly Sprint[]): string {
  return `Sprint ${existing.length + 1}`
}

/**
 * Create a sprint in a project.
 *
 * `status` is never sent: the column defaults to `'future'`, which is exactly S6.1's AC —
 * so the AC is satisfied by the database, not by the client. `sprints` has no `owner_id`;
 * the `sprints_owner` RLS policy scopes writes through the project, so a cross-tenant
 * insert is rejected by the database, not by this function. A failure is not
 * user-correctable (no unique constraint is reachable here — duplicate names are legal),
 * so the error result is a single `'unknown'`.
 */
export type CreateSprintResult = { ok: true; sprint: Sprint } | { ok: false; error: 'unknown' }

export async function createSprint(input: {
  projectId: string
  /** Blank or whitespace-only means "name it for me" — see `defaultSprintName`. */
  name?: string
  goal?: string
  /** An `<input type="date">` value, `'YYYY-MM-DD'`. Pinned to midnight UTC on write. */
  startDate?: string
  endDate?: string
  /** The project's sprints, for auto-naming. Empty when the list has not loaded. */
  existing?: readonly Sprint[]
}): Promise<CreateSprintResult> {
  const name = input.name?.trim() || defaultSprintName(input.existing ?? [])

  // `satisfies SprintCreateInsert` binds the write to the guard type (Omit status), so a
  // future edit that adds `status` here fails to compile at the call site — making the
  // "the database owns status" guarantee structural, not just a doc comment.
  const { data, error } = await supabase
    .from('sprints')
    .insert({
      project_id: input.projectId,
      name,
      goal: input.goal?.trim() || null,
      start_date: input.startDate ? toUtcMidnight(input.startDate) : null,
      end_date: input.endDate ? toUtcMidnight(input.endDate) : null,
    } satisfies SprintCreateInsert)
    .select()
    .single()

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, sprint: data as Sprint }
}

/**
 * The sprints of one project, newest first.
 *
 * The `project_id` filter is required, not optional: `sprints_owner` RLS scopes the select
 * to the owner, but the owner has many projects — without the filter this returns every
 * project's sprints. Same reasoning as `listTickets`.
 *
 * This throws rather than resolving to `[]` on error, and that is the load-bearing part: `[]`
 * is indistinguishable from "this project has no sprints", so a caller handed one could not
 * tell a failed read from an empty one and would render "No sprints yet." over a database it
 * never reached. Only a rejection carries that fact — `ProjectShell`'s `.catch()` turns it
 * into `phase: 'failed'`. Resolving to `[]` here would silently delete the failed state.
 */
export async function listSprints(projectId: string): Promise<Sprint[]> {
  const { data, error } = await supabase
    .from('sprints')
    .select()
    .eq('project_id', projectId)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Could not load sprints: ${error.message}`)
  return (data ?? []) as Sprint[]
}

/**
 * A transition's precondition check. `stale` means the sprint exists and is in a DIFFERENT
 * status than the transition requires — the caller's view is out of date. `unknown` covers a
 * failed read and a zero-row match alike, and that conflation is deliberate: RLS makes
 * "deleted" and "another owner's" indistinguishable, and they must stay so. Returning `stale`
 * for a row we cannot see would turn this guard into an existence oracle.
 */
type SprintStatusGuard = { ok: true } | { ok: false; error: 'stale' | 'unknown' }

/**
 * Read a sprint's CURRENT status and check it against a transition's precondition.
 *
 * Why a read rather than only a filter on the update: `completeSprint` writes TWICE and the
 * destructive write (returning tickets to the backlog) comes FIRST, so a filter on its status
 * flip would fire only after the tickets had already moved. The gate has to precede the first
 * write. `startSprint` uses the same helper for the same error vocabulary — and because only a
 * read can tell `stale` from `unknown` honestly. These are click-driven actions, so the extra
 * round trip costs nothing that matters.
 *
 * This is NOT a general-purpose sprint read and is deliberately unexported: it returns a
 * verdict, not a sprint.
 */
async function requireSprintStatus(id: string, expected: SprintStatus): Promise<SprintStatusGuard> {
  const { data, error } = await supabase.from('sprints').select('status').eq('id', id).single()

  if (error || !data) return { ok: false, error: 'unknown' }
  return data.status === expected ? { ok: true } : { ok: false, error: 'stale' }
}

/**
 * Start a sprint: flip its status to `active`. The one-active-per-project rule is enforced
 * by the `sprints_one_active_per_project` partial unique index, NOT by this function — we
 * attempt the update and let the database reject a second active sprint. We never deactivate
 * another sprint to make room: that would work around the index (CLAUDE.md forbids it) and
 * silently end a running sprint.
 *
 * A sprint can only be started from `future`. `requireSprintStatus` is the gate; the
 * `status = 'future'` filter on the update is a compare-and-swap that closes the window
 * between the read and the write. A lost race there surfaces as `unknown` rather than
 * `stale` — the filter's job is to prevent the wrong write, not to produce a nice message,
 * and a retry hits the guard and reports `stale` correctly.
 *
 * Unlike `createSprint`, this has a user-correctable failure. A `23505` (unique_violation)
 * is the index rejecting a second active sprint — the user can finish the current one and
 * retry — so it gets its own tag and a clear message at the UI. Everything else (an RLS
 * zero-row match on a cross-tenant or missing id, a network error) is not user-correctable
 * and collapses to `'unknown'`. RLS (`sprints_owner`) scopes the write through the owned
 * project, exactly as in the browser.
 */
export type StartSprintResult =
  | { ok: true; sprint: Sprint }
  | { ok: false; error: 'already_active' }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'unknown' }

export async function startSprint(id: string): Promise<StartSprintResult> {
  const guard = await requireSprintStatus(id, 'future')
  if (!guard.ok) return guard

  const { data, error } = await supabase
    .from('sprints')
    .update({ status: 'active' } satisfies SprintStatusUpdate)
    .eq('id', id)
    .eq('status', 'future')
    .select()
    .single()

  if (error) {
    if (error.code === '23505') return { ok: false, error: 'already_active' }
    return { ok: false, error: 'unknown' }
  }
  return { ok: true, sprint: data as Sprint }
}

/**
 * Complete a sprint: return its incomplete tickets to the backlog, then flip its status to
 * `complete`. This touches TWO tables and PostgREST gives the browser no cross-statement
 * transaction, so the two writes are sequenced deliberately.
 *
 * The ORDER is load-bearing. The ticket move runs first and the status flip runs LAST, so
 * the flip is the commit marker: a sprint that reads `complete` is never one whose incomplete
 * tickets are still attached. If the move succeeds and the flip fails, the sprint stays
 * `active` with its incomplete tickets already in the backlog — a visible, self-correcting
 * state (the user sees the error and retries; the move is idempotent, and Done tickets never
 * matched). Flipping first would fail unsafe: a `complete` sprint with tickets still attached,
 * silently violating "incomplete tickets return to the backlog".
 *
 * "Incomplete" means "not on one of this project's TERMINAL statuses", and as of SPRIN-77 that
 * is a CATEGORY question rather than the literal slug `'done'`. The caller supplies the answer
 * as `terminalSlugs`, derived once by `doneSlugs` in `project-statuses.ts` — the same single
 * derivation the shell's optimistic reducer uses, because this function's correctness argument
 * is that the database's rule and the client's local patch are THE SAME RULE. Before SPRIN-77
 * both sites hardcoded `'done'`, which was only true while the vocabulary was immutable: a
 * user-added terminal status would have had its tickets dragged back to the backlog here.
 *
 * Terminal tickets keep their `sprint_id` (that retained id IS the sprint history AC3 asks
 * for, and is why S5.1's `sprint_id is null` backlog rule excludes them) and their status (we
 * never touch them). The bulk UPDATE is atomic across all matching rows and returns them via
 * `.select()` for the UI's local patch — these are the database's own post-update rows, not a
 * guess.
 *
 * An EMPTY set is a real state, not an error: a project with no done-category status has
 * nothing terminal, so every ticket is incomplete and every one returns to the backlog. `in ()`
 * is malformed SQL, so the filter is OMITTED entirely in that case — which produces exactly
 * that behaviour, rather than an error the user cannot act on.
 *
 * The raw join into the `in` list is safe because `project_statuses_slug_format` constrains
 * every slug to `^[a-z][a-z0-9_]{0,29}$`: there is no comma, paren or quote in a slug to
 * escape. The CHECK constraint is what makes this safe, not the caller's good manners — and
 * the slugs originate from database rows, never from user text.
 *
 * A sprint can only be completed from `active`, and the gate has to precede the ticket move:
 * `requireSprintStatus` runs FIRST so a `future` or already-`complete` sprint is rejected
 * having moved nothing. A re-complete used to be silently legal and is now `stale` — a
 * user-correctable failure, so it gets its own tag and its own message. The
 * `status = 'active'` filter on the flip is a compare-and-swap for the window between the
 * read and the write; a lost race there is `unknown` and self-corrects on retry.
 *
 * RLS (`sprints_owner` / `tickets_owner`) scopes both writes through the owned project, but for
 * a cross-tenant caller neither write is what stops the mutation: `requireSprintStatus`'s
 * precondition read is RLS-scoped too, so a cross-tenant id matches zero rows there and the
 * function returns `'unknown'` before either write runs. (Before this guard existed, the bulk
 * update was the thing that actually protected a cross-tenant sprint — it filtered to zero rows
 * and returned NO error, since an UPDATE matching nothing is not an error. That mechanism is
 * gone now: the guard is the gate, not a redundant belt-and-braces on top of it.) Never leaking
 * existence and never mutating another owner's sprint holds exactly as before — RLS still
 * scopes both writes underneath, in case anything upstream of this function ever calls them
 * directly.
 *
 * This safety depends on `sprints_owner` being a single `for all` policy: the same predicate
 * governs the guard's `select` and both writes, so "can read this sprint's status" and "can
 * write it" are the same fact today. Rung 3's membership model (CLAUDE.md's forward-compat
 * rules) could break that equivalence — e.g. a member who can `select` a sprint but not
 * `update` it would pass this guard and reach the ticket move first. RLS would still filter
 * that `update` to zero rows, so this stays defence-in-depth rather than an actual hole, but
 * whoever writes that migration needs to know the guard currently assumes read and write are
 * co-extensive, and should re-check this function once they aren't.
 */
export type CompleteSprintResult =
  | { ok: true; sprint: Sprint; returnedTickets: Ticket[] }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'unknown' }

export async function completeSprint(
  id: string,
  terminalSlugs: ReadonlySet<string>,
): Promise<CompleteSprintResult> {
  const guard = await requireSprintStatus(id, 'active')
  if (!guard.ok) return guard

  const move = supabase
    .from('tickets')
    .update({ sprint_id: null } satisfies TicketUpdate)
    .eq('sprint_id', id)
  const incomplete =
    terminalSlugs.size > 0 ? move.not('status', 'in', `(${[...terminalSlugs].join(',')})`) : move

  const { data: moved, error: ticketsError } = await incomplete.select()

  if (ticketsError) return { ok: false, error: 'unknown' }

  const { data, error } = await supabase
    .from('sprints')
    .update({ status: 'complete' } satisfies SprintStatusUpdate)
    .eq('id', id)
    .eq('status', 'active')
    .select()
    .single()

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, sprint: data as Sprint, returnedTickets: (moved ?? []) as Ticket[] }
}
