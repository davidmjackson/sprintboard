import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TicketDetailDialog } from './TicketDetailDialog'
import {
  DEFAULT_PROJECT_STATUSES,
  type ProjectField,
  type ProjectFieldOption,
  type ProjectStatus,
  type Sprint,
  type Ticket,
} from '@/lib/domain'
import * as tickets from '@/lib/tickets'
import type { UpdateTicketResult } from '@/lib/tickets'

/** A promise the test controls the resolution of, plus its resolver. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// SPRIN-88's per-ticket read. Needed the moment any test here supplies a non-empty `fields`,
// which the phase test below does — without it the real `listTicketFieldValues` issues a live
// PostgREST request, invisibly, because the section catches the rejection and renders its
// failure state. The spread keeps `parseFieldValue`/`fieldValueText` real.
vi.mock('@/lib/ticket-field-values', async (orig) => ({
  ...(await orig<typeof import('@/lib/ticket-field-values')>()),
  listTicketFieldValues: vi.fn().mockResolvedValue([]),
  setTicketFieldValue: vi.fn().mockResolvedValue({ ok: true }),
  clearTicketFieldValue: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/tickets', async (orig) => ({
  ...(await orig<typeof tickets>()),
  updateTicket: vi.fn(),
  deleteTicket: vi.fn(),
  blockTicket: vi.fn(),
  unblockTicket: vi.fn(),
  createTicket: vi.fn(),
}))
const updateTicket = vi.mocked(tickets.updateTicket)
const deleteTicket = vi.mocked(tickets.deleteTicket)
const blockTicket = vi.mocked(tickets.blockTicket)
const unblockTicket = vi.mocked(tickets.unblockTicket)
const createTicket = vi.mocked(tickets.createTicket)

const base: Ticket = {
  id: 't1',
  project_id: 'p1',
  key: 'MP-1',
  number: 1,
  summary: 'Wire the board',
  type: 'story',
  status: 'todo',
  description: null,
  assignee_id: null,
  story_points: null,
  acceptance_criteria: null,
  labels: [],
  sprint_id: null,
  parent_epic_id: null,
  context: null,
  deliverables: [],
  is_blocked: false,
  blocked_reason: null,
  blocked_since: null,
  created_at: '2026-07-15T00:00:00Z',
  updated_at: '2026-07-15T00:00:00Z',
}
const user = { id: 'user-a', email: 'a@example.com' }

// The four rows `seed_project_statuses()` writes for every new project, shaped as the dialog
// receives them. Derived from the seed contract in `domain.ts` rather than retyped, so this
// harness cannot go on describing a vocabulary the database stopped seeding.
//
// The `id`s look NOTHING like the slugs, mirroring `BoardTab.test.tsx`: `tickets.status` is a
// text column carrying the SLUG (composite fk to `project_statuses (project_id, slug)`), so an
// option list built from `status.id` must not be able to pass.
const SEEDED_STATUSES = DEFAULT_PROJECT_STATUSES.map((status, i) => ({
  ...status,
  id: `1ecd8f0${i}-0000-4000-8000-000000000000`,
  project_id: 'p1',
})) as unknown as ProjectStatus[]

// A vocabulary this project's rows could plausibly hold once SPRIN-77 lets them be edited:
// five statuses, one of them ('parked') a slug the `TICKET_STATUSES` constant this story removed
// never contained, and in an order that deliberately disagrees with the once hard-coded board
// order and with sorting by slug. `listProjectStatuses` already returns rows ordered by
// `position`, so the picker's job is to render the list it is handed, unsorted.
//
// `in_review` is named 'In Review' — a NAME that differs visibly from its SLUG — which is what
// makes the header test able to tell "rendered the row's name" from "rendered the raw slug".
const FIVE_STATUSES = [
  { slug: 'in_progress', name: 'In Progress', category: 'in_progress', position: 2 },
  { slug: 'todo', name: 'To Do', category: 'todo', position: 1 },
  { slug: 'in_review', name: 'In Review', category: 'in_progress', position: 3 },
  { slug: 'done', name: 'Done', category: 'done', position: 4 },
  { slug: 'parked', name: 'Parked', category: 'todo', position: 5 },
].map((status, i) => ({
  ...status,
  id: `5ec0dd0${i}-0000-4000-8000-000000000000`,
  project_id: 'p1',
  is_initial: status.slug === 'todo',
})) as unknown as ProjectStatus[]

/** The dialog's title row — uniquely named by the ticket key, so it scopes header assertions
 *  away from the sidebar's `<option>`s, which carry the same status text. A REGEX name query,
 *  never an exact one: this heading's accessible name is composed from several styled spans,
 *  and under jsdom that string is not what any browser computes (see CLAUDE.md, SPRIN-67). */
function dialogHeader() {
  return screen.getByRole('heading', { name: /MP-1/ })
}

/** Every `<option>` belonging to the Status `<select>` specifically — the dialog renders
 *  four other selects, so an unscoped `getAllByRole('option')` would mix them in. */
function statusOptionsOf() {
  return Array.from(
    (screen.getByLabelText('status') as HTMLSelectElement).options,
  ) as HTMLOptionElement[]
}

beforeEach(() => {
  updateTicket.mockReset()
  deleteTicket.mockReset()
  blockTicket.mockReset()
  unblockTicket.mockReset()
  createTicket.mockReset()
})

