import { useEffect, useState } from 'react'

import type { ProjectField } from '@/lib/domain'
import { countTicketsHoldingField, deleteProjectField } from '@/lib/project-fields'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { GENERIC_CREATE_ERROR } from './CreateDialog'

/** The `error` tag `deleteProjectField` can resolve with, read off its own return type rather
 *  than re-declared here — `FieldWriteError` is a private alias in `project-fields.ts`, and
 *  duplicating its literal union would drift the moment a tag is added there. Mirrors
 *  `CustomFieldOptions`'s `DeleteOptionError`. */
type DeleteFieldError = Extract<
  Awaited<ReturnType<typeof deleteProjectField>>,
  { ok: false }
>['error']

/**
 * What each refusal means in words, keyed by tag rather than collapsed to one generic sentence.
 *
 * `'stale'` IS reachable: `deleteProjectField` returns it on its explicit zero-row check, and a
 * zero-row delete is a real production outcome — another tab already deleted this field. Retrying
 * reproduces it forever; only reloading shows the current list. Telling that user to "try again"
 * would be telling them to repeat an action that fails identically every time.
 */
const DELETE_FAILURE_COPY: Record<DeleteFieldError, string> = {
  stale: 'This field no longer exists — refresh the page to see the current list.',
  unknown: GENERIC_CREATE_ERROR,
}

/**
 * How many tickets hold a value for this field, at the point the confirm dialog owns it.
 *
 * THREE shapes, not `number | null` — mirroring `OptionCountState` and SPRIN-80's
 * `StatusDeleteControl`, this project's precedent for count-before-commit. `null` would make "the
 * read failed" and "zero tickets hold a value" the same value, and zero is exactly what UNLOCKS
 * this destructive action: a failed read must never be able to impersonate it (AC4).
 */
type FieldCountState = 'counting' | { count: number } | 'failed'

/**
 * The destructive confirm for deleting one custom field. Mirrors `OptionDeleteDialog`'s shape:
 * closed while a delete is in flight, Cancel/destructive footer, an inline `role="alert"` for a
 * refusal.
 *
 * The count is read HERE, lazily, on the `open` transition — never on render. A project with many
 * fields must not fire one count query per field per paint; only the field whose confirm the user
 * actually opened is ever counted.
 */
function FieldDeleteDialog({
  field,
  open,
  onOpenChange,
  onDeleted,
}: {
  field: ProjectField
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: (id: string) => void
}) {
  const [count, setCount] = useState<FieldCountState>('counting')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // `open` starts `false`, so this never fires on render — only on the transition a click makes.
  // The `'counting'` reset lives in `onOpenChange` below (an event callback, not this effect
  // body), so this body only ever calls `setCount` from the promise's own callbacks.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    countTicketsHoldingField(field.id)
      .then((value) => {
        if (!cancelled) setCount({ count: value })
      })
      .catch(() => {
        if (!cancelled) setCount('failed')
      })
    return () => {
      cancelled = true
    }
  }, [open, field.id])

  async function submit() {
    setDeleting(true)
    setError(null)
    const result = await deleteProjectField(field.id)
    setDeleting(false)
    if (!result.ok) {
      setError(DELETE_FAILURE_COPY[result.error])
      return
    }
    onDeleted(field.id)
  }

  // The ONLY thing that unlocks the confirm button. `count` is a known number, not `'counting'`
  // or `'failed'` — an unknown count must never be able to impersonate zero.
  const known = typeof count === 'object'

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (deleting) return
        setError(null)
        // Reset on the way OUT, mirroring the error reset above: this component stays mounted
        // while the dialog is closed, so without this a stale count from the LAST open would
        // flash as already-known on the next one, ahead of the fresh fetch the effect starts.
        if (!next) setCount('counting')
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {field.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {known
              ? `${count.count} ${count.count === 1 ? 'ticket' : 'tickets'} will lose this value. This can’t be undone.`
              : 'This can’t be undone.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {count === 'failed' ? (
          <p role="alert" className="text-destructive text-sm">
            Could not check how many tickets hold this field. Try again.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={deleting}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button variant="destructive" onClick={() => void submit()} disabled={deleting || !known}>
            {deleting ? 'Removing…' : 'Remove field'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The Remove trigger plus the confirm above. Split into its own file so `CustomFieldSettings.tsx`
 * stays under its line budget, and split from the row for the reason `OptionDeleteControl` is:
 * this owns the confirm-open state because only one field's dialog is ever open at a time.
 *
 * **`onDeleted` has no default**, deliberately: an unplugged wire is then a `TS2741` compile error
 * rather than a silent no-op, which is the class that produced five of SPRIN-92's six findings.
 */
export function CustomFieldDeleteControl({
  field,
  onDeleted,
}: {
  field: ProjectField
  onDeleted: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        aria-label={`Remove ${field.name}`}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
      <FieldDeleteDialog
        field={field}
        open={confirming}
        onOpenChange={setConfirming}
        onDeleted={onDeleted}
      />
    </>
  )
}
