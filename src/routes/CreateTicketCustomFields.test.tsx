import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'
import { describe, expect, it } from 'vitest'

import { Form } from '@/components/ui/form'
import type { ProjectField, ProjectFieldOption } from '@/lib/domain'
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

/** A SECOND `select` field, deliberately kept separate from `SELECT` above — mirroring
 *  `TicketCustomFields.test.tsx`'s `RISK`/`SELECT` split, so the select-behaviour describe block
 *  below never shares a fixture with the "one control per type" tests above it. */
const RISK = field({ id: 'f-r1k', slug: 'risk', name: 'Risk', type: 'select' })
const LOW = { project_id: 'p1', field_id: RISK.id, slug: 'low', label: 'Low', position: 1 }
const HIGH = { project_id: 'p1', field_id: RISK.id, slug: 'high', label: 'High', position: 2 }
const OPTIONS = [LOW, HIGH] satisfies ProjectFieldOption[]

function Harness({
  fields,
  fieldsPhase,
  options,
  optionsPhase,
}: {
  fields?: ProjectField[]
  fieldsPhase?: ReadPhase
  options?: ProjectFieldOption[]
  optionsPhase?: ReadPhase
}) {
  const form = useForm<CreateTicketValues>({ defaultValues: { custom: {} } })
  return (
    <Form {...form}>
      <CreateTicketCustomFields
        control={form.control}
        fields={fields}
        fieldsPhase={fieldsPhase}
        // `options` is REQUIRED on `CreateTicketCustomFields` (fix round 1) — this helper is the
        // one place supplying a convenience `[]` default for the many callers below that never
        // touch a `select` field, mirroring `optionsPhase`'s own `?? 'loading'` immediately
        // below.
        options={options ?? []}
        // `optionsPhase` is REQUIRED on `CreateTicketCustomFields` — no default, mirroring
        // `TicketCustomFields.test.tsx`'s `renderFields` helper. `'loading'` is the SAFE
        // convenience default for the many callers below that never touch a `select` field: it
        // fails closed, so a caller that forgets `optionsPhase` gets a disabled select rather
        // than a silently trusted empty one.
        optionsPhase={optionsPhase ?? 'loading'}
      />
    </Form>
  )
}

/** Renders one row OUTSIDE a dialog, with a reset button INSIDE the harness — for the reset
 *  test, which must call `form.reset()` directly rather than close-and-reopen a dialog. Radix
 *  UNMOUNTS dialog content on close, so a close/reopen test would pass even with the reset
 *  removed; see `CreateTicketDialog.test.tsx`'s own docblock on this exact trap.
 *
 *  The reset is fired from a button INSIDE the harness rather than through a captured `form`
 *  handle, mirroring `ResetHarness` above: reassigning a variable declared outside a component
 *  during render is a side effect, and `react-hooks/globals` rejects it. */
