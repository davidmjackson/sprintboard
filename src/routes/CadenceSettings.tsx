import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import type { Project, SprintCadence } from '@/lib/domain'
import { cadenceSummary, SPRINT_LENGTH_WEEKS, SPRINT_WEEKDAYS } from '@/lib/domain'
import { CadenceSchema, type CadenceValues } from '@/lib/cadence-schemas'
import { updateProjectCadence } from '@/lib/projects'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { GENERIC_CREATE_ERROR } from './CreateDialog'
import { FormRootError, selectClass, SubmitButton } from './form-primitives'

/**
 * What a `'forbidden'` write result means in words, and why it is not the generic retry copy.
 *
 * `updateProjectCadence` maps `42501` — and only `42501` — to this tag, which on this path can
 * have exactly one author: the column grant SPRIN-97's migration B adds is missing (the payload
 * never writes `owner_id`, so the RLS `WITH CHECK` that shares the SQLSTATE cannot fire here).
 * That is a permanent state of the database, fixed only by running SQL, so the generic
 * "please try again" would invite a retry that fails identically forever. The sentence says the
 * one true thing a user can act on: this is not something pressing the button again will solve.
 *
 * Reported at FORM level rather than on either field, for the reason `STALE_LIST` gives in
 * `StatusSettings`: neither the length nor the start day was the problem, and a message under a
 * picker invites the user to change the one thing that cannot help.
 */
const NO_PERMISSION =
  'You do not have permission to change this project’s sprint cadence — retrying will not help.'

/**
 * The project's sprint cadence — a section of the Settings tab beside `StatusSettings` and
 * `CustomFieldSettings`, read-only in SPRIN-94 and a form since SPRIN-97.
 *
 * **No local mirror of the cadence, and that is the whole of AC3.** The summary line and the
 * form's `defaultValues` both come from the `cadence` prop, which is the caller's copy; every
 * successful write hands the database's own returned row up through `onUpdated` instead of
 * being applied here. A failed write therefore simply never calls `onUpdated`, and "the
 * previous values remain shown" is true with no rollback code to get wrong — the same
 * discipline `StatusSettings` uses for its list.
 *
 * It takes `projectId` rather than a whole `Project` for the same reason it takes a
 * `SprintCadence` rather than reading `project.sprint_length_weeks`: the narrowest shape it
 * needs, and no opinion about project type. `SettingsTab` decides whether this section exists
 * at all, which keeps the project-type comparison in the one place
 * `src/test/project-type-single-expression.test.ts` can see it.
 *
 * Both pickers are built from `SPRINT_LENGTH_WEEKS` / `SPRINT_WEEKDAYS`, the same two arrays
 * `CadenceSchema` validates against — so the set the form accepts and the set the user can
 * choose from are the same object, and neither a weekday label nor a length value is written
 * out here. Native `<select>`, per `selectClass`'s own note.
 */
export function CadenceSettings({
  projectId,
  cadence,
  onUpdated,
}: {
  projectId: string
  cadence: SprintCadence
  onUpdated: (project: Project) => void
}) {
  const form = useForm<CadenceValues>({
    resolver: zodResolver(CadenceSchema),
    // The project's CURRENT cadence, so the form opens on what the section states above it
    // rather than on a default that would silently propose a change nobody asked for.
    defaultValues: cadence,
  })

  async function onSubmit(values: CadenceValues) {
    // Re-parsed before the write, exactly as `AddStatusForm` does — but be precise about what
    // this line buys, because it was measured rather than assumed. At RUNTIME it is a no-op:
    // `zodResolver` hands `handleSubmit` the schema's OUTPUT, so the `<select>`'s string has
    // already become a number by the time `onSubmit` is entered (deleting this line and casting
    // instead left all 32 tests in this pair green). What it buys is the TYPE: `values` is
    // `CadenceValues`, i.e. `z.input`, whose fields are `string | number` and are therefore not
    // a `SprintCadence`. Parsing is how the number reaches the write without a cast that would
    // let a genuine string through unnoticed. The coercion itself is pinned in
    // `cadence-schemas.test.ts`, and end-to-end by this component's own write test.
    const parsed = CadenceSchema.parse(values)
    const result = await updateProjectCadence(projectId, parsed)

    if (!result.ok) {
      form.setError('root', {
        message: result.error === 'forbidden' ? NO_PERMISSION : GENERIC_CREATE_ERROR,
      })
      return
    }

    onUpdated(result.project)
  }

  return (
    <section aria-labelledby="cadence-settings-heading" className="flex flex-col gap-2">
      <h2 id="cadence-settings-heading" className="text-lg font-semibold">
        Sprint cadence
      </h2>
      <p className="text-sm">{cadenceSummary(cadence)}</p>
      {/* NO EXPLANATORY LINE, DELIBERATELY. The obvious sentence here — "new sprints are
          suggested from this" — describes behaviour NEITHER THIS STORY NOR SPRIN-94 SHIPS.
          The pre-fill is SPRIN-96; until it lands the cadence is inert, and a form that
          saves a setting nothing reads yet is honest where a sentence promising the pre-fill
          would be a false claim a user can read. SPRIN-96 adds the sentence when it becomes
          true. */}

      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-wrap items-start gap-3"
          noValidate
        >
          <FormField
            control={form.control}
            name="sprint_length_weeks"
            render={({ field }) => (
              <FormItem className="w-40">
                <FormLabel>Sprint length</FormLabel>
                <FormControl>
                  <select className={selectClass} {...field}>
                    {SPRINT_LENGTH_WEEKS.map((weeks) => (
                      <option key={weeks} value={weeks}>
                        {weeks} {weeks === 1 ? 'week' : 'weeks'}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="sprint_start_weekday"
            render={({ field }) => (
              <FormItem className="w-40">
                <FormLabel>Start day</FormLabel>
                <FormControl>
                  <select className={selectClass} {...field}>
                    {SPRINT_WEEKDAYS.map((weekday) => (
                      <option key={weekday.iso} value={weekday.iso}>
                        {weekday.label}
                      </option>
                    ))}
                  </select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <SubmitButton label="Save cadence" pendingLabel="Saving…" className="mt-6" />
          <div className="w-full">
            <FormRootError />
          </div>
        </form>
      </Form>
    </section>
  )
}
