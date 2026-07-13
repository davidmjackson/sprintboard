import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import App from './App'

// S1.1 AC: "shadcn/ui is wired and one sample component renders."
describe('S1.1 scaffold', () => {
  it('renders the app shell', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'Sprintboard' })).toBeInTheDocument()
  })

  it('renders a shadcn/ui Button, styled by its variant classes', () => {
    render(<App />)
    const button = screen.getByRole('button')

    expect(button).toBeInTheDocument()
    // Asserts the component came from shadcn rather than being a bare <button>:
    // these classes are emitted by its cva variant config, not written by us.
    expect(button).toHaveClass('inline-flex', 'items-center', 'justify-center')
  })

  it('is interactive, so React state is wired', async () => {
    const user = userEvent.setup()
    render(<App />)
    const button = screen.getByRole('button')

    expect(button).toHaveTextContent('Clicked 0 times')
    await user.click(button)
    expect(button).toHaveTextContent('Clicked 1 times')
  })
})
