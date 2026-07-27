import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { createTicket } from '@/lib/tickets'
import { parseLabels } from '@/lib/labels'
import { TICKET_TYPES, TICKET_TYPE_LABELS, type Ticket, type TicketType } from '@/lib/domain'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { selectClass } from './form-primitives'
import { CreateDialog } from './CreateDialog'

const CreateTicketSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1, 'Summary is required')
    .max(200, 'Keep the summary to 200 characters or fewer'),
  type: z.enum([...TICKET_TYPES] as [TicketType, ...TicketType[]]),
  description: z.string().trim().max(2000).optional(),
  // Kept a string on the form (so the input stays controlled); parsed to a number at
  // submit. Empty means "no estimate". Digits only, ≤ 3, so it stays a sane int.
  storyPoints: z
    .string()
    .trim()
    .regex(/^\d{0,3}$/, 'Whole numbers only')
    .optional(),
  labels: z.string().optional(),
  acceptanceCriteria: z.string().trim().max(2000).optional(),
})
type CreateTicketValues = z.input<typeof CreateTicketSchema>

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

  async function onSubmit(values: CreateTicketValues, close: () => void) {
    const parsed = CreateTicketSchema.parse(values)
    const result = await createTicket({
      projectId,
      summary: parsed.summary,
      type: parsed.type,
      description: parsed.description?.trim() || undefined,
      storyPoints: parsed.storyPoints ? Number(parsed.storyPoints) : undefined,
      labels: parseLabels(parsed.labels),
      acceptanceCriteria: parsed.acceptanceCriteria?.trim() || undefined,
    })

    if (!result.ok) {
      form.setError('root', { message: 'Something went wrong. Please try again.' })
      return
    }

    onCreated?.(result.ticket)
    close()
  }

  return (
    <CreateDialog
      trigger="New ticket"
      title="Create a ticket"
      description="It gets the next key in this project automatically."
      submitLabel="Create ticket"
      form={form}
      onSubmit={onSubmit}
    >
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
    </CreateDialog>
  )
}
