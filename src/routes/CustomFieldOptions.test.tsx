import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CustomFieldOptions } from './CustomFieldOptions'
import type { ProjectField, ProjectFieldOption } from '@/lib/domain'
import {
  countTicketsHoldingOption,
  createProjectFieldOption,
  deleteProjectFieldOption,
  renameProjectFieldOption,
} from '@/lib/project-field-options'

// Spread the real module: only the network-touching writes (and the count read) are mocked,
// exactly as CustomFieldSettings.test.tsx does for its sibling data module. `optionsForField`
// stays real — it is pure, and mocking it would hide a bug in how this component uses it. An
// unmocked write would otherwise reach the LIVE database silently, because `VITE_SUPABASE_URL`
// is a placeholder in this environment and the rejection is handled.
vi.mock('@/lib/project-field-options', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-field-options')>()),
  createProjectFieldOption: vi.fn(),
  renameProjectFieldOption: vi.fn(),
  countTicketsHoldingOption: vi.fn(),
  deleteProjectFieldOption: vi.fn(),
}))

const mockCreate = vi.mocked(createProjectFieldOption)
const mockRename = vi.mocked(renameProjectFieldOption)
const mockCount = vi.mocked(countTicketsHoldingOption)
const mockDelete = vi.mocked(deleteProjectFieldOption)

const FIELD: ProjectField = {
  id: 'f1',
  project_id: 'p1',
  slug: 'priority',
  name: 'Priority',
  type: 'select',
  created_at: '2026-08-01T00:00:00+00:00',
}

// Positions deliberately NOT in list order and neither slug is its label lowercased with
// underscores swapped for nothing — SPRIN-87 already cost this project three tests whose
// fixture slug was `name.toLowerCase()`, which made a read of `.slug` indistinguishable from a
// read of `.label`.
const HIGH: ProjectFieldOption = {
  project_id: 'p1',
  field_id: 'f1',
  slug: 'high',
  label: 'High',
  position: 2,
}
const LOW: ProjectFieldOption = {
  project_id: 'p1',
  field_id: 'f1',
  slug: 'low',
  label: 'Low',
  position: 1,
}
const OPTIONS = [HIGH, LOW]

const noopHandlers = { onCreated: vi.fn(), onUpdated: vi.fn(), onDeleted: vi.fn() }

/** The row for an option, found by the label it renders. Scoping every DOM-text assertion to
 *  the row is the SPRIN-67 discipline carried over from `CustomFieldSettings.test.tsx`: an
 *  unscoped `getByText` says the text exists and nothing about where. */
function rowFor(label: string): HTMLElement {
  const row = screen.getByText(label).closest('li')
  if (!row) throw new Error(`No row rendered for '${label}'`)
  return row
}

beforeEach(() => {
  mockCreate.mockReset()
  mockRename.mockReset()
  mockCount.mockReset()
  mockDelete.mockReset()
})

