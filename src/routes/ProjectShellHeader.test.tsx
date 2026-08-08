import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { ProjectShellHeader } from './ProjectShellHeader'
import type { Project, ProjectFieldOption } from '@/lib/domain'

/**
 * A direct test file for `ProjectShellHeader`, added in SPRIN-92 task 11's fix round 1.
 *
 * It did not have one before this round, which meant `ProjectShell.test.tsx`'s own "real
 * wiring" tests (shell → header → dialog → control, four hops) were the SOLE guard for BOTH the
 * shell→header wire AND the header→dialog wire: an edit to either test unguarded two hops at
 * once, and neither hop had a guard independent of the other. These two tests exist so the
 * header→dialog hop has its OWN guard, provable independently of `ProjectShell.test.tsx` by
 * killing each here without touching that file at all.
 */

const PROJECT = {
  id: 'p1',
  name: 'Apple',
  key: 'APP',
  owner_id: 'u1',
  project_type: 'scrum',
  created_at: '',
} as Project

const RISK_FIELD = {
  id: 'f-r1k',
  project_id: 'p1',
  slug: 'risk',
  name: 'Risk',
  type: 'select',
  created_at: '2026-08-08T10:00:00Z',
} as never

const LOW: ProjectFieldOption = {
  project_id: 'p1',
  field_id: 'f-r1k',
  slug: 'low',
  label: 'Low',
  position: 1,
}

/** `NavLink` (rendered by the tab bar) needs a Router context — a bare requirement of this
 *  component, unrelated to the wiring under test, so it is wrapped here rather than in each
 *  test. */
function renderHeader(props: {
  options: ProjectFieldOption[]
  optionsPhase: 'loaded' | 'loading'
}) {
  return render(
    <MemoryRouter>
      <ProjectShellHeader
        project={PROJECT}
        ticketsPhase="loaded"
        fields={[RISK_FIELD]}
        fieldsPhase="loaded"
        options={props.options}
        optionsPhase={props.optionsPhase}
        onTicketCreated={() => {}}
      />
    </MemoryRouter>,
  )
}

async function openDialog() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'New ticket' }))
  await screen.findByRole('dialog')
  return user
}

describe('ProjectShellHeader options wiring (SPRIN-92 task 11, fix round 1)', () => {
  it("forwards the header's own options prop to the create dialog's select (real wiring, header hop)", async () => {
    renderHeader({ options: [LOW], optionsPhase: 'loaded' })
    await openDialog()

    const select = await screen.findByRole('combobox', { name: 'Risk' })
    expect(within(select).getByRole('option', { name: 'Low' })).toBeInTheDocument()
  })

  it("forwards the header's own optionsPhase prop to the create dialog's select (real wiring, header hop)", async () => {
    renderHeader({ options: [], optionsPhase: 'loading' })
    await openDialog()

    expect(await screen.findByRole('combobox', { name: 'Risk' })).toBeDisabled()
  })
})
