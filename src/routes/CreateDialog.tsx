import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { FieldValues, UseFormReturn, UseFormSetError } from 'react-hook-form'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Form } from '@/components/ui/form'
import { FormRootError, SubmitButton } from './form-primitives'

/** The copy every Create* dialog shows when the write fails for no reason we can name.
 *  Shared so the three dialogs cannot drift apart on it. */
export const GENERIC_CREATE_ERROR = 'Something went wrong. Please try again.'

/** The generation-guarded callbacks the shell hands to `onSubmit`. Both no-op if the
 *  dialog has been closed or reopened since the submit began — see the shell's own note. */
export type SubmitActions<T extends FieldValues> = {
  close: () => void
  setError: UseFormSetError<T>
}

/**
 * The shell every Create* dialog shares: trigger button, chrome, form wrapper, form-level
 * error, footer and submit. Callers supply only their fields, as children.
 *
 * The shell does NOT close itself on a successful submit. `onSubmit` is handed an explicit
 * `close` callback instead, so each call site still states in as many words that a
 * successful create closes the dialog — rather than that depending on an invisible reading
 * of form state, which would also silently change behaviour for a handler that succeeds
 * *and* warns.
 *
 * `onClosed` runs after the form reset, for a caller with extra state to clear alongside it.
 *
 * ## Why `onSubmit` gets guarded callbacks rather than a bare `close` (SPRIN-51)
 *
 * A submit's continuation runs whenever its promise resolves, against whatever dialog is
 * open at that moment — not the one that was open when it started. Submit, close the
 * dialog by hand mid-flight, reopen it, start typing: the original promise resolves, the
 * old `close()` runs, and the *new* draft is reset away while the record is created
 * anyway. Reproduced on `350ce2a`; it is not idempotent.
 *
 * The naive repair — bail out of the whole continuation when it is stale — is wrong,
 * because the three effects in it do not share an owner. `close()` belongs to the dialog
 * and `setError` to the form, so both are stale; but `onCreated` belongs to the *parent*
 * and the created row is real, so it must still fire or the new record stays invisible
 * until a refetch. Hence a guard per effect, not per continuation.
 *
 * `openGeneration` is bumped on every open-state transition, in both directions, so any
 * close or reopen between submit and resolve invalidates the continuation. Bumping on
 * close as well as open also stops `onClosed` firing twice when a hand-closed dialog's
 * submit later resolves.
 *
 * Call sites must use this `setError` rather than reaching for `form.setError`, which is
 * unguarded. Nothing in the type system enforces that, and neither does lint: reverting
 * only ONE branch of a call site leaves `setError` still bound, so `no-unused-vars` stays
 * quiet and every shell test here stays green. The control is a **call-site** test —
 * `CreateProjectDialog.test.tsx`'s stale duplicate-key case — because a test written
 * against this file's own harness cannot see a production call site bypassing the guard.
 *
 * Two consequences worth knowing, both deliberate:
 * - `onCreated` and anything the parent does with it (`AppLayout` navigates on a created
 *   project) still run, so a stale success can navigate with the reopened dialog still
 *   open over the destination. On `main` the draft was destroyed instead; preserving it
 *   is the point, and the navigation was already happening.
 * - Calling `close()` bumps the generation, so any `setError` a handler issues *after*
 *   its own `close()` is swallowed. No call site does this today, but the note above
 *   about "a handler that succeeds *and* warns" describes exactly that shape — warn
 *   first, close second.
 *
 * (Checked and NOT true, recorded so nobody re-derives it: the reopened draft is not
 * stuck behind the in-flight request. `form.reset()` clears `isSubmitting`, so the submit
 * button reads `Create …`, is enabled, and submits.)
 */
export function CreateDialog<T extends FieldValues>({
  trigger,
  title,
  description,
  submitLabel,
  form,
  onSubmit,
  onClosed,
  children,
}: {
  trigger: string
  title: string
  description: ReactNode
  submitLabel: string
  form: UseFormReturn<T>
  onSubmit: (values: T, actions: SubmitActions<T>) => void | Promise<void>
  onClosed?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // A ref, not state: bumping it must not re-render, and the guard has to read the newest
  // value rather than one captured in the submit's own closure.
  const openGeneration = useRef(0)

  function handleOpenChange(next: boolean) {
    openGeneration.current += 1
    setOpen(next)
    if (!next) {
      form.reset()
      onClosed?.()
    }
  }

  function submitActions(generation: number): SubmitActions<T> {
    const isCurrent = () => openGeneration.current === generation
    return {
      close: () => {
        if (isCurrent()) handleOpenChange(false)
      },
      setError: (name, error, options) => {
        if (isCurrent()) form.setError(name, error, options)
      },
    }
  }

  // The generation is sampled HERE — before `form.handleSubmit` — and not inside its
  // callback. That callback runs only after the resolver settles, so sampling in there
  // reads the generation *after* validation rather than at submit. With a synchronous
  // resolver (all three dialogs today) the difference is one microtask and unreachable;
  // with an async resolver it is the full SPRIN-51 bug again. Demonstrated with a held
  // async resolver: sampling inside the callback closed the reopened dialog and wiped its
  // draft, and no test that existed at the time could tell the two apart.
  //
  // An async resolver is not hypothetical here — the duplicate-key path is exactly the
  // shape that invites an async uniqueness check on the project key.
  //
  // Hoisting out of the JSX is also what satisfies `react-hooks/refs`, which cannot tell
  // that the callback runs on submit rather than during render. Do not fold it back.
  function handleFormSubmit(event: FormEvent<HTMLFormElement>) {
    const generation = openGeneration.current
    return form.handleSubmit((values) => onSubmit(values, submitActions(generation)))(event)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">{trigger}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={handleFormSubmit} className="space-y-4" noValidate>
            {children}
            <FormRootError />
            <DialogFooter>
              <SubmitButton label={submitLabel} pendingLabel="Creating…" />
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
