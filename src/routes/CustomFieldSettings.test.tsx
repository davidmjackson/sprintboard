import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { z } from 'zod'

import { CustomFieldSettings } from './CustomFieldSettings'
import type { ProjectField, ProjectFieldOption } from '@/lib/domain'
import { CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS } from '@/lib/domain'
import { AddFieldSchema, RenameFieldSchema } from '@/lib/field-schemas'
import { createProjectField, renameProjectField } from '@/lib/project-fields'
import type { ReadPhase } from '@/lib/project-reads'

// Spread the real module: only the two network-touching writes are mocked. `listProjectFields`
// is not called from this component, but mocking the module wholesale would also stub any pure
// helper a later story adds beside them — and an unmocked write here would reach the LIVE
// database, silently, because `VITE_SUPABASE_URL` is a placeholder in this environment and the
// rejection is handled. That is the ~90-requests-per-run hole SPRIN-90's review measured.
vi.mock('@/lib/project-fields', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-fields')>()),
  createProjectField: vi.fn(),
  renameProjectField: vi.fn(),
}))

// SPRIN-92 task 9: a `select` field now mounts the REAL `CustomFieldOptions` beneath its row,
// which imports these writes itself. Unmocked, a click this file never makes today could still
// reach the live database the moment a later test does — the identical ~90-requests-per-run
// hole SPRIN-90's review measured, one module over. Mirrors `CustomFieldOptions.test.tsx`'s own
// mock exactly.
vi.mock('@/lib/project-field-options', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-field-options')>()),
  createProjectFieldOption: vi.fn(),
  renameProjectFieldOption: vi.fn(),
  countTicketsHoldingOption: vi.fn(),
  deleteProjectFieldOption: vi.fn(),
}))

const mockCreate = vi.mocked(createProjectField)
const mockRename = vi.mocked(renameProjectField)

/**
 * Fixtures chosen so **no slug is the lowercased name** and **no type is the form's default**.
 *
 * Both are confounds this project has already been bitten by. SPRIN-87 broke three tests whose
 * fixture slug was `name.toLowerCase()`, because a production read of `field.slug` and a read
 * of `field.name` were then indistinguishable — and AC2/AC3 are precisely about telling those
 * two apart. The type confound is the same shape one level down: `CUSTOM_FIELD_TYPES[0]` is
 * `'text'` and it is what the add form's select defaults to, so a row that rendered the DEFAULT
 * type rather than its OWN would look correct on any `text` fixture.
 */
function field(overrides: Partial<ProjectField> = {}): ProjectField {
  return {
    id: 'f1',
    project_id: 'p1',
    slug: 'cust_ref',
    name: 'Customer ref',
    type: 'paragraph',
    created_at: '2026-08-01T00:00:00+00:00',
    ...overrides,
  } as ProjectField
}

const CUSTOMER_REF = field()
const PRIORITY = field({ id: 'f2', slug: 'tier', name: 'Priority level', type: 'number' })
const FIELDS = [CUSTOMER_REF, PRIORITY]

/**
 * A `select` field, and an ordinary (non-`select`) sibling — SPRIN-92 task 9's own fixtures,
 * named to match the brief's illustrative test. Slugs deliberately are NOT the lowercased name,
 * the same SPRIN-87 confound the rest of this file already guards against.
 */
const SELECT_FIELD = field({ id: 'f3', slug: 'urgency', name: 'Priority tier', type: 'select' })
const TEXT_FIELD = field({ id: 'f4', slug: 'billing_note', name: 'Billing note', type: 'text' })

const LOW_OPTION: ProjectFieldOption = {
  project_id: 'p1',
  field_id: SELECT_FIELD.id,
  slug: 'low',
  label: 'Low',
  position: 1,
}
const HIGH_OPTION: ProjectFieldOption = {
  project_id: 'p1',
  field_id: SELECT_FIELD.id,
  slug: 'high',
  label: 'High',
  position: 2,
}
const OPTIONS = [LOW_OPTION, HIGH_OPTION]

