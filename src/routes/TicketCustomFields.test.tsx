import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { TicketCustomFields } from './TicketCustomFields'
import type { ProjectField, ProjectFieldOption, Ticket, TicketFieldValue } from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'
import {
  clearTicketFieldValue,
  listTicketFieldValues,
  setTicketFieldValue,
} from '@/lib/ticket-field-values'

// Spread the real module: only the three network-touching functions are mocked, so
// `parseFieldValue`, `VALUE_COLUMN` and `fieldValueText` stay REAL and this file exercises
// them rather than a stub of them. Mocking the module wholesale would also stub those pure
// helpers — and an unmocked read here would reach the LIVE database silently, because
// `VITE_SUPABASE_URL` is a placeholder in this environment and the rejection is handled. That
// is the ~90-requests-per-run hole SPRIN-90's review measured.
vi.mock('@/lib/ticket-field-values', async (orig) => ({
  ...(await orig<typeof import('@/lib/ticket-field-values')>()),
  listTicketFieldValues: vi.fn(),
  setTicketFieldValue: vi.fn(),
  clearTicketFieldValue: vi.fn(),
}))

const mockList = vi.mocked(listTicketFieldValues)
const mockSet = vi.mocked(setTicketFieldValue)
const mockClear = vi.mocked(clearTicketFieldValue)

const TICKET = {
  id: 't1',
  project_id: 'p1',
  key: 'MP-1',
  summary: 'Wire the board',
  type: 'story',
  status: 'todo',
} as Ticket

/**
 * Fixtures where **no id is derived from the slug, and no slug from the name**, and where
 * **every field has a DIFFERENT type**.
 *
 * Both confounds are named in this story's spec §9. An id-from-slug fixture makes a production
 * read of `field.id` and one of `field.slug` indistinguishable — the confound SPRIN-87 spent a
 * story breaking, and `field.id` is the key every value is looked up by here. An all-`text`
 * fixture would make "writes the column the type calls for" indistinguishable from "always
 * writes value_text", which is the single most valuable thing this file asserts.
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

/** A SECOND `select` field, deliberately kept separate from `SELECT` above. It exists only
 *  for the dedicated select-behaviour describe block below, so those tests never share a
 *  fixture with the AC1 "one control per type" tests and cannot be made to pass by accident
 *  if one block's options list leaked into the other. */
const RISK = field({ id: 'f-r1k', slug: 'risk', name: 'Risk', type: 'select' })

function value(overrides: Partial<TicketFieldValue> = {}): TicketFieldValue {
  return {
    ticket_id: 't1',
    project_id: 'p1',
    field_id: 'f-9a3',
    field_type: 'text',
    value_text: null,
    value_number: null,
    value_date: null,
    value_option: null,
    ...overrides,
  } as TicketFieldValue
}

/** One `SELECT`-field option. `field_id` defaults to `SELECT.id`, never to `RISK.id` below —
 *  the two select fixtures exist precisely so a fixture is never accidentally shared between
 *  the AC1 "renders a control for every type" tests and the dedicated select-behaviour ones. */
function option(overrides: Partial<ProjectFieldOption> = {}): ProjectFieldOption {
  return {
    project_id: 'p1',
    field_id: SELECT.id,
    slug: 'red',
    label: 'Red',
    position: 1,
    ...overrides,
  } as ProjectFieldOption
}

function renderFields(
  props: {
    fields?: ProjectField[]
    fieldsPhase?: ReadPhase
    options?: ProjectFieldOption[]
    optionsPhase?: ReadPhase
    onRetryFields?: () => void
  } = {},
) {
  return render(
    <TicketCustomFields
      ticket={TICKET}
      fields={props.fields ?? [TEXT]}
      fieldsPhase={props.fieldsPhase ?? 'loaded'}
      options={props.options}
      optionsPhase={props.optionsPhase}
      onRetryFields={props.onRetryFields ?? vi.fn()}
    />,
  )
}