describe('TicketDetailDialog', () => {
  it('shows the ticket key, summary, and status when open', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        statuses={SEEDED_STATUSES}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.getByText('MP-1')).toBeInTheDocument()
    expect(screen.getByText('Wire the board')).toBeInTheDocument()
    // Scoped to the dialog's title row (the DialogTitle <h2>, uniquely named by the
    // ticket key) so this pins the header's status badge specifically — the sidebar's
    // Status <select> also renders the text "To Do" (as an <option>), but that node
    // lives outside this heading entirely.
    expect(within(dialogHeader()).getByText('To Do')).toBeInTheDocument()
  })

  it('renders nothing interactive when ticket is null', () => {
    render(
      <TicketDetailDialog
        ticket={null}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.queryByText('MP-1')).not.toBeInTheDocument()
  })

  it('commits an edited summary optimistically, then reconciles the persisted row', async () => {
    const onUpdated = vi.fn()
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: { ...base, summary: 'Renamed', updated_at: '2026-07-15T00:01:00Z' },
    })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    const input = screen.getByRole('textbox', { name: /summary/i })
    await userEvent.clear(input)
    await userEvent.type(input, 'Renamed{Enter}')

    // optimistic call first, reconcile call second
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2))
    expect(onUpdated.mock.calls[0]![0]).toMatchObject({ summary: 'Renamed' })
    expect(onUpdated.mock.calls[1]![0]).toMatchObject({
      summary: 'Renamed',
      updated_at: '2026-07-15T00:01:00Z',
    })
    expect(updateTicket).toHaveBeenCalledWith('t1', { summary: 'Renamed' })
  })

  it('rolls back and shows an error when the save fails', async () => {
    const onUpdated = vi.fn()
    updateTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    const input = screen.getByRole('textbox', { name: /summary/i })
    await userEvent.clear(input)
    await userEvent.type(input, 'Bad{Enter}')

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    // optimistic then rollback -> last call restores the original summary
    expect(onUpdated.mock.calls.at(-1)![0]).toMatchObject({ summary: 'Wire the board' })
  })

  it('does not call updateTicket when Esc cancels the edit', async () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    const input = screen.getByRole('textbox', { name: /summary/i })
    await userEvent.type(input, 'X{Escape}')
    expect(updateTicket).not.toHaveBeenCalled()
  })

  it('commits an assignee change to the current user, sending assignee_id', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, assignee_id: 'user-a' } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /assignee/i }), 'user-a')
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { assignee_id: 'user-a' }))
  })

  it('lists only Unassigned and the current user as assignee options', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    const options = screen.getAllByRole('option').filter((o) =>
      (o as HTMLOptionElement)
        .closest('select')
        ?.getAttribute('aria-label')
        ?.match(/assignee/i),
    )
    expect(options.map((o) => o.textContent)).toEqual(['Unassigned', 'a@example.com'])
  })

  it('preserves a concurrent field edit when an earlier save fails and rolls back only its own field', async () => {
    // Two in-flight saves, resolved manually and out of commit order, so the rollback
    // must merge against the LATEST ticket rather than a stale render-time snapshot.
    let resolveSummarySave!: (r: UpdateTicketResult) => void
    let resolvePointsSave!: (r: UpdateTicketResult) => void
    const summarySave = new Promise<UpdateTicketResult>((res) => {
      resolveSummarySave = res
    })
    const pointsSave = new Promise<UpdateTicketResult>((res) => {
      resolvePointsSave = res
    })
    updateTicket.mockImplementation((_id, patch) => {
      if (patch && 'summary' in patch) return summarySave
      if (patch && 'story_points' in patch) return pointsSave
      return Promise.resolve({ ok: true, ticket: base })
    })

    const onUpdated = vi.fn()
    // A tiny stand-in for the real parent: replaces the ticket by id on every onUpdated,
    // exactly like the app does, so the component's ticketRef sees the latest merged state.
    function Harness() {
      const [t, setT] = useState(base)
      return (
        <TicketDetailDialog
          ticket={t}
          currentUser={user}
          options={[]}
          optionsPhase="loaded"
          onOpenChange={() => {}}
          onUpdated={(next) => {
            setT(next)
            onUpdated(next)
          }}
          onDeleted={() => {}}
        />
      )
    }
    render(<Harness />)

    // Start editing summary; commit fires updateTicket and optimistically applies, but the
    // save stays pending.
    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), 'First edit{Enter}')
    await waitFor(() => expect(screen.getByText('First edit')).toBeInTheDocument())

    // While the summary save is still pending, edit story points too — its optimistic
    // update lands on top of the (still-pending) summary edit.
    await userEvent.click(screen.getByRole('button', { name: /edit story points/i }))
    await userEvent.clear(screen.getByRole('spinbutton', { name: /story points/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /story points/i }), '5{Enter}')
    await waitFor(() =>
      expect(screen.queryByRole('spinbutton', { name: /story points/i })).not.toBeInTheDocument(),
    )

    expect(updateTicket).toHaveBeenCalledWith('t1', { summary: 'First edit' })
    expect(updateTicket).toHaveBeenCalledWith('t1', { story_points: 5 })

    // The SECOND (story points) field's save resolves and reconciles first, while the
    // FIRST (summary) save is still pending.
    resolvePointsSave({
      ok: true,
      ticket: { ...base, story_points: 5, updated_at: '2026-07-15T00:02:00Z' },
    })
    await waitFor(() => expect(onUpdated.mock.calls.at(-1)![0]).toMatchObject({ story_points: 5 }))

    // NOW the summary save fails, after story points has already reconciled to 5. A
    // stale render-time-snapshot rollback would revert the WHOLE ticket (including
    // story_points, back to null) — the fix must revert only `summary`.
    resolveSummarySave({ ok: false, error: 'unknown' })
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())

    const latest = onUpdated.mock.calls.at(-1)![0] as Ticket
    expect(latest.summary).toBe('Wire the board') // reverted — only the failed field
    expect(latest.story_points).toBe(5) // survives — concurrent edit not clobbered
  })

  it('Esc while editing a field cancels only the field edit, not the whole dialog', async () => {
    const onOpenChange = vi.fn()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={onOpenChange}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    const input = screen.getByRole('textbox', { name: /summary/i })
    await userEvent.type(input, 'Should not save{Escape}')

    expect(updateTicket).not.toHaveBeenCalled()
    // Back to view mode: the field editor is gone, the button is back.
    expect(screen.getByRole('button', { name: /edit summary/i })).toBeInTheDocument()
    // The dialog itself must not have been asked to close.
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('Esc with no field being edited allows the dialog to dismiss', async () => {
    const onOpenChange = vi.fn()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={onOpenChange}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    await userEvent.keyboard('{Escape}')

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it('guards a rollback/reconcile against a ticket switch: onUpdated always carries the id of the ticket the save belongs to', async () => {
    const ticketB: Ticket = { ...base, id: 't2', key: 'MP-2', summary: 'Ticket B' }
    const { promise, resolve } = deferred<UpdateTicketResult>()
    updateTicket.mockReturnValue(promise)
    const onUpdated = vi.fn()
    const { rerender } = render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), 'Renamed A{Enter}')

    // Optimistic onUpdated has fired for ticket A; the save itself is still pending.
    expect(onUpdated).toHaveBeenCalledTimes(1)
    expect(onUpdated.mock.calls[0]![0]).toMatchObject({ id: 't1' })

    // Same mounted instance, switched to a DIFFERENT ticket while A's save is in flight —
    // this is exactly what selecting another row on the board does.
    rerender(
      <TicketDetailDialog
        ticket={ticketB}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )

    resolve({
      ok: true,
      ticket: { ...base, summary: 'Renamed A', updated_at: '2026-07-15T00:05:00Z' },
    })
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2))

    // Every onUpdated call must carry ticket A's identity — never a ticket-B-identity
    // object (id t2) carrying ticket A's reconciled data.
    for (const call of onUpdated.mock.calls) {
      expect(call[0]).toMatchObject({ id: 't1' })
    }
  })

  it('guards a rollback/reconcile against the dialog closing (ticket becomes null) mid-save', async () => {
    const { promise, resolve } = deferred<UpdateTicketResult>()
    updateTicket.mockReturnValue(promise)
    const onUpdated = vi.fn()
    const { rerender } = render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), 'Renamed A{Enter}')
    expect(onUpdated).toHaveBeenCalledTimes(1)

    // Dialog closes (parent sets ticket to null) while the save is still in flight.
    rerender(
      <TicketDetailDialog
        ticket={null}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )

    resolve({
      ok: true,
      ticket: { ...base, summary: 'Renamed A', updated_at: '2026-07-15T00:06:00Z' },
    })
    await waitFor(() => expect(onUpdated).toHaveBeenCalledTimes(2))

    // Never an id-less `{}`-spread object — identity and other fields must survive.
    const reconciled = onUpdated.mock.calls[1]![0] as Ticket
    expect(reconciled.id).toBe('t1')
    expect(reconciled.type).toBeDefined()
    expect(reconciled.labels).toBeDefined()
  })

  it('rejects negative or decimal story points without saving, then accepts a valid whole number', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, story_points: 8 } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit story points/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /story points/i }), '-5{Enter}')
    expect(updateTicket).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/whole numbers only/i)

    await userEvent.click(screen.getByRole('button', { name: /edit story points/i }))
    await userEvent.clear(screen.getByRole('spinbutton', { name: /story points/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /story points/i }), '3.5{Enter}')
    expect(updateTicket).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/whole numbers only/i)

    await userEvent.click(screen.getByRole('button', { name: /edit story points/i }))
    await userEvent.clear(screen.getByRole('spinbutton', { name: /story points/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /story points/i }), '8{Enter}')
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { story_points: 8 }))
  })

  it('bounds the story points input at zero, from the CALL SITE that owns the rule', async () => {
    // `min={0}` was `EditableText`'s hardcoded behaviour for any `numeric` field until
    // SPRIN-88, which gave custom `number` fields the same component and needs them UNbounded
    // (a temperature, a variance, a balance). Moving the bound to this call site left it
    // unpinned — nothing was asserting it, so dropping the prop would have been silent. The
    // matching negative, that a custom number field carries no `min`, is in
    // `TicketCustomFields.test.tsx`; the pair is what stops the rule drifting back into the
    // shared component or falling out of this one.
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit story points/i }))
    expect(screen.getByRole('spinbutton', { name: /story points/i })).toHaveAttribute('min', '0')
  })

  it('forwards fieldsPhase, so custom field controls wait for the definitions read', () => {
    // The DIALOG hop for `fieldsPhase`, the sibling of the `statusesPhase` test above and for
    // the identical reason: the prop is optional and UNDEFAULTED here (a destructuring default
    // costs a cyclomatic point and this component is at 10 of 10), so forgetting it at the call
    // site is silent. A re-review found `fieldsPhase={fieldsPhase}` could be dropped from this
    // component with all 1112 tests green.
    //
    // Note the deliberate shape, copied from the statuses test: the field rows ARE supplied and
    // the phase is NOT resolved, so a section that rendered controls anyway could only be
    // defaulting the phase to 'loaded' — which is exactly the mutation this kills. Unwired, the
    // controls appear over an empty value list, which is the overwrite hazard
    // `TicketCustomFields` is written against.
    const field = {
      id: 'f-9a3',
      project_id: 'p1',
      slug: 'cust_ref',
      name: 'Customer ref',
      type: 'text',
      created_at: '2026-08-07T10:00:00Z',
    } as unknown as ProjectField

    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        fields={[field]}
        fieldsPhase="loading"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit Customer ref' })).not.toBeInTheDocument()
  })

  it('forwards options and optionsPhase, so the select control waits for the options read', async () => {
    // SPRIN-92 task 10, fix round 1. The DIALOG hop for `options`/`optionsPhase`, the sibling
    // of `fieldsPhase` immediately above and found the same way: a re-review measured that
    // dropping `options={options}`, dropping `optionsPhase={optionsPhase}`, or CROSSING
    // `optionsPhase` for `fieldsPhase` at this component (or at `TicketDetailSidebar`, which
    // has no test file of its own and is rendered inside this same tree) left all 1227 tests
    // green.
    //
    // Unlike `fieldsPhase`, `optionsPhase` DEFAULTS to `'loaded'` — so an unplugged wire fails
    // OPEN: the select would render ENABLED, offering only the blank choice, rather than
    // anything visibly wrong. The field IS `select` and options ARE supplied; the phase is NOT
    // resolved, so a select rendered enabled here can only mean the phase was defaulted away
    // or crossed with `fieldsPhase` (which DOES resolve, since `fields` is supplied loaded).
    const field = {
      id: 'f-r1k',
      project_id: 'p1',
      slug: 'risk',
      name: 'Risk',
      type: 'select',
      created_at: '2026-08-08T10:00:00Z',
    } as unknown as ProjectField
    const low = {
      project_id: 'p1',
      field_id: 'f-r1k',
      slug: 'low',
      label: 'Low',
      position: 1,
    } as ProjectFieldOption

    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        fields={[field]}
        fieldsPhase="loaded"
        options={[low]}
        optionsPhase="loading"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    expect(await screen.findByRole('combobox', { name: 'Risk' })).toBeDisabled()
  })

  it('returns focus to the field trigger button after commit (Enter) and after cancel (Escape)', async () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    // Commit path.
    const editSummaryBtn = screen.getByRole('button', { name: /edit summary/i })
    await userEvent.click(editSummaryBtn)
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), '{Enter}')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: /edit summary/i })),
    )

    // Cancel path.
    const editDescriptionBtn = screen.getByRole('button', { name: /edit description/i })
    await userEvent.click(editDescriptionBtn)
    await userEvent.type(screen.getByRole('textbox', { name: /^description$/i }), 'X{Escape}')
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /edit description/i }),
      ),
    )
  })

  it('resets a mid-edit field when the parent keys the dialog by ticket id and the selection switches (Ultracode finding B)', async () => {
    const ticketB: Ticket = { ...base, id: 't2', key: 'MP-2', summary: 'Ticket B summary' }
    // Mirrors ProjectShell's `<TicketDetailDialog key={selected?.id ?? 'none'} .../>` —
    // the key is what forces React to unmount the stale instance instead of reusing it
    // with ticket B's props.
    const { rerender } = render(
      <TicketDetailDialog
        key={base.id}
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    const input = screen.getByRole('textbox', { name: /summary/i })
    await userEvent.clear(input)
    await userEvent.type(input, 'Stale draft text')
    expect(input).toHaveValue('Stale draft text')

    // Switch the selected ticket while the summary field is still mid-edit — exactly
    // what selecting a different board card or backlog row does.
    rerender(
      <TicketDetailDialog
        key={ticketB.id}
        ticket={ticketB}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    // Remounted: back to view mode, showing ticket B's own summary — never a live
    // textbox still holding ticket A's stale draft.
    expect(screen.queryByRole('textbox', { name: /summary/i })).not.toBeInTheDocument()
    expect(screen.getByText('Ticket B summary')).toBeInTheDocument()
    expect(screen.queryByText('Stale draft text')).not.toBeInTheDocument()
  })

  it('does not let a stale in-flight save from a closed instance clobber a reopened instance edit (Ultracode Critical)', async () => {
    // Repro: open A, edit story_points (save stays pending) → CLOSE (unmounts this
    // instance under ProjectShell's key={selected?.id}) → REOPEN A (fresh instance) →
    // edit summary (resolves; parent now holds both edits) → the stale story_points
    // save resolves. Without the mounted guard the dead instance's continuation merges
    // onto its FROZEN ticketRef and reverts the summary the reopened instance just saved.
    const firstSave = deferred<UpdateTicketResult>()
    let call = 0
    updateTicket.mockImplementation((_id, patch) => {
      call += 1
      if (call === 1) return firstSave.promise // story_points save — held pending
      return Promise.resolve({ ok: true, ticket: { ...base, ...patch } as Ticket })
    })

    const onUpdated = vi.fn()
    // Stands in for ProjectShell: owns the ticket, keys the dialog by id, and mounts it
    // only when `open` — so open=false unmounts the instance exactly like a real close.
    function Harness({ open }: { open: boolean }) {
      const [t, setT] = useState(base)
      return open ? (
        <TicketDetailDialog
          key={t.id}
          ticket={t}
          currentUser={user}
          options={[]}
          optionsPhase="loaded"
          onOpenChange={() => {}}
          onUpdated={(next) => {
            setT(next)
            onUpdated(next)
          }}
          onDeleted={() => {}}
        />
      ) : null
    }

    const { rerender } = render(<Harness open={true} />)

    // Instance 1: edit story points; the save stays pending.
    await userEvent.click(screen.getByRole('button', { name: /edit story points/i }))
    await userEvent.type(screen.getByRole('spinbutton', { name: /story points/i }), '5{Enter}')
    expect(updateTicket).toHaveBeenCalledWith('t1', { story_points: 5 })

    // Close: instance 1 unmounts while its save is still in flight.
    rerender(<Harness open={false} />)
    // Reopen the SAME ticket: a fresh instance mounts, carrying both edits' parent state.
    rerender(<Harness open={true} />)

    // Instance 2: rename the summary; this save resolves immediately.
    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), 'Renamed B{Enter}')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /edit summary/i })).toHaveTextContent('Renamed B'),
    )

    // The stale (dead-instance) story_points save finally resolves. Flush its continuation.
    await act(async () => {
      firstSave.resolve({
        ok: true,
        ticket: { ...base, story_points: 5, updated_at: '2026-07-15T00:09:00Z' },
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    // The reopened instance's summary edit must survive — never reverted to the original.
    expect(screen.getByRole('button', { name: /edit summary/i })).toHaveTextContent('Renamed B')
    expect(screen.queryByText('Wire the board')).not.toBeInTheDocument()
  })

  it('rejects an empty, whitespace-only, or over-long summary without saving, then accepts a valid rename', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, summary: 'New Title' } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    // (a) cleared to empty — required.
    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), '{Enter}')
    expect(updateTicket).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/summary is required/i)

    // (b) whitespace-only — trims to empty, still required.
    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), '   {Enter}')
    expect(updateTicket).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/summary is required/i)

    // (c) over the 200-char max.
    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), 'x'.repeat(201))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), '{Enter}')
    expect(updateTicket).not.toHaveBeenCalled()
    expect(await screen.findByRole('alert')).toHaveTextContent(/200 characters or fewer/i)

    // (d) a valid rename with surrounding whitespace commits the TRIMMED value.
    await userEvent.click(screen.getByRole('button', { name: /edit summary/i }))
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), '  New Title  {Enter}')
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { summary: 'New Title' }))
  })

  it('commits a value on blur but does NOT steal focus back to the trigger (blur is not a keyboard commit)', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, summary: 'Blurred' } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )

    const editSummaryBtn = screen.getByRole('button', { name: /edit summary/i })
    await userEvent.click(editSummaryBtn)
    await userEvent.clear(screen.getByRole('textbox', { name: /summary/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /summary/i }), 'Blurred')
    // Tab out of the field — focus is already moving intentionally.
    await userEvent.tab()

    // The value committed…
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { summary: 'Blurred' }))
    // …but focus was NOT yanked back to the summary trigger button.
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: /edit summary/i }))
  })

  it('commits a type change, sending the type patch', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, type: 'bug' } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'bug')
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { type: 'bug' }))
  })

  it('commits a description edit, sending the description patch', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, description: 'Some detail' } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /edit description/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /^description$/i }), 'Some detail')
    await userEvent.tab() // description is multiline — blur commits
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t1', { description: 'Some detail' }),
    )
  })

  it('commits an acceptance-criteria edit, sending the acceptance_criteria patch', async () => {
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: { ...base, acceptance_criteria: 'Given, when, then' },
    })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /edit acceptance criteria/i }))
    await userEvent.type(
      screen.getByRole('textbox', { name: /acceptance criteria/i }),
      'Given, when, then',
    )
    await userEvent.tab() // multiline — blur commits
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t1', {
        acceptance_criteria: 'Given, when, then',
      }),
    )
  })

  it('commits a labels edit, sending the parsed labels array', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, labels: ['ui', 'backend'] } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /edit labels/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /labels/i }), 'ui, backend{Enter}')
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t1', { labels: ['ui', 'backend'] }),
    )
  })

  it('renders a status picker showing the ticket current status', () => {
    // `base.status` is 'todo', which is ALSO the first <option> — an uncontrolled select
    // would show 'todo' too, so that fixture cannot tell a controlled select apart from
    // an unbound one. Render a ticket whose status is not the first option so the
    // assertion only passes if the select is genuinely wired to `ticket.status`.
    render(
      <TicketDetailDialog
        ticket={{ ...base, status: 'in_review' }}
        currentUser={user}
        statuses={SEEDED_STATUSES}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.getByRole('combobox', { name: /status/i })).toHaveValue('in_review')
  })

  // SPRIN-76 AC2: the options are the PROJECT'S status rows, not a fixed four. The fixture
  // holds five, includes a slug `TICKET_STATUSES` never had ('parked'), and is
  // in an order that matches neither the old board order nor slug order — so a picker still
  // driven by the constants, or one that re-sorts, cannot pass.
  it('lists the project status rows as picker options, not a fixed four', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        statuses={FIVE_STATUSES}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.getByRole('option', { name: 'Parked' })).toBeInTheDocument()
    const options = statusOptionsOf()
    expect(options.map((o) => o.textContent)).toEqual([
      'In Progress',
      'To Do',
      'In Review',
      'Done',
      'Parked',
    ])
    // The VALUES are the slugs — `tickets.status` carries the slug, and the fixture's ids
    // look nothing like them, so an option list built from `status.id` goes red here.
    expect(options.map((o) => o.value)).toEqual([
      'in_progress',
      'todo',
      'in_review',
      'done',
      'parked',
    ])
  })

  // `statuses` is [] in BOTH the loading and failed phases, so an empty list never means
  // "this project has no statuses". An enabled picker over one would render a blank value
  // and offer nothing but the ticket's own status — one interaction could silently move it.
  // Branch on the phase, never on statuses.length. Same rule as the sprint picker below.
  it.each(['loading', 'failed'] as const)(
    'disables the status picker while the status list is %s',
    (phase) => {
      render(
        <TicketDetailDialog
          ticket={base}
          currentUser={user}
          statuses={[]}
          statusesPhase={phase}
          options={[]}
          optionsPhase="loaded"
          onOpenChange={() => {}}
          onUpdated={() => {}}
          onDeleted={() => {}}
        />,
      )
      expect(screen.getByLabelText('status')).toBeDisabled()
    },
  )

  // The `statusesPhase = 'loading'` DEFAULT, pinned — the prop is optional, so nothing else in
  // this file exercises the value the component picks when a caller says nothing. That default
  // is the whole of the "a standalone render stays honest" claim, and it is one of the two
  // branches that put this component on the T2 cyclomatic ceiling, so it should cost something
  // to remove. Note the deliberate shape: rows ARE supplied and the phase is NOT, so a picker
  // that offered them anyway could only be defaulting the phase to 'loaded' — which is exactly
  // the mutation this kills. Nothing else in the suite goes red on it.
  it('defaults statusesPhase to loading, keeping the picker disabled until a caller says otherwise', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        statuses={SEEDED_STATUSES}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.getByLabelText('status')).toBeDisabled()
  })

  // The test that tells `statusesPhase` apart from `statuses.length`: gating on the length
  // would disable this case while passing every other test in this file.
  it('enables the status picker for a loaded read that returned no rows', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        statuses={[]}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.getByLabelText('status')).toBeEnabled()
  })

  it('keeps the status picker in the tab order and enabled, so a keyboard user can reach it', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        statuses={SEEDED_STATUSES}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    const select = screen.getByRole('combobox', { name: /status/i })
    expect(select).toBeEnabled()
    // A negative tabindex would remove it from sequential navigation while leaving it
    // clickable — the exact regression SPRIN-61 exists to prevent.
    expect(select).not.toHaveAttribute('tabindex')
  })

  // SPRIN-76 AC4, header half: an unknown slug renders as ITSELF rather than blank. Paired
  // with the picker's own fallback test below — the two are different code paths (`statusName`
  // in the dialog, `statusOptions` in the sidebar) and both have to hold.
  it('renders the status NAME in the header, from the row', () => {
    render(
      <TicketDetailDialog
        ticket={{ ...base, status: 'in_review' }}
        currentUser={user}
        statuses={FIVE_STATUSES}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    // The row names 'in_review' → 'In Review', a name that differs visibly from the slug,
    // so rendering `ticket.status` raw would fail this and only this.
    expect(within(dialogHeader()).getByText('In Review')).toBeInTheDocument()
    expect(within(dialogHeader()).queryByText('in_review')).not.toBeInTheDocument()
  })

  it('falls back to the slug when the header status has no row (AC4)', () => {
    render(
      <TicketDetailDialog
        ticket={{ ...base, status: 'ghost' }}
        currentUser={user}
        statuses={FIVE_STATUSES}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(within(dialogHeader()).getByText('ghost')).toBeInTheDocument()
  })

  // The picker half of the same fallback. A <select> whose value matches no <option> renders
  // blank, and the next change event would move the ticket somewhere the user never chose.
  it('keeps the current status selectable when it has no row, so it is not silently lost', () => {
    render(
      <TicketDetailDialog
        ticket={{ ...base, status: 'ghost' }}
        currentUser={user}
        statuses={FIVE_STATUSES}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.getByLabelText('status')).toHaveValue('ghost')
    expect(statusOptionsOf().map((o) => o.value)).toContain('ghost')
  })

  it('commits a status change, sending status and nothing else', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, status: 'in_progress' } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        statuses={SEEDED_STATUSES}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /status/i }), 'in_progress')
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { status: 'in_progress' }))
  })

  it('applies the status change optimistically, before the write resolves', async () => {
    const pending = deferred<UpdateTicketResult>()
    updateTicket.mockReturnValue(pending.promise)
    const onUpdated = vi.fn()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        statuses={SEEDED_STATUSES}
        statusesPhase="loaded"
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /status/i }), 'in_review')
    // The write has NOT resolved, yet the parent already has the new status.
    expect(onUpdated).toHaveBeenCalledWith(expect.objectContaining({ status: 'in_review' }))
    await act(async () => {
      pending.resolve({ ok: true, ticket: { ...base, status: 'in_review' } })
    })
  })

  it('reverts only the status field and shows an error when the status write fails', async () => {
    // `error` is the literal type 'unknown', not a free string — any other value is a
    // compile error. See `UpdateTicketResult` in src/lib/tickets.ts.
    updateTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const onUpdated = vi.fn()
    function Harness() {
      const [t, setT] = useState({ ...base, summary: 'Original summary' })
      return (
        <TicketDetailDialog
          ticket={t}
          currentUser={user}
          statuses={SEEDED_STATUSES}
          statusesPhase="loaded"
          options={[]}
          optionsPhase="loaded"
          onOpenChange={() => {}}
          onUpdated={(next) => {
            setT(next)
            onUpdated(next)
          }}
          onDeleted={() => {}}
        />
      )
    }
    render(<Harness />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /status/i }), 'done')

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    // Rolled back to the original status, and the error is shown.
    expect(screen.getByRole('combobox', { name: /status/i })).toHaveValue('todo')
    // This only proves the status field is restored and `summary` still reads its
    // original value from THIS render — it does not distinguish a field-scoped revert
    // from a whole-ticket revert to a stale snapshot, because nothing here changes a
    // second field between the optimistic apply and the failure. The sibling test
    // 'preserves a concurrent field edit when an earlier save fails and rolls back only
    // its own field' is the one that actually pins field-scoped rollback (it edits
    // summary and points concurrently, out of commit order) — do not delete it believing
    // this test covers the same ground.
    expect(onUpdated.mock.calls.at(-1)![0]).toMatchObject({
      status: 'todo',
      summary: 'Original summary',
    })
  })
})

