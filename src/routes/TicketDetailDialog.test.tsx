import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TicketDetailDialog } from './TicketDetailDialog'
import type { Ticket } from '@/lib/domain'
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

vi.mock('@/lib/tickets', async (orig) => ({
  ...(await orig<typeof tickets>()),
  updateTicket: vi.fn(),
}))
const updateTicket = vi.mocked(tickets.updateTicket)

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

beforeEach(() => updateTicket.mockReset())

describe('TicketDetailDialog', () => {
  it('shows the ticket key, summary, and status when open', () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        onOpenChange={() => {}}
        onUpdated={() => {}}
      />,
    )
    expect(screen.getByText('MP-1')).toBeInTheDocument()
    expect(screen.getByText('Wire the board')).toBeInTheDocument()
    expect(screen.getByText('To Do')).toBeInTheDocument()
  })

  it('renders nothing interactive when ticket is null', () => {
    render(
      <TicketDetailDialog
        ticket={null}
        currentUser={user}
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={onUpdated}
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
        onOpenChange={() => {}}
        onUpdated={onUpdated}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
          onOpenChange={() => {}}
          onUpdated={(next) => {
            setT(next)
            onUpdated(next)
          }}
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
        onOpenChange={onOpenChange}
        onUpdated={() => {}}
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
        onOpenChange={onOpenChange}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={onUpdated}
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
        onOpenChange={() => {}}
        onUpdated={onUpdated}
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
        onOpenChange={() => {}}
        onUpdated={onUpdated}
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
        onOpenChange={() => {}}
        onUpdated={onUpdated}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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

  it('returns focus to the field trigger button after commit (Enter) and after cancel (Escape)', async () => {
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
          onOpenChange={() => {}}
          onUpdated={(next) => {
            setT(next)
            onUpdated(next)
          }}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
    expect(document.activeElement).not.toBe(
      screen.getByRole('button', { name: /edit summary/i }),
    )
  })

  it('commits a type change, sending the type patch', async () => {
    updateTicket.mockResolvedValue({ ok: true, ticket: { ...base, type: 'bug' } })
    render(
      <TicketDetailDialog
        ticket={base}
        currentUser={user}
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
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
        onOpenChange={() => {}}
        onUpdated={() => {}}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /edit labels/i }))
    await userEvent.type(screen.getByRole('textbox', { name: /labels/i }), 'ui, backend{Enter}')
    await waitFor(() =>
      expect(updateTicket).toHaveBeenCalledWith('t1', { labels: ['ui', 'backend'] }),
    )
  })
})