describe('CustomFieldOptions', () => {
  it('lists the options in position order', () => {
    render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)
    const items = screen.getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(within(items[0]!).getByText('Low')).toBeInTheDocument()
    expect(within(items[1]!).getByText('High')).toBeInTheDocument()
  })

  // The point of this test: `position`-only ordering survives every OTHER test in this file.
  // Only a tied position exercises the slug tiebreak at all.
  it('breaks a position TIE on slug, so the order is total', () => {
    const tied = [
      { ...HIGH, slug: 'zebra', label: 'Zebra', position: 1 },
      { ...LOW, slug: 'apple', label: 'Apple', position: 1 },
    ]
    render(<CustomFieldOptions field={FIELD} options={tied} {...noopHandlers} />)
    const items = screen.getAllByRole('listitem')
    expect(within(items[0]!).getByText('Apple')).toBeInTheDocument()
    expect(within(items[1]!).getByText('Zebra')).toBeInTheDocument()
  })

  it('shows an empty state when the field has no options', () => {
    render(<CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} />)
    const empty = screen.getByText('No options yet.')
    expect(empty).toBeInTheDocument()
    // Guarded against `aria-hidden`, mirroring CustomFieldSettings.test.tsx's identical "No X
    // yet." assertion: `getByText` reaches hidden text just as happily as visible text, so
    // without this an `aria-hidden="true"` on the paragraph would leave every test here green.
    expect(empty).not.toHaveAttribute('aria-hidden')
    // Positive control: `queryByRole` EXCLUDES `aria-hidden`, so an absence check on the list
    // alone would not distinguish "no rows" from "rows hidden".
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  describe('adding an option', () => {
    it('adds an option and hands the row up', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: true, value: HIGH })
      const onCreated = vi.fn()
      render(
        <CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} onCreated={onCreated} />,
      )

      await u.type(screen.getByRole('textbox', { name: /option label/i }), 'High')
      await u.click(screen.getByRole('button', { name: 'Add option' }))

      await waitFor(() =>
        expect(mockCreate).toHaveBeenCalledWith({
          projectId: 'p1',
          fieldId: 'f1',
          label: 'High',
          existing: [],
        }),
      )
      await waitFor(() => expect(onCreated).toHaveBeenCalledWith(HIGH))
    })

    it("passes only THIS field's options as the de-duplication list", async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: true, value: HIGH })
      const mixed = [...OPTIONS, { ...HIGH, field_id: 'f2', slug: 'other' }]
      render(<CustomFieldOptions field={FIELD} options={mixed} {...noopHandlers} />)

      await u.type(screen.getByRole('textbox', { name: /option label/i }), 'Medium')
      await u.click(screen.getByRole('button', { name: 'Add option' }))

      // Sorted, matching the query's own order: LOW (position 1) before HIGH (position 2).
      await waitFor(() =>
        expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ existing: [LOW, HIGH] })),
      )
    })

    it('clears the label input after a successful add', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: true, value: HIGH })
      render(<CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} />)

      const label = screen.getByRole('textbox', { name: /option label/i })
      await u.type(label, 'High')
      await u.click(screen.getByRole('button', { name: 'Add option' }))

      await waitFor(() => expect(label).toHaveValue(''))
    })

    it('reports a stale list with copy that says to reload, not to retry', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: false, error: 'stale' })
      const onCreated = vi.fn()
      render(
        <CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} onCreated={onCreated} />,
      )

      await u.type(screen.getByRole('textbox', { name: /option label/i }), 'High')
      await u.click(screen.getByRole('button', { name: 'Add option' }))

      const alert = await screen.findByRole('alert')
      // Anchored: `toHaveTextContent` with a bare string is a SUBSTRING match, so an additive
      // reword would survive an unanchored assertion.
      expect(alert).toHaveTextContent(
        /^This list of options is out of date — refresh the page and try adding it again\.$/,
      )
      expect(onCreated).not.toHaveBeenCalled()
    })

    it('shows the generic retry copy for a failure the user cannot correct', async () => {
      const u = userEvent.setup()
      mockCreate.mockResolvedValue({ ok: false, error: 'unknown' })
      const onCreated = vi.fn()
      render(
        <CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} onCreated={onCreated} />,
      )

      await u.type(screen.getByRole('textbox', { name: /option label/i }), 'High')
      await u.click(screen.getByRole('button', { name: 'Add option' }))

      expect(await screen.findByRole('alert')).toHaveTextContent(
        /^Something went wrong\. Please try again\.$/,
      )
      expect(onCreated).not.toHaveBeenCalled()
    })

    it('refuses a blank label at the client edge, without a write', async () => {
      const u = userEvent.setup()
      render(<CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} />)

      const label = screen.getByRole('textbox', { name: /option label/i })
      await u.click(screen.getByRole('button', { name: 'Add option' }))

      await waitFor(() => expect(label).toHaveAttribute('aria-invalid', 'true'))
      expect(mockCreate).not.toHaveBeenCalled()
    })
  })

  describe('renaming an option', () => {
    async function startRename(u: ReturnType<typeof userEvent.setup>, label: string) {
      await u.click(
        within(rowFor(label)).getByRole('button', { name: new RegExp(`edit .*${label}`, 'i') }),
      )
      const input = screen.getByRole('textbox', { name: new RegExp(label, 'i') })
      await u.clear(input)
      return input
    }

    it('sends the field id, slug and new label, and hands the returned row up', async () => {
      const u = userEvent.setup()
      const renamed = { ...LOW, label: 'Lowest' }
      mockRename.mockResolvedValue({ ok: true, value: renamed })
      const onUpdated = vi.fn()
      render(
        <CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} onUpdated={onUpdated} />,
      )

      const input = await startRename(u, 'Low')
      await u.type(input, 'Lowest{Enter}')

      await waitFor(() => expect(mockRename).toHaveBeenCalledWith('f1', 'low', 'Lowest'))
      expect(mockRename).toHaveBeenCalledOnce()
      await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(renamed))
    })

    it('sends the trimmed label, not the raw commit', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: true, value: { ...LOW, label: 'Lowest' } })
      render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)

      const input = await startRename(u, 'Low')
      await u.type(input, 'Lowest   {Enter}')

      await waitFor(() => expect(mockRename).toHaveBeenCalledWith('f1', 'low', 'Lowest'))
    })

    it('reports a failed rename on the row that failed, and hands nothing up', async () => {
      const u = userEvent.setup()
      mockRename.mockResolvedValue({ ok: false, error: 'unknown' })
      const onUpdated = vi.fn()
      render(
        <CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} onUpdated={onUpdated} />,
      )

      const input = await startRename(u, 'Low')
      await u.type(input, 'Lowest{Enter}')

      const alert = await within(rowFor('Low')).findByRole('alert')
      expect(alert).toHaveTextContent(/^Something went wrong\. Please try again\.$/)
      // On the ROW that failed, not floating at the top — with two rows on screen a
      // page-level banner would not say which label was refused.
      expect(within(rowFor('High')).queryByRole('alert')).toBeNull()
      expect(onUpdated).not.toHaveBeenCalled()
    })

    it('does not write when the label is committed untouched', async () => {
      const u = userEvent.setup()
      render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)

      await u.click(within(rowFor('Low')).getByRole('button', { name: /edit .*low/i }))
      await u.type(screen.getByRole('textbox', { name: /low/i }), '{Enter}')

      expect(mockRename).not.toHaveBeenCalled()
    })

    it('refuses an emptied label at the client edge, without a write', async () => {
      const u = userEvent.setup()
      render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)

      const input = await startRename(u, 'Low')
      await u.type(input, '{Enter}')

      expect(await within(rowFor('Low')).findByRole('alert')).toBeInTheDocument()
      expect(mockRename).not.toHaveBeenCalled()
    })
  })

  describe('deleting an option', () => {
    it('shows how many tickets hold the option before committing', async () => {
      const u = userEvent.setup()
      mockCount.mockResolvedValue(3)
      render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)

      await u.click(screen.getAllByRole('button', { name: /remove/i })[0]!)
      expect(await screen.findByText(/3 tickets/i)).toBeInTheDocument()
      expect(mockDelete).not.toHaveBeenCalled()
    })

    it('reads the count only when the confirm opens, not on render', () => {
      render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)
      expect(mockCount).not.toHaveBeenCalled()
    })

    it('BLOCKS the delete when the count could not be read', async () => {
      const u = userEvent.setup()
      mockCount.mockRejectedValue(new Error('boom'))
      render(<CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} />)

      await u.click(screen.getAllByRole('button', { name: /remove/i })[0]!)

      // Zero is what UNLOCKS a destructive action, so an unknown count must not read as zero.
      expect(await screen.findByRole('alert')).toHaveTextContent(/could not check/i)
      const confirm = screen.getByRole('button', { name: 'Remove option' })
      expect(confirm).toBeDisabled()
    })

    it('deletes on confirm and hands the removal up', async () => {
      const u = userEvent.setup()
      mockCount.mockResolvedValue(0)
      mockDelete.mockResolvedValue({ ok: true, value: undefined })
      const onDeleted = vi.fn()
      render(
        <CustomFieldOptions field={FIELD} options={OPTIONS} {...noopHandlers} onDeleted={onDeleted} />,
      )

      await u.click(screen.getAllByRole('button', { name: /remove/i })[0]!)
      await u.click(await screen.findByRole('button', { name: 'Remove option' }))

      expect(mockDelete).toHaveBeenCalledWith('f1', 'low')
      expect(onDeleted).toHaveBeenCalledWith('f1', 'low')
    })
  })

  it('offers the add form on a loaded but empty list', () => {
    render(<CustomFieldOptions field={FIELD} options={[]} {...noopHandlers} />)

    expect(screen.getByRole('button', { name: 'Add option' })).toBeVisible()
  })
})