const LOW = { project_id: 'p1', field_id: RISK.id, slug: 'low', label: 'Low', position: 1 }
const HIGH = { project_id: 'p1', field_id: RISK.id, slug: 'high', label: 'High', position: 2 }
const OPTIONS = [LOW, HIGH] satisfies ProjectFieldOption[]
const LOW_VALUE = value({ field_id: RISK.id, field_type: 'select', value_option: 'low' })

/** Renders a single field row, seeding `listTicketFieldValues` with `value` (or nothing). The
 *  dedicated helper for the select-behaviour describe block below — `renderFields` above stays
 *  as the AC1/AC2/AC3 suites' own helper, unchanged, so this file's existing coverage is never
 *  put at risk by a helper change made for one new block. */
function renderRow(props: {
  field: ProjectField
  options?: ProjectFieldOption[]
  optionsPhase?: ReadPhase
  value?: TicketFieldValue
}) {
  mockList.mockResolvedValue(props.value ? [props.value] : [])
  return render(
    <TicketCustomFields
      ticket={TICKET}
      fields={[props.field]}
      fieldsPhase="loaded"
      options={props.options}
      optionsPhase={props.optionsPhase}
      onRetryFields={vi.fn()}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockList.mockResolvedValue([])
  mockSet.mockResolvedValue({ ok: true })
  mockClear.mockResolvedValue({ ok: true })
})

