import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import { createSprint } from '@/lib/sprints'
import { CreateSprintSchema, type CreateSprintValues } from '@/lib/sprint-schemas'
import type { Sprint } from '@/lib/domain'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { CreateDialog, GENERIC_CREATE_ERROR, type SubmitActions } from './CreateDialog'

/**
 * Create-sprint dialog. `status` is not on this form and is never sent — the column
 * defaults to `'future'`, which is S6.1's AC. Every field is optional; a blank name is
 * filled in by `defaultSprintName`, which is why the project's existing sprints are passed
 * down rather than re-fetched here.
 *
 * The date inputs are native `<input type="date">`. They render in the user's own locale
 * (a UK browser shows 20/07/2026, a US one 07/20/2026) and that is not restylable — but
 * the value they yield is always ISO `YYYY-MM-DD`, which is what both the schema's
 * ordering check and `toUtcMidnight` consume.
 */
export function CreateSprintDialog({
  projectId,
  existing,
  onCreated,
}: {
  projectId: string
  existing: readonly Sprint[]
  onCreated?: (sprint: Sprint) => void
}) {
  const form = useForm<CreateSprintValues>({
    resolver: zodResolver(CreateSprintSchema),
    defaultValues: { name: '', goal: '', startDate: '', endDate: '' },
  })

  async function onSubmit(
    values: CreateSprintValues,
    { close, setError }: SubmitActions<CreateSprintValues>,
  ) {
    const parsed = CreateSprintSchema.parse(values)
    const result = await createSprint({
      projectId,
      // `|| undefined` collapses '' to absent: the form always holds strings, but
      // `createSprint` distinguishes "not given" from "given as empty".
      name: parsed.name?.trim() || undefined,
      goal: parsed.goal?.trim() || undefined,
      startDate: parsed.startDate || undefined,
      endDate: parsed.endDate || undefined,
      existing,
    })

    if (!result.ok) {
      setError('root', { message: GENERIC_CREATE_ERROR })
      return
    }

    onCreated?.(result.sprint)
    close()
  }

  return (
    <CreateDialog
      trigger="New sprint"
      title="Create a sprint"
      description="It starts as a future sprint. Everything here is optional — leave the name blank and we will number it for you."
      submitLabel="Create sprint"
      form={form}
      onSubmit={onSubmit}
    >
      <FormField
        control={form.control}
        name="name"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Name</FormLabel>
            <FormControl>
              <Input placeholder="Sprint 1" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="goal"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Goal</FormLabel>
            <FormControl>
              <Textarea rows={2} placeholder="Ship the board" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid grid-cols-2 gap-4">
        <FormField
          control={form.control}
          name="startDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Start date</FormLabel>
              <FormControl>
                <Input type="date" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="endDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>End date</FormLabel>
              <FormControl>
                <Input type="date" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </CreateDialog>
  )
}
