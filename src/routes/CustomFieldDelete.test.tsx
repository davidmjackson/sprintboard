import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'

import { CustomFieldDeleteControl } from './CustomFieldDelete'
import type { ProjectField } from '@/lib/domain'
import { countTicketsHoldingField, deleteProjectField } from '@/lib/project-fields'

// Spread the real module and replace only the two network-touching functions, exactly as
// `CustomFieldOptions.test.tsx` does one level down. An unmocked write here would reach the LIVE
// database silently — `VITE_SUPABASE_URL` is a placeholder in this environment and the rejection
// is handled, so nothing would say so.
vi.mock('@/lib/project-fields', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-fields')>()),
  countTicketsHoldingField: vi.fn(),
  deleteProjectField: vi.fn(),
}))

const mockCount = vi.mocked(countTicketsHoldingField)
const mockDelete = vi.mocked(deleteProjectField)

type DeleteResult = Awaited<ReturnType<typeof deleteProjectField>>

// The slug is NOT the name lowercased, and neither is the id: `ship_by`/`Ship by` would make a
// read of `.slug` indistinguishable from a read of `.name` (SPRIN-87 cost this project three
// tests to that confound). `id`, `slug`, `name` and `project_id` are four distinct strings, so
// every assertion on one of them fails if another is read instead.
const FIELD: ProjectField = {
  id: 'f1',
  project_id: 'p1',
  slug: 'target_date',
  name: 'Ship by',
  type: 'date',
  created_at: '2026-08-01T00:00:00+00:00',
}

beforeEach(() => {
  mockCount.mockReset()
  mockDelete.mockReset()
  mockCount.mockResolvedValue(0)
  mockDelete.mockResolvedValue({ ok: true, value: undefined })
})

function renderControl() {
  const onDeleted = vi.fn()
  render(<CustomFieldDeleteControl field={FIELD} onDeleted={onDeleted} />)
  return onDeleted
}

/**
 * Open the confirm and hand back the dialog. Every assertion about the confirm's contents is
 * scoped to it with `within(dialog)`, mirroring `StatusSettings.test.tsx` and
 * `CustomFieldOptions.test.tsx`: reaching them through bare `screen` works only because a single
 * `AlertDialog` happens to be mounted, which is not a property anything enforces. The trigger
 * itself stays unscoped — it lives outside the dialog and is what opens it.
 */
async function openConfirm(u: UserEvent) {
  await u.click(screen.getByRole('button', { name: 'Remove Ship by' }))
  return await screen.findByRole('alertdialog')
}

/** Captured as an ELEMENT rather than re-queried, because its accessible name changes to
 *  'Removing…' while a delete is in flight — a name query would then find nothing. */
const confirmIn = (dialog: HTMLElement) =>
  within(dialog).getByRole('button', { name: 'Remove field' })

/**
 * Open the confirm on a resolved count and click Remove on a delete that never settles, so the
 * in-flight state can be observed at all. Every caller MUST `settle()` before returning: a state
 * update landing after the test has finished is an `act()` warning at best and a leak into the
 * next test at worst. Mirrors `StatusSettings.test.tsx`'s `startPendingDelete`.
 */
async function startPendingDelete(u: UserEvent) {
  let release: (v: DeleteResult) => void = () => {}
  mockDelete.mockReturnValue(
    new Promise<DeleteResult>((resolve) => {
      release = resolve
    }),
  )
  const onDeleted = renderControl()
  const dialog = await openConfirm(u)
  const confirm = confirmIn(dialog)
  await waitFor(() => expect(confirm).toBeEnabled())
  await u.click(confirm)
  // A PRECONDITION, not a synchronisation point: it says the click really did issue the write.
  expect(mockDelete).toHaveBeenCalledOnce()

  const settle = async () => {
    await act(async () => {
      release({ ok: true, value: undefined })
    })
  }
  return { dialog, confirm, onDeleted, settle }
}