describe('AC1 — each custom field renders a control labelled with its name', () => {
  it('renders one control per definition, for every type', async () => {
    renderFields({ fields: [TEXT, PARAGRAPH, NUMBER, DATE, SELECT] })

    // Exact accessible names are safe HERE and only here: each comes from a single
    // `aria-label` on one element, which is the carve-out `CLAUDE.md` documents. Names
    // COMPOSED from several children under Tailwind's flex layout are the ones jsdom gets
    // wrong, and nothing below queries one.
    expect(await screen.findByRole('button', { name: 'Edit Customer ref' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Delivery notes' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Priority level' })).toBeInTheDocument()
    expect(screen.getByLabelText('Go live')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Colour' })).toBeInTheDocument()
  })

  it('shows each field NAME as its visible label', async () => {
    renderFields({ fields: [TEXT, NUMBER] })

    // The name, not the slug. A fixture whose slug were `customer_ref` would let a component
    // rendering `field.slug` pass this — which is why the fixtures above use `cust_ref`.
    expect(await screen.findByText('Customer ref')).toBeInTheDocument()
    expect(screen.getByText('Priority level')).toBeInTheDocument()
    expect(screen.queryByText('cust_ref')).not.toBeInTheDocument()
    expect(screen.queryByText('tier')).not.toBeInTheDocument()
  })

  it('renders each stored value in the control for ITS OWN field and column', async () => {
    // The anti-confound assertion. Three fields, three types, three columns — a component
    // that always read `value_text`, or that matched values to fields by position rather than
    // by `field_id`, fails this and passes a single-field version of it.
    mockList.mockResolvedValue([
      value({ field_id: 'f-2c7', field_type: 'number', value_number: 4.5 }),
      value({ field_id: 'f-9a3', field_type: 'text', value_text: 'ACME-1' }),
      value({ field_id: 'f-7e5', field_type: 'date', value_date: '2026-08-07' }),
    ])
    renderFields({ fields: [TEXT, NUMBER, DATE] })

    expect(await screen.findByRole('button', { name: 'Edit Customer ref' })).toHaveTextContent(
      'ACME-1',
    )
    expect(screen.getByRole('button', { name: 'Edit Priority level' })).toHaveTextContent('4.5')
    expect(screen.getByLabelText('Go live')).toHaveValue('2026-08-07')
  })

  it("renders a select field's STORED value, not just an empty disabled control", async () => {
    // `value_option` is the one `VALUE_COLUMN` entry whose read path had no end-to-end
    // coverage: `select` appeared only in tests that supplied no value, so a control hardcoded
    // to `value=""` with a single placeholder option passed both of them.
    mockList.mockResolvedValue([
      value({ field_id: 'f-1d8', field_type: 'select', value_option: 'red' }),
    ])
    renderFields({ fields: [SELECT], options: [option()], optionsPhase: 'loaded' })

    expect(await screen.findByRole('combobox', { name: 'Colour' })).toHaveValue('red')
  })

  it('renders select DISABLED while the caller passes no options-read wiring at all (SPRIN-92)', async () => {
    // `renderFields` forwards NO `options`/`optionsPhase` here, matching a dialog rendered
    // without that wiring — standalone, or an older test. `TicketCustomFields` DEFAULTS
    // `optionsPhase` to `'loaded'`, same as `fieldsPhase`, so this is really pinning that the
    // dedicated select tests below are what changed the DEFAULT-rendered outcome from "always
    // disabled" (the story 3 placeholder) to "enabled with the blank choice alone", not this
    // test alone — see the `optionsPhase` describe block for the disabled/enabled matrix.
    renderFields({ fields: [SELECT] })

    const select = await screen.findByRole('combobox', { name: 'Colour' })
    expect(select).toBeEnabled()
    expect(within(select).getAllByRole('option')).toHaveLength(1)
  })
})

describe('AC2 — setting a value persists it', () => {
  it('writes a text value to the field it was typed into', async () => {
    const user = userEvent.setup()
    renderFields({ fields: [TEXT, NUMBER] })

    await user.click(await screen.findByRole('button', { name: 'Edit Customer ref' }))
    await user.type(screen.getByRole('textbox', { name: 'Customer ref' }), 'ACME-1')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(mockSet).toHaveBeenCalledWith({
        ticketId: 't1',
        projectId: 'p1',
        fieldId: 'f-9a3',
        fieldType: 'text',
        value: 'ACME-1',
      }),
    )
  })

  it('writes a number value as a NUMBER, to the number field', async () => {
    const user = userEvent.setup()
    renderFields({ fields: [TEXT, NUMBER] })

    await user.click(await screen.findByRole('button', { name: 'Edit Priority level' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Priority level' }), '-2.5')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ fieldId: 'f-2c7', fieldType: 'number', value: -2.5 }),
      ),
    )
  })

  it('does NOT bound a custom number field at zero the way story points is bounded', async () => {
    // `EditableText`'s numeric mode hardcoded `min={0}` until this story. A custom `number`
    // field is a plain `numeric` column — a temperature, a variance, a balance — so the
    // estimation rule must not follow the component here.
    const user = userEvent.setup()
    renderFields({ fields: [NUMBER] })

    await user.click(await screen.findByRole('button', { name: 'Edit Priority level' }))
    expect(screen.getByRole('spinbutton', { name: 'Priority level' })).not.toHaveAttribute('min')
  })

  it('keeps showing a NUMBER after a successful save, not a blank', async () => {
    // The optimistic row is built by `applyValueWrite`, which stamps `field_type` — and
    // `fieldValueText` reads the column that names. A row stamped `'text'` after a number save
    // routes to `value_text` (null) and the control silently blanks. Every other rendered-value
    // assertion in this file reads rows that came from `mockList`, never from a patch, so none
    // of them could see it.
    const user = userEvent.setup()
    renderFields({ fields: [NUMBER] })

    await user.click(await screen.findByRole('button', { name: 'Edit Priority level' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Priority level' }), '-2.5')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Priority level' })).toHaveTextContent('-2.5'),
    )
  })

  it('REPLACES an existing value on screen rather than showing the stale one', async () => {
    // Starts from a NON-empty list, unlike its sibling below. Editing a field that already has
    // a value is the common case and was the untested half of `applyValueWrite`.
    const user = userEvent.setup()
    mockList.mockResolvedValue([value({ field_id: 'f-9a3', value_text: 'OLD' })])
    renderFields({ fields: [TEXT] })

    const control = await screen.findByRole('button', { name: 'Edit Customer ref' })
    expect(control).toHaveTextContent('OLD')

    await user.click(control)
    await user.clear(screen.getByRole('textbox', { name: 'Customer ref' }))
    await user.type(screen.getByRole('textbox', { name: 'Customer ref' }), 'NEW')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Customer ref' })).toHaveTextContent('NEW'),
    )
    expect(screen.getByRole('button', { name: 'Edit Customer ref' })).not.toHaveTextContent('OLD')
  })

  it('shows the new value without refetching', async () => {
    const user = userEvent.setup()
    renderFields({ fields: [TEXT] })

    await user.click(await screen.findByRole('button', { name: 'Edit Customer ref' }))
    await user.type(screen.getByRole('textbox', { name: 'Customer ref' }), 'ACME-1')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Customer ref' })).toHaveTextContent('ACME-1'),
    )
    // One read on mount and no more. A refetch here would be a second request whose response
    // could land out of order with the write's.
    expect(mockList).toHaveBeenCalledTimes(1)
  })
})

