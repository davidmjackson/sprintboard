import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CreateTicketDialog } from './CreateTicketDialog'
import { createTicket } from '@/lib/tickets'
import * as ticketFieldValues from '@/lib/ticket-field-values'
import { insertTicketFieldValues } from '@/lib/ticket-field-values'
import type { ProjectField, ProjectFieldOption, Ticket } from '@/lib/domain'
import type { ReadPhase } from '@/lib/project-reads'

vi.mock('@/lib/tickets', () => ({ createTicket: vi.fn() }))

// Keeping the real `parseFieldValues`/`ticketFieldValueRows` is deliberate: mocking them would
// make these tests agree with the dialog by construction and stop them seeing a wrong column.
vi.mock('@/lib/ticket-field-values', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ticket-field-values')>()),
  insertTicketFieldValues: vi.fn(),
}))

const mockCreate = vi.mocked(createTicket)
const mockInsertValues = vi.mocked(insertTicketFieldValues)

/** Mirrors `field()` at `src/routes/CreateTicketCustomFields.test.tsx:18` — same ids, same
 *  names, so a failure message asserted against a literal field name stays true across files. */
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
const NUMBER = field({ id: 'f-2c7', slug: 'tier', name: 'Priority level', type: 'number' })
const DATE = field({ id: 'f-7e5', slug: 'target', name: 'Go live', type: 'date' })
const RISK = field({ id: 'f-r1k', slug: 'risk', name: 'Risk', type: 'select' })
const LOW = { project_id: 'p1', field_id: RISK.id, slug: 'low', label: 'Low', position: 1 }
const HIGH = { project_id: 'p1', field_id: RISK.id, slug: 'high', label: 'High', position: 2 }
const OPTIONS = [LOW, HIGH] satisfies ProjectFieldOption[]

async function openDialog(
  props: Partial<{
    fields: ProjectField[]
    fieldsPhase: ReadPhase
    options: ProjectFieldOption[]
    optionsPhase: ReadPhase
    onCreated: (ticket: Ticket) => void
  }> = {},
) {
  const user = userEvent.setup()
  // `optionsPhase` is REQUIRED on `CreateTicketDialog` (SPRIN-92 task 11, shipped required from
  // the first commit). This helper is the one place supplying a convenience default for the
  // many callers below that never touch a `select` field — placed AFTER the spread so it wins
  // over whatever (or nothing) `props.optionsPhase` set, mirroring `fieldsPhase`'s implicit
  // `undefined` default. `'loaded'` is the neutral, harmless value here: none of these callers
  // sets `fields` to a `select`-typed field without also setting `optionsPhase` explicitly.
  render(
    <CreateTicketDialog projectId="p1" {...props} optionsPhase={props.optionsPhase ?? 'loaded'} />,
  )
  await user.click(screen.getByRole('button', { name: 'New ticket' }))
  await screen.findByRole('dialog')
  return user
}

beforeEach(() => {
  mockCreate.mockReset()
  mockInsertValues.mockReset()
  mockInsertValues.mockResolvedValue({ ok: true })
})

// `vite.config.ts` sets neither `restoreMocks` nor `clearMocks`, so the one `vi.spyOn` in this
// file (on the real `parseFieldValues`) would otherwise leak into every later test if an
// assertion above its own `spy.mockRestore()` ever failed. Restoring here is unconditional and
// covers that failure path, which a same-test `mockRestore()` call cannot.
afterEach(() => {
  vi.restoreAllMocks()
})

