import { useState } from 'react'
import { useForm, type UseFormSetError } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { z } from 'zod'

import { createTicket } from '@/lib/tickets'
import { parseLabels } from '@/lib/labels'
import {
  insertTicketFieldValues,
  parseFieldValues,
  ticketFieldValueRows,
} from '@/lib/ticket-field-values'
import { CreateTicketSchema, type CreateTicketValues } from '@/lib/ticket-schemas'
import { TICKET_TYPES, TICKET_TYPE_LABELS, type ProjectField, type Ticket } from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { selectClass } from './form-primitives'
import { CreateDialog, GENERIC_CREATE_ERROR, type SubmitActions } from './CreateDialog'
import { CreateTicketCustomFields } from './CreateTicketCustomFields'

/** The form's fixed fields as `createTicket`'s input. Extracted from `onSubmit` so the custom
 *  field branches fit inside T2 — it carried five of that function's eight cyclomatic points. */
function ticketInput(parsed: z.output<typeof CreateTicketSchema>, projectId: string) {
  return {
    projectId,
    summary: parsed.summary,
    type: parsed.type,
    description: parsed.description?.trim() || undefined,
    storyPoints: parsed.storyPoints ? Number(parsed.storyPoints) : undefined,
    labels: parseLabels(parsed.labels),
    acceptanceCriteria: parsed.acceptanceCriteria?.trim() || undefined,
  }
}

/** AC4. Names the ticket so the user can find it, and every field that did not save so they
 *  know exactly what to re-enter. A silent success is the one outcome ruled out. */
function unsavedFieldsMessage(ticketKey: string, fields: ProjectField[]): string {
  return `Created ${ticketKey}, but couldn’t save: ${fields
    .map((f) => f.name)
    .join(', ')}. Set them on the ticket.`
}

/** Puts each bad custom value's message on its own field. Extracted from `onSubmit` — the
 *  `for` loop was its own cyclomatic point, and this is the one clean extraction available
 *  without contorting the submit sequence's own parse→create→write ordering. */
function applyFieldErrors(
  errors: Array<{ fieldId: string; message: string }>,
  setError: UseFormSetError<CreateTicketValues>,
) {
  for (const e of errors) setError(`custom.${e.fieldId}`, { message: e.message })
}

/**
 * Create-ticket dialog. The key and number are assigned by the database trigger and
 * the status defaults to To Do, so neither is on this form. Validation is at both
 * edges: zod here, checks and the trigger in the database.
 */
export function CreateTicketDialog({
  projectId,
  onCreated,
  fields,
  fieldsPhase,
}: {
  projectId: string
  onCreated?: (ticket: Ticket) => void
  fields?: ProjectField[]
  fieldsPhase?: ReadPhase
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
      custom: {},
    },
  })
  const [created, setCreated] = useState(false)

  async function onSubmit(
    values: CreateTicketValues,
    { close, setError }: SubmitActions<CreateTicketValues>,
  ) {
    const parsed = CreateTicketSchema.parse(values)

    // FIRST, before anything is written: a bad value must not cost the user a ticket.
    const drafts = parseFieldValues(fields ?? [], parsed.custom ?? {})
    if (!drafts.ok) {
      applyFieldErrors(drafts.errors, setError)
      return
    }

    const result = await createTicket(ticketInput(parsed, projectId))
    if (!result.ok) {
      setError('root', { message: GENERIC_CREATE_ERROR })
      return
    }

    // The ticket is real. It reaches the board whatever the values write does — withholding
    // it would be the invisible-create defect ProjectShellHeader's own gate exists to prevent.
    onCreated?.(result.ticket)

    const written = await insertTicketFieldValues(
      ticketFieldValueRows(result.ticket, drafts.writes),
    )
    if (!written.ok) {
      // The dialog stays OPEN and its submit LATCHES. Retrying is right everywhere else
      // here, because everywhere else an error means nothing was written — this is the one
      // state where pressing Create again makes a second ticket.
      setError('root', {
        message: unsavedFieldsMessage(
          result.ticket.key,
          drafts.writes.map((w) => w.field),
        ),
      })
      setCreated(true)
      return
    }

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
      onClosed={() => setCreated(false)}
      submitDisabled={created}
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

      <CreateTicketCustomFields control={form.control} fields={fields} fieldsPhase={fieldsPhase} />
    </CreateDialog>
  )
}
