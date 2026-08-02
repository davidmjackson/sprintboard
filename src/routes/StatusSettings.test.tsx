import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { StatusSettings } from './StatusSettings'
import type { ProjectStatus } from '@/lib/domain'
import {
  createProjectStatus,
  deleteProjectStatus,
  renameProjectStatus,
  reorderProjectStatuses,
} from '@/lib/project-statuses'

// Spread the real module: `status-schemas.ts` calls `slugForName` from it during validation,
// and `doneSlugs`/`statusName`/`removeStatus`/`deleteBlockReason` are pure. Only the four
// network-touching writes are mocked.
vi.mock('@/lib/project-statuses', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-statuses')>()),
  createProjectStatus: vi.fn(),
  renameProjectStatus: vi.fn(),
  reorderProjectStatuses: vi.fn(),
  deleteProjectStatus: vi.fn(),
}))

const mockCreate = vi.mocked(createProjectStatus)
const mockRename = vi.mocked(renameProjectStatus)
const mockReorder = vi.mocked(reorderProjectStatuses)
const mockDelete = vi.mocked(deleteProjectStatus)

/**
 * A vocabulary that is NOT the seeded four, and whose names never equal a CATEGORY label.
 * A fixture reusing 'To Do'/'In Progress'/'Done' could not tell "renders the row's name" from
 * "renders the row's category", nor "reads the rows" from "reads a constant".
 */
function status(overrides: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    id: 'st1',
    project_id: 'p1',
    slug: 'triage',
    name: 'Triage',
    category: 'todo',
    position: 1,
    is_initial: true,
    created_at: '2026-08-01T00:00:00+00:00',
    ...overrides,
  } as ProjectStatus
}

const TRIAGE = status()
const BUILDING = status({
  id: 'st2',
  slug: 'building',
  name: 'Building',
  category: 'in_progress',
  position: 2,
  is_initial: false,
})
const SHIPPED = status({
  id: 'st3',
  slug: 'shipped',
  name: 'Shipped',
  category: 'done',
  position: 3,
  is_initial: false,
})
const STATUSES = [TRIAGE, BUILDING, SHIPPED]

function renderSettings(
  props: {
    statuses?: ProjectStatus[]
    counts?: Map<string, number>
    onCreated?: (s: ProjectStatus) => void
    onUpdated?: (s: ProjectStatus) => void
    onReordered?: (s: ProjectStatus[]) => void
    onDeleted?: (id: string) => void
  } = {},
) {
  const handlers = {
    onCreated: vi.fn(),
    onUpdated: vi.fn(),
    onReordered: vi.fn(),
    onDeleted: vi.fn(),
    ...props,
  }
  render(
    <StatusSettings
      projectId="p1"
      statuses={props.statuses ?? STATUSES}
      counts={props.counts ?? new Map()}
      onCreated={handlers.onCreated}
      onUpdated={handlers.onUpdated}
      onReordered={handlers.onReordered}
      onDeleted={handlers.onDeleted}
    />,
  )
  return handlers
}

/** The row containing a given status's controls, anchored on the Delete button's
 *  `aria-label` — one text node, one element, no composed name — then scoped with `within`.
 *  Deliberately NOT `getByRole('listitem', { name })`: a listitem's accessible name is
 *  composed from its children, which is precisely the jsdom-vs-browser fusion SPRIN-67
 *  established is not real. */
function deleteRowFor(name: string): HTMLElement {
  const button = screen.getByRole('button', { name: `Delete ${name}` })
  const row = button.closest('li')
  if (!row) throw new Error(`No row found for "${name}"`)
  return row
}

/** The row for a status, found by the name it renders. Scoping every DOM-text assertion to
 *  the row is the SPRIN-67 discipline: an unscoped `getByText` says the text exists and
 *  nothing about where. A `<li>` takes no accessible name from its content, so the row is
 *  reached through the name it renders rather than by a role-name query. */
function rowFor(name: string): HTMLElement {
  const row = screen.getByText(name).closest('li')
  if (!row) throw new Error(`No row rendered for '${name}'`)
  return row
}

/** The text a field actually POINTS AT through `aria-describedby` — not merely text that
 *  exists somewhere on the page. A field-level message is a relationship, and asserting the
 *  sentence alone passes just as happily with the message rendered as a page banner. */
function fieldMessage(field: HTMLElement): string {
  return (field.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? '')
    .join(' ')
}

beforeEach(() => {
  mockCreate.mockReset()
  mockRename.mockReset()
  mockReorder.mockReset()
  mockDelete.mockReset()
})