function renderSettings(
  props: {
    fields?: ProjectField[]
    phase?: ReadPhase
    options?: ProjectFieldOption[]
    optionsPhase?: ReadPhase
    onCreated?: (f: ProjectField) => void
    onUpdated?: (f: ProjectField) => void
    onRetry?: () => void
    onOptionCreated?: (option: ProjectFieldOption) => void
    onOptionUpdated?: (option: ProjectFieldOption) => void
    onOptionDeleted?: (fieldId: string, slug: string) => void
  } = {},
) {
  const handlers = {
    onCreated: vi.fn(),
    onUpdated: vi.fn(),
    onRetry: vi.fn(),
    onOptionCreated: vi.fn(),
    onOptionUpdated: vi.fn(),
    onOptionDeleted: vi.fn(),
    ...props,
  }
  const { container } = render(
    <CustomFieldSettings
      projectId="p1"
      fields={props.fields ?? FIELDS}
      phase={props.phase ?? 'loaded'}
      options={props.options ?? []}
      optionsPhase={props.optionsPhase ?? 'loaded'}
      onRetry={handlers.onRetry}
      onCreated={handlers.onCreated}
      onUpdated={handlers.onUpdated}
      onOptionCreated={handlers.onOptionCreated}
      onOptionUpdated={handlers.onOptionUpdated}
      onOptionDeleted={handlers.onOptionDeleted}
    />,
  )
  return { ...handlers, container }
}

/** The row for a field, found by the name it renders. Scoping every DOM-text assertion to the
 *  row is the SPRIN-67 discipline: an unscoped `getByText` says the text exists and nothing
 *  about where. Deliberately NOT `getByRole('listitem', { name })` — a listitem's accessible
 *  name is composed from its children, which is the jsdom-vs-browser fusion SPRIN-67
 *  established is not real. */
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('li')
  if (!row) throw new Error(`No row rendered for '${name}'`)
  return row
}

/** The text a field actually POINTS AT through `aria-describedby` — not merely text that
 *  exists somewhere on the page. A field-level message is a relationship, and asserting the
 *  sentence alone passes just as happily with the message rendered as a page banner. */
