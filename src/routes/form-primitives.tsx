import { useFormState } from 'react-hook-form'

import { Button } from '@/components/ui/button'

/** Input-styled class for a native <select>. Native beats radix Select for a fixed enum:
 *  it needs no jsdom pointer mocks and tests cleanly with userEvent.selectOptions. Shared
 *  by the create-ticket form and the ticket detail sidebar. */
export const selectClass =
  'border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:ring-3 md:text-sm'

/** The form-level (not field-level) error, painted as an alert. Reads the error itself so
 *  the five forms that show one no longer each repeat the read and the markup.
 *
 *  `useFormState()`, NOT `useFormContext().formState`: the latter hands back the parent's
 *  proxy, and reading `errors` off it from a child subscribes the parent by side effect.
 *  `useFormState` establishes this component's own subscription — the same thing
 *  `useFormField` in `src/components/ui/form.tsx` does. */
export function FormRootError() {
  const { errors } = useFormState()
  const message = errors.root?.message
  return message ? (
    <p role="alert" className="text-destructive text-sm">
      {message}
    </p>
  ) : null
}

/** Submit button that reflects the form's own `isSubmitting`: disabled, and showing
 *  `pendingLabel` in place of `label`. Both labels are required — a caller that forgets
 *  the pending copy would otherwise show a button that looks idle mid-submit. */
export function SubmitButton({
  label,
  pendingLabel,
  className,
}: {
  label: string
  pendingLabel: string
  className?: string
}) {
  const { isSubmitting } = useFormState()
  return (
    <Button type="submit" className={className} disabled={isSubmitting}>
      {isSubmitting ? pendingLabel : label}
    </Button>
  )
}