async function openDeleteConfirm(ue: ReturnType<typeof userEvent.setup>) {
  await ue.click(screen.getByRole('button', { name: /ticket actions/i }))
  await ue.click(await screen.findByRole('menuitem', { name: /delete/i }))
}

describe('TicketDetailDialog — delete', () => {
  it('deletes after confirm and reports the id up', async () => {
    const ue = userEvent.setup()
    deleteTicket.mockResolvedValue({ ok: true })
    const onDeleted = vi.fn()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={onDeleted}
      />,
    )
    await openDeleteConfirm(ue)
    await ue.click(await screen.findByRole('button', { name: /^delete$/i }))
    await waitFor(() => expect(deleteTicket).toHaveBeenCalledWith('t1'))
    expect(onDeleted).toHaveBeenCalledWith('t1')
  })

  it('does nothing when the confirm is cancelled', async () => {
    const ue = userEvent.setup()
    const onDeleted = vi.fn()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={onDeleted}
      />,
    )
    await openDeleteConfirm(ue)
    await ue.click(await screen.findByRole('button', { name: /cancel/i }))
    expect(deleteTicket).not.toHaveBeenCalled()
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('keeps the ticket and shows an error when the delete fails', async () => {
    const ue = userEvent.setup()
    deleteTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const onDeleted = vi.fn()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={onDeleted}
      />,
    )
    await openDeleteConfirm(ue)
    await ue.click(await screen.findByRole('button', { name: /^delete$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not delete/i)
    expect(onDeleted).not.toHaveBeenCalled()
  })
})

const blockedTicket: Ticket = {
  ...base,
  is_blocked: true,
  blocked_reason: 'waiting on API',
  blocked_since: '2026-07-15T00:03:00Z',
}

async function openActionsMenu(ue: ReturnType<typeof userEvent.setup>) {
  await ue.click(screen.getByRole('button', { name: /ticket actions/i }))
}

describe('TicketDetailDialog — block/unblock', () => {
  it('offers Block (not Unblock) in the actions menu for an unblocked ticket', async () => {
    const ue = userEvent.setup()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await openActionsMenu(ue)
    expect(await screen.findByRole('menuitem', { name: /^block$/i })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: /unblock/i })).not.toBeInTheDocument()
  })

  it('requires a reason: the Block confirm button is disabled until one is typed', async () => {
    const ue = userEvent.setup()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    await openActionsMenu(ue)
    await ue.click(await screen.findByRole('menuitem', { name: /^block$/i }))

    const confirm = await screen.findByRole('button', { name: /^block$/i })
    expect(confirm).toBeDisabled()
    await ue.type(screen.getByRole('textbox', { name: /reason/i }), 'waiting on API')
    expect(confirm).toBeEnabled()
    expect(blockTicket).not.toHaveBeenCalled()
  })

  it('blocks with the typed reason and reports the trigger-stamped row up', async () => {
    const ue = userEvent.setup()
    blockTicket.mockResolvedValue({ ok: true, ticket: blockedTicket })
    const onUpdated = vi.fn()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )
    await openActionsMenu(ue)
    await ue.click(await screen.findByRole('menuitem', { name: /^block$/i }))
    await ue.type(screen.getByRole('textbox', { name: /reason/i }), 'waiting on API')
    await ue.click(screen.getByRole('button', { name: /^block$/i }))

    await waitFor(() => expect(blockTicket).toHaveBeenCalledWith('t1', 'waiting on API'))
    // Not optimistic: we apply the row the DB returned, which carries the
    // trigger-stamped blocked_since — never a client guess.
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 't1',
        is_blocked: true,
        blocked_reason: 'waiting on API',
        blocked_since: '2026-07-15T00:03:00Z',
      }),
    )
  })

  it('keeps the ticket and shows an error when blocking fails', async () => {
    const ue = userEvent.setup()
    blockTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const onUpdated = vi.fn()
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )
    await openActionsMenu(ue)
    await ue.click(await screen.findByRole('menuitem', { name: /^block$/i }))
    await ue.type(screen.getByRole('textbox', { name: /reason/i }), 'waiting on API')
    await ue.click(screen.getByRole('button', { name: /^block$/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not block/i)
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('shows a blocked banner carrying the reason when the ticket is blocked', () => {
    render(
      <TicketDetailDialog
        ticket={blockedTicket}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    const banner = screen.getByRole('status')
    expect(banner).toHaveTextContent(/blocked/i)
    expect(banner).toHaveTextContent(/waiting on API/i)
  })

  it('offers Unblock (not Block) in the actions menu for a blocked ticket, and unblocks', async () => {
    const ue = userEvent.setup()
    unblockTicket.mockResolvedValue({
      ok: true,
      ticket: { ...base, is_blocked: false, blocked_reason: null, blocked_since: null },
    })
    const onUpdated = vi.fn()
    render(
      <TicketDetailDialog
        ticket={blockedTicket}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )
    await openActionsMenu(ue)
    expect(screen.queryByRole('menuitem', { name: /^block$/i })).not.toBeInTheDocument()
    await ue.click(await screen.findByRole('menuitem', { name: /unblock/i }))

    await waitFor(() => expect(unblockTicket).toHaveBeenCalledWith('t1'))
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't1', is_blocked: false, blocked_reason: null }),
    )
  })

  it('keeps the ticket blocked and shows an error when unblocking fails', async () => {
    const ue = userEvent.setup()
    unblockTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const onUpdated = vi.fn()
    render(
      <TicketDetailDialog
        ticket={blockedTicket}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )
    await openActionsMenu(ue)
    await ue.click(await screen.findByRole('menuitem', { name: /unblock/i }))

    await waitFor(() => expect(unblockTicket).toHaveBeenCalledWith('t1'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not unblock/i)
    expect(onUpdated).not.toHaveBeenCalled()
  })

  it('shows no blocked banner for an unblocked ticket', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

const epicTicket: Ticket = {
  ...base,
  id: 'e-main',
  key: 'MP-9',
  type: 'epic',
  summary: 'Platform epic',
  context: null,
  deliverables: [],
}

/** Renders the dialog with sensible defaults; override only what a test needs. */
function renderDialog(props: Partial<React.ComponentProps<typeof TicketDetailDialog>> = {}) {
  return render(
    <TicketDetailDialog
      ticket={epicTicket}
      currentUser={user}
      options={[]}
      optionsPhase="loaded"
      onOpenChange={() => {}}
      onUpdated={() => {}}
      onDeleted={() => {}}
      {...props}
    />,
  )
}

describe('TicketDetailDialog — epic fields', () => {
  it('shows Context and Deliverables for an epic, and a parent-epic picker for a non-epic', () => {
    const { rerender } = renderDialog({ ticket: epicTicket })
    expect(screen.getByText('Context')).toBeInTheDocument()
    expect(screen.getByText('Deliverables')).toBeInTheDocument()
    // An epic does not get a parent epic in the Phase 1 UI.
    expect(screen.queryByRole('combobox', { name: /parent epic/i })).not.toBeInTheDocument()

    // A story (base) is the mirror image: no epic-only fields, but a parent-epic picker.
    rerender(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={() => {}}
        onDeleted={() => {}}
      />,
    )
    expect(screen.queryByText('Context')).not.toBeInTheDocument()
    expect(screen.queryByText('Deliverables')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: /parent epic/i })).toBeInTheDocument()
  })

  it('commits an epic context edit, sending the context patch', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...epicTicket, context: 'Background' } })
    renderDialog()
    await userEvent.click(screen.getByRole('button', { name: /edit context/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /^context$/i }), 'Background')
    await userEvent.tab() // context is multiline — blur commits
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('e-main', { context: 'Background' }),
    )
  })

  it('adds a deliverable, committing the appended list', async () => {
    const epicWithOne: Ticket = { ...epicTicket, deliverables: ['Ship the API'] }
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: { ...epicWithOne, deliverables: ['Ship the API', 'Wire the UI'] },
    })
    renderDialog({ ticket: epicWithOne })
    await userEvent.type(screen.getByRole('textbox', { name: /new deliverable/i }), 'Wire the UI')
    await userEvent.click(screen.getByRole('button', { name: /add deliverable/i }))
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('e-main', {
        deliverables: ['Ship the API', 'Wire the UI'],
      }),
    )
  })

  it('does not add a blank or whitespace-only deliverable (Add stays disabled)', async () => {
    renderDialog({ ticket: epicTicket }) // deliverables: []
    const addBtn = screen.getByRole('button', { name: /add deliverable/i })
    expect(addBtn).toBeDisabled()
    await userEvent.type(screen.getByRole('textbox', { name: /new deliverable/i }), '   ')
    expect(addBtn).toBeDisabled()
    expect(updateTicket).not.toHaveBeenCalled()
  })

  it('removes a deliverable, committing the list without it', async () => {
    const epicTwo: Ticket = { ...epicTicket, deliverables: ['Ship the API', 'Wire the UI'] }
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: { ...epicTwo, deliverables: ['Wire the UI'] },
    })
    renderDialog({ ticket: epicTwo })
    await userEvent.click(screen.getByRole('button', { name: /remove deliverable 1/i }))
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('e-main', { deliverables: ['Wire the UI'] }),
    )
  })

  it('edits a deliverable in place, committing the updated list', async () => {
    const epicTwo: Ticket = { ...epicTicket, deliverables: ['Ship the API', 'Wire the UI'] }
    updateTicket.mockResolvedValue({ ok: true, ticket: epicTwo })
    renderDialog({ ticket: epicTwo })
    await userEvent.click(screen.getByRole('button', { name: /edit deliverable 1/i }))
    const input = screen.getByRole('textbox', { name: /^deliverable 1$/i })
    await userEvent.clear(input)
    await userEvent.type(input, 'Ship the v2 API{Enter}')
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('e-main', {
        deliverables: ['Ship the v2 API', 'Wire the UI'],
      }),
    )
  })

  it('lists project epics in the parent-epic picker and commits the selected epic id', async () => {
    const epicA: Ticket = { ...base, id: 'e1', key: 'MP-2', type: 'epic', summary: 'Epic A' }
    const epicB: Ticket = { ...base, id: 'e2', key: 'MP-3', type: 'epic', summary: 'Epic B' }
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, parent_epic_id: 'e2' } })
    renderDialog({ ticket: base, epics: [epicA, epicB] })
    const picker = screen.getByRole('combobox', { name: /parent epic/i })
    const optionLabels = screen.getAllByRole('option').map((o) => o.textContent)
    expect(optionLabels).toEqual(expect.arrayContaining([expect.stringMatching(/MP-2/)]))
    await userEvent.selectOptions(picker, 'e2')
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { parent_epic_id: 'e2' }))
  })

  it('clears the parent epic when No epic is chosen, sending null', async () => {
    const child: Ticket = { ...base, parent_epic_id: 'e1' }
    const epicA: Ticket = { ...base, id: 'e1', key: 'MP-2', type: 'epic', summary: 'Epic A' }
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...child, parent_epic_id: null } })
    renderDialog({ ticket: child, epics: [epicA] })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /parent epic/i }), '')
    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { parent_epic_id: null }))
  })

  // Review finding 1: two rapid adds are whole-array writes that can resolve out of order
  // and silently drop an item. The fix serializes them — while one deliverables save is in
  // flight, Add is disabled and no second write fires.
  it('serializes deliverable writes: Add is disabled while a save is in flight', async () => {
    const epicWithOne: Ticket = { ...epicTicket, deliverables: ['A'] }
    const pending = deferred<UpdateTicketResult>()
    updateTicket.mockReturnValue(pending.promise)
    renderDialog({ ticket: epicWithOne })

    await userEvent.type(screen.getByRole('textbox', { name: /new deliverable/i }), 'B')
    await userEvent.click(screen.getByRole('button', { name: /add deliverable/i }))

    expect(updateTicket).toHaveBeenCalledTimes(1)
    // The draft is still 'B' (non-empty), so a disabled Add can only be the in-flight guard.
    expect(screen.getByRole('button', { name: /add deliverable/i })).toBeDisabled()

    pending.resolve({ ok: true, ticket: { ...epicWithOne, deliverables: ['A', 'B'] } })
    await waitFor(() => expect(updateTicket).toHaveBeenCalledTimes(1))
  })

  // Review finding 3: the epic-fields block had no ok:false test (unlike every other
  // mutating block), and a failed add silently wiped the typed draft.
  it('rolls back and shows an error when a deliverable add fails, preserving the draft', async () => {
    const epicWithOne: Ticket = { ...epicTicket, deliverables: ['A'] }
    updateTicket.mockResolvedValue({ ok: false, error: 'unknown' })
    const onUpdated = vi.fn()
    render(
      <TicketDetailDialog
        ticket={epicWithOne}
        currentUser={user}
        epics={[]}
        options={[]}
        optionsPhase="loaded"
        onOpenChange={() => {}}
        onUpdated={onUpdated}
        onDeleted={() => {}}
      />,
    )
    await userEvent.type(screen.getByRole('textbox', { name: /new deliverable/i }), 'B')
    await userEvent.click(screen.getByRole('button', { name: /add deliverable/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not save/i)
    // optimistic add then rollback → the last onUpdated restores the original list.
    expect(onUpdated.mock.calls.at(-1)![0]).toMatchObject({ deliverables: ['A'] })
    // The draft survives so the user can retry without retyping.
    expect(screen.getByRole('textbox', { name: /new deliverable/i })).toHaveValue('B')
  })

  // Review finding 8: pin the "edit an item to blank removes it" contract.
  it('removes a deliverable when it is edited to blank', async () => {
    const epicTwo: Ticket = { ...epicTicket, deliverables: ['A', 'B'] }
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...epicTwo, deliverables: ['B'] } })
    renderDialog({ ticket: epicTwo })
    await userEvent.click(screen.getByRole('button', { name: /edit deliverable 1/i }))
    const input = screen.getByRole('textbox', { name: /^deliverable 1$/i })
    await userEvent.clear(input)
    await userEvent.type(input, '   {Enter}')
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('e-main', { deliverables: ['B'] }),
    )
  })

  // Review finding 5: changing a child to type epic must not orphan its parent_epic_id
  // (an epic nested under an epic violates the Phase-1 no-nesting invariant).
  it('nulls the parent epic when a child ticket is changed to type epic', async () => {
    const child: Ticket = { ...base, parent_epic_id: 'e1' }
    updateTicket.mockResolvedValue({
      ok: true,
      ticket: { ...child, type: 'epic', parent_epic_id: null },
    })
    renderDialog({ ticket: child, epics: [] })
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /type/i }), 'epic')
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t1', { type: 'epic', parent_epic_id: null }),
    )
  })

  // Review finding 2: a parent_epic_id absent from the epics list must not silently render
  // as "No epic" — a fallback option keeps the value and shows the link exists.
  it('renders a fallback option when the parent epic is not in the list', () => {
    const child: Ticket = { ...base, parent_epic_id: 'gone' }
    renderDialog({ ticket: child, epics: [] })
    const picker = screen.getByRole('combobox', { name: /parent epic/i }) as HTMLSelectElement
    expect(picker.value).toBe('gone') // the value round-trips, no controlled-value mismatch
    expect(screen.getByRole('option', { name: /current parent/i })).toBeInTheDocument()
  })

  // Review finding 7: Esc in the add-deliverable input should clear the draft like every
  // other field's Esc, not dismiss the whole modal.
  it('clears the add-deliverable draft on Escape without closing the dialog', async () => {
    const onOpenChange = vi.fn()
    renderDialog({ ticket: epicTicket, onOpenChange })
    const input = screen.getByRole('textbox', { name: /new deliverable/i })
    await userEvent.type(input, 'Draft{Escape}')
    expect(input).toHaveValue('')
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})

