import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'

import { createSprint } from '@/lib/sprints'
import { CreateSprintSchema, type CreateSprintValues } from '@/lib/sprint-schemas'
import type { Sprint } from '@/lib/domain'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'

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
  const [open, setOpen] = useState(false)

  const form = useForm<CreateSprintValues>({
    resolver: zodResolver(CreateSprintSchema),
    defaultValues: { name: '', goal: '', startDate: '', endDate: '' },
  })

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) form.reset()
  }

  async function onSubmit(values: CreateSprintValues) {
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
      form.setError('root', { message: 'Something went wrong. Please try again.' })
      return
    }

    onCreated?.(result.sprint)
    handleOpenChange(false)
  }

  const rootError = form.formState.errors.root?.message

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">New sprint</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a sprint</DialogTitle>
          <DialogDescription>
            It starts as a future sprint. Everything here is optional — leave the name blank and
            we will number it for you.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
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

            {rootError ? (
              <p role="alert" className="text-destructive text-sm">
                {rootError}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Creating…' : 'Create sprint'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
