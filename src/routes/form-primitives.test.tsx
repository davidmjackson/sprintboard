import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useForm } from 'react-hook-form'

import { Form } from '@/components/ui/form'
import { FormRootError, SubmitButton } from './form-primitives'

/** A minimal real form. `onSubmit` is whatever the test needs the submit to do —
 *  set a root error, or hang so the pending state is observable. */
function Harness({
  onSubmit,
}: {
  onSubmit?: (setRootError: (m: string) => void) => Promise<void>
}) {
  const form = useForm<{ x: string }>({ defaultValues: { x: '' } })
  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(async () => {
          await onSubmit?.((m) => form.setError('root', { message: m }))
        })}
        noValidate
      >
        <FormRootError />
        <SubmitButton label="Save" pendingLabel="Saving…" />
      </form>
    </Form>
  )
}

describe('FormRootError', () => {
  it('renders nothing until a root error is set', () => {
    render(<Harness />)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('paints the root error as an alert once it is set', async () => {
    const user = userEvent.setup()
    render(<Harness onSubmit={async (setRootError) => setRootError('It went wrong.')} />)

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('It went wrong.')
  })
})

describe('SubmitButton', () => {
  it('shows the label and is enabled at rest', () => {
    render(<Harness />)
    const button = screen.getByRole('button', { name: 'Save' })
    expect(button).toBeEnabled()
    expect(button).toHaveAttribute('type', 'submit')
  })

  it('swaps to the pending label and disables itself while submitting', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const user = userEvent.setup()
    render(<Harness onSubmit={() => held} />)

    await user.click(screen.getByRole('button', { name: 'Save' }))

    const pending = await screen.findByRole('button', { name: 'Saving…' })
    expect(pending).toBeDisabled()

    release()
    await screen.findByRole('button', { name: 'Save' })
  })

  it('applies the className it is given', () => {
    function Wide() {
      const form = useForm<{ x: string }>({ defaultValues: { x: '' } })
      return (
        <Form {...form}>
          <form noValidate>
            <SubmitButton label="Save" pendingLabel="Saving…" className="w-full" />
          </form>
        </Form>
      )
    }
    render(<Wide />)
    expect(screen.getByRole('button', { name: 'Save' })).toHaveClass('w-full')
  })
})
