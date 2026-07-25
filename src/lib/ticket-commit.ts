import { useEffect, useRef, useState, type RefObject } from 'react'

import { updateTicket } from './tickets'
import type { Ticket, TicketUpdate } from './domain'

/**
 * The optimistic ticket-write engine, kept apart from the components that use it (the
 * ticket detail dialog) so each file stays single-purpose — the codebase's ESLint config
 * asks app modules to export either components or plain values, not both.
 *
 * `ticket` is nullable because the dialog's `if (!ticket) return null` sits AFTER every
 * hook call, and hooks cannot be called conditionally.
 */

/** Copies only `keys` from `source` into a new object, typed exactly like `Pick<T, K>`.
 *  Used to capture/apply a FIELD-SCOPED slice of a ticket for optimistic rollback and
 *  reconcile, instead of ever swapping in a whole (possibly stale) ticket object. */
export function pickFields<T, K extends keyof T>(source: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>
  for (const key of keys) out[key] = source[key]
  return out
}

/** True while this component instance is mounted. Read it after every `await` before
 *  touching state: a continuation that lands after unmount would otherwise resolve
 *  against a dead instance. The explicit true-on-mount (rather than relying on the
 *  initial value) keeps it correct under React StrictMode's mount→unmount→mount. */
export function useIsMounted(): () => boolean {
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  return () => mountedRef.current
}

export type TicketError = {
  error: string | null
  setError: (ticketId: string, message: string) => void
  clearError: () => void
}

/** The save-failure message for ONE ticket. A separate concern from the write itself:
 *  the write decides *whether* there is an error, this decides *whose* it is. */
export function useTicketError(ticket: Ticket | null): TicketError {
  // Keyed to the ticket id so switching tickets resets any stale error without a
  // synchronous "reset on prop change" effect (the project's react-hooks lint rule
  // forbids deriving state that way).
  const [errorFor, setErrorFor] = useState<{ ticketId: string; message: string } | null>(null)

  const error = ticket && errorFor?.ticketId === ticket.id ? errorFor.message : null

  function setError(ticketId: string, message: string) {
    setErrorFor({ ticketId, message })
  }
  function clearError() {
    setErrorFor(null)
  }

  return { error, setError, clearError }
}

/** `ticketRef` is the REF, not its value: `commitTicket` must read `.current` at
 *  continuation time (after the await), never at call time. */
type CommitTicketArgs = {
  patch: TicketUpdate
  ticketRef: RefObject<Ticket | null>
  isMounted: () => boolean
  onUpdated: (ticket: Ticket) => void
  setError: (ticketId: string, message: string) => void
  clearError: () => void
}

async function commitTicket({
  patch,
  ticketRef,
  isMounted,
  onUpdated,
  setError,
  clearError,
}: CommitTicketArgs): Promise<boolean> {
  const current = ticketRef.current!
  const keys = Object.keys(patch) as (keyof TicketUpdate)[]
  const revert = pickFields(current, keys) // pre-change values of ONLY the changed keys

  onUpdated({ ...current, ...patch } as Ticket) // optimistic — merge onto the latest ticket
  const result = await updateTicket(current.id, patch)
  // This instance is gone (close→reopen remounted a fresh one that now owns the ticket):
  // its optimistic value was already applied to parent state before the await and carried
  // forward by the fresh instance, so reconciling here would only clobber the live
  // instance's newer edits. Bail (Ultracode Critical — the mountedRef guard).
  if (!isMounted()) return false
  // `ticketRef.current` may also have moved on WITHIN this live instance — to a DIFFERENT
  // ticket (the dialog switched tickets while this save was in flight) or to `null`.
  // Merging onto it unguarded would emit a wrong-identity object (or, for null, an id-less
  // `{}`). Fall back to the commit-time `current` — always non-null, always
  // `id === current.id` — whenever the live ref no longer matches this save's ticket.
  const base = ticketRef.current?.id === current.id ? ticketRef.current : current
  if (!result.ok) {
    // Revert only the fields this commit changed, merged onto whatever is latest NOW —
    // preserves any other field a concurrent commit has since applied.
    onUpdated({ ...base, ...revert } as Ticket)
    setError(current.id, 'Could not save your change. Please try again.')
    return false
  } else {
    // Reconcile only the changed fields (+ the DB-refreshed updated_at) onto the latest
    // ticket — never swap in the whole `result.ticket`, which would clobber a
    // concurrent in-flight optimistic edit to a different field.
    // NOTE: two in-flight saves to the SAME field resolving out of order can still
    // reconcile/revert in the wrong order (last-resolved wins, not last-committed) —
    // a known, deliberately deferred limitation.
    const reconciled = pickFields(result.ticket, keys)
    onUpdated({ ...base, ...reconciled, updated_at: result.ticket.updated_at } as Ticket)
    clearError()
    return true
  }
}

