import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import type { ProjectField, ProjectFieldOption } from '@/lib/domain'
import {
  createProjectFieldOption,
  optionsForField,
  renameProjectFieldOption,
} from '@/lib/project-field-options'
import { AddOptionSchema, RenameOptionSchema, type AddOptionValues } from '@/lib/field-schemas'
import { Input } from '@/components/ui/input'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { GENERIC_CREATE_ERROR } from './CreateDialog'
import { EditableText } from './EditableText'
import { FormRootError, SubmitButton } from './form-primitives'

/**
 * What a `'stale'` write result means in words, mirroring `CustomFieldSettings`'s
 * `STALE_LIST` exactly — same mechanism, one table over.
 *
 * `createProjectFieldOption` de-duplicates the slug it derives against the `existing` rows
 * it is HANDED, so a `23505` on `project_field_options_pkey` means this field's option list
 * was older than the database's — another tab added an option whose slug the derivation
 * could not see. Retrying the same submit reproduces it forever; reloading is the only thing
 * that fixes it, so that is what the sentence has to say.
 */
const STALE_OPTIONS =
  'This list of options is out of date — refresh the page and try adding it again.'

/**
 * Sort by `(position, slug)`, mirroring `listProjectFieldOptions`'s own `.order()` calls.
 *
 * This component receives the WHOLE project's options and filters per field with
 * `optionsForField`, so it must not lean on the server having already sorted the slice it is
 * handed — nothing re-fetches after `optionsForField` narrows the list. `position` alone is
 * not unique (the client derives it as `max(position) + 1` from a list nothing refetches), so
 * two options can tie; `slug` is unique per field and breaks every tie, making the order
 * total.
 */
function byPositionThenSlug(a: ProjectFieldOption, b: ProjectFieldOption) {
  return a.position - b.position || a.slug.localeCompare(b.slug)
}

/**
 * Add an option to a `select` field: one label, mirroring `AddFieldForm`'s shape exactly
 * (`useForm` + `zodResolver`, a form-level `root` error, `form.reset()` on success).
 *
 * `existing` must already be filtered and sorted for THIS field — `createProjectFieldOption`
 * de-duplicates the derived slug against exactly the rows it is handed, so passing the whole
 * project's options would de-duplicate against other fields' slugs the primary key
 * `(field_id, slug)` does not require.
 */
function AddOptionForm({
  projectId,
  fieldId,
  existing,
  onCreated,
}: {
  projectId: string
  fieldId: string
  existing: readonly ProjectFieldOption[]
  onCreated: (option: ProjectFieldOption) => void
}) {
  const form = useForm<AddOptionValues>({
    resolver: zodResolver(AddOptionSchema),
    defaultValues: { label: '' },
  })

  async function onSubmit(values: AddOptionValues) {
    const parsed = AddOptionSchema.parse(values)
    const result = await createProjectFieldOption({
      projectId,
      fieldId,
      label: parsed.label,
      existing,
    })

    if (!result.ok) {
      // Both tags land at FORM level rather than on the label field: for `'stale'` the label
      // was never the problem, so a message under the input would invite the user to edit the
      // one thing that cannot help.
      form.setError('root', {
        message: result.error === 'stale' ? STALE_OPTIONS : GENERIC_CREATE_ERROR,
      })
      return
    }

    onCreated(result.value)
    form.reset()
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-wrap items-start gap-3"
        noValidate
      >
        <FormField
          control={form.control}
          name="label"
          render={({ field }) => (
            <FormItem className="min-w-48 flex-1">
              <FormLabel>Option label</FormLabel>
              <FormControl>
                <Input placeholder="High" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <SubmitButton label="Add option" pendingLabel="Adding…" className="mt-6" />
        <div className="w-full">
          <FormRootError />
        </div>
      </form>
    </Form>
  )
}

/**
 * One option: its label, editable in place. Mirrors `CustomFieldRow`'s rename shape.
 *
 * The rename call lives HERE rather than in the parent for the same reason `CustomFieldRow`'s
 * does: with several rows on screen, a page-level banner would not say WHICH label was
 * refused. The row owns its own `role="alert"` region and nothing else on this surface
 * reports a rename.
 *
 * **There is deliberately no `'stale'` branch here**, unlike the add form. A rename sends
 * `label` alone — `authenticated` holds UPDATE on `label` alone, and the slug is untouched by
 * construction — so it cannot reach `project_field_options_pkey`, the only constraint that
 * produces the `'stale'` tag, and there is no label-uniqueness constraint for it to reach
 * instead. Both write-result tags are therefore undiagnosed on this path, and generic retry
 * copy is the honest fallback (identical reasoning to `CustomFieldRow`'s own rename).
 */
function CustomFieldOptionRow({
  fieldId,
  option,
  onUpdated,
}: {
  fieldId: string
  option: ProjectFieldOption
  onUpdated: (option: ProjectFieldOption) => void
}) {
  const [error, setError] = useState<string | null>(null)

  async function rename(next: string) {
    const parsed = RenameOptionSchema.safeParse({ label: next })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? GENERIC_CREATE_ERROR)
      return
    }
    // Clear the previous error BEFORE the no-op check, otherwise a failed attempt's message
    // outlives it and goes on accusing a label the user has since reverted, about a request
    // that was never sent.
    setError(null)
    if (parsed.data.label === option.label) return
    const result = await renameProjectFieldOption(fieldId, option.slug, parsed.data.label)
    if (!result.ok) {
      setError(GENERIC_CREATE_ERROR)
      return
    }
    onUpdated(result.value)
  }

  return (
    <li className="flex items-center gap-3 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <EditableText
          value={option.label}
          ariaLabel={`label of ${option.label}`}
          onCommit={(next) => void rename(next)}
        />
        {error ? (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        ) : null}
      </div>
    </li>
  )
}