describe('CreateTicketDialog', () => {
  it('requires a summary', async () => {
    const user = await openDialog()
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    expect(await screen.findByText('Summary is required')).toBeInTheDocument()
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('floors the story-points input at zero', async () => {
    await openDialog()

    // The zod regex rejects a typed "-1", but the spinner and a browser's own numeric
    // stepper bypass the keyboard entirely — `min` is what stops them going negative.
    expect(screen.getByLabelText('Story points')).toHaveAttribute('min', '0')
  })

  it('creates a ticket with parsed fields and closes on success', async () => {
    mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1' } as never })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.selectOptions(screen.getByLabelText('Type'), 'bug')
    await user.type(screen.getByLabelText('Story points'), '3')
    await user.type(screen.getByLabelText('Labels'), 'ui, urgent ,')

    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        projectId: 'p1',
        summary: 'Wire the board',
        type: 'bug',
        description: undefined,
        storyPoints: 3,
        labels: ['ui', 'urgent'],
        acceptanceCriteria: undefined,
      }),
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('surfaces a failure and stays open', async () => {
    mockCreate.mockResolvedValue({ ok: false, error: 'unknown' })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    expect(await screen.findByText(/Something went wrong/)).toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  /**
   * The test above fills neither free-text field, so both arrive as `undefined` and the
   * two are interchangeable in the create call without anything noticing — one of the
   * pre-existing gaps S9.4's mutation sweep recorded. The values here are deliberately
   * distinct and non-substitutable, so no single default satisfies both positions.
   */
  it('does not transpose description and acceptance criteria', async () => {
    mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1' } as never })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.type(screen.getByLabelText('Description'), 'DESCRIPTION-SIDE')
    await user.type(screen.getByLabelText('Acceptance criteria'), 'CRITERIA-SIDE')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          description: 'DESCRIPTION-SIDE',
          acceptanceCriteria: 'CRITERIA-SIDE',
        }),
      ),
    )
  })

  /**
   * Blank story points must reach `createTicket` as `undefined`, never `0`. A Scrum board
   * treats a 0-point ticket as estimated-at-zero, which is a different and wrong claim
   * from unestimated — and `Number('')` is `0`, so this is one keystroke away.
   */
  it('sends undefined story points when the field is left blank', async () => {
    mockCreate.mockResolvedValue({ ok: true, ticket: { id: 't1' } as never })
    const user = await openDialog()

    await user.type(screen.getByLabelText('Summary'), 'Unestimated work')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    const sent = mockCreate.mock.calls[0]![0]
    expect(sent.storyPoints).toBeUndefined()
    expect(sent.storyPoints).not.toBe(0)
  })

  /**
   * SPRIN-51, AC3. The shell suppresses a stale `close`, but the row was still written, so
   * the parent must still be told about it or the new ticket stays invisible until a
   * refetch. This is the assertion that rules out "fixing" the stale-submit bug by
   * bailing out of the whole continuation — it lives here, not in `CreateDialog.test.tsx`,
   * because `onCreated` is a call site's call to make and no change to the shell can drop it.
   *
   * Known gap, measured not guessed: this pins the TICKET dialog only. The same naive
   * `if (!isCurrent()) return` inserted into `CreateProjectDialog` or `CreateSprintDialog`
   * leaves the whole suite green. Covering those two needs the same test twice more; the
   * shape of the mistake is identical, so it is recorded here rather than triplicated.
   */
  it('still notifies the parent of the created ticket when the submit resolved stale', async () => {
    let release: (v: { ok: true; ticket: { id: string } }) => void = () => {}
    mockCreate.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      }) as never,
    )
    const onCreated = vi.fn()
    const user = userEvent.setup()
    render(<CreateTicketDialog projectId="p1" onCreated={onCreated} optionsPhase="loaded" />)

    await user.click(screen.getByRole('button', { name: 'New ticket' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))
    await screen.findByRole('button', { name: 'Creating…' })

    // Abandon it mid-flight, then reopen and start something else.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'New ticket' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Summary'), 'A different ticket')

    release({ ok: true, ticket: { id: 't1' } })

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 't1' }))
    // ...and the reopened draft is untouched by the resolution.
    expect(screen.getByLabelText('Summary')).toHaveValue('A different ticket')
  })

  it('renders the custom fields after the fixed ones', async () => {
    await openDialog({ fields: [TEXT] })

    const labels = screen.getAllByText(/Summary|Acceptance criteria|Customer ref/)
    expect(labels.map((l) => l.textContent)).toEqual([
      'Summary',
      'Acceptance criteria',
      'Customer ref',
    ])
  })

  it('creates the ticket, then writes its custom values in one insert', async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never,
    })
    mockInsertValues.mockResolvedValue({ ok: true })
    const user = await openDialog({ fields: [TEXT, NUMBER] })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
    await user.type(screen.getByLabelText('Priority level'), '-2.5')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(mockInsertValues).toHaveBeenCalledTimes(1))
    // Each value in the column ITS OWN TYPE calls for — a single wrong column here is a 23514
    // against the real database.
    expect(mockInsertValues).toHaveBeenCalledWith([
      {
        ticket_id: 't1',
        project_id: 'p1',
        field_id: TEXT.id,
        field_type: 'text',
        value_text: 'ACME-1',
        value_number: null,
        value_date: null,
        value_option: null,
      },
      {
        ticket_id: 't1',
        project_id: 'p1',
        field_id: NUMBER.id,
        field_type: 'number',
        value_number: -2.5,
        value_text: null,
        value_date: null,
        value_option: null,
      },
    ])
  })

  it('writes no value row for a custom field left empty', async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never,
    })
    mockInsertValues.mockResolvedValue({ ok: true })
    const user = await openDialog({ fields: [TEXT, NUMBER] })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(mockInsertValues).toHaveBeenCalledTimes(1))
    const rows = mockInsertValues.mock.calls[0]![0]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.field_id).toBe(TEXT.id)
  })

  /**
   * SPRIN-92 task 11 — the `select` control's write path, submit-level. The control-level
   * behaviours (blank-first ordering, disabled-while-unloaded) are pinned in
   * `CreateTicketCustomFields.test.tsx`; this file is where the SUBMIT actually happens, so the
   * value-column write can be pinned end to end the way `NUMBER`'s -2.5 is above.
   */
  it('writes the option SLUG to value_option, never its label', async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never,
    })
    mockInsertValues.mockResolvedValue({ ok: true })
    const user = await openDialog({ fields: [RISK], options: OPTIONS, optionsPhase: 'loaded' })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.selectOptions(screen.getByLabelText('Risk'), 'low')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(mockInsertValues).toHaveBeenCalledTimes(1))
    expect(mockInsertValues).toHaveBeenCalledWith([
      {
        ticket_id: 't1',
        project_id: 'p1',
        field_id: RISK.id,
        field_type: 'select',
        value_option: 'low',
        value_text: null,
        value_number: null,
        value_date: null,
      },
    ])
  })

  /**
   * The blank choice must leave the field EMPTY in the submitted draft, never write `''` as an
   * option value — `tfv_option_fk` would refuse it. Picks a real option first, then picks it
   * back to blank, so this cannot pass merely because the field started empty.
   */
  it('writes no value row when the select is picked back to blank', async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never,
    })
    mockInsertValues.mockResolvedValue({ ok: true })
    const user = await openDialog({ fields: [RISK], options: OPTIONS, optionsPhase: 'loaded' })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.selectOptions(screen.getByLabelText('Risk'), 'low')
    await user.selectOptions(screen.getByLabelText('Risk'), '')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    expect(mockInsertValues).toHaveBeenCalledWith([])
  })

  it("keeps the select control disabled until the shell's options read settles", async () => {
    // `fieldsPhase` set explicitly (and to a DIFFERENT value than `optionsPhase`) so a mutation
    // crossing the two props at this component's own pass-through to `CreateTicketCustomFields`
    // reddens THIS test, not only the shell's four-hop "real wiring" sibling in
    // `ProjectShell.test.tsx` — `fieldsPhase: 'loaded'` would otherwise render the select
    // enabled if `optionsPhase` were silently fed `fieldsPhase`'s value instead of its own.
    await openDialog({
      fields: [RISK],
      fieldsPhase: 'loaded',
      options: [],
      optionsPhase: 'loading',
    })

    expect(screen.getByLabelText('Risk')).toBeDisabled()
  })

  /**
   * DEVIATION from the brief's literal `user.type(..., 'twelve')`: confirmed against real
   * Chromium (via a throwaway Playwright probe, not part of this suite) that `<input
   * type="number">`'s value-sanitisation algorithm empties the field for ANY string that is
   * not a finite floating-point number — 'twelve', 'Infinity', and even the syntactically
   * "valid" `1e400` all sanitise to `""`, whether typed keystroke-by-keystroke or assigned to
   * `.value` directly. So `numberDraft`'s non-finite rejection can never actually fire from
   * this control as wired — there is no string a user can get INTO the box that trips it. That
   * is a real, load-bearing finding about `CreateTicketCustomFields`'s choice of `<input
   * type="number">`, not a defect in this test; it is reported in the task-5 report rather
   * than silently worked around.
   *
   * A `vi.spyOn` on the real `parseFieldValues` forces the refusal so this test can still pin
   * what the DIALOG does with one: nothing is created and the message renders. Every other
   * test in this file leaves `parseFieldValues` real, per the file's own top-of-file note —
   * this is the one deliberate, documented exception. The refusal LOGIC itself is already
   * covered where it lives, by task 1's unit tests in `ticket-field-values.test.ts`; what this
   * test pins is that the dialog routes the error to the right field and stops before writing
   * anything.
   *
   * Coordinator-confirmed independently: a bare `<input type="number">` under jsdom +
   * userEvent holds `""` after typing `twelve`, `1e999`, and even `1-2` — so this branch is
   * unreachable through the CURRENT control, more comprehensively than the Chromium probe
   * above found. Keeping the test (via the spy) is deliberate DEFENCE-IN-DEPTH: if a future
   * story swaps the control for something that can carry an out-of-range or malformed string
   * (a plain text input with its own numeric mask, say), this test is what would catch that
   * `parseFieldNumber`'s rejection stopped being reachable from production — do not delete it
   * as "dead" on the strength of today's control.
   */
  it('refuses a bad number before creating anything', async () => {
    vi.spyOn(ticketFieldValues, 'parseFieldValues').mockReturnValue({
      ok: false,
      errors: [{ fieldId: NUMBER.id, message: 'Numbers only' }],
    })
    const user = await openDialog({ fields: [NUMBER] })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    // Scoped to the Priority level FIELD, not an unscoped `findByText`. `applyFieldErrors`
    // exists solely to route a message to its own field via `setError(\`custom.${fieldId}\`,
    // …)` rather than to `root` — an unscoped query would match `FormRootError`'s
    // `role="alert"` just as happily as this field's own `FormMessage`, so it cannot tell
    // "routed to the wrong place" from "routed correctly". The FormItem container is what
    // `getByLabelText`'s `<input>` sits inside, alongside its own `FormMessage`.
    const priorityField = screen.getByLabelText('Priority level').closest('[data-slot="form-item"]')
    expect(priorityField).not.toBeNull()
    expect(
      await within(priorityField as HTMLElement).findByText('Numbers only'),
    ).toBeInTheDocument()
    // The ORDERING is the point: parse first, so the user loses nothing.
    expect(mockCreate).not.toHaveBeenCalled()
    expect(mockInsertValues).not.toHaveBeenCalled()
  })

  it('keeps the ticket and names the unsaved fields when the values write fails', async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never,
    })
    mockInsertValues.mockResolvedValue({ ok: false, error: 'unknown' })
    const onCreated = vi.fn()
    const user = await openDialog({ fields: [TEXT, DATE], onCreated })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
    await user.type(screen.getByLabelText('Go live'), '2026-08-07')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    // Exact string, not a substring: toHaveTextContent with a bare string is a SUBSTRING
    // match, so an additive reword would survive it. The apostrophe is the LITERAL curly
    // character (’), not a `.` wildcard — a `.` would let an apostrophe swap survive too.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Created MP-12, but couldn’t save: Customer ref, Go live\. Set them on the ticket\.$/,
    )
    // The ticket is REAL and must reach the board — withholding it is the invisible-create
    // defect.
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 't1' }))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  /**
   * The test above fills BOTH of its fields, so `drafts.writes.map((w) => w.field)` and
   * `fields ?? []` produce identical lists and the test cannot tell "only the fields actually
   * written" from "every field on the form" apart — a real mutation the reviewer demonstrated.
   * A third field, left EMPTY, is what separates them: `parseFieldValues` excludes an empty
   * field from `drafts.writes` (no write, nothing attempted, nothing to fail), so it must not
   * be named in a message about what failed to save.
   */
  it('names only the fields actually attempted, not every custom field on the form', async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never,
    })
    mockInsertValues.mockResolvedValue({ ok: false, error: 'unknown' })
    const user = await openDialog({ fields: [TEXT, NUMBER, DATE] })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
    // Priority level (NUMBER) deliberately left blank.
    await user.type(screen.getByLabelText('Go live'), '2026-08-07')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /^Created MP-12, but couldn’t save: Customer ref, Go live\. Set them on the ticket\.$/,
    )
  })

  it('will not create a second ticket after a values failure', async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never,
    })
    mockInsertValues.mockResolvedValue({ ok: false, error: 'unknown' })
    const user = await openDialog({ fields: [TEXT] })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: 'Create ticket' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'Create ticket' }))
    expect(mockCreate).toHaveBeenCalledTimes(1)
  })

  it('re-enables the submit when the dialog is closed and reopened', async () => {
    // The latch is per-attempt, not permanent. `CreateDialog` owns the state and clears it in
    // `handleOpenChange` alongside `form.reset()`, so this dialog holds no latch state of its
    // own and needs no `onClosed` to clear one.
    mockCreate.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never,
    })
    mockInsertValues.mockResolvedValue({ ok: false, error: 'unknown' })
    const user = await openDialog({ fields: [TEXT] })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))
    await screen.findByRole('alert')

    await user.keyboard('{Escape}')
    await user.click(screen.getByRole('button', { name: 'New ticket' }))

    expect(await screen.findByRole('button', { name: 'Create ticket' })).toBeEnabled()
  })

  it('issues no values request when the project has custom fields but none are filled', async () => {
    mockCreate.mockResolvedValue({
      ok: true,
      ticket: { id: 't1', project_id: 'p1', key: 'MP-12' } as never,
    })
    mockInsertValues.mockResolvedValue({ ok: true })
    const user = await openDialog({ fields: [TEXT] })

    await user.type(screen.getByLabelText('Summary'), 'Wire the board')
    await user.click(screen.getByRole('button', { name: 'Create ticket' }))

    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    // insertTicketFieldValues short-circuits on an empty list, so it is called with [] and
    // issues no request — assert the ARGUMENT, since the call itself is cheap and expected.
    expect(mockInsertValues).toHaveBeenCalledWith([])
  })

  /**
   * Closing then reopening must show an empty control rather than the stale typed value —
   * `CreateDialog`'s `handleOpenChange` calls `form.reset()` on close.
   *
   * **This is NOT a control on `CreateTicketCustomFields`'s `rhf.value ?? ''` fallback**, and an
   * earlier version of this docblock said it was. Radix unmounts the dialog content on close, so
   * the control remounts fresh on reopen whether or not `form.reset()` did anything, and this
   * dialog's `defaultValues` carry no `custom` key, so `rhf.value` is `undefined` from birth and
   * no render here ever observes a controlled→uncontrolled flip. Measured: mutating that line to
   * a bare `value={rhf.value}` left all 1153 tests green, with no React warning. The real control
   * is `CreateTicketCustomFields.test.tsx`'s "keeps the control controlled across a form.reset()",
   * which renders outside a dialog so nothing remounts.
   */
  it('clears a typed custom value when the dialog is closed and reopened', async () => {
    const user = await openDialog({ fields: [TEXT] })

    await user.type(screen.getByLabelText('Customer ref'), 'ACME-1')
    expect(screen.getByLabelText('Customer ref')).toHaveValue('ACME-1')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'New ticket' }))
    await screen.findByRole('dialog')

    expect(screen.getByLabelText('Customer ref')).toHaveValue('')
  })
})
