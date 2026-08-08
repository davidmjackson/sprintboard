import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  type ProjectField,
  type ProjectFieldOption,
} from '@/lib/domain'
import { createProjectField, renameProjectField } from '@/lib/project-fields'
import { AddFieldSchema, RenameFieldSchema, type AddFieldValues } from '@/lib/field-schemas'
import type { ReadPhase } from '@/lib/project-reads'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { CustomFieldOptions } from './CustomFieldOptions'
import { GENERIC_CREATE_ERROR } from './CreateDialog'
import { EditableText } from './EditableText'
import { FormRootError, selectClass, SubmitButton } from './form-primitives'
import { LoadFailure } from './LoadFailure'

/**
 * What a `'stale'` write result means in words, and why it is not the generic retry copy.
 *
 * `createProjectField` derives a collision-free slug from the rows it is HANDED, so a
 * `23505` on `project_fields_project_slug_unique` means this tab's list was older than the
 * database's — another tab (or another window) added a field whose slug the derivation could
 * not see. Retrying the same submit reproduces it exactly, forever; reloading is the only
 * thing that fixes it, so that is what the sentence has to say.
 *
 * **This is emphatically NOT "a field with that name already exists".** `project_fields`
 * carries no name-uniqueness constraint at all — AC2 requires that adding two fields called
 * `Customer ref` SUCCEEDS, producing `customer_ref` and `customer_ref_2` — so importing
 * `status-schemas`'s `DUPLICATE_NAME` here would put a sentence on screen describing a
 * constraint this table does not have, about a write that in fact succeeded. The two
 * surfaces look identical and this is the one place copying the sibling wholesale is wrong.
 * The write's tag set is `'stale' | 'unknown'`, two where statuses have five, for that reason.
 */
const STALE_LIST =
  'This list of custom fields is out of date — refresh the page and try adding it again.'

/**
 * Add a custom field to the project: a name and a type.
 *
 * Mirrors `AddStatusForm` deliberately — an inline form rather than a `CreateDialog`, because
 * the control belongs beside the list it appends to and a dialog would add a click and a focus
 * trap to reach two inputs. It likewise does NOT take `CreateDialog`'s generation-guarded
 * `setError`/`close` (SPRIN-51): that guard exists because a dialog can be closed and reopened
 * with a submit in flight, and this form is always mounted with no open state to race.
 *
 * **The type options are generated from `CUSTOM_FIELD_TYPES`, never written out here.** That
 * is CLAUDE.md's rule with teeth: a status/type vocabulary is named in `domain.ts` and nowhere
 * else, so a sixth type cannot become addable on this form without the database's own check
 * constraint agreeing. `CUSTOM_FIELD_TYPE_LABELS` is `Record<CustomFieldType, string>`, so a
 * new type without a label is a compile error rather than an option reading `undefined`.
 *
 * **The label is "Name", the same word `AddStatusForm` uses one section above on the same
 * tab.** That is not an oversight: each form sits inside a `<section>` with its own accessible
 * name ("Statuses" / "Custom fields"), and shadcn's `FormItem` generates a unique id per
 * field, so the association is unambiguous for a user. It does mean a query written against
 * the whole SETTINGS TAB must scope by section — an unscoped `getByRole('textbox', { name:
 * 'Name' })` there is ambiguous and will throw rather than silently pick one, which is the
 * failure mode one wants.
 */
