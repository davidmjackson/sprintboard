import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { BoardTab } from './BoardTab'
import { BacklogTab } from './BacklogTab'

describe('BoardTab', () => {
  it('renders all four fixed columns, in board order', () => {
    render(<BoardTab />)
    const headings = screen.getAllByRole('heading').map((h) => h.textContent)
    expect(headings).toEqual(['To Do', 'In Progress', 'In Review', 'Done'])
  })

  it('renders with no tickets without crashing', () => {
    render(<BoardTab />)
    expect(screen.getAllByText('No tickets yet.')).toHaveLength(4)
  })
})

describe('BacklogTab', () => {
  it('renders an empty state when there are no tickets', () => {
    render(<BacklogTab />)
    expect(screen.getByText('No tickets yet.')).toBeInTheDocument()
  })
})
