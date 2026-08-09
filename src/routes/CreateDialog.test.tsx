import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'

import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { CreateDialog, type SubmitActions } from './CreateDialog'

type Values = { thing: string }

/** A stand-in for a real Create* dialog: one text field, nothing else. */
function Harness({
  onSubmit = vi.fn(),
  onOpened,
  onClosed,
}: {
  onSubmit?: (values: Values, actions: SubmitActions<Values>) => void | Promise<void>
  onOpened?: () => void
  onClosed?: () => void
}) {
  const form = useForm<Values>({ defaultValues: { thing: '' } })
  return (
    <CreateDialog
      trigger="New thing"
      title="Create a thing"
      description="It makes a thing."
      submitLabel="Create thing"
      form={form}
      onSubmit={onSubmit}
      onOpened={onOpened}
      onClosed={onClosed}
    >
      <FormField
        control={form.control}
        name="thing"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Thing</FormLabel>
            <FormControl>
              <Input {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </CreateDialog>
  )
}

async function open() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'New thing' }))
  await screen.findByRole('dialog')
  return user
}

describe('CreateDialog', () => {
  it('opens from its trigger and shows the title and description', async () => {
    render(<Harness />)
    await open()

    expect(screen.getByText('Create a thing')).toBeInTheDocument()
    expect(screen.getByText('It makes a thing.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Create thing' })).toBeInTheDocument()
  })

  it('hands the submitted values and all three guarded callbacks to onSubmit', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    const user = await open()

    await user.type(screen.getByLabelText('Thing'), 'a widget')
    await user.click(screen.getByRole('button', { name: 'Create thing' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toEqual({ thing: 'a widget' })
    const actions = onSubmit.mock.calls[0]![1] as SubmitActions<Values>
    expect(typeof actions.close).toBe('function')
    expect(typeof actions.setError).toBe('function')
    expect(typeof actions.latch).toBe('function')
    // Not called => still open. The shell must never close itself.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes when onSubmit invokes the close callback, the same way a manual close does', async () => {
    const onClosed = vi.fn()
    render(<Harness onSubmit={(_values, { close }) => close()} onClosed={onClosed} />)
    const user = await open()

    await user.type(screen.getByLabelText('Thing'), 'a widget')
    await user.click(screen.getByRole('button', { name: 'Create thing' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    // A manual close resets the form and fires onClosed. The programmatic close
    // callback must do both too — not just make the dialog disappear.
    expect(onClosed).toHaveBeenCalledTimes(1)

    await open()
    expect(screen.getByLabelText('Thing')).toHaveValue('')
  })

  it('keeps the submit button pending and disabled while onSubmit is in flight', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const onSubmit = vi.fn(() => held)
    render(<Harness onSubmit={onSubmit} />)
    const user = await open()

    await user.type(screen.getByLabelText('Thing'), 'a widget')
    await user.click(screen.getByRole('button', { name: 'Create thing' }))

    const pending = await screen.findByRole('button', { name: 'Creating…' })
    expect(pending).toBeDisabled()

    release()
    await screen.findByRole('button', { name: 'Create thing' })
  })

  it('resets the form when the dialog closes, so a reopen starts blank', async () => {
    render(<Harness />)
    const user = await open()

    await user.type(screen.getByLabelText('Thing'), 'abandoned draft')
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    await open()
    expect(screen.getByLabelText('Thing')).toHaveValue('')
  })

  it('calls onClosed when the dialog closes, and not while it is open', async () => {
    const onClosed = vi.fn()
    render(<Harness onClosed={onClosed} />)
    const user = await open()

    expect(onClosed).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1))
  })

  it('paints a root error set by onSubmit and stays open', async () => {
    function ErroringHarness() {
      const form = useForm<Values>({ defaultValues: { thing: '' } })
      return (
        <CreateDialog
          trigger="New thing"
          title="Create a thing"
          description="It makes a thing."
          submitLabel="Create thing"
          form={form}
          onSubmit={() => form.setError('root', { message: 'Something went wrong.' })}
        >
          <div />
        </CreateDialog>
      )
    }
    render(<ErroringHarness />)
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create thing' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.')
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('disables the submit button once onSubmit latches it', async () => {
    render(<Harness onSubmit={(_values, { latch }) => latch()} />)
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create thing' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create thing' })).toBeDisabled())
  })

  it('leaves the submit button enabled until something latches it', async () => {
    // The other two Create dialogs never latch. If the shell ever starts latched they break,
    // and this is the test that says so.
    render(<Harness />)
    await open()

    expect(await screen.findByRole('button', { name: 'Create thing' })).toBeEnabled()
  })

  it('does not submit again once latched', async () => {
    // A disabled attribute the form still honours would be decoration. This is the property
    // that actually prevents the duplicate create.
    const onSubmit = vi.fn((_values: Values, { latch }: SubmitActions<Values>) => latch())
    render(<Harness onSubmit={onSubmit} />)
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create thing' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create thing' })).toBeDisabled())

    await user.click(screen.getByRole('button', { name: 'Create thing' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('does not submit on Enter once latched', async () => {
    // A native disabled submit button is excluded from the form's default-submit
    // candidates, so pressing Enter in a text field must not fire onSubmit either.
    const onSubmit = vi.fn((_values: Values, { latch }: SubmitActions<Values>) => latch())
    render(<Harness onSubmit={onSubmit} />)
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create thing' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create thing' })).toBeDisabled())

    await user.type(screen.getByLabelText('Thing'), 'a widget{Enter}')

    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('clears the latch when the dialog is closed and reopened', async () => {
    // The latch is per-attempt, not permanent — and the shell clears it, so no call site has
    // to remember an `onClosed` for it.
    render(<Harness onSubmit={(_values, { latch }) => latch()} />)
    const user = await open()

    await user.click(screen.getByRole('button', { name: 'Create thing' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Create thing' })).toBeDisabled())

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await open()

    expect(screen.getByRole('button', { name: 'Create thing' })).toBeEnabled()
  })

  it('fires onOpened on every open, so a caller can recompute defaults it captured at mount', async () => {
    const onOpened = vi.fn()
    render(<Harness onOpened={onOpened} onSubmit={(_values, { close }) => close()} />)

    const user = await open()
    expect(onOpened).toHaveBeenCalledTimes(1)

    // Close it the way a successful create does, then open it again.
    await user.click(screen.getByRole('button', { name: 'Create thing' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await open()

    // Twice, not once: a caller whose defaults depend on props that changed between the two
    // opens has no other moment to recompute them.
    expect(onOpened).toHaveBeenCalledTimes(2)
  })

  it('does not fire onOpened when the dialog closes', async () => {
    const onOpened = vi.fn()
    const onClosed = vi.fn()
    render(
      <Harness onOpened={onOpened} onClosed={onClosed} onSubmit={(_v, { close }) => close()} />,
    )

    const user = await open()
    await user.click(screen.getByRole('button', { name: 'Create thing' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(onOpened).toHaveBeenCalledTimes(1)
  })
})

/**
 * SPRIN-51. A submit's continuation resolves against whatever dialog is open at that
 * moment, not the one that was open when it started. Every test here drives the same
 * sequence — submit, close by hand mid-flight, reopen, type — and then releases the
 * original promise.
 *
 * Each was observed to fail against the unguarded shell before the fix: the reopened
 * dialog closed and took the new draft with it. The `onCreated` assertion is the one that
 * pins the *shape* of the fix rather than its presence, since an `if (stale) return` over
 * the whole continuation would satisfy every other assertion here while silently dropping
 * a record that really was written.
 */
describe('CreateDialog — a stale submit must not reach a reopened dialog', () => {
  /** Opens, types `first`, submits, and holds the submit open. Returns a `release`. */
  async function submitThenAbandon(
    onSubmit: (values: Values, actions: SubmitActions<Values>) => Promise<void>,
  ) {
    const user = userEvent.setup()
    render(<Harness onSubmit={onSubmit} />)

    await user.click(screen.getByRole('button', { name: 'New thing' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Thing'), 'first')
    await user.click(screen.getByRole('button', { name: 'Create thing' }))
    await screen.findByRole('button', { name: 'Creating…' })

    // The user gives up and closes it by hand while the write is still in flight.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    // ...then reopens and starts an unrelated draft.
    await user.click(screen.getByRole('button', { name: 'New thing' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Thing'), 'second draft')
    return user
  }

  it('leaves the reopened draft intact when the abandoned submit succeeds', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const onCreated = vi.fn()
    await submitThenAbandon(async (_values, { close }) => {
      await held
      onCreated()
      close()
    })

    release()
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByLabelText('Thing')).toHaveValue('second draft')
  })

  // AC3 — "the parent still receives the created record" — is deliberately NOT tested
  // here. `onCreated` is invoked by the call site's own `onSubmit`, so no change to this
  // shell can suppress it and any assertion on it at this level would be unfalsifiable.
  // It is pinned where a regression could actually land, in `CreateTicketDialog.test.tsx`.

  it('paints no stale error onto the reopened draft when the abandoned submit fails', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await submitThenAbandon(async (_values, { setError }) => {
      await held
      setError('root', { message: 'Something went wrong.' })
    })

    release()
    await waitFor(() => expect(screen.getByLabelText('Thing')).toHaveValue('second draft'))

    // The failure belongs to a submit the user already walked away from.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  /**
   * The generation must be sampled when the form is submitted, NOT inside the callback
   * `form.handleSubmit` runs after validation resolves. With the synchronous resolvers the
   * three real dialogs use today the gap is one microtask; with an async resolver it is
   * the whole bug again, and every other test in this file passes either way.
   *
   * This harness holds validation open across the close-and-reopen, so the abandoned
   * submit reaches `onSubmit` only once a new draft is on screen.
   */
  it('samples the generation at submit, not after an async resolver settles', async () => {
    let releaseValidation = () => {}
    const validationHeld = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })

    function AsyncValidatedHarness() {
      const form = useForm<Values>({
        defaultValues: { thing: '' },
        resolver: async (values) => {
          await validationHeld
          return { values, errors: {} }
        },
      })
      return (
        <CreateDialog
          trigger="New thing"
          title="Create a thing"
          description="It makes a thing."
          submitLabel="Create thing"
          form={form}
          onSubmit={(_values, { close }) => close()}
        >
          <FormField
            control={form.control}
            name="thing"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Thing</FormLabel>
                <FormControl>
                  <Input {...field} />
                </FormControl>
              </FormItem>
            )}
          />
        </CreateDialog>
      )
    }

    const user = userEvent.setup()
    render(<AsyncValidatedHarness />)

    await user.click(screen.getByRole('button', { name: 'New thing' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Thing'), 'first')
    await user.click(screen.getByRole('button', { name: 'Create thing' }))

    // Validation is still pending — abandon and reopen while it is in flight.
    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'New thing' }))
    await screen.findByRole('dialog')
    await user.type(screen.getByLabelText('Thing'), 'second draft')

    releaseValidation()

    await waitFor(() => expect(screen.getByLabelText('Thing')).toHaveValue('second draft'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  /**
   * The review finding SPRIN-89's latch was rewritten for. While `latch` was a caller-owned
   * `submitDisabled` prop it was the ONE effect of the continuation the shell's generation
   * guard could not reach, so a stale submit disabled whichever dialog was open when it
   * resolved. The `setError` beside it *was* guarded and correctly swallowed the explanation,
   * which is what made the outcome so bad: a fresh draft, intact, unsubmittable, and no alert
   * saying why. Only a second close/reopen recovered, discarding the draft.
   *
   * The alert assertion is deliberately paired with the enabled one. A latch that fired
   * without its message is exactly the dead-dialog state, so asserting only `toBeEnabled()`
   * would leave the pairing unpinned.
   */
  it('does not latch the reopened dialog when the abandoned submit latches', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const resolved = vi.fn()
    await submitThenAbandon(async (_values, { setError, latch }) => {
      await held
      setError('root', { message: 'Created it, but the rest did not save.' })
      latch()
      resolved()
    })

    release()
    await waitFor(() => expect(resolved).toHaveBeenCalledTimes(1))

    // A PLAIN assertion, not a `waitFor`: `waitFor` polls, so its first attempt could pass
    // before a latch had rendered and the test would go green against the very defect it
    // exists for. RTL's `waitFor` above already flushed React's work inside `act`.
    expect(screen.getByRole('button', { name: 'Create thing' })).toBeEnabled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Thing')).toHaveValue('second draft')
  })

  it('does not fire onClosed a second time when a hand-closed submit later resolves', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const onClosed = vi.fn()
    const user = userEvent.setup()
    render(
      <Harness
        onClosed={onClosed}
        onSubmit={async (_values, { close }) => {
          await held
          close()
        }}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'New thing' }))
    await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: 'Create thing' }))
    await screen.findByRole('button', { name: 'Creating…' })

    await user.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1))

    release()
    await screen.findByRole('button', { name: 'New thing' })
    // The dialog is already closed; the resolving submit must not close it again.
    expect(onClosed).toHaveBeenCalledTimes(1)
  })
})