describe('AC3 — clearing a value deletes the row', () => {
  it('DELETES rather than writing a null', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue([value({ field_id: 'f-9a3', value_text: 'ACME-1' })])
    renderFields({ fields: [TEXT] })

    await user.click(await screen.findByRole('button', { name: 'Edit Customer ref' }))
    await user.clear(screen.getByRole('textbox', { name: 'Customer ref' }))
    await user.keyboard('{Enter}')

    await waitFor(() => expect(mockClear).toHaveBeenCalledWith('t1', 'f-9a3'))
    // The positive half: `setTicketFieldValue` must NOT also have been called. A component
    // that wrote nulls AND deleted would satisfy a bare "clear was called" assertion.
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('drops the value from the rendered control', async () => {
    const user = userEvent.setup()
    mockList.mockResolvedValue([value({ field_id: 'f-9a3', value_text: 'ACME-1' })])
    renderFields({ fields: [TEXT] })

    await user.click(await screen.findByRole('button', { name: 'Edit Customer ref' }))
    await user.clear(screen.getByRole('textbox', { name: 'Customer ref' }))
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Customer ref' })).not.toHaveTextContent(
        'ACME-1',
      ),
    )
  })
})

describe('AC6 — a project with no custom fields renders nothing', () => {
  it('renders nothing at all, and the SAME component renders a control when one exists', async () => {
    // The absence assertion carries its positive control IN THE SAME TEST, per the Jira issue's
    // own note. "Renders nothing" passes trivially against an empty fixture — including if the
    // component threw, or rendered nothing under every input. The second half is what makes
    // the first half mean anything.
    const { container, unmount } = renderFields({ fields: [] })
    expect(container).toBeEmptyDOMElement()
    // Not merely absent from the a11y tree: `queryByRole` EXCLUDES `aria-hidden` subtrees, so
    // it would report "absent" for a control still in the DOM and still keyboard-reachable.
    expect(container.querySelector('input, button, select, textarea')).toBeNull()

    unmount()

    renderFields({ fields: [TEXT] })
    expect(await screen.findByRole('button', { name: 'Edit Customer ref' })).toBeInTheDocument()
  })

  it('does not even read values for a project with no fields', () => {
    renderFields({ fields: [] })
    expect(mockList).not.toHaveBeenCalled()
  })

  it("defaults fieldsPhase to 'loaded', so an UNWIRED dialog renders nothing at all", () => {
    // The DEFAULT, pinned — `renderFields` always passes `fieldsPhase` explicitly, so nothing
    // else in this file exercises the value the component picks when a caller says nothing.
    // That default is deliberately the opposite of `sprintsPhase`'s and the component's own
    // docblock spends a paragraph arguing for it; `TicketDetailDialog.test.tsx` has the
    // equivalent test for `statusesPhase`, so the pattern was established and this was missed.
    //
    // Mutating the default to 'loading' left 1094 tests green, and the consequence is exactly
    // what the docblock warns of: a dialog rendered without field wiring shows a "Loading…"
    // line that never resolves, because no read is ever issued for an empty field list.
    const { container } = render(<TicketCustomFields ticket={TICKET} />)

    expect(container).toBeEmptyDOMElement()
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })
})