const sprintFuture: Sprint = {
  id: 's1',
  project_id: 'p1',
  name: 'Sprint 1',
  goal: null,
  status: 'future',
  start_date: null,
  end_date: null,
  created_at: '2026-07-15T00:00:00+00:00',
}
const sprintActive: Sprint = { ...sprintFuture, id: 's2', name: 'Sprint 2', status: 'active' }

describe('TicketDetailDialog — sprint picker (S6.2)', () => {
  it('lists Backlog plus every sprint, labelled with its status', () => {
    renderDialog({
      ticket: base,
      sprints: [sprintFuture, sprintActive],
      sprintsPhase: 'loaded',
    })
    const picker = screen.getByLabelText('sprint') as HTMLSelectElement
    // Backlog is the domain's word for `sprint_id is null` — see backlog.ts.
    expect(picker.value).toBe('')
    expect(
      Array.from(picker.options).map((o) => o.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['Backlog', 'Sprint 1 · Future', 'Sprint 2 · Active'])
  })

  // The picker is not gated on ticket type: an epic can be in a sprint.
  it('renders for an epic as well as a story', () => {
    renderDialog({ ticket: epicTicket, sprints: [sprintFuture], sprintsPhase: 'loaded' })
    expect(screen.getByLabelText('sprint')).toBeInTheDocument()
  })

  it('adds the ticket to a sprint, sending the sprint_id patch', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, sprint_id: 's1' } })
    renderDialog({ ticket: base, sprints: [sprintFuture], sprintsPhase: 'loaded' })

    await userEvent.selectOptions(screen.getByLabelText('sprint'), 's1')

    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { sprint_id: 's1' }))
  })

  // AC 1's "removed back to the backlog" at the unit level: `sprint_id: null` IS the backlog.
  it('removes the ticket back to the backlog, sending a null sprint_id', async () => {
    const sprinted: Ticket = { ...base, sprint_id: 's1' }
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...sprinted, sprint_id: null } })
    renderDialog({ ticket: sprinted, sprints: [sprintFuture], sprintsPhase: 'loaded' })

    const picker = screen.getByLabelText('sprint') as HTMLSelectElement
    expect(picker.value).toBe('s1')
    await userEvent.selectOptions(picker, '')

    await waitFor(() => expect(updateTicket).toHaveBeenCalledWith('t1', { sprint_id: null }))
  })

  // `sprints` is [] in BOTH the loading and failed phases, so an empty list never means
  // "no sprints". An enabled picker would then offer only "Backlog" and one click would
  // quietly unsprint the ticket — branch on the phase, never on sprints.length.
  it.each(['loading', 'failed'] as const)(
    'disables the picker while the sprint list is %s',
    (phase) => {
      renderDialog({ ticket: { ...base, sprint_id: 's1' }, sprints: [], sprintsPhase: phase })
      expect(screen.getByLabelText('sprint')).toBeDisabled()
    },
  )

  it('enables the picker once the sprint list has loaded', () => {
    renderDialog({ ticket: base, sprints: [sprintFuture], sprintsPhase: 'loaded' })
    expect(screen.getByLabelText('sprint')).toBeEnabled()
  })

  // The test that tells `sprintsPhase` apart from `sprints.length`. A project that genuinely
  // has no sprints is 'loaded' with an empty list, and its picker must still work — "Backlog"
  // is then the truth, not a lie. Gating on `sprints.length` would disable this case and pass
  // every other test in this file, so without this the length-based defect ships green.
  it('enables the picker for a loaded project that genuinely has no sprints', () => {
    renderDialog({ ticket: base, sprints: [], sprintsPhase: 'loaded' })
    expect(screen.getByLabelText('sprint')).toBeEnabled()
  })

  // Mirrors the parent-epic picker's guard: a sprint_id absent from the list must not
  // silently render as "Backlog" — that would misreport the ticket's membership.
  it('renders a fallback option when the current sprint is not in the list', () => {
    renderDialog({ ticket: { ...base, sprint_id: 'gone' }, sprints: [], sprintsPhase: 'loaded' })
    const picker = screen.getByLabelText('sprint') as HTMLSelectElement
    expect(picker.value).toBe('gone') // the value round-trips, no controlled-value mismatch
    expect(
      screen.getByRole('option', { name: /current sprint \(unavailable\)/i }),
    ).toBeInTheDocument()
  })
})