function fieldMessage(input: HTMLElement): string {
  return (input.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

/**
 * The message the SCHEMA produces for a given input, read from the schema rather than written
 * out here.
 *
 * The exact wording is `field-schemas.test.ts`'s subject, not this file's — restating it would
 * make a copy edit over there red over here for no reason. What this file is entitled to pin is
 * that the component surfaces **the schema's own reason**, and the way to prove that without
 * owning the wording is to show two DIFFERENT inputs producing two DIFFERENT sentences on
 * screen. A component that hardcoded one message would pass the first assertion and fail the
 * second, which is exactly the mutation `StatusSettings.test.tsx` records catching on the
 * sibling surface.
 *
 * `issues[0]` matches what both consumers select: zodResolver hands RHF the first issue for a
 * path, and `CustomFieldRow`'s rename reads `parsed.error.issues[0]`.
 */
function schemaMessage(schema: z.ZodType, value: unknown): string {
  const parsed = schema.safeParse(value)
  if (parsed.success) throw new Error(`Expected ${JSON.stringify(value)} to be refused`)
  const message = parsed.error.issues[0]?.message
  if (!message) throw new Error(`No issue message for ${JSON.stringify(value)}`)
  return message
}

/** One past the 40-character cap that mirrors `project_fields_name_nonempty`. */
const TOO_LONG = 'F'.repeat(41)

beforeEach(() => {
  mockCreate.mockReset()
  mockRename.mockReset()
})

describe('CustomFieldSettings', () => {
  it("lists the project's fields in the order given, with each type's label", () => {
    renderSettings()

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]!).getByText('Customer ref')).toBeVisible()
    expect(within(rows[1]!).getByText('Priority level')).toBeVisible()
    // The TYPE, by its label — neither fixture's type is the add form's default, so a row
    // rendering a constant rather than its own field's type cannot produce both of these.
    expect(within(rows[0]!).getByText(CUSTOM_FIELD_TYPE_LABELS.paragraph)).toBeVisible()
    expect(within(rows[1]!).getByText(CUSTOM_FIELD_TYPE_LABELS.number)).toBeVisible()
  })

  describe('adding a field (AC1)', () => {
    it('sends the typed name and the chosen type, then hands the row up', async () => {
      const u = userEvent.setup()
      // The server's row carries a `created_at` and a `slug` the component has no way to
      // derive, so `onCreated(result.value)` is distinguishable from a locally fabricated row.
      const created = field({
        id: 'f3',
        slug: 'ship_by_2',
        name: 'Ship by',
        type: 'date',
        created_at: '2026-08-06T09:30:00+00:00',
      })
      mockCreate.mockResolvedValue({ ok: true, value: created })
      const { onCreated } = renderSettings()

      await u.type(screen.getByRole('textbox', { name: 'Name' }), 'Ship by')
      await u.selectOptions(screen.getByRole('combobox', { name: 'Type' }), 'date')
      await u.click(screen.getByRole('button', { name: 'Add field' }))

      await waitFor(() =>
        expect(mockCreate).toHaveBeenCalledWith({
          projectId: 'p1',
          name: 'Ship by',
          type: 'date',
          // The existing rows travel with it: `createProjectField` derives the collision-free
          // slug from them, so a call without them can only produce a `23505` the user cannot
          // act on. AC2 (two fields may share a name) depends entirely on this argument.
          existing: FIELDS,
        }),
      )
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
    })

    /**
     * AC5, and the whole reason it is an AC: **the option list is derived from
     * `CUSTOM_FIELD_TYPES`, never written out.**
     *
     * A test that hard-coded the five names would pass in exactly the case AC5 exists to
     * prevent — the constant and the control disagreeing — because both sides of the
     * comparison would then be the test's own literals. Compared against the shared constant,
     * a hand-written option list in the component goes red the moment `domain.ts` moves, which
     * is CLAUDE.md's rule ("a type vocabulary is named in `domain.ts` and nowhere else") given
     * a test rather than a paragraph.
     *
     * Values AND labels, in order, and both exhaustively: `toEqual` on an array is exact, so
     * this is "these and nothing else" rather than "at least these".
     */
    it('offers exactly the shared list of types, with their shared labels', () => {
      renderSettings()

      const select = screen.getByRole('combobox', { name: 'Type' })
      const options = within(select).getAllByRole('option') as HTMLOptionElement[]

      expect(options.map((o) => o.value)).toEqual([...CUSTOM_FIELD_TYPES])
      expect(options.map((o) => o.textContent)).toEqual(
        CUSTOM_FIELD_TYPES.map((type) => CUSTOM_FIELD_TYPE_LABELS[type]),
      )
      // POSITIVE CONTROL for the two assertions above. Both compare the rendered options
      // against the constant, so an empty constant rendering an empty control would satisfy
      // them vacuously — `toEqual([])` on two empty arrays passes. This says the comparison had
      // something in it, without restating what.
      expect(options.length).toBeGreaterThan(1)
    })

    // The DEFAULT type, asserted from the shared constant rather than the literal `'text'`.
    // Nothing else observes it: a user who types a name and clicks Add without touching the
    // select gets whatever this is, so `CUSTOM_FIELD_TYPES[0]` silently becoming `[3]` would
    // create date fields for everyone who never opened the picker.
    it('defaults the type to the first of the shared list, not an arbitrary one', () => {
      renderSettings()

      expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue(CUSTOM_FIELD_TYPES[0])
    })

    it('clears BOTH controls after a successful add', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: true, value: field({ id: 'f3', name: 'Ship by' }) })
      renderSettings()

      const name = screen.getByRole('textbox', { name: 'Name' })
      const type = screen.getByRole('combobox', { name: 'Type' })
      await u.type(name, 'Ship by')
      await u.selectOptions(type, 'date')
      await u.click(screen.getByRole('button', { name: 'Add field' }))

      await waitFor(() => expect(name).toHaveValue(''))
      // The type too. `form.reset()` narrowed to `form.resetField('name')` stays green unless
      // something reads this select back — the blind spot that left the sibling form's default
      // unpinned for a whole story.
      expect(type).toHaveValue(CUSTOM_FIELD_TYPES[0])
    })

    /**
     * A slug collision is a STALE LIST — and it is emphatically NOT "a field with that name
     * already exists", because `project_fields` has no name-uniqueness constraint and AC2
     * requires two same-named fields to succeed.
     *
     * Asserted three ways, because any one alone would pass on the wrong copy: it is a
     * page-level banner (editing the name field cannot fix this), it names refreshing as the
     * remedy, and it does NOT claim the name is taken. Retrying the same submit reproduces the
     * result forever, so "please try again" here would be a loop.
     */
    it('tells the user to refresh when the list is stale, and never that the name is taken', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: false, error: 'stale' })
      const { onCreated } = renderSettings()

      const name = screen.getByRole('textbox', { name: 'Name' })
      await u.type(name, 'Ship by')
      await u.click(screen.getByRole('button', { name: 'Add field' }))

      const alert = await screen.findByRole('alert')
      // Anchored: `toHaveTextContent` with a bare string is a SUBSTRING match, so an additive
      // reword survives an unanchored assertion.
      expect(alert).toHaveTextContent(
        /^This list of custom fields is out of date — refresh the page and try adding it again\.$/,
      )
      expect(alert).not.toHaveTextContent(/already exists/i)
      expect(fieldMessage(name)).not.toMatch(/already/i)
      expect(onCreated).not.toHaveBeenCalled()
    })

    it('shows the generic retry copy for a failure the user cannot correct', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: false, error: 'unknown' })
      const { onCreated } = renderSettings()

      await u.type(screen.getByRole('textbox', { name: 'Name' }), 'Ship by')
      await u.click(screen.getByRole('button', { name: 'Add field' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /^Something went wrong\. Please try again\.$/,
      )
      expect(onCreated).not.toHaveBeenCalled()
    })

    it('refuses a blank name at the client edge, without a write', async () => {
      const u = userEvent.setup()
      renderSettings()

      const name = screen.getByRole('textbox', { name: 'Name' })
      await u.click(screen.getByRole('button', { name: 'Add field' }))

      // On the FIELD, through `aria-describedby` — a blank name IS a correctable fact about
      // that one input, unlike the write failures above.
      await waitFor(() =>
        expect(fieldMessage(name)).toContain(
          schemaMessage(AddFieldSchema, { name: '', type: 'text' }),
        ),
      )
      expect(name).toHaveAttribute('aria-invalid', 'true')
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it('refuses a whitespace-only name at the client edge, without a write', async () => {
      const u = userEvent.setup()
      renderSettings()

      const name = screen.getByRole('textbox', { name: 'Name' })
      await u.type(name, '   ')
      await u.click(screen.getByRole('button', { name: 'Add field' }))

      // The schema TRIMS, so this must be refused exactly as the blank one is — mirroring
      // `project_fields_name_nonempty`'s `btrim(name) <> ''`. Dropping `.trim()` leaves the
      // blank test above green and ships a field whose name is three spaces.
      await waitFor(() =>
        expect(fieldMessage(name)).toContain(
          schemaMessage(AddFieldSchema, { name: '   ', type: 'text' }),
        ),
      )
      expect(mockCreate).not.toHaveBeenCalled()
    })

    /**
     * The SECOND schema message out of the same expression, and it is not redundant.
     *
     * With only the empty case, the form could show a hardcoded sentence and stay green. Two
     * different inputs producing two different sentences is what proves it reports the
     * SCHEMA's reason rather than a constant of its own — so the precondition below is part of
     * the test, not decoration: if the schema ever gave both the same wording, this pair would
     * silently stop proving anything.
     */
    it("refuses a 41-character name with the schema's own, different message", async () => {
      const u = userEvent.setup()
      const blank = schemaMessage(AddFieldSchema, { name: '', type: 'text' })
      const long = schemaMessage(AddFieldSchema, { name: TOO_LONG, type: 'text' })
      expect(long).not.toBe(blank)
      renderSettings()

      const name = screen.getByRole('textbox', { name: 'Name' })
      await u.type(name, TOO_LONG)
      await u.click(screen.getByRole('button', { name: 'Add field' }))

      await waitFor(() => expect(fieldMessage(name)).toContain(long))
      expect(mockCreate).not.toHaveBeenCalled()
    })
  })

  describe('renaming a field (AC3)', () => {
    async function startRename(u: ReturnType<typeof userEvent.setup>, name: string) {
      await u.click(
        within(rowFor(name)).getByRole('button', { name: new RegExp(`edit .*${name}`, 'i') }),
      )
      const input = screen.getByRole('textbox', { name: new RegExp(name, 'i') })
      await u.clear(input)
      return input
    }

    it('sends the id and the new name, and hands the returned row up', async () => {
      const u = userEvent.setup()
      // The server's row carries a `created_at` the component has no way to derive, so
      // `onUpdated(result.value)` is distinguishable from `onUpdated({ ...field, name })`.
      const renamed = field({ name: 'Client ref', created_at: '2026-08-06T11:00:00+00:00' })
      mockRename.mockResolvedValue({ ok: true, value: renamed })
      const { onUpdated } = renderSettings()

      const input = await startRename(u, 'Customer ref')
      await u.type(input, 'Client ref{Enter}')

      // The ID and the NAME, and — because `toHaveBeenCalledWith` pins the whole argument
      // list — nothing else at this layer. `renameProjectField` is where `{ name } satisfies
      // ProjectFieldUpdate` keeps `slug` out of the PATCH; the component's job is simply not to
      // hand it anything more. 'f1' rather than the id of the first row by accident: the row
      // renamed here is the one whose id is asserted.
      await waitFor(() => expect(mockRename).toHaveBeenCalledWith('f1', 'Client ref'))
      expect(mockRename).toHaveBeenCalledOnce()
      await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(renamed))
    })

    // Renaming the SECOND row, so a component that ignored its argument and always sent the
    // head of the list would be caught rather than accidentally right. Both fixtures' ids are
    // distinct from their slugs and names, so `field.id` cannot be confused with either.
    it('sends the id of the row that was edited, not the first row', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: true, value: field({ id: 'f2', name: 'Priority' }) })
      renderSettings()

      const input = await startRename(u, 'Priority level')
      await u.type(input, 'Priority{Enter}')

      await waitFor(() => expect(mockRename).toHaveBeenCalledWith('f2', 'Priority'))
    })

    // The TRIMMED name is what reaches the write, not the raw commit. `EditableText` compares
    // the raw draft, so trailing spaces are a change to it and `onCommit` fires; the row's own
    // guard lets it through because the trimmed name differs from 'Customer ref'. That makes
    // this the only shape where `parsed.data.name` and `next` are distinguishable.
    it('sends the trimmed name, not the raw commit', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: true, value: field({ name: 'Client ref' }) })
      renderSettings()

      const input = await startRename(u, 'Customer ref')
      await u.type(input, 'Client ref   {Enter}')

      await waitFor(() => expect(mockRename).toHaveBeenCalledWith('f1', 'Client ref'))
    })

    it('reports a failed rename on the row that failed, and hands nothing up', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: false, error: 'unknown' })
      const { onUpdated } = renderSettings()

      const input = await startRename(u, 'Customer ref')
      await u.type(input, 'Client ref{Enter}')

      const alert = await within(rowFor('Customer ref')).findByRole('alert')
      expect(alert).toHaveTextContent(/^Something went wrong\. Please try again\.$/)
      // On the ROW that failed, not floating at the top of the section — with two rows on
      // screen a page-level banner would not say which name was refused.
      expect(within(rowFor('Priority level')).queryByRole('alert')).toBeNull()
      expect(onUpdated).not.toHaveBeenCalled()
    })

    /**
     * The `'stale'` tag on the RENAME path takes the generic copy, deliberately.
     *
     * A rename sends `name` alone, so it cannot reach `project_fields_project_slug_unique` —
     * the only constraint that produces that tag — and `project_fields` has no name constraint
     * for it to reach instead. Both tags are therefore undiagnosed here, and telling the user
     * to refresh would be inventing a remedy. Pinned rather than left to the docblock: without
     * this, adding a stale branch to the row (copying the add form's, which is the obvious
     * "tidy-up") would be invisible.
     */
    it('does not tell the user to refresh when a rename fails', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: false, error: 'stale' })
      renderSettings()

      const input = await startRename(u, 'Customer ref')
      await u.type(input, 'Client ref{Enter}')

      const alert = await within(rowFor('Customer ref')).findByRole('alert')
      expect(alert).toHaveTextContent(/^Something went wrong\. Please try again\.$/)
      expect(alert).not.toHaveTextContent(/refresh/i)
    })

    it('does not write when the field is committed untouched', async () => {
      const u = userEvent.setup()
      renderSettings()

      await u.click(
        within(rowFor('Customer ref')).getByRole('button', { name: /edit .*customer ref/i }),
      )
      await u.type(screen.getByRole('textbox', { name: /customer ref/i }), '{Enter}')

      expect(mockRename).not.toHaveBeenCalled()
    })

    // Where the ROW's own guard is the only one that can fire. `EditableText` compares the raw
    // draft, so 'Customer ref   ' is a change to it and `onCommit` runs; the row compares the
    // TRIMMED name, which the database also stores and compares, so this is a no-op write that
    // never needs sending. Without the row's guard the request goes out for nothing.
    it('does not write when the name differs only by surrounding whitespace', async () => {
      const u = userEvent.setup()
      renderSettings()

      await u.click(
        within(rowFor('Customer ref')).getByRole('button', { name: /edit .*customer ref/i }),
      )
      await u.type(screen.getByRole('textbox', { name: /customer ref/i }), '   {Enter}')

      expect(mockRename).not.toHaveBeenCalled()
    })

    /**
     * A failed rename's message must not outlive the attempt it describes.
     *
     * The no-op path is the one that leaks it: move `setError(null)` below the trim guard and
     * the row goes on showing a failure about a commit that was never sent. Reached through
     * trailing whitespace because that is the only commit `EditableText` forwards and the row
     * then declines — an untouched field never reaches this code at all.
     */
    it('clears a failed rename’s message when the next commit is a no-op', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: false, error: 'unknown' })
      renderSettings()

      const input = await startRename(u, 'Customer ref')
      await u.type(input, 'Client ref{Enter}')
      expect(await within(rowFor('Customer ref')).findByRole('alert')).toHaveTextContent(
        /something went wrong/i,
      )

      await u.click(
        within(rowFor('Customer ref')).getByRole('button', { name: /edit .*customer ref/i }),
      )
      await u.type(screen.getByRole('textbox', { name: /customer ref/i }), '   {Enter}')

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
      // And it really was a no-op — the message went away without a second write.
      expect(mockRename).toHaveBeenCalledOnce()
    })

    // Reachable by an ordinary user: `EditableText` commits whenever `draft !== value`, so
    // clearing the field and pressing Enter forwards `''`.
    it('refuses an emptied name at the client edge, without a write', async () => {
      const u = userEvent.setup()
      renderSettings()

      const input = await startRename(u, 'Customer ref')
      await u.type(input, '{Enter}')

      expect(await within(rowFor('Customer ref')).findByRole('alert')).toHaveTextContent(
        schemaMessage(RenameFieldSchema, { name: '' }),
      )
      expect(mockRename).not.toHaveBeenCalled()
    })

    // The SECOND message from the same expression — see the add form's equivalent. Without it,
    // `setError(parsed.error.issues[0]?.message ?? GENERIC_CREATE_ERROR)` can be replaced by a
    // hardcoded literal and stay green.
    it("refuses a 41-character rename with the schema's own, different message", async () => {
      const u = userEvent.setup()
      const empty = schemaMessage(RenameFieldSchema, { name: '' })
      const long = schemaMessage(RenameFieldSchema, { name: TOO_LONG })
      expect(long).not.toBe(empty)
      renderSettings()

      const input = await startRename(u, 'Customer ref')
      await u.type(input, `${TOO_LONG}{Enter}`)

      expect(await within(rowFor('Customer ref')).findByRole('alert')).toHaveTextContent(long)
      expect(mockRename).not.toHaveBeenCalled()
    })
  })

  /**
   * The read phase gates the WRITE surface too, which is this story's own placement decision
   * and therefore needs its own tests rather than inheriting SPRIN-90's.
   *
   * `createProjectField` derives its collision-free slug from the rows it is handed, so a form
   * offered over a failed or still-loading read derives from `[]` and can only produce a
   * `23505` the user cannot act on. Every absence assertion below carries a positive control in
   * the same test: with no fields the surface renders almost nothing, so "the add form is
   * absent" passes just as well when the whole section failed to render.
   */
  describe('the read phase', () => {
    it('shows a failed read as a failure, and offers no add form over it', () => {
      const { container } = renderSettings({ fields: [], phase: 'failed' })

      expect(screen.getByRole('alert')).toHaveTextContent(/^Could not load custom fields\.$/)
      expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
      expect(screen.queryByRole('button', { name: 'Add field' })).toBeNull()
      // `queryByRole` EXCLUDES `aria-hidden` subtrees, so it reports "absent" for a form that is
      // still in the DOM and still keyboard-reachable. The raw DOM query honours neither
      // `aria-hidden` nor CSS, so it is the one that makes absent mean absent.
      expect(container.querySelector('form')).toBeNull()
      // POSITIVE CONTROL: the section itself rendered.
      expect(screen.getByRole('heading', { name: 'Custom fields' })).toBeVisible()
      expect(screen.queryByText('No custom fields yet.')).toBeNull()
    })

    it('shows neither the list, the empty state nor the add form while loading', () => {
      const { container } = renderSettings({ fields: [], phase: 'loading' })

      expect(screen.getByText('Loading…')).toBeVisible()
      expect(screen.queryByText('No custom fields yet.')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Add field' })).toBeNull()
      expect(container.querySelector('form')).toBeNull()
      expect(screen.getByRole('heading', { name: 'Custom fields' })).toBeVisible()
    })

    /**
     * The POSITIVE CONTROL for both tests above, and the state it is easiest to get wrong:
     * a project with no custom fields is the DEFAULT, not an edge case — nothing seeds them —
     * so this is the surface most users see first, and it must still be addable.
     */
    it('offers the add form on a loaded but empty list', () => {
      renderSettings({ fields: [], phase: 'loaded' })

      expect(screen.queryAllByRole('listitem')).toHaveLength(0)
      expect(screen.getByRole('button', { name: 'Add field' })).toBeVisible()
      // The empty-state sentence itself: `fields.length === 0` mutated to `>= 0` removes it and
      // the assertions above stay green, because zero listitems is equally true of an empty
      // `<ul>`. Guarded against `aria-hidden` because `getByText` reaches it either way.
      const empty = screen.getByText('No custom fields yet.')
      expect(empty).toBeVisible()
      expect(empty).not.toHaveAttribute('aria-hidden')
    })
  })

  /**
   * SPRIN-92 task 9: wiring the options editor in for `select` fields, and gating it on its OWN
   * phase — a requirement carried forward from Task 7's review rather than written in the task
   * brief. `CustomFieldOptions` takes no `phase` prop, so left ungated it renders its empty
   * state ("No options yet.") on a FAILED read exactly as readily as on a genuinely empty one —
   * the S4.6 defect one surface over. `CustomFieldBody`'s own gate above is the precedent this
   * mirrors: failure first, then loading, then the loaded content.
   */
  describe("a select field's options (SPRIN-92 task 9)", () => {
    it('renders the options editor for a select field and NOT for the others', () => {
      renderSettings({ fields: [SELECT_FIELD, TEXT_FIELD] })

      const rows = screen.getAllByRole('listitem')
      expect(rows).toHaveLength(2)
      expect(within(rows[0]!).getByRole('button', { name: 'Add option' })).toBeInTheDocument()
      expect(within(rows[1]!).queryByRole('button', { name: 'Add option' })).not.toBeInTheDocument()
    })

    // The requirement itself: a FAILED options read must not be able to impersonate "this field
    // genuinely has no options yet". Both sentences are asserted, and the absence check goes
    // through a raw DOM query as well as `queryByRole` — `queryByRole` EXCLUDES `aria-hidden`
    // subtrees, so it would report "absent" for text that is merely hidden rather than gone.
    it('shows an honest failure for a select field’s options, never the empty state, when that read failed', () => {
      const { container } = renderSettings({
        fields: [SELECT_FIELD],
        options: [],
        optionsPhase: 'failed',
      })

      const row = rowFor('Priority tier')
      expect(within(row).getByRole('alert')).toBeInTheDocument()
      expect(within(row).queryByText('No options yet.')).toBeNull()
      expect(container.textContent).not.toContain('No options yet.')
      expect(within(row).queryByRole('button', { name: 'Add option' })).not.toBeInTheDocument()
    })

    it('shows a loading state for a select field’s options, never the empty state, while that read is in flight', () => {
      const { container } = renderSettings({
        fields: [SELECT_FIELD],
        options: [],
        optionsPhase: 'loading',
      })

      const row = rowFor('Priority tier')
      expect(within(row).queryByText('No options yet.')).toBeNull()
      expect(container.textContent).not.toContain('No options yet.')
      expect(within(row).queryByRole('button', { name: 'Add option' })).not.toBeInTheDocument()
    })

    /**
     * The POSITIVE CONTROL for the two tests above: without this, "never renders 'No options
     * yet.'" could be true because the sentence is unreachable from here at all, rather than
     * because the phase gate is doing its job.
     */
    it('shows the empty state once a select field’s options read has genuinely loaded empty', () => {
      renderSettings({ fields: [SELECT_FIELD], options: [], optionsPhase: 'loaded' })

      const row = rowFor('Priority tier')
      const empty = within(row).getByText('No options yet.')
      expect(empty).toBeVisible()
      expect(empty).not.toHaveAttribute('aria-hidden')
    })

    it('lists a loaded select field’s own options, scoped to its row', () => {
      renderSettings({ fields: [SELECT_FIELD, TEXT_FIELD], options: OPTIONS })

      const row = rowFor('Priority tier')
      expect(within(row).getByText('Low')).toBeVisible()
      expect(within(row).getByText('High')).toBeVisible()
      expect(within(rowFor('Billing note')).queryByText('Low')).toBeNull()
    })
  })
})
