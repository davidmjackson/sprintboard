import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

import { SettingsTab } from './SettingsTab'
import type { ProjectShellContext } from './ProjectShell'
import type { ReadPhase } from '@/lib/project-reads'
import type { Project, ProjectField, ProjectStatus } from '@/lib/domain'
import { ticketCountsByStatus } from '@/lib/project-statuses'

// Only the counts read is network-touching from this tab's point of view; every pure helper
// stays real.
vi.mock('@/lib/project-statuses', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-statuses')>()),
  ticketCountsByStatus: vi.fn(),
}))

/**
 * A mutable switch rather than `vi.resetModules()` + a dynamic re-import: resetting the
 * module registry would reload React itself, so the freshly-imported `SettingsTab` and this
 * file's own `render`/`screen` (bound to the ORIGINAL React instance) would belong to two
 * different reconcilers. Every test defaults to the fake probe below; the wiring block near
 * the bottom of the file flips this to `true` so `SettingsTab` renders the REAL
 * `StatusSettings` — the only way to prove `SettingsTab` actually calls `hasWipLimits(project)`
 * rather than hardcoding a literal, which is a seam no per-task test suite can see (SPRIN-85,
 * fix round 1, Finding B).
 */
let renderRealStatusSettings = false

// The list, the add form and the writes are exercised by `StatusSettings.test.tsx`. Here it is
// a probe that reports the props the tab handed down, so this suite pins the SEAM — which
// context fields reach the list — rather than re-testing the list.
//
// `counts` is rendered with `.has()`, deliberately NOT the real component's `?? 0` fallback:
// this probe exists to pin what the TAB passes down, and `.has()` is the only rendering that
// can tell "we fetched a real count" apart from "we have no data for this status at all" —
// exactly the distinction the failed-fetch test below depends on.
vi.mock('./StatusSettings', async (orig) => {
  const actual = await orig<typeof import('./StatusSettings')>()
  return {
    StatusSettings: (props: Parameters<typeof actual.StatusSettings>[0]) => {
      if (renderRealStatusSettings) return <actual.StatusSettings {...props} />
      const { projectId, statuses, counts } = props
      return (
        <div>
          <p>
            settings for {projectId}: {statuses.map((s) => s.name).join(', ')}
          </p>
          <ul>
            {statuses.map((s) => (
              <li key={s.id}>
                <span>
                  {counts.has(s.slug) ? `${counts.get(s.slug)} tickets` : 'unknown count'}
                </span>
                <button type="button" disabled={!counts.has(s.slug)}>
                  Delete {s.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )
    },
  }
})

// Explicitly Scrum, as `BoardTab.test.tsx` and `BacklogTab.test.tsx` now are. `hasSprints({})`
// is `undefined === 'scrum'` → false, so leaving the field off would silently turn this whole
// file into a suite about a project WITHOUT sprints the moment anything in this tab consults
// the project type (SPRIN-83) — and SPRIN-84 refactors `StatusSettings` right here.
const project = { id: 'p1', name: 'Sprintboard', key: 'SPB', project_type: 'scrum' } as Project

const STATUSES = [
  { id: 'st1', slug: 'triage', name: 'Triage', category: 'todo', position: 1, wip_limit: null },
  { id: 'st2', slug: 'shipped', name: 'Shipped', category: 'done', position: 2, wip_limit: null },
] as unknown as ProjectStatus[]

function renderTab(
  ctx: {
    project?: Project
    statuses?: ProjectStatus[]
    statusesPhase?: ReadPhase
    fields?: ProjectField[]
    fieldsPhase?: ReadPhase
    onRetry?: () => void
  } = {},
) {
  const context = {
    project,
    statuses: STATUSES,
    statusesPhase: 'loaded',
    // SPRIN-90. Defaulted to a LOADED EMPTY list rather than left off: the cast below is
    // `as unknown as ProjectShellContext`, so omitting these compiles clean and hands the
    // component `undefined`, which reads as "not loaded" and renders the spinner forever —
    // a harness silently testing a state the real shell never produces.
    fields: [],
    fieldsPhase: 'loaded',
    onRetry: vi.fn(),
    onStatusCreated: vi.fn(),
    onStatusUpdated: vi.fn(),
    onStatusDeleted: vi.fn(),
    onStatusesReordered: vi.fn(),
    ...ctx,
  } as unknown as ProjectShellContext
  render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/" element={<Outlet context={context} />}>
          <Route path="settings" element={<SettingsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
  return context
}

describe('SettingsTab', () => {
  beforeEach(() => {
    vi.mocked(ticketCountsByStatus).mockReset().mockResolvedValue(new Map())
  })

  it("hands the project's own status rows to the list", () => {
    renderTab()

    expect(screen.getByText('settings for p1: Triage, Shipped')).toBeVisible()
  })

  // AC2: the count is shown BEFORE the user commits to a delete. Keyed on `project.id` and the
  // status list — the tab's own set-state-in-effect fetch, not something `StatusSettings` does
  // for itself (it has no project id to read `tickets` with beyond the one it already gets for
  // `AddStatusForm`).
  it('fetches ticket counts for the project statuses and passes them down', async () => {
    vi.mocked(ticketCountsByStatus).mockResolvedValue(new Map([['triage', 3]]))

    renderTab()

    expect(await screen.findByText('3 tickets')).toBeInTheDocument()
    expect(ticketCountsByStatus).toHaveBeenCalledWith('p1', STATUSES)
  })

  // The single most important behaviour in this task. `ticketCountsByStatus` THROWS rather
  // than resolving a fabricated zero, and a `.catch` here that substituted zeros anyway would
  // silently undo that: zero is the value that UNLOCKS a destructive delete, so a swallowed
  // error becoming zero would offer a delete the database is about to refuse. The tab must
  // default to an EMPTY map instead — this probe's `.has()` rendering is what makes that
  // observable, since the real component's own fallback for a genuinely fresh status looks
  // the same as "no data" from the outside.
  //
  // THE REJECTION IS SETTLED BY HAND, AND THAT IS THE WHOLE POINT OF THE SHAPE BELOW.
  // The first version of this test used `mockRejectedValue` plus `waitFor`, and was VACUOUS:
  // `useState(new Map())` means the PRE-FETCH render already blocks every Delete, and
  // `waitFor` resolves on its first synchronous check — before the rejection had settled. It
  // therefore observed the initial render and never the `.catch` branch at all. Proven by
  // mutation: rewriting the `.catch` to `setCounts(new Map(statuses.map((s) => [s.slug, 0])))`
  // — the exact fabricated-zero bug this test is named for — left it green. So: control the
  // promise, reject it, flush to the far side of the `.catch`, and only then assert.
  it('does not claim a count of zero when the count read fails', async () => {
    let fail!: (reason: Error) => void
    vi.mocked(ticketCountsByStatus).mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject
      }),
    )

    renderTab()
    const deletes = () => screen.getAllByRole('button', { name: /^delete /i })

    // In flight, nothing is deletable either — so the assertions after the flush are the
    // only ones that can distinguish the `.catch` from this render.
    expect(deletes().every((b) => b.hasAttribute('disabled'))).toBe(true)

    // A macrotask drains every pending microtask, so the component's `.then`-then-`.catch`
    // chain has fully run and repainted by the time this resolves.
    await act(async () => {
      fail(new Error('down'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    // Delete stays blocked rather than unlocking on a count we do not have…
    expect(deletes().every((b) => b.hasAttribute('disabled'))).toBe(true)
    // …because the map is still EMPTY, not full of zeros. `unknown count` for every status
    // is what the probe renders for "no entry"; a single "N tickets" here would mean the
    // failure had been turned into a number.
    expect(screen.getAllByText('unknown count')).toHaveLength(STATUSES.length)
    expect(screen.queryByText(/\d+ ticket/)).toBeNull()
  })

  // The phase-before-empty rule every other tab follows. `statuses` is `[]` during BOTH
  // loading and failed, so a tab that only looked at the list would render a confident
  // "this project has no statuses" over a list it does not have — S4.6's defect, a distinct
  // state wearing another state's face. And with writes now on this surface it is worse than
  // cosmetic: adding a status against a failed read computes `max(position)+1` from `[]`.
  it('shows a loading state, not an empty list, while the read is in flight', () => {
    renderTab({ statuses: [], statusesPhase: 'loading' })

    expect(screen.getByText('Loading…')).toBeVisible()
    expect(screen.queryByText(/settings for p1/)).toBeNull()
  })

  it('shows an error state with a Retry, not an empty list, when the read failed', async () => {
    const u = userEvent.setup()
    const ctx = renderTab({ statuses: [], statusesPhase: 'failed' })

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load statuses.')
    expect(screen.queryByText(/settings for p1/)).toBeNull()

    await u.click(screen.getByRole('button', { name: 'Retry' }))
    expect(ctx.onRetry).toHaveBeenCalled()
  })
})

/**
 * The SEAM between two SPRIN-85 tasks: `SettingsTab` computes `hasWipLimits(project)` and
 * `StatusSettings`/`StatusRow` only forward whatever boolean they are handed. Every test
 * above replaces `StatusSettings` with a probe, which cannot tell "the tab called
 * `hasWipLimits`" apart from "the tab hardcoded a literal" — both render identically through
 * a probe that never reads the prop's VALUE, only its presence. This block flips the module
 * mock to the real `StatusSettings` (see the switch above) and drives the whole chain —
 * `SettingsTab` → `StatusSettings` → `StatusRow` — for a Scrum and a Kanban project.
 *
 * A raw `document.querySelectorAll` pairs with the role query for the same reason
 * `StatusSettings.test.tsx`'s own absence test does: a role query honours `aria-hidden`, so
 * it would report "absent" for a field that is merely hidden from the accessibility tree
 * while staying in the DOM.
 */
describe('the wiring between SettingsTab and the WIP limit field (SPRIN-85, fix round 1)', () => {
  beforeEach(() => {
    renderRealStatusSettings = true
    // Fix round 1, finding 6: this describe used to have no `beforeEach` of its own and
    // borrowed whatever mock state the sibling `describe`'s LAST test happened to leave
    // behind — invisible coupling that `-t` filtering breaks (`TypeError: Cannot read
    // properties of undefined (reading 'then')`, because nothing had configured a resolved
    // value). Configuring it here is what makes these two tests independent of file order.
    vi.mocked(ticketCountsByStatus).mockReset().mockResolvedValue(new Map())
  })

  afterEach(() => {
    renderRealStatusSettings = false
  })

  it('renders no WIP limit field for a Scrum project', () => {
    renderTab()

    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0)
  })

  it('renders a WIP limit field per status for a Kanban project', () => {
    renderTab({ project: { ...project, project_type: 'kanban' } })

    expect(screen.getAllByRole('spinbutton', { name: /wip limit/i })).toHaveLength(STATUSES.length)
  })
})

/**
 * SPRIN-90 AC1 and AC2, asserted through the TAB rather than against
 * `CustomFieldSettings` directly.
 *
 * There is NO `CustomFieldSettings.test.tsx` — the component's three phases are covered here,
 * through the tab, and that is deliberate rather than an omission. An earlier draft of this
 * docblock claimed such a file existed and divided the labour with it. It did not exist, and
 * that fiction is what made the shell → tab seam read as covered when it was not. Same class
 * as the SPRIN-86 defect: a docblock asserting a control that is not there.
 *
 * What these cover is the tab → component seam: that `SettingsTab` actually reads
 * `fields`/`fieldsPhase` off the outlet context and forwards them. The seam ABOVE this one —
 * shell → tab, where the read actually lives — is pinned in `ProjectShell.test.tsx`, and had
 * to be added after review when four mutations of that wiring survived everything here.
 */
describe('SettingsTab custom fields', () => {
  const FIELDS = [
    { id: 'f1', slug: 'customer_ref', name: 'Customer ref', type: 'text' },
    { id: 'f2', slug: 'due', name: 'Due', type: 'date' },
  ] as unknown as ProjectField[]

  beforeEach(() => {
    vi.mocked(ticketCountsByStatus).mockReset().mockResolvedValue(new Map())
  })

  it("lists the project's custom fields, with each type's label", () => {
    renderTab({ fields: FIELDS })

    const list = screen.getByRole('heading', { name: 'Custom fields' }).closest('section')
    expect(list).not.toBeNull()

    // Scoped with `within`, not a bare getByText: an unscoped query says the text exists
    // somewhere on the tab and nothing about whether it is in THIS section.
    expect(within(list!).getByText('Customer ref')).toBeInTheDocument()
    expect(within(list!).getByText('Text')).toBeInTheDocument()
    expect(within(list!).getByText('Due')).toBeInTheDocument()
    expect(within(list!).getByText('Date')).toBeInTheDocument()

    // The description-list structure, pinned rather than merely argued for in a docblock.
    // Rewriting <dl>/<dt>/<dd> to <div>/<span>/<span> otherwise survives the whole suite, and
    // it is the structure that pairs each field with its type for assistive technology.
    expect(within(list!).getByText('Customer ref').tagName).toBe('DT')
    expect(within(list!).getByText('Text').tagName).toBe('DD')

    // The empty state must NOT also be on screen — otherwise "lists the fields" would pass
    // for a component rendering both.
    expect(screen.queryByText('No custom fields yet.')).not.toBeInTheDocument()
  })

  it('shows the empty state when the project has no custom fields', () => {
    renderTab({ fields: [], fieldsPhase: 'loaded' })

    // Scoped through getByRole, not a bare getByText. `getByText` ignores only <script> and
    // <style>, so it matches an `aria-hidden` subtree happily — an `aria-hidden="true"` on
    // the section reverts this surface for every screen-reader user with the assertion still
    // green (measured: that mutation killed four tests in this file but not this one).
    // `getByRole` honours `aria-hidden`, so the section has to be exposed for this to pass.
    const section = screen.getByRole('region', { name: 'Custom fields' })
    expect(within(section).getByText('No custom fields yet.')).toBeInTheDocument()
  })

  it('shows neither the list nor the empty state while the fields are still loading', () => {
    renderTab({ fields: [], fieldsPhase: 'loading' })

    // The same `[]` again, for a third distinct reason. If "loading" rendered the empty
    // state, a slow read would flash "No custom fields yet." at every user on every visit.
    expect(screen.queryByText('No custom fields yet.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Custom fields' })).toBeInTheDocument()
  })

  it('shows a failed fields read as a failure, never as "no custom fields"', () => {
    renderTab({ fields: [], fieldsPhase: 'failed' })

    // The claim under test: an empty list from a FAILED read must not render the same as an
    // empty list from a project that genuinely has none. Both arrive as `[]`.
    expect(screen.getByRole('alert')).toHaveTextContent(/^Could not load custom fields\.$/)
    expect(screen.queryByText('No custom fields yet.')).not.toBeInTheDocument()

    // POSITIVE CONTROL. Without this, the assertions above pass just as well if the whole tab
    // failed to render — which is shape 4 of green-for-the-wrong-reason, and the exact
    // vacuous-absence trap SPRIN-86's review found in this project's own work.
    expect(screen.getByRole('heading', { name: 'Custom fields' })).toBeInTheDocument()
  })

  it('forwards the tab-level Retry to the fields failure', async () => {
    const ctx = renderTab({ fields: [], fieldsPhase: 'failed' })

    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(ctx.onRetry).toHaveBeenCalledTimes(1)
  })
})