function renderRowWithForm(props: {
  field: ProjectField
  options?: ProjectFieldOption[]
  optionsPhase?: ReadPhase
}) {
  function ResetRowHarness() {
    const form = useForm<CreateTicketValues>({ defaultValues: { custom: {} } })
    return (
      <Form {...form}>
        <CreateTicketCustomFields
          control={form.control}
          fields={[props.field]}
          fieldsPhase="loaded"
          options={props.options ?? []}
          optionsPhase={props.optionsPhase ?? 'loaded'}
        />
        <button type="button" onClick={() => form.reset()}>
          Reset the form
        </button>
      </Form>
    )
  }
  return render(<ResetRowHarness />)
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

  it('renders the controls in the same DOM order as the fields array', () => {
    // `listProjectFields` sorts by `(created_at, slug)` and the shell passes that list straight
    // through — the database decides the order, and this component is supposed to preserve it.
    // A raw DOM query in document order, not `getByLabelText` per field: every per-field
    // assertion elsewhere in this file is order-agnostic by design, so none of them would
    // notice `fields.map` being replaced with a reversed copy. Each `FormLabel` is a single
    // text node, so reading `textContent` here is not the composed-accessible-name hazard
    // CLAUDE.md warns about — it is one label's own text, exactly.
    const { container } = render(<Harness fields={[DATE, TEXT, NUMBER]} fieldsPhase="loaded" />)

    const labels = Array.from(container.querySelectorAll('label')).map((el) => el.textContent)
    expect(labels).toEqual(['Go live', 'Customer ref', 'Priority level'])
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

  /**
   * The control on `rhf.value ?? ''`, and it has to live HERE rather than in
   * `CreateTicketDialog.test.tsx`. That file's close-and-reopen test cannot pin the fallback for
   * two independent reasons: radix unmounts the dialog content on close, so the control remounts
   * fresh on reopen whether or not the reset did anything; and `CreateTicketDialog`'s
   * `defaultValues` carry no `custom` key, so `rhf.value` is `undefined` from birth and no render
   * ever observes the controlled→uncontrolled transition. Mutating the fallback away left all
   * 1153 tests green, with no React warning.
   *
   * Rendered outside a dialog, under a `useForm` whose defaults DO include `custom: {}`, the
   * transition is real: the control mounts controlled at `''`, takes a typed value, and
   * `form.reset()` then restores `custom` to `{}` — at which point this path has no value. A bare
   * `value={rhf.value}` hands React `undefined`, the input goes uncontrolled, and it KEEPS the
   * text already in the DOM node rather than clearing.
   */
  it('keeps the control controlled across a form.reset()', async () => {
    // `form.reset()` is fired from a button INSIDE the harness rather than through a captured
    // `form` handle: reassigning a variable declared outside a component during render is a side
    // effect, and `react-hooks/globals` rejects it.
    function ResetHarness() {
      const form = useForm<CreateTicketValues>({ defaultValues: { custom: {} } })
      return (
        <Form {...form}>
          <CreateTicketCustomFields
            control={form.control}
            fields={[TEXT]}
            fieldsPhase="loaded"
            // TEXT is not a `select` field, so `options` is genuinely inert to this test — `[]`
            // is the honest value, not a compiler-silencing placeholder.
            options={[]}
            optionsPhase="loaded"
          />
          <button type="button" onClick={() => form.reset()}>
            Reset the form
          </button>
        </Form>
      )
    }

    const user = userEvent.setup()
    render(<ResetHarness />)

    await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
    expect(screen.getByLabelText('Customer ref')).toHaveValue('ACME-1')

    await user.click(screen.getByRole('button', { name: 'Reset the form' }))

    // Nothing remounted, so an empty value here is the FALLBACK doing its job and not a fresh
    // control. `toHaveValue('')` is what an uncontrolled input fails: it keeps 'ACME-1'.
    expect(screen.getByLabelText('Customer ref')).toHaveValue('')
    // And it is still a controlled element — React only sets the `value` PROPERTY on one it
    // owns, so a `value` attribute alone would not distinguish the two.
    expect(screen.getByLabelText('Customer ref')).toHaveAttribute('value', '')
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

/**
 * SPRIN-92 task 11 — the create dialog's own `select` control, mirroring task 10's
 * `TicketCustomFields.test.tsx` block of the same name. The two controls share none of their
 * implementation (`CREATE_CONTROLS` is a separate map from `TicketCustomFields`'s `CONTROLS`:
 * the create dialog's are plain react-hook-form inputs, never `EditableText`'s commit-on-blur),
 * so the behaviours are pinned again here rather than assumed to follow from the sidebar's own
 * coverage.
 */
describe('the select control offers real options (SPRIN-92)', () => {
  it('offers a blank choice FIRST, then the options in order', () => {
    render(<Harness fields={[RISK]} options={OPTIONS} optionsPhase="loaded" />)

    const select = screen.getByRole('combobox', { name: 'Risk' })
    const opts = within(select).getAllByRole('option')
    expect(opts[0]).toHaveValue('')
    expect(opts.map((o) => o.textContent)).toEqual(['—', 'Low', 'High'])
  })

  /**
   * The `optionsForField` SLICE. Every other test in this block renders ONE select field, so
   * dropping the slice (`options={options}` in the map) hands that single control the same
   * array either way and nothing notices. Two select fields, each with options, is the only
   * arrangement that separates them — the identical gap, and the identical fix, as the sidebar's
   * own block in `TicketCustomFields.test.tsx`.
   */
  it('gives each select field ONLY its own options, never the whole project’s', () => {
    const COLOURS = [
      { project_id: 'p1', field_id: SELECT.id, slug: 'red', label: 'Red', position: 1 },
      { project_id: 'p1', field_id: SELECT.id, slug: 'blue', label: 'Blue', position: 2 },
    ] satisfies ProjectFieldOption[]
    render(
      <Harness fields={[SELECT, RISK]} options={[...COLOURS, ...OPTIONS]} optionsPhase="loaded" />,
    )

    const colour = screen.getByRole('combobox', { name: 'Colour' })
    const risk = screen.getByRole('combobox', { name: 'Risk' })
    expect(
      within(colour)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['—', 'Red', 'Blue'])
    expect(
      within(risk)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['—', 'Low', 'High'])
  })

  it('carries the option SLUG as its value, never its label', () => {
    render(<Harness fields={[RISK]} options={OPTIONS} optionsPhase="loaded" />)

    const select = screen.getByRole('combobox', { name: 'Risk' })
    const opts = within(select).getAllByRole('option')
    // opts[0] is the blank choice; opts[1] is LOW, whose slug ('low') and label ('Low') are
    // deliberately different strings so a component reading `o.label` for the VALUE would be
    // caught rather than passing by coincidence.
    expect(opts[1]).toHaveValue('low')
    expect(opts[1]).toHaveTextContent('Low')
  })

  it('is DISABLED while the options read has not loaded', () => {
    render(<Harness fields={[RISK]} options={[]} optionsPhase="loading" />)

    expect(screen.getByRole('combobox', { name: 'Risk' })).toBeDisabled()
  })

  it('is DISABLED when the options read FAILED — an empty list is not "no options"', () => {
    render(<Harness fields={[RISK]} options={[]} optionsPhase="failed" />)

    expect(screen.getByRole('combobox', { name: 'Risk' })).toBeDisabled()
  })

  it('is ENABLED with only the blank choice when the field genuinely has no options', () => {
    render(<Harness fields={[RISK]} options={[]} optionsPhase="loaded" />)

    const select = screen.getByRole('combobox', { name: 'Risk' })
    expect(select).toBeEnabled()
    expect(within(select).getAllByRole('option')).toHaveLength(1)
  })

  it('leaves the other four types unchanged', () => {
    render(<Harness fields={[TEXT]} options={[]} optionsPhase="failed" />)

    expect(screen.getByLabelText('Customer ref')).toBeEnabled()
  })

  /**
   * Radix UNMOUNTS dialog content on close, so a close/reopen test through `CreateTicketDialog`
   * would pass even with the reset removed — that exact test was found vacuous in SPRIN-89 for
   * every other control on this form. Rendered OUTSIDE a dialog via `renderRowWithForm`, with a
   * captured form handle, so `form.reset()` is called directly rather than simulated through a
   * dialog close.
   */
  it('clears the draft option when the dialog is reopened', async () => {
    const user = userEvent.setup()
    renderRowWithForm({ field: RISK, options: OPTIONS, optionsPhase: 'loaded' })

    await user.selectOptions(screen.getByRole('combobox', { name: 'Risk' }), 'low')
    expect(screen.getByRole('combobox', { name: 'Risk' })).toHaveValue('low')

    await user.click(screen.getByRole('button', { name: 'Reset the form' }))

    expect(screen.getByRole('combobox', { name: 'Risk' })).toHaveValue('')
  })
})