/**
 * The loaded list, or the empty state. Mirrors `CustomFieldList`'s `<ul>`/`<li>` shape: each
 * row is an item with a control (`EditableText`) and its own error region, not a term/
 * definition pair, so a `<dl>` would answer a concern this surface does not have.
 */
function CustomFieldOptionList({
  fieldId,
  options,
  onUpdated,
}: {
  fieldId: string
  options: readonly ProjectFieldOption[]
  onUpdated: (option: ProjectFieldOption) => void
}) {
  if (options.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
        No options yet.
      </p>
    )
  }

  return (
    <ul className="divide-border divide-y rounded-lg border">
      {options.map((option) => (
        <CustomFieldOptionRow
          key={option.slug}
          fieldId={fieldId}
          option={option}
          onUpdated={onUpdated}
        />
      ))}
    </ul>
  )
}

/**
 * A `select` field's option list: listed, renameable, and addable (SPRIN-92, epic SPRIN-71
 * story 5). Task 8 adds the delete-with-count confirm; there is no delete control here.
 *
 * `options` is the WHOLE PROJECT's options, exactly as `CustomFieldSettings` receives the
 * whole project's fields — `CustomFieldRow` renders one of these per `select` field, so a
 * per-field fetch would multiply reads with the number of select fields on the project.
 * `optionsForField` narrows it, and `byPositionThenSlug` re-sorts the narrowed slice rather
 * than trusting the server's order to have survived the filter.
 *
 * Every write hands its result up through `onCreated` / `onUpdated`, the same discipline
 * `CustomFieldSettings` uses: this component never keeps a second copy of the list to mutate,
 * so a failed write leaves the rendered list exactly as it was with no rollback code anywhere.
 */
export function CustomFieldOptions({
  field,
  options,
  onCreated,
  onUpdated,
}: {
  field: ProjectField
  options: readonly ProjectFieldOption[]
  onCreated: (option: ProjectFieldOption) => void
  onUpdated: (option: ProjectFieldOption) => void
}) {
  const mine = optionsForField(options, field.id).sort(byPositionThenSlug)

  return (
    <div className="flex flex-col gap-3">
      <CustomFieldOptionList fieldId={field.id} options={mine} onUpdated={onUpdated} />
      <AddOptionForm
        projectId={field.project_id}
        fieldId={field.id}
        existing={mine}
        onCreated={onCreated}
      />
    </div>
  )
}
