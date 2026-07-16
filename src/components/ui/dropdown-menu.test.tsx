import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './dropdown-menu'

describe('DropdownMenu', () => {
  it('reveals its items when the trigger is clicked', async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Open menu">⋯</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Only item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    )
    expect(screen.queryByText('Only item')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Open menu' }))
    expect(await screen.findByRole('menuitem', { name: 'Only item' })).toBeInTheDocument()
  })
})