describe('CustomFieldDeleteControl', () => {
  it('does not read the count until the confirm is opened', () => {
    renderControl()

    // A project with many fields must not fire one count query per field per paint.
    expect(mockCount).not.toHaveBeenCalled()
    // Positive control: the trigger really did render, so the absence above means something.
    expect(screen.getByRole('button', { name: 'Remove Ship by' })).toBeInTheDocument()
    // And the confirm is genuinely not mounted. `queryByRole` EXCLUDES `aria-hidden` subtrees, so
    // it alone would report "absent" for a dialog still in the DOM — paired with a raw DOM query,
    // which does not.
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('shows how many tickets hold a value before committing', async () => {
    const u = userEvent.setup()
    mockCount.mockResolvedValue(4)
    renderControl()

    const dialog = await openConfirm(u)

    // WHICH field was counted, not merely that a count happened. The count is what UNLOCKS the
    // destructive Remove, so passing `field.slug` (or the project id) would make the live
    // database report zero for every field and unlock a delete whose blast radius the user was
    // told was nil.
    expect(mockCount).toHaveBeenCalledWith('f1')
    // Anchored: `toHaveTextContent`/`getByText` with a bare string is a SUBSTRING match, so an
    // unanchored assertion survives an additive reword of the sentence.
    expect(
      await within(dialog).findByText(/^4 tickets will lose this value\. This can’t be undone\.$/),
    ).toBeInTheDocument()
    // The field is named where the user is deciding, not only on the trigger. `AlertDialogTitle`
    // renders an `h2` whose name is one text node, so an exact assertion is safe here.
    expect(within(dialog).getByRole('heading')).toHaveTextContent(/^Remove Ship by\?$/)
    // Nothing is destroyed by merely opening the confirm.
    expect(mockDelete).not.toHaveBeenCalled()
  })

  // The singular branch of `${n} ${n === 1 ? 'ticket' : 'tickets'}`, which no other fixture
  // reaches — the rest use 0, 2, 4 and 7. "1 tickets will lose this value" is what ships without
  // it.
  it('says "1 ticket", not "1 tickets", when exactly one ticket holds a value', async () => {
    const u = userEvent.setup()
    mockCount.mockResolvedValue(1)
    renderControl()

    const dialog = await openConfirm(u)

    expect(
      await within(dialog).findByText(/^1 ticket will lose this value\. This can’t be undone\.$/),
    ).toBeInTheDocument()
  })

  it('BLOCKS the delete when the count could not be read', async () => {
    const u = userEvent.setup()
    mockCount.mockRejectedValue(new Error('boom'))
    renderControl()

    const dialog = await openConfirm(u)

    // The alert AND the disabled button. The button alone cannot tell a failed count from a count
    // of zero, and AC4 is precisely that those are different states: an unknown count must never
    // be able to impersonate the zero that unlocks this action.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /^Could not check how many tickets hold this field\. Try again\.$/,
    )
    // The description says nothing about a count either — a failed read that still rendered
    // '0 tickets will lose this value' would be the same lie in the other half of the dialog.
    expect(within(dialog).getByText(/^This can’t be undone\.$/)).toBeInTheDocument()
    const confirm = confirmIn(dialog)
    expect(confirm).toBeDisabled()

    // Behavioural, not only the attribute: clicking it sends nothing.
    await u.click(confirm)
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('deletes a field no ticket uses, and hands the removal up', async () => {
    const u = userEvent.setup()
    mockCount.mockResolvedValue(0)
    const onDeleted = renderControl()

    const dialog = await openConfirm(u)
    const confirm = confirmIn(dialog)
    await waitFor(() => expect(confirm).toBeEnabled())
    expect(
      within(dialog).getByText(/^0 tickets will lose this value\. This can’t be undone\.$/),
    ).toBeInTheDocument()
    await u.click(confirm)

    expect(mockDelete).toHaveBeenCalledWith('f1')
    // The ID, not the field object — this is what `ProjectShell`'s reducer filters on.
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('f1'))
  })

  // `DELETE_FAILURE_COPY`'s two tags, each pinned to its OWN anchored sentence. Unanchored, the
  // two could be swapped — or either replaced by the generic retry copy — with nothing red.
  it('explains a stale refusal in its own words, and hands nothing up', async () => {
    const u = userEvent.setup()
    mockDelete.mockResolvedValue({ ok: false, error: 'stale' })
    const onDeleted = renderControl()

    const dialog = await openConfirm(u)
    const confirm = confirmIn(dialog)
    await waitFor(() => expect(confirm).toBeEnabled())
    await u.click(confirm)

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /^This field no longer exists — refresh the page to see the current list\.$/,
    )
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('shows the generic retry copy for a refusal the user cannot correct', async () => {
    const u = userEvent.setup()
    mockDelete.mockResolvedValue({ ok: false, error: 'unknown' })
    const onDeleted = renderControl()

    const dialog = await openConfirm(u)
    const confirm = confirmIn(dialog)
    await waitFor(() => expect(confirm).toBeEnabled())
    await u.click(confirm)

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /^Something went wrong\. Please try again\.$/,
    )
    expect(onDeleted).not.toHaveBeenCalled()
  })

  /**
   * THE `cancelled` FLAG IS AC4'S SECOND HALF, and until this test nothing observed it.
   *
   * Four of five adversarial lenses found this independently, in four mutation shapes — deleting
   * both `if (!cancelled)` reads, deleting the cleanup, deleting the mechanism, and flipping the
   * cleanup to `cancelled = false` (which also slips past ESLint, since the variable stays both
   * read and assigned). Every shape survived the full suite, lint and typecheck.
   *
   * The sibling test below is NOT this test. It closes the dialog after the count has already
   * settled, so it exercises the `onOpenChange` reset. This one differs in exactly one respect —
   * **when** the first read settles — and that is the whole difference between the two guards.
   * The reset was left fully intact while measuring this, and the stale write still landed: an
   * abandoned read resolving after the close flips `known` true and UNLOCKS the destructive
   * button on the next open, before that open's own count has arrived. An unknown count
   * impersonating a known one is AC4 breached in its own words.
   */
  it('ignores a count abandoned by a previous open, even after it settles', async () => {
    const u = userEvent.setup()

    // The FIRST open's read never settles while the dialog is open — it is released below, after
    // the close, which is the moment the `cancelled` flag exists to cover.
    let releaseAbandoned: (n: number) => void = () => {}
    mockCount.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        releaseAbandoned = resolve
      }),
    )
    renderControl()

    const dialog = await openConfirm(u)
    // POSITIVE CONTROL: the first open really did start a read and really is waiting on it, so
    // the release below is resolving something real rather than a promise nobody awaited.
    expect(confirmIn(dialog)).toBeDisabled()
    expect(mockCount).toHaveBeenCalledTimes(1)

    await u.click(within(dialog).getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // The abandoned read lands NOW, after its dialog is gone.
    await act(async () => {
      releaseAbandoned(5)
    })

    // A second open whose own read is still in flight, so the state under test is observable.
    mockCount.mockReturnValue(new Promise<number>(() => {}))
    const reopened = await openConfirm(u)

    // The destructive button must still be locked: this open has no count of its own yet.
    expect(confirmIn(reopened)).toBeDisabled()
    // `queryByText` does not honour `aria-hidden`, so it is the raw-DOM half of the pair.
    expect(within(reopened).queryByText(/5 tickets will lose this value/)).toBeNull()
    // POSITIVE CONTROL: the dialog really did reopen, so the absence above is the guard working
    // rather than an unmounted subtree.
    expect(within(reopened).getByText(/^This can’t be undone\.$/)).toBeInTheDocument()
  })

  /**
   * A refusal must not outlive the open it belongs to.
   *
   * `submit()` clears `error` on retry, which covers retrying WITHOUT closing. Nothing covered
   * close-and-reopen until now: dropping `setError(null)` from `onOpenChange` leaves the whole
   * suite green while a stale "Something went wrong" renders inside a freshly reopened confirm,
   * describing nothing that happened in that open. The file argues against itself there — the
   * adjacent line resets `count` for exactly this reason.
   */
  it('does not carry a refusal into the next open', async () => {
    const u = userEvent.setup()
    mockCount.mockResolvedValue(0)
    mockDelete.mockResolvedValue({ ok: false, error: 'unknown' })
    renderControl()

    const dialog = await openConfirm(u)
    await waitFor(() => expect(confirmIn(dialog)).toBeEnabled())
    await u.click(confirmIn(dialog))
    // POSITIVE CONTROL: the refusal really did render in the open it belongs to.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      /^Something went wrong\. Please try again\.$/,
    )

    await u.click(within(dialog).getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    const reopened = await openConfirm(u)
    expect(within(reopened).queryByRole('alert')).toBeNull()
    expect(reopened.querySelector('[role="alert"]')).toBeNull()
    // POSITIVE CONTROL: the reopened dialog is real and has resolved its own count, so the
    // absence above is not an unmounted subtree.
    await waitFor(() => expect(confirmIn(reopened)).toBeEnabled())
  })

  it('re-reads the count on a second open rather than flashing the first one', async () => {
    // The component stays mounted while the dialog is closed, so without the reset on the way OUT
    // a stale count renders as already-known ahead of the fresh fetch — and 'already-known' is
    // what enables the destructive button.
    const u = userEvent.setup()
    mockCount.mockResolvedValue(2)
    renderControl()

    const dialog = await openConfirm(u)
    expect(
      await within(dialog).findByText(/^2 tickets will lose this value\. This can’t be undone\.$/),
    ).toBeInTheDocument()
    await u.click(within(dialog).getByRole('button', { name: /^cancel$/i }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // A count that never settles, so the SECOND open's pre-fetch state is observable at all.
    let releaseCount: (n: number) => void = () => {}
    mockCount.mockReturnValue(
      new Promise<number>((resolve) => {
        releaseCount = resolve
      }),
    )
    const reopened = await openConfirm(u)

    // `queryByText` does not honour `aria-hidden`, so this is the raw-DOM half of the pair; the
    // positive control is the fallback description below, which proves the dialog really did
    // reopen and this absence is not just an unmounted subtree.
    expect(within(reopened).queryByText(/2 tickets will lose this value/)).toBeNull()
    expect(within(reopened).getByText(/^This can’t be undone\.$/)).toBeInTheDocument()
    expect(confirmIn(reopened)).toBeDisabled()

    await act(async () => {
      releaseCount(7)
    })
    expect(
      await within(reopened).findByText(
        /^7 tickets will lose this value\. This can’t be undone\.$/,
      ),
    ).toBeInTheDocument()
  })

  /**
   * Both footer buttons' `disabled={deleting}` and the pending label. None of the plan's tests
   * reach the `deleting` branches at all: without this, `{deleting ? 'Removing…' : 'Remove
   * field'}` could collapse to the static label and Cancel could lose its guard with nothing red,
   * leaving a user able to fire a second delete for one intent.
   */
  it('disables both footer buttons and says so while the delete is in flight', async () => {
    const u = userEvent.setup()
    const { dialog, confirm, settle } = await startPendingDelete(u)

    expect(within(dialog).getByRole('button', { name: /^cancel$/i })).toBeDisabled()
    expect(confirm).toBeDisabled()
    expect(confirm).toHaveTextContent(/^Removing…$/)

    await settle()
    expect(confirm).toHaveTextContent(/^Remove field$/)
  })

  /**
   * The `if (deleting) return` in `onOpenChange`, pinned on the ONE close path it is the sole
   * defence for. Cancel cannot pin it — Cancel is itself `disabled={deleting}`, so "click Cancel,
   * the dialog stays open" passes with either guard removed and therefore pins neither. Escape
   * reaches `onOpenChange` without going through a disabled control.
   */
  it('keeps the confirm open on Escape while the delete is in flight', async () => {
    const u = userEvent.setup()
    const { settle } = await startPendingDelete(u)

    await u.keyboard('{Escape}')

    expect(screen.getByRole('alertdialog')).toBeVisible()

    await settle()
  })
})
