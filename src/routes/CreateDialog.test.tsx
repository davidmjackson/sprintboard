import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'

import { FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'
import { CreateDialog } from './CreateDialog'

type Values = { thing: string }

/** A stand-in for a real Create* dialog: one text field, nothing else. */
function Harness({
  onSubmit = vi.fn(),
  onClosed,
}: {
  onSubmit?: (values: Values, close: () => void) => void | Promise<void>
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

  it('hands the submitted values and a close callback to onSubmit', async () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    const user = await open()

    await user.type(screen.getByLabelText('Thing'), 'a widget')
    await user.click(screen.getByRole('button', { name: 'Create thing' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
    expect(onSubmit.mock.calls[0]![0]).toEqual({ thing: 'a widget' })
    expect(typeof onSubmit.mock.calls[0]![1]).toBe('function')
    // Not called => still open. The shell must never close itself.
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('closes when onSubmit invokes the close callback, the same way a manual close does', async () => {
    const onClosed = vi.fn()
    render(<Harness onSubmit={(_values, close) => close()} onClosed={onClosed} />)
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
})
