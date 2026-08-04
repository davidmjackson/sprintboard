import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { StatusSettings } from './StatusSettings'
import type { ProjectStatus } from '@/lib/domain'
import { STATUS_CATEGORIES } from '@/lib/domain'
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
 *
 * THREE confounds are deliberately broken here, every one found by mutation rather than by
 * reading. A fixture whose values coincide cannot tell two different reads apart — and each of
 * these was found only after the previous one was fixed, so treat the list as open.
 *
 * 1. **`slug` is not the lowercased `name`.** Every status here used to be a single word, so
 *    `slug === name.toLowerCase()` held for all three — and two production call sites that key
 *    on the SLUG (`counts.get(status.slug)` and the reorder payload) survived being re-keyed on
 *    the name, whole suite green. The seeded vocabulary is exactly where they diverge:
 *    'In Progress' slugs to `in_progress`.
 * 2. **The initial status is not the FIRST status.** While TRIAGE was both `is_initial` and
 *    `statuses[0]`, `removeStatus(statuses, status.id)` survived being re-keyed to
 *    `statuses[0].id` — so the confirm dialog could name the wrong takeover status on any
 *    project whose initial status is not first. `is_initial` is independent of `position`, and
 *    the fixture now says so.
 * 3. **`position` is not `index + 1`.** They were 1, 2, 3 in array order, so `move()`'s
 *    `statuses.indexOf(status) + delta` was indistinguishable from `status.position - 1 + delta`.
 *    Positions are sparse in any reorderable list — the database only requires them unique and
 *    ordered per project, never contiguous, and `reorder_project_statuses` assigns from the
 *    array's ORDINALITY rather than from these numbers.
 */
function status(overrides: Partial<ProjectStatus> = {}): ProjectStatus {
  return {
    id: 'st1',
    project_id: 'p1',
    slug: 'triage',
    name: 'Triage',
    category: 'todo',
    position: 10,
    is_initial: true,
    created_at: '2026-08-01T00:00:00+00:00',
    ...overrides,
  } as ProjectStatus
}