type ApplyServerRowArgs = {
  id: string
  next: Ticket
  keys: readonly (keyof Ticket)[]
  ticketRef: RefObject<Ticket | null>
  onUpdated: (ticket: Ticket) => void
}

// Block/unblock are NOT optimistic: the `sync_blocked_fields` trigger stamps/clears
// `blocked_since` server-side, so we apply the row the DB returns rather than guess it.
// Reconcile is field-scoped (only the three blocked fields + the refreshed updated_at)
// onto whatever is latest NOW — the same discipline as `commit()`, so a concurrent
// in-flight optimistic edit to a different field is never clobbered.
function applyServerRowOnto({ id, next, keys, ticketRef, onUpdated }: ApplyServerRowArgs) {
  const base = ticketRef.current?.id === id ? ticketRef.current : next
  onUpdated({
    ...base,
    ...pickFields(next, keys),
    updated_at: next.updated_at,
  } as Ticket)
}

export type TicketCommit = {
  commit: (patch: TicketUpdate) => Promise<boolean>
  error: string | null
  setError: (ticketId: string, message: string) => void
  clearError: () => void
  applyServerRow: (id: string, next: Ticket, keys: readonly (keyof Ticket)[]) => void
  isMounted: () => boolean
}

type UseTicketCommitArgs = {
  ticket: Ticket | null
  onUpdated: (ticket: Ticket) => void
}

export function useTicketCommit({ ticket, onUpdated }: UseTicketCommitArgs): TicketCommit {
  const { error, setError, clearError } = useTicketError(ticket)

  // The freshest ticket, readable from inside an in-flight async `commit()` closure.
  // Without this, a rollback/reconcile that fires after a concurrent edit to a
  // DIFFERENT field would merge against the ticket as it was when `commit` was
  // *called*, silently discarding that concurrent edit.
  const ticketRef = useRef<Ticket | null>(ticket)
  // Ref writes must happen outside render (the project's react-hooks/refs rule forbids
  // writing `.current` during render), so this syncs after commit rather than inline.
  useEffect(() => {
    ticketRef.current = ticket
  })

  // A commit()'s async continuation must not touch parent state after THIS instance
  // unmounts. ProjectShell renders us with key={selected?.id ?? 'none'}, so closing then
  // reopening the SAME ticket unmounts this instance and mounts a fresh one that now owns
  // the ticket. A save still in flight when the old instance dies would otherwise resolve
  // against a frozen ticketRef (its sync effect has no cleanup) and clobber the fresh
  // instance's already-saved edits (Ultracode Critical). Set true on (re)mount, false on
  // unmount — the explicit true-on-mount keeps it correct under React StrictMode's
  // mount→unmount→mount.
  const isMounted = useIsMounted()

  function commit(patch: TicketUpdate) {
    return commitTicket({ patch, ticketRef, isMounted, onUpdated, setError, clearError })
  }
  function applyServerRow(id: string, next: Ticket, keys: readonly (keyof Ticket)[]) {
    applyServerRowOnto({ id, next, keys, ticketRef, onUpdated })
  }

  return { commit, error, setError, clearError, applyServerRow, isMounted }
}
