import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AppLayout } from './AppLayout'
import { ProjectsHome } from './ProjectsHome'
import { ProjectShell } from './ProjectShell'
import { BoardTab } from './BoardTab'
import { BacklogTab } from './BacklogTab'
import { createProject, listProjects } from '@/lib/projects'

vi.mock('@/lib/auth-context', () => ({
  useAuth: () => ({ session: {}, user: { id: 'u1', email: 'a@example.com' }, loading: false }),
}))
vi.mock('@/lib/projects', () => ({ listProjects: vi.fn(), createProject: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signOut: vi.fn() } } }))

const mockList = vi.mocked(listProjects)
const mockCreate = vi.mocked(createProject)

const PROJECTS = [
  { id: 'p1', name: 'Apple', key: 'APP', owner_id: 'u1', project_type: 'scrum', created_at: '' },
  { id: 'p2', name: 'Banana', key: 'BAN', owner_id: 'u1', project_type: 'scrum', created_at: '' },
] as never

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AppLayout />}>
          <Route path="/" element={<ProjectsHome />} />
          <Route path="/projects/:projectId" element={<ProjectShell />}>
            <Route index element={<Navigate to="board" replace />} />
            <Route path="board" element={<BoardTab />} />
            <Route path="backlog" element={<BacklogTab />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  mockList.mockReset()
  mockCreate.mockReset()
})

describe('AppLayout project nav', () => {
  it("lists the owner's projects in the nav", async () => {
    mockList.mockResolvedValue(PROJECTS)
    renderApp('/')

    expect(await screen.findByRole('link', { name: /Apple/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Banana/ })).toBeInTheDocument()
  })

  it('shows an empty state when there are no projects', async () => {
    mockList.mockResolvedValue([])
    renderApp('/')

    expect(await screen.findByText('No projects yet.')).toBeInTheDocument()
    expect(screen.getByText(/Create your first project/)).toBeInTheDocument()
  })

  it('selecting a project opens it', async () => {
    mockList.mockResolvedValue(PROJECTS)
    const user = userEvent.setup()
    renderApp('/')

    await user.click(await screen.findByRole('link', { name: /Apple/ }))

    expect(await screen.findByRole('heading', { name: /Apple/ })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: 'Board' })).toBeInTheDocument()
  })

  it('restores the selected project from the URL on load (survives a refresh)', async () => {
    mockList.mockResolvedValue(PROJECTS)
    renderApp('/projects/p2')

    expect(await screen.findByRole('heading', { name: /Banana/ })).toBeInTheDocument()
  })

  it('sends you home if the project id is not in your list', async () => {
    mockList.mockResolvedValue(PROJECTS)
    renderApp('/projects/not-mine')

    expect(await screen.findByText(/Select a project from the left/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Board' })).not.toBeInTheDocument()
  })

  it('opens a freshly created project immediately, before the nav refetch resolves', async () => {
    const created = {
      id: 'pNew',
      name: 'Zeta',
      key: 'ZET',
      owner_id: 'u1',
      project_type: 'scrum',
      created_at: '',
    }
    // Mount returns nothing; the post-create refetch stays pending, so ONLY the
    // optimistic insert can open the project. (Navigating on the stale list would
    // bounce the user home — the bug this guards.)
    let resolveRefetch: (v: unknown) => void = () => {}
    mockList.mockResolvedValueOnce([])
    mockList.mockReturnValueOnce(new Promise((r) => (resolveRefetch = r)) as never)
    mockCreate.mockResolvedValue({ ok: true, project: created } as never)

    const user = userEvent.setup()
    renderApp('/')

    await user.click(await screen.findByRole('button', { name: 'New project' }))
    await user.type(screen.getByLabelText('Name'), 'Zeta')
    await user.click(screen.getByRole('button', { name: 'Create project' }))

    expect(await screen.findByRole('heading', { name: /Zeta/ })).toBeInTheDocument()
    resolveRefetch([created]) // let the background refetch settle
  })
})