describe('the read phases are consulted before the controls', () => {
  it('renders no writable control while values are still loading', async () => {
    // §4: a field whose value has not arrived renders an empty control that says, in the only
    // language a control has, "this ticket has no value for this field" — one keystroke from
    // overwriting real data with a blank the user was shown by mistake.
    let resolve: (v: TicketFieldValue[]) => void = () => {}
    mockList.mockReturnValue(new Promise((r) => (resolve = r)))
    renderFields({ fields: [TEXT] })

    expect(await screen.findByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Customer ref' })).not.toBeInTheDocument()

    resolve([])
    expect(await screen.findByRole('button', { name: 'Edit Customer ref' })).toBeInTheDocument()
  })

  it('renders a scoped failure when the VALUES read fails, and retries only that read', async () => {
    const user = userEvent.setup()
    const onRetryFields = vi.fn()
    mockList.mockRejectedValueOnce(new Error('nope')).mockResolvedValue([])
    renderFields({ fields: [TEXT], onRetryFields })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load custom field values.',
    )
    expect(screen.queryByRole('button', { name: 'Edit Customer ref' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    // Refetches the VALUES, and does NOT reload the shell's four project reads to fix one
    // ticket's values.
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))
    expect(onRetryFields).not.toHaveBeenCalled()
  })

  it('renders the FIELDS failure and hands its Retry to the shell, which owns that read', async () => {
    // The section's own nonce cannot refetch the definitions — they are the shell's read. A
    // Retry wired to the local nonce would render, click, and do nothing at all, which is the
    // "Retry that silently does nothing" LoadFailure's own docblock warns about.
    const user = userEvent.setup()
    const onRetryFields = vi.fn()
    renderFields({ fields: [], fieldsPhase: 'failed', onRetryFields })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load custom fields.')
    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(onRetryFields).toHaveBeenCalledTimes(1)
  })

  it('prefers a failure over a still-loading read', async () => {
    // `firstUnready`'s rule: any `failed` beats any `loading`. A single ordered scan would let
    // the loading values read mask the real fields failure behind a spinner that never
    // resolves, because nothing retries a `loading` phase on its own.
    mockList.mockReturnValue(new Promise(() => {}))
    renderFields({ fields: [TEXT], fieldsPhase: 'failed' })

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load custom fields.')
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument()
  })
})

/**
 * **`parseFieldValue`'s "Numbers only" branch cannot be driven through this UI, and that is
 * measured rather than assumed.** `<input type="number">` runs the HTML value-sanitisation
 * algorithm, so an unparseable string never reaches `onCommit`. Probed directly in jsdom on
 * 2026-08-07: typing `abc`, `1e999`, `1-2` and `--` each leaves `input.value === ''`, while
 * `-2.5` survives intact. An empty string is CLEAR, not an error, so the refusal path is
 * unreachable from here.
 *
 * It is kept anyway, as a backstop for the day the control changes (a `text` input, a paste
 * handler, a browser whose sanitiser admits `1e999` — Chrome's grammar does) — and it is
 * covered DIRECTLY in `ticket-field-values.test.ts`, which calls
 * `parseFieldValue('number', 'abc')` and asserts the message. What is exercised below is the
 * error region itself, through the failure that IS reachable: a rejected write.
 *
 * Recorded so nobody writes the obvious "type abc, expect an error" test again and concludes
 * the component is broken when it goes green-by-clearing instead.
 */
describe('errors are reported per FIELD, not per ticket', () => {
  it('sanitises an unparseable number to empty, so it CLEARS rather than refusing', async () => {
    // Pins the measured behaviour above. If a future control stops sanitising, this test flips
    // to a refusal and goes red — which is the signal that the backstop has become reachable.
    const user = userEvent.setup()
    mockList.mockResolvedValue([
      value({ field_id: 'f-2c7', field_type: 'number', value_number: 4.5 }),
    ])
    renderFields({ fields: [NUMBER] })

    await user.click(await screen.findByRole('button', { name: 'Edit Priority level' }))
    await user.clear(screen.getByRole('spinbutton', { name: 'Priority level' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Priority level' }), 'abc')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(mockClear).toHaveBeenCalledWith('t1', 'f-2c7'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('names the offending field and leaves the others clean', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: false, error: 'unknown' })
    renderFields({ fields: [TEXT, NUMBER] })

    await user.click(await screen.findByRole('button', { name: 'Edit Priority level' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Priority level' }), '7')
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save/i)
    // Exactly one alert — the dialog-level banner could not say WHICH field was refused, which
    // is the whole reason each row owns its own region. The text field beside it stays clean.
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('reports a rejected write on the field it was made from', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: false, error: 'stale' })
    renderFields({ fields: [TEXT] })

    await user.click(await screen.findByRole('button', { name: 'Edit Customer ref' }))
    await user.type(screen.getByRole('textbox', { name: 'Customer ref' }), 'ACME-1')
    await user.keyboard('{Enter}')

    expect(await screen.findByRole('alert')).toHaveTextContent(/reload/i)
  })

  it('clears a stale error once the field writes successfully', async () => {
    const user = userEvent.setup()
    mockSet.mockResolvedValueOnce({ ok: false, error: 'unknown' }).mockResolvedValue({ ok: true })
    renderFields({ fields: [TEXT] })

    await user.click(await screen.findByRole('button', { name: 'Edit Customer ref' }))
    await user.type(screen.getByRole('textbox', { name: 'Customer ref' }), 'first')
    await user.keyboard('{Enter}')
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Edit Customer ref' }))
    await user.type(screen.getByRole('textbox', { name: 'Customer ref' }), 'second')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})

describe('the section is scoped to its own ticket', () => {
  it('reads values for the ticket it was given', async () => {
    renderFields({ fields: [TEXT] })
    await waitFor(() => expect(mockList).toHaveBeenCalledWith('t1'))
  })

  it("writes against the ticket AND its project, not the field definition's project", async () => {
    // `project_id` reaches the row from the TICKET. Both fixtures use 'p1', so this asserts the
    // shape rather than distinguishing the two sources — declared rather than claimed, because
    // a value row whose project differed from its ticket's is exactly what `tfv_ticket_fk`
    // makes unrepresentable, so a fixture separating them would encode an impossible state.
    const user = userEvent.setup()
    renderFields({ fields: [TEXT] })

    await user.click(await screen.findByRole('button', { name: 'Edit Customer ref' }))
    await user.type(screen.getByRole('textbox', { name: 'Customer ref' }), 'x')
    await user.keyboard('{Enter}')

    await waitFor(() =>
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ ticketId: 't1', projectId: 'p1' }),
      ),
    )
  })
})

describe('the date control', () => {
  it('commits the ISO date the picker produced', async () => {
    renderFields({ fields: [DATE] })
    const input = await screen.findByLabelText('Go live')

    await userEvent.setup().type(input, '2026-08-07')

    await waitFor(() =>
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ fieldId: 'f-7e5', fieldType: 'date', value: '2026-08-07' }),
      ),
    )
  })

  it('clears when emptied', async () => {
    mockList.mockResolvedValue([
      value({ field_id: 'f-7e5', field_type: 'date', value_date: '2026-08-07' }),
    ])
    renderFields({ fields: [DATE] })
    const input = await screen.findByLabelText('Go live')

    await userEvent.setup().clear(input)

    await waitFor(() => expect(mockClear).toHaveBeenCalledWith('t1', 'f-7e5'))
  })
})

describe('each field keeps its own error region', () => {
  it('scopes the alert inside the failing field rather than beside it', async () => {
    // `getByText` unscoped says the message exists and nothing about WHERE. SPRIN-65's points
    // badge was moved outside its button and all twelve of its tests stayed green.
    const user = userEvent.setup()
    mockSet.mockResolvedValue({ ok: false, error: 'unknown' })
    renderFields({ fields: [TEXT, NUMBER] })

    await user.click(await screen.findByRole('button', { name: 'Edit Priority level' }))
    await user.type(screen.getByRole('spinbutton', { name: 'Priority level' }), '7')
    await user.keyboard('{Enter}')

    const group = (await screen.findByText('Priority level')).closest('label')
    expect(group).not.toBeNull()
    expect(within(group as HTMLElement).getByRole('alert')).toHaveTextContent(/could not save/i)
  })
})

/**
 * SPRIN-92 task 10 — the four behaviours the `select` control must get right, on `RISK`
 * rather than `SELECT` (see that fixture's own docblock for why the two are kept apart).
 */
describe('the select control offers real options (SPRIN-92)', () => {
  it('offers a blank choice FIRST, then the options in order', async () => {
    renderRow({ field: RISK, options: OPTIONS, optionsPhase: 'loaded' })

    const select = await screen.findByRole('combobox', { name: /risk/i })
    const opts = within(select).getAllByRole('option')
    expect(opts[0]).toHaveValue('')
    expect(opts.map((o) => o.textContent)).toEqual(['—', 'Low', 'High'])
  })

  it('CLEARS rather than writing an empty string when the blank choice is picked', async () => {
    const user = userEvent.setup()
    renderRow({ field: RISK, options: OPTIONS, optionsPhase: 'loaded', value: LOW_VALUE })

    const select = await screen.findByRole('combobox', { name: /risk/i })
    expect(select).toHaveValue('low')
    await user.selectOptions(select, '')

    await waitFor(() => expect(mockClear).toHaveBeenCalledWith('t1', RISK.id))
    expect(mockSet).not.toHaveBeenCalled()
  })

  it('writes the option SLUG, not its label', async () => {
    const user = userEvent.setup()
    renderRow({ field: RISK, options: OPTIONS, optionsPhase: 'loaded' })

    const select = await screen.findByRole('combobox', { name: /risk/i })
    await user.selectOptions(select, 'low')

    await waitFor(() =>
      expect(mockSet).toHaveBeenCalledWith(
        expect.objectContaining({ fieldId: RISK.id, fieldType: 'select', value: 'low' }),
      ),
    )
  })

  it('is DISABLED while the options read has not loaded', async () => {
    renderRow({ field: RISK, options: [], optionsPhase: 'loading' })

    expect(await screen.findByRole('combobox', { name: /risk/i })).toBeDisabled()
  })

  it('is DISABLED when the options read FAILED — an empty list is not "no options"', async () => {
    renderRow({ field: RISK, options: [], optionsPhase: 'failed' })

    expect(await screen.findByRole('combobox', { name: /risk/i })).toBeDisabled()
  })

  it('is ENABLED with only the blank choice when the field genuinely has no options', async () => {
    renderRow({ field: RISK, options: [], optionsPhase: 'loaded' })

    const select = await screen.findByRole('combobox', { name: /risk/i })
    expect(select).toBeEnabled()
    expect(within(select).getAllByRole('option')).toHaveLength(1)
  })

  it('leaves the other four types unchanged', async () => {
    renderRow({ field: TEXT, options: [], optionsPhase: 'failed' })

    expect(await screen.findByRole('button', { name: /customer ref/i })).toBeEnabled()
  })
})
