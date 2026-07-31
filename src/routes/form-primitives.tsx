import { useFormState } from 'react-hook-form'

import { Button } from '@/components/ui/button'

/** Input-styled class for a native <select>. Native beats radix Select for a short list of
 *  plain options: it needs no jsdom pointer mocks and tests cleanly with
 *  userEvent.selectOptions. This used to say "for a fixed enum", which SPRIN-76 made wrong —
 *  the status picker's options are now the project's own `project_statuses` rows, read from
 *  the database and different per project. The reason to stay native is the testability, not
 *  the list being fixed. */
export const selectClass =
  'border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:ring-3 md:text-sm'

/** Both primitives below subscribe via `useFormState()`, never `useFormContext().formState`
 *  — the same family of subscription as this repo's own `useFormField` in
 *  `src/components/ui/form.tsx:42`, though that hook scopes it to one field
 *  (`useFormState({ name })`) while both primitives here are unscoped (`useFormState()`)
 *  because each watches form-wide state (`errors.root`, `isSubmitting`), not one field.
 *  `useFormState()` establishes each component's own subscription, so its re-render does
 *  not depend on which fields the `useForm()` owner happens to have read, and a large form
 *  does not re-render wholesale on an unrelated field change elsewhere. That is a real
 *  benefit and the reason to keep it. The unscoped call does mean `FormRootError` re-reads
 *  `errors` on *any* field's error, not only `root` — a broader subscription than the
 *  narrowest one possible, traded for not having to name every field it doesn't otherwise
 *  care about.
 *
 *  It is not, however, something a test in this repository can observe: mutating either
 *  function to `useFormContext().formState` was tried and stayed green under every
 *  arrangement tested — a `React.memo` wrapper, a `useForm()` owner proven by a
 *  render-count spy never to re-render, a memoized sibling, and a lazy-mounted error
 *  region. `FormProvider` memoizes its context value, so these are not vacuous barriers;
 *  the two implementations are simply behaviourally indistinguishable to every test this
 *  repo can write today. Keep `useFormState()` for the reason above, not because a test
 *  would catch its removal — recorded here so the next reader neither deletes it expecting
 *  a red test nor writes one that cannot fail. */

/** The form-level (not field-level) error, painted as an alert. Reads the error itself so
 *  the five forms that show one no longer each repeat the read and the markup. */
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