describe('StatusSettings', () => {
  it("lists the project's statuses in the order given, with their category", () => {
    renderSettings()

    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    // Order is the rows' own (position) order, which IS the board's column order.
    expect(within(rows[0]!).getByText('Triage')).toBeVisible()
    expect(within(rows[1]!).getByText('Building')).toBeVisible()
    expect(within(rows[2]!).getByText('Shipped')).toBeVisible()
    // The CATEGORY, by its label — 'Shipped' is a done-category status whose name says so
    // nowhere, so a row echoing its own name would not produce this.
    expect(within(rows[2]!).getByText('Done')).toBeVisible()
    expect(within(rows[1]!).getByText('In progress')).toBeVisible()
  })

  describe('adding a status', () => {
    it('sends the typed name and the chosen category, then hands the row up', async () => {
      const u = userEvent.setup()
      const created = status({ id: 'st4', slug: 'blocked', name: 'Blocked', position: 4 })
      mockCreate.mockResolvedValue({ ok: true, value: created })
      const { onCreated } = renderSettings()

      await u.type(screen.getByRole('textbox', { name: 'Name' }), 'Blocked')
      await u.selectOptions(screen.getByRole('combobox', { name: 'Category' }), 'in_progress')
      await u.click(screen.getByRole('button', { name: 'Add status' }))

      await waitFor(() =>
        expect(mockCreate).toHaveBeenCalledWith({
          projectId: 'p1',
          name: 'Blocked',
          category: 'in_progress',
          // The existing rows travel with it: `createProjectStatus` derives both the unique
          // slug and `max(position)+1` from them, so a call without them appends wrongly.
          existing: STATUSES,
        }),
      )
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(created))
    })

    it('clears the name field after a successful add', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: true, value: status({ id: 'st4', name: 'Blocked' }) })
      renderSettings()

      const name = screen.getByRole('textbox', { name: 'Name' })
      await u.type(name, 'Blocked')
      await u.click(screen.getByRole('button', { name: 'Add status' }))

      await waitFor(() => expect(name).toHaveValue(''))
    })

    // AC4: a duplicate is a user-correctable outcome about ONE field, so it is reported on
    // that field — not as a banner the user has to map back to an input themselves.
    it('reports a duplicate name on the name field, and does not hand anything up', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: false, error: 'duplicate' })
      const { onCreated } = renderSettings()

      const field = screen.getByRole('textbox', { name: 'Name' })
      await u.type(field, 'Triage')
      await u.click(screen.getByRole('button', { name: 'Add status' }))

      await waitFor(() => expect(fieldMessage(field)).toMatch(/already/i))
      expect(field).toHaveAttribute('aria-invalid', 'true')
      // And NOT as a page-level banner, which is the shape AC4 rules out.
      expect(screen.queryByRole('alert')).toBeNull()
      expect(onCreated).not.toHaveBeenCalled()
    })

    /**
     * A position collision is a STALE LIST, not a duplicate name — two tabs on one project both
     * compute the same `max(position)+1` from a list nothing refetches. Told "that name already
     * exists", the user retries the same unique name and gets the identical result forever.
     *
     * Asserted three ways, because any one alone would pass on the old behaviour: the copy names
     * the actual remedy, it is NOT the duplicate-name sentence, and it is a page-level banner
     * rather than a message on the name field — editing that field cannot fix this.
     */
    it('tells the user to refresh when the list is stale, not that the name is taken', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: false, error: 'stale' })
      const { onCreated } = renderSettings()

      const field = screen.getByRole('textbox', { name: 'Name' })
      await u.type(field, 'Blocked')
      await u.click(screen.getByRole('button', { name: 'Add status' }))

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/refresh/i)
      expect(alert).not.toHaveTextContent(/already exists/i)
      expect(fieldMessage(field)).not.toMatch(/already/i)
      expect(onCreated).not.toHaveBeenCalled()
    })

    it('shows the generic retry copy for a failure the user cannot correct', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: false, error: 'unknown' })
      const { onCreated } = renderSettings()

      await u.type(screen.getByRole('textbox', { name: 'Name' }), 'Blocked')
      await u.click(screen.getByRole('button', { name: 'Add status' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong. Please try again.',
      )
      expect(onCreated).not.toHaveBeenCalled()
    })

    it('refuses a blank name at the client edge, without a write', async () => {
      const u = userEvent.setup()
      renderSettings()

      await u.click(screen.getByRole('button', { name: 'Add status' }))

      expect(await screen.findByText('Give the status a name')).toBeVisible()
      expect(mockCreate).not.toHaveBeenCalled()
    })
  })

  describe('renaming a status', () => {
    it('commits the new name and hands the returned row up', async () => {
      const u = userEvent.setup()
      const renamed = { ...BUILDING, name: 'In Build' }
      mockRename.mockResolvedValue({ ok: true, value: renamed })
      const { onUpdated } = renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      const input = screen.getByRole('textbox', { name: /building/i })
      await u.clear(input)
      await u.type(input, 'In Build{Enter}')

      await waitFor(() => expect(mockRename).toHaveBeenCalledWith('st2', 'In Build'))
      await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(renamed))
    })

    it('reports a duplicate rename on the row and hands nothing up', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: false, error: 'duplicate' })
      const { onUpdated } = renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      const input = screen.getByRole('textbox', { name: /building/i })
      await u.clear(input)
      await u.type(input, 'Triage{Enter}')

      const alert = await screen.findByRole('alert')
      expect(alert).toHaveTextContent(/already/i)
      // On the ROW that failed, not floating at the top of the page.
      expect(within(rowFor('Building')).getByRole('alert')).toBe(alert)
      expect(onUpdated).not.toHaveBeenCalled()
    })

    // Committing an untouched field writes nothing. Recorded honestly: this passes because of
    // `EditableText`'s own `draft !== value` test, NOT the row's — deleting the row's guard
    // leaves this test green (measured by mutation). It is kept because the composed behaviour
    // is worth pinning, not because it pins this file. The test below is the one that does.
    it('does not write when the field is committed untouched', async () => {
      const u = userEvent.setup()
      renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      await u.type(screen.getByRole('textbox', { name: /building/i }), '{Enter}')

      expect(mockRename).not.toHaveBeenCalled()
    })

    /**
     * A failed rename's message must not outlive the attempt it describes.
     *
     * The no-op path is the one that leaked it: the row's own trim guard returns BEFORE the
     * error is cleared, so the row went on claiming "a status with that name already exists"
     * about a commit that was never sent and could not have collided with anything. Reached
     * through trailing whitespace because that is the only commit `EditableText` forwards and
     * the row then declines — an untouched field never reaches this code at all.
     */
    it('clears a failed rename’s message when the next commit is a no-op', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: false, error: 'duplicate' })
      renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      const input = screen.getByRole('textbox', { name: /building/i })
      await u.clear(input)
      await u.type(input, 'Triage{Enter}')
      expect(await screen.findByRole('alert')).toHaveTextContent(/already/i)

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      await u.type(screen.getByRole('textbox', { name: /building/i }), '   {Enter}')

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
      // And it really was a no-op — the message went away without a second write.
      expect(mockRename).toHaveBeenCalledOnce()
    })

    // Where the row's OWN guard is the only one that can fire. `EditableText` compares the raw
    // draft, so 'Building ' is a change to it and `onCommit` runs; the row compares the TRIMMED
    // name, which the database also stores and compares, so this is a no-op write that never
    // needs sending. Without the row's guard the request goes out and a duplicate-name index
    // is consulted for nothing.
    it('does not write when the name differs only by surrounding whitespace', async () => {
      const u = userEvent.setup()
      renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      await u.type(screen.getByRole('textbox', { name: /building/i }), '   {Enter}')

      expect(mockRename).not.toHaveBeenCalled()
    })
  })

  describe('reordering', () => {
    it('sends the COMPLETE swapped slug list when a row moves down', async () => {
      const u = userEvent.setup()
      mockReorder.mockResolvedValue({ ok: true, value: [BUILDING, TRIAGE, SHIPPED] })
      const { onReordered } = renderSettings()

      await u.click(within(rowFor('Triage')).getByRole('button', { name: /move .* down/i }))

      // Every slug the project has, in the new order. A PARTIAL list would leave the omitted
      // rows on their old positions and can collide on the deferred unique constraint.
      await waitFor(() =>
        expect(mockReorder).toHaveBeenCalledWith('p1', ['building', 'triage', 'shipped']),
      )
      await waitFor(() => expect(onReordered).toHaveBeenCalledWith([BUILDING, TRIAGE, SHIPPED]))
    })

    it('sends the COMPLETE swapped slug list when a row moves up', async () => {
      const u = userEvent.setup()
      mockReorder.mockResolvedValue({ ok: true, value: [TRIAGE, SHIPPED, BUILDING] })
      renderSettings()

      await u.click(within(rowFor('Shipped')).getByRole('button', { name: /move .* up/i }))

      await waitFor(() =>
        expect(mockReorder).toHaveBeenCalledWith('p1', ['triage', 'shipped', 'building']),
      )
    })

    it('offers no Move up on the first row and no Move down on the last', () => {
      renderSettings()

      expect(within(rowFor('Triage')).queryByRole('button', { name: /move .* up/i })).toBeNull()
      expect(within(rowFor('Triage')).getByRole('button', { name: /move .* down/i })).toBeVisible()
      expect(within(rowFor('Shipped')).queryByRole('button', { name: /move .* down/i })).toBeNull()
      expect(within(rowFor('Shipped')).getByRole('button', { name: /move .* up/i })).toBeVisible()
    })

    it('disables every move control while a reorder is in flight', async () => {
      const u = userEvent.setup()
      let release: (v: { ok: true; value: ProjectStatus[] }) => void = () => {}
      mockReorder.mockReturnValue(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      renderSettings()

      await u.click(within(rowFor('Triage')).getByRole('button', { name: /move .* down/i }))

      await waitFor(() =>
        expect(
          within(rowFor('Shipped')).getByRole('button', { name: /move .* up/i }),
        ).toBeDisabled(),
      )
      release({ ok: true, value: STATUSES })
      await waitFor(() =>
        expect(
          within(rowFor('Shipped')).getByRole('button', { name: /move .* up/i }),
        ).toBeEnabled(),
      )
    })

    it('leaves the list alone and says so when the reorder fails', async () => {
      const u = userEvent.setup()
      mockReorder.mockResolvedValue({ ok: false, error: 'unknown' })
      const { onReordered } = renderSettings()

      await u.click(within(rowFor('Triage')).getByRole('button', { name: /move .* down/i }))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Something went wrong. Please try again.',
      )
      expect(onReordered).not.toHaveBeenCalled()
      // The rendered order is the prop's, untouched — the parent owns the list.
      const rows = screen.getAllByRole('listitem')
      expect(within(rows[0]!).getByText('Triage')).toBeVisible()

      // AND THE USER CAN TRY AGAIN. Without this line, moving `setReordering(false)` below the
      // failure return passes every test in this file — shipping a settings tab where every
      // Move control is permanently disabled after one failed reorder, sitting next to a
      // "Please try again" message the user cannot act on. Asserting the message alone reads
      // as though it covers the recovery; it does not.
      expect(within(rowFor('Triage')).getByRole('button', { name: /move .* down/i })).toBeEnabled()
    })
  })

  describe('deleting a status', () => {
    // A KNOWN zero for every row — distinct from the default `renderSettings()` map, which is
    // EMPTY and (since the fix below) means "we do not know", not "zero". Tests in this block
    // that are about something other than the availability gate itself use this so they are not
    // incidentally blocked by it.
    const KNOWN_ZERO_COUNTS = new Map([
      ['triage', 0],
      ['building', 0],
      ['shipped', 0],
    ])

    it("shows each status's ticket count", () => {
      renderSettings({ counts: new Map([['triage', 4]]) })

      expect(within(deleteRowFor('Triage')).getByText('4 tickets')).toBeInTheDocument()
    })

    it('disables Delete on a status holding tickets, and states the reason', () => {
      renderSettings({ counts: new Map([['triage', 4]]) })

      const row = deleteRowFor('Triage')
      expect(within(row).getByRole('button', { name: 'Delete Triage' })).toBeDisabled()
      expect(within(row).getByText(/holds 4 tickets/i)).toBeInTheDocument()
    })

    it('disables Delete on the last remaining status, and states the reason', () => {
      renderSettings({ statuses: [TRIAGE], counts: new Map([['triage', 0]]) })

      const row = deleteRowFor('Triage')
      expect(within(row).getByRole('button', { name: 'Delete Triage' })).toBeDisabled()
      expect(within(row).getByText(/at least one status/i)).toBeInTheDocument()
    })

    // THE ONE THAT MATTERS for this fix. An EMPTY counts map means the caller does not know
    // ANY status's count — e.g. `ticketCountsByStatus` failed — and that must block every
    // Delete, not read as "0 tickets, deletable" the way `?? 0` used to make it read.
    it('blocks every Delete and states the reason when the counts map is empty', () => {
      renderSettings({ counts: new Map() })

      for (const status of STATUSES) {
        const row = deleteRowFor(status.name)
        expect(within(row).getByRole('button', { name: `Delete ${status.name}` })).toBeDisabled()
        // Scoped to the REASON sentence specifically — the count span above it also renders
        // "count unavailable", so an unscoped /unavailable/i would match twice in the same row.
        expect(within(row).getByText(/cannot be deleted safely/i)).toBeInTheDocument()
      }
    })

    it('names the status that will take over when deleting the initial one', async () => {
      const u = userEvent.setup()
      renderSettings({ counts: KNOWN_ZERO_COUNTS })

      // TRIAGE is the initial status; BUILDING is the lowest-position survivor, so
      // `removeStatus` promotes it — the dialog must name it, not re-derive the rule itself.
      await u.click(screen.getByRole('button', { name: 'Delete Triage' }))

      const dialog = await screen.findByRole('alertdialog')
      expect(dialog).toHaveTextContent(/will start in/i)
      expect(dialog).toHaveTextContent('Building')
    })

    // The MIRROR of the test above, and the one that pins the `status.is_initial` guard in
    // front of the promotion lookup. Without it, `removeStatus(...).find(s => s.is_initial)`
    // still returns the CURRENT initial status for a delete that does not touch it, and the
    // dialog tells the user "New tickets will start in Triage instead." on a delete that
    // changes nothing about where tickets start — an untrue sentence, on a destructive
    // confirmation. Dropping the guard leaves every other test in this file green.
    it('says nothing about where new tickets start when the status is not the initial one', async () => {
      const u = userEvent.setup()
      renderSettings({ counts: KNOWN_ZERO_COUNTS })

      // BUILDING is not initial; TRIAGE is, and survives this delete as the initial status.
      await u.click(screen.getByRole('button', { name: 'Delete Building' }))

      const dialog = await screen.findByRole('alertdialog')
      expect(dialog).toHaveTextContent(/can’t be undone/i)
      expect(dialog).not.toHaveTextContent(/will start in/i)
      expect(within(dialog).queryByText(/triage/i)).toBeNull()
    })

    it('calls onDeleted after a successful delete', async () => {
      const u = userEvent.setup()
      mockDelete.mockResolvedValue({ ok: true, value: undefined })
      const { onDeleted } = renderSettings({ counts: KNOWN_ZERO_COUNTS })

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const dialog = await screen.findByRole('alertdialog')
      // Scoped to the dialog: an unscoped /delete/i would also match every row's button.
      await u.click(within(dialog).getByRole('button', { name: /^delete$/i }))

      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('st2'))
    })

    it('surfaces a has_tickets refusal without calling onDeleted', async () => {
      const u = userEvent.setup()
      mockDelete.mockResolvedValue({ ok: false, error: 'has_tickets' })
      const { onDeleted } = renderSettings({ counts: KNOWN_ZERO_COUNTS })

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const dialog = await screen.findByRole('alertdialog')
      await u.click(within(dialog).getByRole('button', { name: /^delete$/i }))

      expect(await screen.findByRole('alert')).toHaveTextContent(/move them/i)
      expect(onDeleted).not.toHaveBeenCalled()
    })

    // The same class of bug `StatusRow`'s rename already fixed, on the other control. The
    // dialog's error state outlives a close, because only Radix's content unmounts — so a
    // cancelled failure would still be on screen when the dialog is reopened, describing a
    // request this open has not sent.
    it('clears a failed delete’s message when the dialog is reopened', async () => {
      const u = userEvent.setup()
      mockDelete.mockResolvedValue({ ok: false, error: 'has_tickets' })
      renderSettings({ counts: KNOWN_ZERO_COUNTS })

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const dialog = await screen.findByRole('alertdialog')
      await u.click(within(dialog).getByRole('button', { name: /^delete$/i }))
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(/move them/i)

      await u.click(within(dialog).getByRole('button', { name: /^cancel$/i }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const reopened = await screen.findByRole('alertdialog')
      expect(within(reopened).queryByRole('alert')).toBeNull()
      expect(within(reopened).queryByText(/move them/i)).toBeNull()
    })
  })

  it('still offers the add form when the project has no statuses at all', () => {
    renderSettings({ statuses: [] })

    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('button', { name: 'Add status' })).toBeVisible()
    // The empty-state sentence itself, which nothing observed: `statuses.length > 0` mutated to
    // `>= 0` removes it entirely and the two assertions above stay green, because zero
    // `listitem`s is equally true of an empty `<ul>`. Unreachable today — the seed trigger
    // guarantees four statuses and there is no DELETE policy — but SPRIN-80 makes it reachable,
    // and a state that only appears once deletion exists is the one least likely to be noticed.
    expect(
      screen.getByText('This project has no statuses, so its board has no columns.'),
    ).toBeVisible()
  })
})
