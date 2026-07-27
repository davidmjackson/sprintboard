import { useState, type ReactNode } from 'react'
import type { FieldValues, UseFormReturn } from 'react-hook-form'

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
  onSubmit: (values: T, close: () => void) => void | Promise<void>
  onClosed?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      form.reset()
      onClosed?.()
    }
  }

  const close = () => handleOpenChange(false)

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
          <form
            onSubmit={form.handleSubmit((values) => onSubmit(values, close))}
            className="space-y-4"
            noValidate
          >
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
