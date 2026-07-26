import { useState } from 'react'

import { useIsMounted } from './ticket-commit'
import { blockTicket, deleteTicket, parseBlockReason, unblockTicket } from './tickets'
import type { Ticket } from './domain'

/**
 * The ticket detail dialog's two destructive-ish flows: block/unblock, and delete. Kept
 * apart from the components that render them (the dialog, its reason modal and its delete
 * confirm) so each file stays single-purpose.
 *
 * `ticket` is nullable because the dialog's `if (!ticket) return null` sits AFTER every
 * hook call, and hooks cannot be called conditionally — so each handler guards on it and
 * captures the id BEFORE its await, never at continuation time.
 */

/** The three fields the `sync_blocked_fields` trigger owns. Block and unblock are NOT
 *  optimistic — the trigger stamps and clears `blocked_since` server-side, so we apply the
 *  row the database returns rather than guess it. The reconcile is field-scoped to exactly
 *  these three; see `applyServerRowOnto` in `ticket-commit.ts` for why. */
const BLOCKED_FIELDS: readonly (keyof Ticket)[] = ['is_blocked', 'blocked_reason', 'blocked_since']

type ApplyServerRow = (id: string, next: Ticket, keys: readonly (keyof Ticket)[]) => void

/** The block dialog's own state writers, bundled so `submitBlock` takes one argument object
 *  and the hook body stays a set of thin wrappers. */
type BlockDialogSetters = {
  setBlocking: (value: boolean) => void
  setReasonValue: (value: string) => void
  setBlockError: (value: string | null) => void
  setPending: (value: boolean) => void
}

/** `isMounted` is the FUNCTION, not a snapshotted boolean: it is read at continuation time,
 *  after the await. Passing `isMounted()` by value would silently defeat the mount guard
 *  while every test still passed. */
type SubmitBlockArgs = {
  ticket: Ticket | null
  reason: string
  set: BlockDialogSetters
  applyServerRow: ApplyServerRow
  isMounted: () => boolean
}

async function submitBlock({ ticket, reason, set, applyServerRow, isMounted }: SubmitBlockArgs) {
  const { setBlocking, setReasonValue, setBlockError, setPending } = set
  if (!ticket) return
  const id = ticket.id
  const parsed = parseBlockReason(reason)
  if (!parsed.ok) {
    // The confirm button is disabled while the reason is invalid, so this is a
    // defensive backstop rather than the normal path.
    setBlockError(parsed.message)
    return
  }
  setPending(true)
  const result = await blockTicket(id, parsed.value)
  if (!isMounted()) return // dialog was dismissed while the block was in flight
  setPending(false)
  if (result.ok) {
    applyServerRow(id, result.ticket, BLOCKED_FIELDS)
    setBlocking(false)
    setReasonValue('')
    setBlockError(null)
  } else {
    // A failed block leaves the dialog OPEN so the reason survives the retry.
    setBlockError(
      result.error === 'invalid_reason'
        ? result.message
        : 'Could not block this ticket. Please try again.',
    )
  }
}

export type BlockFlow = {
  blocking: boolean
  open: () => void
  close: () => void
  reason: string
  setReason: (value: string) => void
  error: string | null
  pending: boolean
  submit: () => Promise<void>
  unblockPending: boolean
  unblock: () => Promise<void>
}

type UseBlockFlowArgs = {
  ticket: Ticket | null
  applyServerRow: ApplyServerRow
  setError: (ticketId: string, message: string) => void
  clearError: () => void
}

/** The reason dialog's half of the flow: its open state, draft reason, validation error and
 *  the write behind Block. Split from `useUnblock` so each stays small and each guards its
 *  own state after its own await; `useBlockFlow` composes them back into one contract. */
type BlockDialogFlow = Omit<BlockFlow, 'unblockPending' | 'unblock'>

function useBlockDialog({
  ticket,
  applyServerRow,
}: Pick<UseBlockFlowArgs, 'ticket' | 'applyServerRow'>): BlockDialogFlow {
  // Block flow: the reason dialog's open state, its draft reason, and an in-flight flag.
  // (That undercounts by one: it also tracks its own validation-error string.)
  const [blocking, setBlocking] = useState(false)
  const [reason, setReasonValue] = useState('')
  const [error, setBlockError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const isMounted = useIsMounted()
  const set = { setBlocking, setReasonValue, setBlockError, setPending }

  function open() {
    setReasonValue('')
    setBlockError(null)
    setBlocking(true)
  }
  function close() {
    setBlocking(false)
    setReasonValue('')
    setBlockError(null)
  }
  function setReason(value: string) {
    setReasonValue(value)
    // Editing the reason clears a stale validation error — the dialog's Textarea did this
    // inline before the extraction, and this flow owns that error now.
    if (error) setBlockError(null)
  }
  function submit() {
    return submitBlock({ ticket, reason, set, applyServerRow, isMounted })
  }

  return { blocking, open, close, reason, setReason, error, pending, submit }
}

/** Unblock has no dialog (it needs no input), so it only tracks its own in-flight flag. */
type UnblockFlow = Pick<BlockFlow, 'unblockPending' | 'unblock'>

function useUnblock({
  ticket,
  applyServerRow,
  setError,
  clearError,
}: UseBlockFlowArgs): UnblockFlow {
  const [unblockPending, setUnblockPending] = useState(false)
  const isMounted = useIsMounted()

  async function unblock() {
    // Unblock fires from the kebab (which closes on select) and is not optimistic, so
    // without a guard an impatient second click would fire a duplicate request. The
    // banner shows an "Unblocking…" state off this flag until the row reconciles.
    if (unblockPending) return
    if (!ticket) return
    const id = ticket.id
    setUnblockPending(true)
    const result = await unblockTicket(id)
    if (!isMounted()) return // dialog was dismissed while the unblock was in flight
    setUnblockPending(false)
    if (result.ok) {
      applyServerRow(id, result.ticket, BLOCKED_FIELDS)
      clearError()
    } else {
      setError(id, 'Could not unblock this ticket. Please try again.')
    }
  }

  return { unblockPending, unblock }
}

export function useBlockFlow(args: UseBlockFlowArgs): BlockFlow {
  const dialog = useBlockDialog(args)
  const unblocking = useUnblock(args)
  return { ...dialog, ...unblocking }
}

export type DeleteFlow = {
  confirming: boolean
  setConfirming: (open: boolean) => void
  deleting: boolean
  submit: () => Promise<void>
}

type UseDeleteFlowArgs = {
  ticket: Ticket | null
  onDeleted: (id: string) => void
  setError: (ticketId: string, message: string) => void
}

export function useDeleteFlow({ ticket, onDeleted, setError }: UseDeleteFlowArgs): DeleteFlow {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const isMounted = useIsMounted()

  async function submit() {
    if (!ticket) return
    const id = ticket.id
    setDeleting(true)
    const result = await deleteTicket(id)
    if (!isMounted()) return // dialog was dismissed while the delete was in flight
    if (result.ok) {
      // Parent removes the row → `ticket` becomes null → this dialog unmounts. We don't
      // reset local state (we're on our way out) and never close ourselves directly.
      onDeleted(id)
    } else {
      setDeleting(false)
      setConfirming(false)
      setError(id, 'Could not delete this ticket. Please try again.')
    }
  }

  return { confirming, setConfirming, deleting, submit }
}
