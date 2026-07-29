import { useState } from 'react'

import { parseDeliverables } from './deliverables'
import type { Ticket, TicketUpdate } from './domain'

/**
 * The epic deliverables editor's logic — the ordered list, the add-input draft, and the
 * serialized whole-array writes behind add/remove/edit. Kept apart from the components
 * that render it (the ticket detail dialog) so each file stays single-purpose.
 *
 * `ticket` is nullable because the dialog's `if (!ticket) return null` sits AFTER every
 * hook call, and hooks cannot be called conditionally.
 *
 * The hook owns the DRAFT STATE only. The add-input's ref stays in the dialog, because the
 * dialog's `onEscapeKeyDown` must read it: Radix dismisses at the document level in the
 * capture phase, so a child's `stopPropagation` cannot keep the dialog open. That split is
 * deliberate — it was chosen over an escape-handler registry.
 */

/** `isMounted` is the FUNCTION, not a snapshotted boolean: it is read at continuation time,
 *  after the await. Passing it by value would silently defeat the mount guard while every
 *  test still passed. `pending` is a plain boolean by contrast, and correctly so — it is read
 *  synchronously on entry, before any await, exactly as the render closure read it. */
type WriteDeliverablesArgs = {
  next: string[]
  pending: boolean
  setPending: (value: boolean) => void
  commit: (patch: TicketUpdate) => Promise<boolean>
  isMounted: () => boolean
}

// Deliverables are an epic-only, order-preserving `string[]`. Each mutation rebuilds the
// WHOLE array and commits it — which makes two concurrent mutations conflicting writes to
// one column, not the coexisting edits the user intends ("add A", "add B"). Out-of-order
// resolution would then persist last-write-wins and silently drop an item. So deliverable
// writes are SERIALIZED: `deliverablesPending` blocks a second mutation until the first
// reconciles, and Add/remove are disabled meanwhile. Each still rides the shared optimistic
// commit, so a failed save reverts just `deliverables`.
async function writeDeliverables({
  next,
  pending,
  setPending,
  commit,
  isMounted,
}: WriteDeliverablesArgs): Promise<boolean> {
  if (pending) return false
  setPending(true)
  const ok = await commit({ deliverables: next })
  if (!isMounted()) return ok
  setPending(false)
  return ok
}

export type Deliverables = {
  items: string[]
  draft: string
  setDraft: (value: string) => void
  pending: boolean
  add: () => Promise<void>
  remove: (index: number) => void
  edit: (index: number, value: string) => void
}

type UseDeliverablesArgs = {
  ticket: Ticket | null
  commit: (patch: TicketUpdate) => Promise<boolean>
  isMounted: () => boolean
}

export function useDeliverables({ ticket, commit, isMounted }: UseDeliverablesArgs): Deliverables {
  // The draft for the "add a deliverable" input (epic only). Cleared on a successful add.
  const [draft, setDraft] = useState('')
  // True while a deliverables write is in flight — serializes them so two quick add/remove/
  // edits can't race into a lost update (they are whole-array overwrites of one column).
  const [pending, setPending] = useState(false)

  // The epic's deliverables, narrowed from the `jsonb` column to a clean string list. The
  // editor always rebuilds the whole array and commits it through `commit`, so a write is
  // always a well-formed `string[]` and never a half-mutated jsonb value.
  const items = parseDeliverables(ticket?.deliverables)

  function write(next: string[]) {
    return writeDeliverables({ next, pending, setPending, commit, isMounted })
  }
  async function add() {
    const trimmed = draft.trim()
    if (!trimmed) return
    const ok = await write([...items, trimmed])
    // Clear the input only once the add persisted — a failed save keeps the typed text so
    // the user can retry without re-entering it.
    if (ok && isMounted()) setDraft('')
  }
  function remove(index: number) {
    void write(items.filter((_, i) => i !== index))
  }
  function edit(index: number, value: string) {
    // Editing an item to blank removes it — `filter(Boolean)` after the replace, so the
    // list never holds an empty deliverable (the same rule `parseDeliverables` enforces).
    const next = items.map((d, i) => (i === index ? value.trim() : d)).filter(Boolean)
    void write(next)
  }

  return { items, draft, setDraft, pending, add, remove, edit }
}