const TRIAGE = status({ is_initial: false })
const BUILDING = status({
  id: 'st2',
  slug: 'in_build',
  name: 'Building',
  category: 'in_progress',
  position: 20,
  is_initial: true,
})
const SHIPPED = status({
  id: 'st3',
  slug: 'shipped',
  name: 'Shipped',
  category: 'done',
  position: 30,
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

    /**
     * The DEFAULT category, which nothing observed — and the consequence is not cosmetic.
     *
     * The only test that asserted a category selected one first, so `STATUS_CATEGORIES[0]` could
     * become `[2]` with the whole 890-test unit suite green: a user who types a name and clicks
     * Add without touching the select would silently create a **done-category** status.
     * `doneSlugs()` treats done-category statuses as terminal, so `completeSprint` would then
     * carry those tickets out of the sprint — precisely the drift `doneSlugs` was extracted to
     * prevent. The value is asserted from `STATUS_CATEGORIES[0]` rather than the literal
     * `'todo'`, because CLAUDE.md says a category value is named in `domain.ts` and nowhere else.
     */
    it('defaults the category to the first of the shared list, not an arbitrary one', () => {
      renderSettings()

      expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue(STATUS_CATEGORIES[0])
    })

    it('clears BOTH fields after a successful add', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: true, value: status({ id: 'st4', name: 'Blocked' }) })
      renderSettings()

      const name = screen.getByRole('textbox', { name: 'Name' })
      const category = screen.getByRole('combobox', { name: 'Category' })
      await u.type(name, 'Blocked')
      await u.selectOptions(category, 'done')
      await u.click(screen.getByRole('button', { name: 'Add status' }))

      await waitFor(() => expect(name).toHaveValue(''))
      // The category too. `form.reset()` narrowed to `form.resetField('name')` was green,
      // because nothing in the suite ever read this select — the same blind spot that left
      // the default unpinned above. A stale 'Done' selection is how the next status quietly
      // becomes terminal.
      expect(category).toHaveValue(STATUS_CATEGORIES[0])
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
      // Anchored, like the delete dialog's stale sentence three describe-blocks away. The
      // fragment /refresh/i survived an additive reword; one of three sites was anchored and
      // two were not, which is this story's recurring failure in miniature.
      expect(alert).toHaveTextContent(
        /^This list of statuses is out of date — refresh the page and try adding it again\.$/,
      )
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
        /^Something went wrong\. Please try again\.$/,
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
      // The server's row carries a `position` the component has no way to derive, so
      // `onUpdated(result.value)` is distinguishable from `onUpdated({ ...status, name })`.
      // While the mock resolved exactly what local code could build, the deep-equality
      // assertion below could not tell "hands the SERVER's row up" from "fabricates one".
      const renamed = { ...BUILDING, name: 'In Build', position: 99 }
      mockRename.mockResolvedValue({ ok: true, value: renamed })
      const { onUpdated } = renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      const input = screen.getByRole('textbox', { name: /building/i })
      await u.clear(input)
      await u.type(input, 'In Build{Enter}')

      await waitFor(() => expect(mockRename).toHaveBeenCalledWith('st2', 'In Build'))
      await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(renamed))
    })

    // The TRIMMED name is what reaches the write, not the raw commit. Typed with trailing
    // spaces, which `EditableText` forwards (it compares the raw draft) and the row's own
    // guard lets through (the trimmed name differs from 'Building') — so this is the only
    // shape where `parsed.data.name` and `next` are distinguishable. Sending `next` survived
    // every other test in the file. `renameProjectStatus` trims server-side too, so this is
    // defence in depth rather than a live bug; it is pinned for the same reason the row's
    // no-op guard is.
    it('sends the trimmed name, not the raw commit', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: true, value: { ...BUILDING, name: 'In Build' } })
      renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      const input = screen.getByRole('textbox', { name: /building/i })
      await u.clear(input)
      await u.type(input, 'In Build   {Enter}')

      await waitFor(() => expect(mockRename).toHaveBeenCalledWith('st2', 'In Build'))
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
      // Anchored, to the same standard as the three delete sentences. The fragment /already/i
      // survived an additive reword of DUPLICATE_NAME.
      expect(alert).toHaveTextContent(/^A status with that name already exists in this project\.$/)
      // On the ROW that failed, not floating at the top of the page.
      expect(within(rowFor('Building')).getByRole('alert')).toBe(alert)
      expect(onUpdated).not.toHaveBeenCalled()
    })

    /**
     * The OTHER side of the rename's failure ternary, and the one with real consequence.
     *
     * `setError(result.error === 'duplicate' ? DUPLICATE_NAME : GENERIC_CREATE_ERROR)` could be
     * collapsed to `setError(DUPLICATE_NAME)` with the whole unit suite green — so a rename that
     * failed for any other reason would tell the user "a status with that name already exists"
     * and send them to edit a name that was never the problem. That is precisely the wrong-copy
     * outcome the delete side's AC4 exists to prevent, on the sibling control, unpinned.
     */
    it('shows the generic retry copy when a rename fails for a reason that is not a duplicate', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: false, error: 'unknown' })
      const { onUpdated } = renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      const input = screen.getByRole('textbox', { name: /building/i })
      await u.clear(input)
      await u.type(input, 'In Build{Enter}')

      expect(await within(rowFor('Building')).findByRole('alert')).toHaveTextContent(
        /^Something went wrong\. Please try again\.$/,
      )
      expect(onUpdated).not.toHaveBeenCalled()
    })

    // Committing an untouched field writes nothing. This test pins NEITHER guard that produces
    // that, and the honest statement of why took three mutations to get right:
    //
    //   drop the row's `parsed.data.name === status.name` guard  -> 2 failed, NOT this test
    //   drop `EditableText`'s `draft !== value` guard            -> suite green
    //   drop BOTH                                                -> 3 failed, incl. this test
    //
    // Stated as outcomes rather than "N passed" on purpose: an absolute count in a comment is
    // wrong the moment the next test is added, and a stale "34 passed" in a 36-test suite reads
    // as two failures — inverting the very claim it was recording.
    //
    // They are overlapping defences and each alone is free to go. An earlier version of this
    // comment claimed the test passed "because of `EditableText`'s own guard, NOT the row's",
    // which measurement contradicts — the row's guard shadows it on every path this file
    // exercises. Kept because the composed behaviour is worth pinning; the test below is the
    // one that pins the row's guard. `EditableText`'s cannot be pinned from here at all, and
    // would need a component-level test of its own.
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

    /**
     * The rename's zod-failure branch — uncovered until SPRIN-87, and REACHABLE by an ordinary
     * user: `EditableText` commits whenever `draft !== value`, so clearing the field and
     * pressing Enter forwards `''` and the schema's `min(1)` refuses it.
     *
     * Untested, its copy could be swapped for the generic 'Something went wrong' with nothing
     * red — telling a user to retry when the fix is to type a name — and dropping its early
     * `return` was caught only incidentally by `tsc`.
     */
    it('refuses an emptied name at the client edge, without a write', async () => {
      const u = userEvent.setup()
      renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      const input = screen.getByRole('textbox', { name: /building/i })
      await u.clear(input)
      await u.type(input, '{Enter}')

      expect(await within(rowFor('Building')).findByRole('alert')).toHaveTextContent(
        'Give the status a name',
      )
      expect(mockRename).not.toHaveBeenCalled()
    })

    /**
     * The SECOND schema message from the same branch, and it is not redundant with the one
     * above: with only the empty case,
     * `setError(parsed.error.issues[0]?.message ?? GENERIC_CREATE_ERROR)` can be replaced by the
     * hardcoded literal `'Give the status a name'` and stay green. Two different messages out of
     * one expression is what proves the row reports the SCHEMA's reason rather than a constant.
     */
    it('refuses an over-long name with the schema’s own message', async () => {
      const u = userEvent.setup()
      renderSettings()

      await u.click(within(rowFor('Building')).getByRole('button', { name: /edit .*building/i }))
      const input = screen.getByRole('textbox', { name: /building/i })
      await u.clear(input)
      // 41 characters — one past the cap that mirrors `project_statuses_name_nonempty`.
      await u.type(input, `${'B'.repeat(41)}{Enter}`)

      expect(await within(rowFor('Building')).findByRole('alert')).toHaveTextContent(
        'Keep the name to 40 characters or fewer',
      )
      expect(mockRename).not.toHaveBeenCalled()
    })
  })

  describe('reordering', () => {
    it('sends the COMPLETE swapped slug list when a row moves down', async () => {
      const u = userEvent.setup()
      // Positions renumbered by the server, which the local splice cannot produce — so
      // `onReordered(rest)` and `onReordered(result.value)` are distinguishable here rather
      // than only in `ProjectShell.test.tsx`.
      const reordered = [
        { ...BUILDING, position: 10 },
        { ...TRIAGE, position: 20 },
        { ...SHIPPED, position: 30 },
      ]
      mockReorder.mockResolvedValue({ ok: true, value: reordered })
      const { onReordered } = renderSettings()

      await u.click(within(rowFor('Triage')).getByRole('button', { name: /move .* down/i }))

      // Every slug the project has, in the new order. A PARTIAL list would leave the omitted
      // rows on their old positions and can collide on the deferred unique constraint.
      await waitFor(() =>
        expect(mockReorder).toHaveBeenCalledWith('p1', ['in_build', 'triage', 'shipped']),
      )
      await waitFor(() => expect(onReordered).toHaveBeenCalledWith(reordered))
    })

    it('sends the COMPLETE swapped slug list when a row moves up', async () => {
      const u = userEvent.setup()
      mockReorder.mockResolvedValue({ ok: true, value: [TRIAGE, SHIPPED, BUILDING] })
      renderSettings()

      await u.click(within(rowFor('Shipped')).getByRole('button', { name: /move .* up/i }))

      await waitFor(() =>
        expect(mockReorder).toHaveBeenCalledWith('p1', ['triage', 'shipped', 'in_build']),
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
      // BOTH directions, because the test says "every move control" and only asserted one:
      // dropping `disabled={reordering}` from the Move DOWN button left the whole 888-test
      // unit suite green. The invariant `StatusSettings` states is that every row waits — the
      // write sends the WHOLE order, so a second one races the first — and half of it was
      // unobserved.
      expect(within(rowFor('Triage')).getByRole('button', { name: /move .* down/i })).toBeDisabled()

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
        /^Something went wrong\. Please try again\.$/,
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

    /**
     * A failed reorder's message must not outlive the attempt it describes.
     *
     * This is the THIRD instance of one bug. The rename clears before its no-op check and the
     * delete dialog clears on close — both were fixed with a test — while `move()`'s own
     * `setError(null)` and the dialog's were fixed without one, so both could be deleted with
     * every test green. The test above asserts the button re-enables ("AND THE USER CAN TRY
     * AGAIN") but never retries, so the message's LIFETIME went unobserved.
     *
     * Fixing one of two mirrored call sites and leaving the other is a mistake this project has
     * already made twice, so the delete dialog's gets the same test in the block below.
     */
    it('clears a failed reorder’s message once a later reorder succeeds', async () => {
      const u = userEvent.setup()
      mockReorder.mockResolvedValue({ ok: false, error: 'unknown' })
      renderSettings()

      await u.click(within(rowFor('Triage')).getByRole('button', { name: /move .* down/i }))
      expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i)

      // The rendered order is still the prop's, so the same control is still there to retry on.
      mockReorder.mockResolvedValue({ ok: true, value: [BUILDING, TRIAGE, SHIPPED] })
      await u.click(within(rowFor('Triage')).getByRole('button', { name: /move .* down/i }))

      await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    })
  })

  describe('deleting a status', () => {
    // A KNOWN zero for every row — distinct from the default `renderSettings()` map, which is
    // EMPTY and (since the fix below) means "we do not know", not "zero". Tests in this block
    // that are about something other than the availability gate itself use this so they are not
    // incidentally blocked by it.
    const KNOWN_ZERO_COUNTS = new Map([
      ['triage', 0],
      ['in_build', 0],
      ['shipped', 0],
    ])

    it("shows each status's ticket count", () => {
      renderSettings({ counts: new Map([['triage', 4]]) })

      expect(within(deleteRowFor('Triage')).getByText('4 tickets')).toBeInTheDocument()
    })

    // ZERO — the count every deletable status has, and the only one that was never asserted.
    // `4` and `undefined` were both covered; `count === 0 ? '' : …` was green.
    it('shows a zero count rather than nothing at all', () => {
      renderSettings({ counts: new Map([['triage', 0]]) })

      expect(within(deleteRowFor('Triage')).getByText('0 tickets')).toBeInTheDocument()
    })

    // And ONE, which is the singular. Declared as an accepted gap for two review rounds on the
    // grounds that the code is correct and only the coverage was missing — which is true of
    // every unpinned line, and is exactly the reasoning that left the count's other two cases
    // unobserved. Adding the zero case and not this one would have been the mirror-site mistake
    // this story has now made three times.
    it('says “1 ticket”, singular, for a status holding one', () => {
      renderSettings({ counts: new Map([['triage', 1]]) })

      expect(within(deleteRowFor('Triage')).getByText('1 ticket')).toBeInTheDocument()
    })

    it('disables Delete on a status holding tickets, and states the reason', () => {
      renderSettings({ counts: new Map([['triage', 4]]) })

      const row = deleteRowFor('Triage')
      expect(within(row).getByRole('button', { name: 'Delete Triage' })).toBeDisabled()
      // `getByText` matches an `aria-hidden` subtree perfectly happily, so the sentence
      // existing in the DOM says nothing about a screen reader reaching it — and this sentence
      // is the ONLY explanation for a disabled control. Adding `aria-hidden="true"` to the
      // reason paragraph left all three tests that name it green.
      const reason = within(row).getByText(/holds 4 tickets/i)
      expect(reason).toBeInTheDocument()
      expect(reason).not.toHaveAttribute('aria-hidden')
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
        // And the COUNT itself says it does not know. Only the gate was pinned, so the span
        // could render a fabricated '0 tickets' directly above "counts are unavailable" —
        // re-introducing on screen the exact `?? 0` lie the `number | undefined` prop exists
        // to prevent. Guarded against `aria-hidden` for the same reason the reason paragraph
        // above is: it is explanatory text for a disabled control, and `getByText` reaches it
        // either way.
        const unknown = within(row).getByText('count unavailable')
        expect(unknown).toBeInTheDocument()
        expect(unknown).not.toHaveAttribute('aria-hidden')
      }
    })

    it('names the status that will take over when deleting the initial one', async () => {
      const u = userEvent.setup()
      renderSettings({ counts: KNOWN_ZERO_COUNTS })

      // BUILDING is the initial status and is NOT the first row — which is the whole point.
      // TRIAGE is the lowest-position survivor, so `removeStatus` promotes it and the dialog
      // must name it rather than re-derive the rule itself. While the initial status was also
      // `statuses[0]`, `removeStatus(statuses, status.id)` survived being re-keyed to
      // `statuses[0].id`, because the two reads could not be told apart.
      await u.click(screen.getByRole('button', { name: 'Delete Building' }))

      const dialog = await screen.findByRole('alertdialog')
      expect(dialog).toHaveTextContent(/will start in/i)
      expect(dialog).toHaveTextContent('Triage')
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

      // TRIAGE is not initial; BUILDING is, and survives this delete as the initial status.
      await u.click(screen.getByRole('button', { name: 'Delete Triage' }))

      const dialog = await screen.findByRole('alertdialog')
      // `toHaveTextContent` reads `textContent` and does not honour `aria-hidden`, so the
      // warning on a DESTRUCTIVE confirm could be hidden from assistive tech with every test
      // green — the same mechanism already guarded on the row's block-reason and count span,
      // unapplied to the two sibling sites until now.
      const undone = within(dialog).getByText(/can’t be undone/i)
      expect(undone).not.toHaveAttribute('aria-hidden')
      expect(dialog).not.toHaveTextContent(/will start in/i)
      // The surviving initial status must not be named at all. 'Building' rather than 'Triage'
      // now that the initial status has moved — the dialog's own title says 'Delete Triage?',
      // so looking for that name here would match the heading and never the promotion sentence.
      expect(within(dialog).queryByText(/building/i)).toBeNull()
    })

    /**
     * THE CRITICAL from the SPRIN-84 review, and the reason SPRIN-87 exists.
     *
     * `onDeleted(status.id)` was asserted here and the WRITE's own argument was not —
     * `mockDelete` was the only one of this file's four mocks with no `toHaveBeenCalledWith`
     * at all. So `deleteProjectStatus('WRONG-ID-NOT-A-STATUS')` left the whole unit suite
     * green while the shell removed the right row optimistically and the database lost a
     * different status: silent, destructive, and green.
     *
     * Both halves belong in ONE test. Apart, each says only "some id was used"; together they
     * say the row that disappears from the list is the row that was deleted from the database.
     * 'Building' rather than the first row, so a write that ignored its argument and sent the
     * head of the list would be caught rather than accidentally right.
     */
    it('deletes the status the dialog was opened on, and removes that same row', async () => {
      const u = userEvent.setup()
      mockDelete.mockResolvedValue({ ok: true, value: undefined })
      const { onDeleted } = renderSettings({ counts: KNOWN_ZERO_COUNTS })

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const dialog = await screen.findByRole('alertdialog')
      // Scoped to the dialog: an unscoped /delete/i would also match every row's button.
      await u.click(within(dialog).getByRole('button', { name: /^delete$/i }))

      // The USER-FACING half of the same question, and it was unpinned: the confirm can stop
      // naming its target entirely ('Delete this status?') with every other assertion green,
      // leaving a destructive dialog that does not say which of three identical Delete buttons
      // opened it. A WRONG name was caught only incidentally, by an assertion in a different
      // test about a different sentence.
      //
      // Scoped to the HEADING and anchored, which the first version of this line was not — it
      // read `expect(dialog).toHaveTextContent('Delete Building?')`, a substring match over the
      // whole subtree (title, description AND both buttons), so an additive reword of the title
      // survived it. That is the same defect this commit's siblings were anchored to fix, three
      // lines away. `AlertDialogTitle` renders an `h2`, whose name is one text node.
      expect(within(dialog).getByRole('heading')).toHaveTextContent(/^Delete Building\?$/)
      await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('st2'))
      expect(mockDelete).toHaveBeenCalledOnce()
      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('st2'))
    })

    /**
     * Open Building's confirm and click Delete on a write that never settles, so the in-flight
     * state can be observed at all. Every caller MUST `release()` before returning: a state
     * update that lands after the test has finished is an `act()` warning at best and a leak
     * into the next test at worst.
     *
     * **No wait is needed here, and there is deliberately not one.** `await u.click` runs inside
     * `act`, and `setDeleting(true)` and the `deleteProjectStatus` call sit in the same
     * synchronous block, so the in-flight render has already flushed by the time it returns —
     * measured: `disabled=true text=Deleting… mockDeleteCalls=1` immediately after the click.
     * An earlier version waited on the button reading 'Deleting…', which coupled all three tests
     * below to that one string (removing the label failed all three, so none could tell "the
     * guard is gone" from "the label is gone"). Its replacement waited on `mockDelete` and was
     * simply inert — deleting the line changed nothing. What follows is a PRECONDITION check,
     * not a synchronisation point: it says the click really did issue the write.
     */
    async function startPendingDelete() {
      const u = userEvent.setup()
      let release: (v: { ok: true; value: undefined }) => void = () => {}
      mockDelete.mockReturnValue(
        new Promise((resolve) => {
          release = resolve
        }),
      )
      const handlers = renderSettings({ counts: KNOWN_ZERO_COUNTS })

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const dialog = await screen.findByRole('alertdialog')
      const confirm = within(dialog).getByRole('button', { name: /^delete$/i })
      await u.click(confirm)
      expect(mockDelete).toHaveBeenCalledOnce()

      /**
       * Resolve the pending write inside `act` so its state update lands before the test ends.
       *
       * A DRAIN, not an assertion, and that distinction is the whole point. Every observable in
       * this block is some test's subject, so a drain that waits on one stops waiting under
       * exactly the mutation that test exists to catch: settling on `onDeleted` turned a single
       * clean failure into three, two of them reported against the drain line rather than the
       * assertion that actually broke. `act` waits on React, which is nobody's subject.
       */
      const settle = async () => {
        await act(async () => {
          release({ ok: true, value: undefined })
        })
      }
      return { u, dialog, confirm, handlers, settle }
    }

    /**
     * The `if (deleting) return` in `onOpenChange`, pinned on the ONE close path it is the sole
     * defence for.
     *
     * Cancel cannot pin it: Cancel is itself `disabled={deleting}`, so "click Cancel, the dialog
     * stays open" passes with either guard removed and therefore pins neither. Escape reaches
     * `onOpenChange` without going through a disabled control, so this test fails the moment the
     * early return goes — leaving a user able to dismiss the confirm mid-write and watch a row
     * vanish from a dialog they thought they had cancelled.
     */
    it('keeps the confirm open on Escape while the delete is in flight', async () => {
      const { u, settle } = await startPendingDelete()

      await u.keyboard('{Escape}')

      expect(screen.getByRole('alertdialog')).toBeVisible()

      await settle()
    })

    /**
     * Both footer buttons' `disabled={deleting}`.
     *
     * Cancel's is asserted as the ATTRIBUTE deliberately, not through behaviour: with the
     * `onOpenChange` guard above still standing, the two defences overlap and the attribute is
     * the only observable difference between them. A disabled control is itself the user-facing
     * property — not focusable, visibly unavailable — so this is the honest assertion rather
     * than a retreat to mechanism. The Delete button gets the behavioural test as well, below,
     * because nothing else guards it.
     */
    it('disables both footer buttons while the delete is in flight', async () => {
      const { dialog, confirm, settle } = await startPendingDelete()

      expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled()
      expect(confirm).toBeDisabled()
      // And the confirm SAYS it is working. Asserted here rather than relied on as this
      // block's synchronisation point, so removing the pending label fails one test about the
      // label instead of three tests about the guards.
      expect(confirm).toHaveTextContent(/^Deleting…$/)

      // Both released again once the write lands. Assertions AFTER the drain rather than a
      // `waitFor` doubling as one — `toBeEnabled()` is this test's own subject, so waiting on
      // it would have been the same trap in miniature.
      await settle()
      expect(confirm).toBeEnabled()
      // Anchored like everything else in this file: unanchored, both labels admit an additive
      // reword ('Delete now', 'Deleting… please wait') that says nothing has broken.
      expect(confirm).toHaveTextContent(/^Delete$/)
    })

    // The consequence the disabled attribute exists for. `submit()` has no re-entrancy check of
    // its own, so without the button's `disabled` a second click calls `deleteProjectStatus`
    // again — a double-click on a slow connection sending two deletes for one intent.
    it('sends only one delete when the confirm button is clicked twice', async () => {
      const { u, confirm, settle } = await startPendingDelete()

      await u.click(confirm)

      expect(mockDelete).toHaveBeenCalledOnce()

      await settle()
    })

    it('surfaces a has_tickets refusal without calling onDeleted', async () => {
      const u = userEvent.setup()
      mockDelete.mockResolvedValue({ ok: false, error: 'has_tickets' })
      const { onDeleted } = renderSettings({ counts: KNOWN_ZERO_COUNTS })

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const dialog = await screen.findByRole('alertdialog')
      await u.click(within(dialog).getByRole('button', { name: /^delete$/i }))

      // Anchored and scoped, to the same standard as its two siblings below. This was the ONE
      // delete-failure sentence with a test, and it was pinned by the fragment /move them/i —
      // so the copy could lose its entire explanation of WHY and stay green.
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        /^This status still holds tickets\. Move them to another status first, then try again\.$/,
      )
      expect(onDeleted).not.toHaveBeenCalled()
    })

    /**
     * `DELETE_FAILURE_COPY`'s other two reachable entries. Only `has_tickets` was pinned, so
     * both of these could be reworded to the generic 'Something went wrong. Please try again.'
     * with nothing going red — copy that tells the user to retry a write which will refuse
     * identically every time.
     *
     * Driven through the mock, exactly as the `has_tickets` test above is, because the UI gates
     * both: `deleteBlockReason` disables Delete on a one-status list, and a stale row is a race
     * with another tab. Gated in the UI is not the same as unreachable from the write — that
     * is the whole reason the map is total over the tag union.
     *
     * ANCHORED, because `toHaveTextContent` with a string is a SUBSTRING match. The first
     * version of these tests asserted the bare sentence and called it exact — and the mutation
     * they were written to kill still survived, because appending the generic retry copy to the
     * end of the sentence is an additive reword and every substring assertion still held. `/^…$/`
     * is what makes "this and nothing else" true. Found by review, not by writing it twice.
     *
     * This stays inside CLAUDE.md's accessible-name rule: it is DOM text on one element, not an
     * exact-name query on an element whose name is composed from stylesheet-positioned children.
     */
    it('explains a last-status refusal in its own words', async () => {
      const u = userEvent.setup()
      mockDelete.mockResolvedValue({ ok: false, error: 'last' })
      const { onDeleted } = renderSettings({ counts: KNOWN_ZERO_COUNTS })

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const dialog = await screen.findByRole('alertdialog')
      await u.click(within(dialog).getByRole('button', { name: /^delete$/i }))

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        /^A project must keep at least one status\.$/,
      )
      expect(onDeleted).not.toHaveBeenCalled()
    })

    // Scoped to the DIALOG, not the page: `AddStatusForm`'s own stale copy also says 'refresh',
    // so an unscoped assertion here would pass on the wrong element's sentence.
    it('explains a stale refusal in its own words', async () => {
      const u = userEvent.setup()
      mockDelete.mockResolvedValue({ ok: false, error: 'stale' })
      const { onDeleted } = renderSettings({ counts: KNOWN_ZERO_COUNTS })

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const dialog = await screen.findByRole('alertdialog')
      await u.click(within(dialog).getByRole('button', { name: /^delete$/i }))

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        /^This status no longer exists — refresh the page to see the current list\.$/,
      )
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

    /**
     * The MIRROR of the reorder test above, on the other `setError(null)` that had no test.
     *
     * The dialog clears its message when it CLOSES (pinned above) but also at the top of
     * `submit()`, and only the first of those was observed — so a user who fixes the cause and
     * retries without closing the dialog would see the previous refusal still sitting there
     * next to a delete that has just succeeded. Every path this component takes to a stale
     * message is now pinned rather than two of the four.
     */
    it('clears a failed delete’s message when the retry succeeds', async () => {
      const u = userEvent.setup()
      mockDelete.mockResolvedValue({ ok: false, error: 'has_tickets' })
      const { onDeleted } = renderSettings({ counts: KNOWN_ZERO_COUNTS })

      await u.click(screen.getByRole('button', { name: 'Delete Building' }))
      const dialog = await screen.findByRole('alertdialog')
      const confirm = within(dialog).getByRole('button', { name: /^delete$/i })
      await u.click(confirm)
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(/move them/i)

      // Same dialog, never closed — the close path is a different clear, tested above.
      mockDelete.mockResolvedValue({ ok: true, value: undefined })
      await u.click(confirm)

      await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('st2'))
      expect(within(dialog).queryByRole('alert')).toBeNull()
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
    const empty = screen.getByText('This project has no statuses, so its board has no columns.')
    expect(empty).toBeVisible()
    expect(empty).not.toHaveAttribute('aria-hidden')
  })
})
