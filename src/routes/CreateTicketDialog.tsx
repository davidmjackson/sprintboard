import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { createTicket } from '@/lib/tickets'
import { TICKET_TYPES, TICKET_TYPE_LABELS, type Ticket, type TicketType } from '@/lib/domain'
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

const CreateTicketSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1, 'Summary is required')
    .max(200, 'Keep the summary to 200 characters or fewer'),
  type: z.enum([...TICKET_TYPES] as [TicketType, ...TicketType[]]),
  description: z.string().trim().max(2000).optional(),
  // Empty input means "no estimate": map '' to undefined before coercing to a number.
  storyPoints: z.preprocess(
    (v) => (v === '' || v == null ? undefined : v),
    z.coerce.number().int('Whole numbers only').min(0, 'Cannot be negative').max(999).optional(),
  ),
  labels: z.string().optional(),
  acceptanceCriteria: z.string().trim().max(2000).optional(),
})
type CreateTicketValues = z.input<typeof CreateTicketSchema>

/** "ui, urgent ," -> ["ui", "urgent"]. Trims, drops blanks. */
function parseLabels(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
}

// The type field is a native <select> styled like Input — a fixed four-option enum
// where a native control is honest and easy to test, and needs no extra dependency.
const selectClass =
  'border-input focus-visible:border-ring focus-visible:ring-ring/50 h-8 w-full rounded-lg border bg-transparent px-2.5 py-1 text-base transition-colors outline-none focus-visible:ring-3 md:text-sm'

/**
 * Create-ticket dialog. The key and number are assigned by the database trigger and
 * the status defaults to To Do, so neither is on this form. Validation is at both
 * edges: zod here, checks and the trigger in the database.
 */
export function CreateTicketDialog({
  projectId,
  onCreated,
}: {
  projectId: string
  onCreated?: (ticket: Ticket) => void
}) {
  const [open, setOpen] = useState(false)

  const form = useForm<CreateTicketValues>({
    resolver: zodResolver(CreateTicketSchema),
    defaultValues: {
      summary: '',
      type: 'story',
      description: '',
      storyPoints: '',
      labels: '',
      acceptanceCriteria: '',
    },
  })

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) form.reset()
  }

  async function onSubmit(values: CreateTicketValues) {
    const parsed = CreateTicketSchema.parse(values)
    const result = await createTicket({
      projectId,
      summary: parsed.summary,
      type: parsed.type,
      description: parsed.description?.trim() || undefined,
      storyPoints: parsed.storyPoints,
      labels: parseLabels(parsed.labels),
      acceptanceCriteria: parsed.acceptanceCriteria?.trim() || undefined,
    })

    if (!result.ok) {
      form.setError('root', { message: 'Something went wrong. Please try again.' })
      return
    }

    onCreated?.(result.ticket)
    handleOpenChange(false)
  }

  const rootError = form.formState.errors.root?.message

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">New ticket</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a ticket</DialogTitle>
          <DialogDescription>
            It gets the next key in this project automatically.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
            <FormField
              control={form.control}
              name="summary"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Summary</FormLabel>
                  <FormControl>
                    <Input placeholder="Wire the board" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <FormControl>
                    <select className={selectClass} {...field}>
                      {TICKET_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {TICKET_TYPE_LABELS[type]}
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
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="storyPoints"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Story points</FormLabel>
                  <FormControl>
                    <Input type="number" min={0} inputMode="numeric" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="labels"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Labels</FormLabel>
                  <FormControl>
                    <Input placeholder="ui, backend" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="acceptanceCriteria"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Acceptance criteria</FormLabel>
                  <FormControl>
                    <Textarea rows={3} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {rootError ? (
              <p role="alert" className="text-destructive text-sm">
                {rootError}
              </p>
            ) : null}

            <DialogFooter>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Creating…' : 'Create ticket'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