function AddFieldForm({
  projectId,
  existing,
  onCreated,
}: {
  projectId: string
  /** The rows the write derives its collision-free slug from. Only ever the LOADED list —
   *  see `CustomFieldBody`, which is why this form is not rendered before then. */
  existing: readonly ProjectField[]
  onCreated: (field: ProjectField) => void
}) {
  const form = useForm<AddFieldValues>({
    resolver: zodResolver(AddFieldSchema),
    // From the shared constant, never the literal `'text'` — same rule as the options below.
    defaultValues: { name: '', type: CUSTOM_FIELD_TYPES[0] },
  })

  async function onSubmit(values: AddFieldValues) {
    const parsed = AddFieldSchema.parse(values)
    const result = await createProjectField({
      projectId,
      name: parsed.name,
      type: parsed.type,
      existing,
    })

    if (!result.ok) {
      // Both tags land at FORM level rather than on the name field, and for `'stale'` that is
      // the point: the name was never the problem, so a message under an input would invite
      // the user to edit the one thing that cannot help. Contrast `AddStatusForm`, where a
      // `'duplicate'` IS a correctable fact about that one input — there is no such tag here.
      form.setError('root', {
        message: result.error === 'stale' ? STALE_LIST : GENERIC_CREATE_ERROR,
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
          name="name"
          render={({ field }) => (
            <FormItem className="min-w-48 flex-1">
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input placeholder="Ship by" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="type"
          render={({ field }) => (
            <FormItem className="w-44">
              <FormLabel>Type</FormLabel>
              <FormControl>
                <select className={selectClass} {...field}>
                  {CUSTOM_FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {CUSTOM_FIELD_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <SubmitButton label="Add field" pendingLabel="Adding…" className="mt-6" />
        <div className="w-full">
          <FormRootError />
        </div>
      </form>
    </Form>
  )
}

/**
 * Gates a `select` field's options editor on `optionsPhase` — its OWN phase, not the field
 * list's `phase` above. Carried forward from Task 7's review rather than stated in this task's
 * brief: `CustomFieldOptions` takes no `phase` prop of its own (a deliberate Task 7 decision —
 * a single component rendering both a project's whole field set AND per-field options would
 * conflate two independent reads), so left ungated here it would render its own empty state
 * ("No options yet.") on a FAILED read exactly as readily as on a field that genuinely has
 * none — the identical S4.6 defect `CustomFieldBody` above already guards against for the field
 * list itself, one surface over. Same order of outcomes for the same reason: failure first
 * (an already-known failure must not be masked by a spinner, because nothing retries a
 * `loading` phase on its own), then loading, then the loaded content.
 *
 * There is deliberately no dedicated resource in `LoadFailure`'s closed union for this state —
 * adding one would touch a file this task does not otherwise change, so the failure notice is
 * written out locally instead, in the same shape (`role="alert"` plus a `Retry` button wired to
 * the shell's own `onRetry`, which reloads all five of the shell's reads together).
 */
function FieldOptionsGate({
  field,
  options,
  phase,
  onRetry,
  onCreated,
  onUpdated,
  onDeleted,
}: {
  field: ProjectField
  options: readonly ProjectFieldOption[]
  phase: ReadPhase
  onRetry: () => void
  onCreated: (option: ProjectFieldOption) => void
  onUpdated: (option: ProjectFieldOption) => void
  onDeleted: (fieldId: string, slug: string) => void
}) {
  if (phase === 'failed') {
    return (
      <div className="flex items-center gap-3">
        <p role="alert" className="text-destructive text-xs">
          Could not load this field&rsquo;s options.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    )
  }
  if (phase !== 'loaded') {
    return <p className="text-muted-foreground text-xs">Loading options…</p>
  }
  return (
    <CustomFieldOptions
      field={field}
      options={options}
      onCreated={onCreated}
      onUpdated={onUpdated}
      onDeleted={onDeleted}
    />
  )
}

/**
 * One custom field: its name, editable in place, and its type — plus, for a `select` field, the
 * options editor beneath the name (SPRIN-92 task 9).
 *
 * The rename call lives HERE rather than in the parent for the same reason `StatusRow`'s does:
 * with several rows on screen, a page-level banner would not say WHICH name was refused. The
 * row owns its own `role="alert"` region and nothing else on this surface reports a rename.
 *
 * **The TYPE is not editable, and its absence is a decision.** `authenticated` holds UPDATE on
 * `name` alone (migration B), so a control for it would be refused by Postgres before any
 * policy was consulted — and the immutability is load-bearing: epic story 3 denormalises
 * `field_type` onto each value row, which is only sound while a field's type cannot change.
 *
 * The three orderings inside `rename` are `StatusRow`'s, and each was paid for there:
 * parse first (the schema's own message explains a fixable name; the generic retry copy does
 * not), clear the previous error BEFORE the no-op check (otherwise a failed attempt's message
 * outlives it and goes on accusing a name the user has since reverted, about a request that
 * was never sent), and skip the request when the TRIMMED name is unchanged (`EditableText`
 * compares the raw draft, so `'Ship by '` reaches this function and is a no-op the database
 * would also see as one).
 *
 * **`options` is the WHOLE PROJECT's options, unfiltered**, exactly as `CustomFieldSettings`
 * receives the whole project's fields — `CustomFieldOptions` filters and sorts to this one
 * field internally (`optionsForField`), so a per-row fetch or pre-filter here would either
 * multiply reads or duplicate that filtering logic.
 */
function CustomFieldRow({
  field,
  options,
  optionsPhase,
  onUpdated,
  onRetryOptions,
  onOptionCreated,
  onOptionUpdated,
  onOptionDeleted,
}: {
  field: ProjectField
  options: readonly ProjectFieldOption[]
  optionsPhase: ReadPhase
  onUpdated: (field: ProjectField) => void
  onRetryOptions: () => void
  onOptionCreated: (option: ProjectFieldOption) => void
  onOptionUpdated: (option: ProjectFieldOption) => void
  onOptionDeleted: (fieldId: string, slug: string) => void
}) {
  const [error, setError] = useState<string | null>(null)

  async function rename(next: string) {
    const parsed = RenameFieldSchema.safeParse({ name: next })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? GENERIC_CREATE_ERROR)
      return
    }
    setError(null)
    if (parsed.data.name === field.name) return
    const result = await renameProjectField(field.id, parsed.data.name)
    if (!result.ok) {
      // No `'stale'` branch, and that is not an omission — the same reasoning `StatusRow`
      // records. A rename sends `name` alone, so it cannot reach
      // `project_fields_project_slug_unique`, the only constraint that produces that tag, and
      // there is no name constraint for it to reach instead. Telling the user to refresh
      // would be inventing a remedy for a failure we have no diagnosis of; generic retry copy
      // is the honest fallback.
      setError(GENERIC_CREATE_ERROR)
      return
    }
    onUpdated(result.value)
  }

  return (
    <li className="flex flex-col gap-2 px-3 py-2 text-sm">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <EditableText
            value={field.name}
            ariaLabel={`name of ${field.name}`}
            onCommit={(next) => void rename(next)}
          />
          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </div>
        <span className="text-muted-foreground shrink-0 text-xs">
          {CUSTOM_FIELD_TYPE_LABELS[field.type]}
        </span>
      </div>
      {field.type === 'select' ? (
        <FieldOptionsGate
          field={field}
          options={options}
          phase={optionsPhase}
          onRetry={onRetryOptions}
          onCreated={onOptionCreated}
          onUpdated={onOptionUpdated}
          onDeleted={onOptionDeleted}
        />
      ) : null}
    </li>
  )
}

/**
 * The project's custom field definitions: listed, renameable, and addable (SPRIN-90 built the
 * read; SPRIN-91 adds the two writes). Epic SPRIN-71.
 *
 * The list itself is the SHELL's, exactly as `StatusSettings`'s is — every write hands its
 * result up through `onCreated` / `onUpdated` so the shell patches the one copy every surface
 * reads. This component never keeps a second copy to mutate, which is why a failed write
 * leaves the rendered list exactly as it was with no rollback code anywhere.
 *
 * Deleting a field is story 6 and there is no control for it here: `authenticated` holds no
 * DELETE on `project_fields` at all, so nothing on this surface could write one even by
 * mistake.
 */
export function CustomFieldSettings({
  projectId,
  fields,
  phase,
  options,
  optionsPhase,
  onRetry,
  onCreated,
  onUpdated,
  onOptionCreated,
  onOptionUpdated,
  onOptionDeleted,
}: {
  projectId: string
  fields: readonly ProjectField[]
  phase: ReadPhase
  options: readonly ProjectFieldOption[]
  optionsPhase: ReadPhase
  onRetry: () => void
  onCreated: (field: ProjectField) => void
  onUpdated: (field: ProjectField) => void
  onOptionCreated: (option: ProjectFieldOption) => void
  onOptionUpdated: (option: ProjectFieldOption) => void
  onOptionDeleted: (fieldId: string, slug: string) => void
}) {
  return (
    <section className="flex flex-col gap-3" aria-labelledby="custom-fields-heading">
      <div className="flex flex-col gap-1">
        <h2 id="custom-fields-heading" className="text-sm font-semibold">
          Custom fields
        </h2>
        <p className="text-muted-foreground text-xs">
          Extra fields on this project&rsquo;s tickets, beyond the built-in ones.
        </p>
      </div>

      <CustomFieldBody
        projectId={projectId}
        fields={fields}
        phase={phase}
        options={options}
        optionsPhase={optionsPhase}
        onRetry={onRetry}
        onCreated={onCreated}
        onUpdated={onUpdated}
        onOptionCreated={onOptionCreated}
        onOptionUpdated={onOptionUpdated}
        onOptionDeleted={onOptionDeleted}
      />
    </section>
  )
}

/**
 * The list and the add form, split out so `CustomFieldSettings` stays a plain wrapper and the
 * whole phase decision sits in one place. Three outcomes, in the order this project's other
 * tabs use: failure first, then loading, then the list (which may legitimately be empty).
 *
 * Failure BEFORE loading, matching `firstUnready`'s rule — an already-known failure must not
 * be masked by a spinner, because nothing retries a `loading` phase on its own.
 *
 * **The phase is consulted before the list, and here that is not a formality.** Every other
 * surface in this app treats "empty" as a rare state; for custom fields it is the DEFAULT —
 * every project starts with zero and nothing seeds them. So `[]` from a failed read and `[]`
 * from a project that simply has no custom fields are the same value arriving for opposite
 * reasons, and rendering the empty state over a failure would be a confident claim about a
 * list we do not have. That is S4.6's defect, and this is the surface where it is easiest to
 * ship.
 *
 * **The ADD FORM is inside that gate too, which is this story's own placement decision.**
 * `createProjectField` derives its collision-free slug from the rows it is handed, so an add
 * against a degraded read derives from `[]` — it would send `ship_by` over a project that
 * already has one and come back `23505`, i.e. the `'stale'` tag, on the user's very first
 * attempt with no stale list to blame. `SettingsTab` records the identical reasoning for
 * `max(position)+1` on the statuses side. Offering the form only once the list is real is
 * therefore the same rule the read gate already states, not an extra one: do not act on a
 * list we do not have. It also keeps the failure surface honest — Retry, rather than a form
 * whose submit is primed to fail.
 */
function CustomFieldBody({
  projectId,
  fields,
  phase,
  options,
  optionsPhase,
  onRetry,
  onCreated,
  onUpdated,
  onOptionCreated,
  onOptionUpdated,
  onOptionDeleted,
}: {
  projectId: string
  fields: readonly ProjectField[]
  phase: ReadPhase
  options: readonly ProjectFieldOption[]
  optionsPhase: ReadPhase
  onRetry: () => void
  onCreated: (field: ProjectField) => void
  onUpdated: (field: ProjectField) => void
  onOptionCreated: (option: ProjectFieldOption) => void
  onOptionUpdated: (option: ProjectFieldOption) => void
  onOptionDeleted: (fieldId: string, slug: string) => void
}) {
  if (phase === 'failed') return <LoadFailure resource="custom fields" onRetry={onRetry} />
  if (phase !== 'loaded') return <p className="text-muted-foreground text-sm">Loading…</p>

  return (
    <>
      <CustomFieldList
        fields={fields}
        options={options}
        optionsPhase={optionsPhase}
        onUpdated={onUpdated}
        onRetryOptions={onRetry}
        onOptionCreated={onOptionCreated}
        onOptionUpdated={onOptionUpdated}
        onOptionDeleted={onOptionDeleted}
      />
      <AddFieldForm projectId={projectId} existing={fields} onCreated={onCreated} />
    </>
  )
}

/**
 * The loaded list, or the empty state.
 *
 * **`<ul>`/`<li>`, reversing SPRIN-90's `<dl>` — because that choice's premise has gone.**
 * Story 1's docblock argued a `<dl>` on two grounds: each row was a term and its definition,
 * and each entry's accessible name stayed a single text node (this codebase having already
 * spent a story on names fused by flex layout under jsdom). Neither survives this story. The
 * name is now an `EditableText` button and the row carries its own error region, so a row is
 * an item WITH CONTROLS rather than a term/definition pair — which is exactly what
 * `StatusSettings` renders as an `<li>`. The name concern is answered better than the `<dl>`
 * answered it: the button takes its own `aria-label` from `EditableText`, one attribute rather
 * than a composed name, so nothing here is exposed to the fusion at all. Recorded so the diff
 * does not read as an unexplained rewrite: reversing a decision because its premise changed is
 * the correct move, not churn.
 */
function CustomFieldList({
  fields,
  options,
  optionsPhase,
  onUpdated,
  onRetryOptions,
  onOptionCreated,
  onOptionUpdated,
  onOptionDeleted,
}: {
  fields: readonly ProjectField[]
  options: readonly ProjectFieldOption[]
  optionsPhase: ReadPhase
  onUpdated: (field: ProjectField) => void
  onRetryOptions: () => void
  onOptionCreated: (option: ProjectFieldOption) => void
  onOptionUpdated: (option: ProjectFieldOption) => void
  onOptionDeleted: (fieldId: string, slug: string) => void
}) {
  if (fields.length === 0) {
    return (
      <p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
        No custom fields yet.
      </p>
    )
  }

  return (
    <ul className="divide-border divide-y rounded-lg border">
      {fields.map((field) => (
        <CustomFieldRow
          key={field.id}
          field={field}
          options={options}
          optionsPhase={optionsPhase}
          onUpdated={onUpdated}
          onRetryOptions={onRetryOptions}
          onOptionCreated={onOptionCreated}
          onOptionUpdated={onOptionUpdated}
          onOptionDeleted={onOptionDeleted}
        />
      ))}
    </ul>
  )
}
