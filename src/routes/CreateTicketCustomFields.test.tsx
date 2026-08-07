import { render, screen } from '@testing-library/react'
import { useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'

import { Form } from '@/components/ui/form'
import type { ProjectField } from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import type { CreateTicketValues } from '@/lib/ticket-schemas'
import { CreateTicketCustomFields } from './CreateTicketCustomFields'

/**
 * Mirrors `field()` at `src/routes/TicketCustomFields.test.tsx:50`: no id derived from the
 * slug, no slug from the name, and every fixture below uses a DIFFERENT type — the two
 * confounds that story's spec named. An id-from-slug fixture would make a production read of
 * `field.id` and one of `field.slug` indistinguishable, and an all-`text` fixture would make
 * "renders the control the type calls for" indistinguishable from "always renders text".
 */
function field(overrides: Partial<ProjectField> = {}): ProjectField {
  return {
    id: 'f-9a3',
    project_id: 'p1',
    slug: 'cust_ref',
    name: 'Customer ref',
    type: 'text',
    created_at: '2026-08-01T00:00:00+00:00',
    ...overrides,
  } as ProjectField
}

const TEXT = field()
const PARAGRAPH = field({
  id: 'f-4b1',
  slug: 'notes_long',
  name: 'Delivery notes',
  type: 'paragraph',
})
const NUMBER = field({ id: 'f-2c7', slug: 'tier', name: 'Priority level', type: 'number' })
const DATE = field({ id: 'f-7e5', slug: 'target', name: 'Go live', type: 'date' })
const SELECT = field({ id: 'f-1d8', slug: 'band', name: 'Colour', type: 'select' })

function Harness({ fields, fieldsPhase }: { fields?: ProjectField[]; fieldsPhase?: ReadPhase }) {
  const form = useForm<CreateTicketValues>({ defaultValues: { custom: {} } })
  return (
    <Form {...form}>
      <CreateTicketCustomFields control={form.control} fields={fields} fieldsPhase={fieldsPhase} />
    </Form>
  )
}

describe('CreateTicketCustomFields', () => {
  it('renders one labelled control per custom field', () => {
    render(<Harness fields={[TEXT, NUMBER, DATE]} fieldsPhase="loaded" />)

    // getByLabelText, not getByText: it proves the LABEL IS ASSOCIATED with the control, which
    // is what FormControl's cloning provides and what a component wrapper would silently break.
    expect(screen.getByLabelText('Customer ref')).toBeInTheDocument()
    expect(screen.getByLabelText('Priority level')).toBeInTheDocument()
    expect(screen.getByLabelText('Go live')).toBeInTheDocument()
  })

  it('renders each type as its own control', () => {
    render(<Harness fields={[PARAGRAPH, NUMBER, DATE, SELECT]} fieldsPhase="loaded" />)

    expect(screen.getByLabelText('Delivery notes').tagName).toBe('TEXTAREA')
    expect(screen.getByLabelText('Priority level')).toHaveAttribute('type', 'number')
    expect(screen.getByLabelText('Go live')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('Colour')).toBeDisabled()
  })

  it('does not floor a custom number field at zero', () => {
    // min=0 is the STORY POINTS rule — a property of estimation, not of arithmetic. A custom
    // number field might be a temperature, a variance or a balance. SPRIN-88 moved that bound to
    // the story-points call site that owns it; this is the create-side half of the same rule.
    render(<Harness fields={[NUMBER]} fieldsPhase="loaded" />)
    expect(screen.getByLabelText('Priority level')).not.toHaveAttribute('min')
  })

  it('renders nothing when the project has no custom fields', () => {
    const { container } = render(<Harness fields={[]} fieldsPhase="loaded" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when no field wiring is supplied at all', () => {
    // The defaults live HERE, so a standalone <CreateTicketDialog projectId="p1" /> — which is
    // how the seven existing dialog tests render it — is completely unchanged. AC5.
    const { container } = render(<Harness />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says so when the definitions read failed, and renders no controls', () => {
    render(<Harness fields={[]} fieldsPhase="failed" />)

    expect(screen.getByRole('status')).toHaveTextContent(
      /^Custom fields couldn.t be loaded\. You can set them on the ticket after it.s created\.$/,
    )
    // A raw DOM query, because queryByRole EXCLUDES aria-hidden subtrees and would report
    // "absent" for a control that is still in the DOM and still keyboard-reachable.
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0)
  })

  it('shows a loading line rather than empty controls while the definitions load', () => {
    // An empty control says "this ticket has no value for this field" in the only language a
    // control has. Rendering one before the definitions are known invites the user to fill in a
    // field that may not exist.
    render(<Harness fields={[]} fieldsPhase="loading" />)

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(document.querySelectorAll('input, textarea, select')).toHaveLength(0)
  })
})
