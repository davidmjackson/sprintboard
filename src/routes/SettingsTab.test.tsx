import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

import { SettingsTab } from './SettingsTab'
import type { ProjectShellContext } from './ProjectShell'
import type { ReadPhase } from '@/lib/project-reads'
import type { Project, ProjectField, ProjectFieldOption, ProjectStatus } from '@/lib/domain'
import { ticketCountsByStatus } from '@/lib/project-statuses'
import {
  countTicketsHoldingField,
  createProjectField,
  deleteProjectField,
  renameProjectField,
} from '@/lib/project-fields'
import {
  countTicketsHoldingOption,
  createProjectFieldOption,
  deleteProjectFieldOption,
  renameProjectFieldOption,
} from '@/lib/project-field-options'

// SPRIN-91. Mocked because the tests below drive the custom-field add and rename forms through
// this tab, and the real writes reach PostgREST. `useTaggedRead` is not involved here, so an
// unmocked write would not merely be slow — it would be a genuine outbound request from a unit
// test, the exact defect SPRIN-90's review measured at ~90 per run in `ProjectShell.test.tsx`.
//
// SPRIN-93 adds the two the delete control calls. `countTicketsHoldingField` fires on the
// confirm's `open` transition and `deleteProjectField` on its commit, so leaving either real
// would put a live PostgREST request behind a button this file clicks.
vi.mock('@/lib/project-fields', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-fields')>()),
  createProjectField: vi.fn(),
  renameProjectField: vi.fn(),
  countTicketsHoldingField: vi.fn(),
  deleteProjectField: vi.fn(),
}))

// SPRIN-92 task 9, fix round 1: the same reasoning one table over. A `select` field's row now
// mounts the REAL `CustomFieldOptions` when this tab renders the real `CustomFieldSettings`,
// so its writes need mocking here too or an unmocked one reaches the live database.
vi.mock('@/lib/project-field-options', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-field-options')>()),
  createProjectFieldOption: vi.fn(),
  renameProjectFieldOption: vi.fn(),
  deleteProjectFieldOption: vi.fn(),
  countTicketsHoldingOption: vi.fn(),
}))

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
    options?: ProjectFieldOption[]
    optionsPhase?: ReadPhase
    onFieldCreated?: (field: ProjectField) => void
    onFieldUpdated?: (field: ProjectField) => void
    onFieldDeleted?: (id: string) => void
    // SPRIN-93. Overridable only so the crossed-wire test below can hand in its OWN spy: this
    // callback shares `onFieldDeleted`'s exact signature, which is what makes the swap invisible
    // to the compiler and worth a test.
    onStatusDeleted?: (id: string) => void
    onOptionCreated?: (option: ProjectFieldOption) => void
    onOptionUpdated?: (option: ProjectFieldOption) => void
    onOptionDeleted?: (fieldId: string, slug: string) => void
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
    // SPRIN-92 task 9, fix round 1. Same reasoning as `fields`/`fieldsPhase` above, one table
    // over — defaulted to a loaded empty list rather than left off.
    options: [],
    optionsPhase: 'loaded',
    // SPRIN-91, and the docblock above applies to these with more force than to `fields`.
    // The cast is `as unknown as ProjectShellContext`, so omitting them COMPILES and hands
    // `CustomFieldSettings` `undefined` for its two write callbacks — which throws only when a
    // test actually adds or renames a field, i.e. exactly the tests this story adds. The type
    // checker cannot help here; only stating them can.
    // Stubs by default; a caller that wants to ASSERT the seam passes its own. Supplying a
    // stub is NOT pinning — a review swapped these two props and reversed `projectId`, and the
    // whole suite stayed green precisely because they were present-but-unasserted. The two
    // write tests at the end of this file are what actually close that.
    onFieldCreated: vi.fn(),
    onFieldUpdated: vi.fn(),
    onFieldDeleted: vi.fn(),
    // SPRIN-92 task 9, fix round 1 (Important): the identical swap risk one table over —
    // `onOptionCreated`/`onOptionUpdated` are stubs by default; the write tests further down
    // pass their own and assert them.
    onOptionCreated: vi.fn(),
    onOptionUpdated: vi.fn(),
    onOptionDeleted: vi.fn(),
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
    // The two write mocks are MODULE-level and nothing in this project configures
    // `clearMocks`/`restoreMocks`, so call counts accumulate across tests in file order.
    // `toHaveBeenCalledTimes(1)` below is correct today only because nothing above the write
    // tests triggers a write — a property that quietly stops holding the moment a second write
    // test is inserted anywhere earlier in the file.
    vi.mocked(createProjectField).mockReset()
    vi.mocked(renameProjectField).mockReset()
    vi.mocked(countTicketsHoldingField).mockReset()
    vi.mocked(deleteProjectField).mockReset()
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
 * **`CustomFieldSettings.test.tsx` now exists** (SPRIN-91) and owns the component's own
 * behaviour — the add form, the rename path, and the five type options. This docblock
 * previously said it did NOT exist, and said so correctly: SPRIN-90 shipped a docblock
 * claiming the file, the claim was false, and that fiction is what made the shell → tab seam
 * read as covered when it was not. The claim is true now, and it is restated here only
 * because a stale "no such file" is the same defect pointing the other way.
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

    const section = screen.getByRole('region', { name: 'Custom fields' })

    // Scoped to the LIST, not merely to the section, and SPRIN-91 is why. The section now also
    // holds the add form, whose type `<select>` renders an `<option>` for every one of the five
    // labels — so `within(section).getByText('Text')` became ambiguous the moment that form
    // landed, matching the option as readily as the row. Narrowing to the `<ul>` is what keeps
    // this test about the LIST. There is exactly one list in this region; the options are
    // `option` role inside a `combobox`, not list items.
    const list = within(section).getByRole('list')

    expect(within(list).getByText('Customer ref')).toBeInTheDocument()
    expect(within(list).getByText('Text')).toBeInTheDocument()
    expect(within(list).getByText('Due')).toBeInTheDocument()
    expect(within(list).getByText('Date')).toBeInTheDocument()

    // The row structure, pinned rather than merely argued for in a docblock.
    //
    // SPRIN-90 asserted `DT`/`DD` here, because the list was a `<dl>`. SPRIN-91 reversed that
    // to `<ul>`/`<li>`: once the name is an `EditableText` button and the row owns its own
    // `role="alert"`, a row is an item with controls rather than a term and its definition.
    // The assertion is updated rather than dropped — without it, flattening the list back to
    // bare `<div>`s survives the whole suite.
    //
    // The name now sits inside a BUTTON, so its own tagName is no longer the row's. Asserting
    // the enclosing `<li>` is what stays true across that change, and `closest` is what makes
    // it an assertion about structure rather than about which element happens to hold the text.
    expect(within(list).getByText('Customer ref').closest('li')).not.toBeNull()
    expect(within(list).getByText('Text').closest('li')).not.toBeNull()
    expect(within(list).getAllByRole('listitem')).toHaveLength(FIELDS.length)

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

  /**
   * THE TAB → COMPONENT SEAM FOR THE TWO WRITES. Added on a review finding, and the finding is
   * worth stating because it is subtle: SPRIN-91 first "closed" this by adding
   * `onFieldCreated: vi.fn(), onFieldUpdated: vi.fn()` to the harness above. That made the
   * props PRESENT, which made the seam INVISIBLE — supplied and never asserted. Two mutations
   * then survived the entire 1031-test suite:
   *
   *   `projectId={project.id}` → `projectId={'not-this-project'}`
   *   `onCreated`/`onUpdated` swapped
   *
   * The seam control that proves the harness can see this class: the SAME two mutations on the
   * `StatusSettings` props twelve lines higher killed two tests each. So the gap was coverage,
   * not technique.
   *
   * `projectId` is the sharper half. A wrong id there writes a custom field into the wrong
   * project, and `fields_owner_insert`'s WITH CHECK permits it whenever the user owns BOTH
   * projects — RLS is not a backstop for this one.
   */
  it('adds a field through the tab, against THIS project, and forwards the created row', async () => {
    // A project id that is NOT the shared `'p1'` fixture. With `'p1'`, replacing
    // `projectId={project.id}` with the LITERAL `'p1'` survives the whole suite — measured in
    // re-review — because every fixture in this file and in `CustomFieldSettings.test.tsx`
    // uses that same value. The confound doubles rather than cancels. A distinct id is what
    // makes this test about the SEAM rather than about a coincidence.
    const project = { id: 'p-distinct', name: 'Sprintboard', key: 'SPB' } as Project
    const created = {
      id: 'f9',
      project_id: 'p-distinct',
      slug: 'ship_by',
      name: 'Ship by',
      type: 'date',
    }
    vi.mocked(createProjectField).mockResolvedValue({
      ok: true,
      value: created as unknown as ProjectField,
    })
    const onFieldCreated = vi.fn()
    const onFieldUpdated = vi.fn()
    renderTab({ project, fields: [], onFieldCreated, onFieldUpdated })

    const addField = screen.getByRole('button', { name: 'Add field' })
    const form = within(addField.closest('form')!)
    await userEvent.type(form.getByRole('textbox', { name: 'Name' }), 'Ship by')
    await userEvent.selectOptions(form.getByRole('combobox', { name: 'Type' }), 'date')
    await userEvent.click(addField)

    // The barrier is the CALLBACK, not the write call. Waiting on `createProjectField` having
    // been called waits for something that happens strictly BEFORE `onCreated` fires, which
    // would leave the assertion that matters outside the barrier.
    //
    // HONEST ABOUT WHAT THIS IS: it is the correct barrier, not a demonstrated fix. Both
    // forms pass today, and they still pass with the write resolution delayed by 10ms and
    // this line deleted — measured, after a review reported the opposite. `userEvent.type`
    // and `.click` are themselves awaited and yield to the macrotask queue, so a short delay
    // has already elapsed by the time the assertions run. Assert on the thing you care about
    // anyway; the alternative is a test whose correctness depends on how long userEvent
    // happens to take.
    await waitFor(() => expect(onFieldCreated).toHaveBeenCalledWith(created))

    // The project id actually reaching the write, not merely that a write happened.
    expect(vi.mocked(createProjectField)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createProjectField).mock.calls[0]![0]).toMatchObject({
      projectId: 'p-distinct',
      name: 'Ship by',
      type: 'date',
    })

    // And the row goes to the CREATE callback, not the update one. Asserting both is what
    // kills the swap: either alone passes when the two props are exchanged.
    expect(onFieldUpdated).not.toHaveBeenCalled()
  })

  it('renames a field through the tab and forwards the row to onFieldUpdated', async () => {
    const FIELD = {
      id: 'f1',
      project_id: 'p1',
      slug: 'delivery_date',
      name: 'Ship by',
      type: 'date',
    } as unknown as ProjectField
    const renamed = { ...FIELD, name: 'Target ship date' }
    vi.mocked(renameProjectField).mockResolvedValue({ ok: true, value: renamed })
    const onFieldCreated = vi.fn()
    const onFieldUpdated = vi.fn()
    renderTab({ fields: [FIELD], onFieldCreated, onFieldUpdated })

    // `EditableText` names its view-mode trigger `Edit ${ariaLabel}` and its input `${ariaLabel}`
    // — two different names for the two modes, which is why both are stated literally here.
    await userEvent.click(screen.getByRole('button', { name: 'Edit name of Ship by' }))
    const input = screen.getByRole('textbox', { name: 'name of Ship by' })
    await userEvent.clear(input)
    await userEvent.type(input, 'Target ship date{Enter}')

    // Barrier on the callback, for the reason spelled out in the add test above.
    await waitFor(() => expect(onFieldUpdated).toHaveBeenCalledWith(renamed))

    expect(vi.mocked(renameProjectField)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(renameProjectField)).toHaveBeenCalledWith('f1', 'Target ship date')

    // The mirror of the add test: the renamed row goes to UPDATE, and create stays untouched.
    expect(onFieldCreated).not.toHaveBeenCalled()
  })

  /**
   * THE CROSSED-WIRE TEST (SPRIN-93).
   *
   * `onFieldDeleted` is required at every hop, so a MISSING wire is a `TS2741` — that is what
   * Task 4's required prop buys. Requiredness cannot catch a CROSSED one, and this tab reads
   * `onStatusDeleted` off the SAME context object with the IDENTICAL signature,
   * `(id: string) => void`. `onDeleted={onStatusDeleted}` compiles, lints and typechecks clean,
   * and would silently delete-from-the-status-list a field id that is not a status id. This file
   * has already paid for that class once — SPRIN-92's `optionsPhase={fieldsPhase}`, the sixth
   * instance — so the assertion is on the IDENTITY of the function that arrives, not merely that
   * one did: the field spy must fire AND the same-signature sibling must not.
   *
   * `CustomFieldSettings.test.tsx` closes the seam below this one — it hands `onDeleted` in
   * itself, so it passes just as well when `SettingsTab` forwards the wrong callback.
   */
  it("hands the context's own onFieldDeleted down, never a same-signature sibling", async () => {
    const u = userEvent.setup()
    const FIELD = {
      id: 'f1',
      project_id: 'p1',
      slug: 'delivery_date',
      name: 'Ship by',
      type: 'date',
    } as unknown as ProjectField
    vi.mocked(countTicketsHoldingField).mockResolvedValue(0)
    vi.mocked(deleteProjectField).mockResolvedValue({ ok: true, value: undefined })
    const onFieldDeleted = vi.fn()
    const onStatusDeleted = vi.fn()
    renderTab({ fields: [FIELD], onFieldDeleted, onStatusDeleted })

    await u.click(screen.getByRole('button', { name: 'Remove Ship by' }))
    const dialog = await screen.findByRole('alertdialog')
    const confirm = within(dialog).getByRole('button', { name: 'Remove field' })
    // The confirm unlocks only once the count is known, so this waits for the read rather than
    // clicking a disabled button and asserting nothing.
    await waitFor(() => expect(confirm).toBeEnabled())
    await u.click(confirm)

    await waitFor(() => expect(onFieldDeleted).toHaveBeenCalledWith('f1'))
    expect(vi.mocked(deleteProjectField)).toHaveBeenCalledWith('f1')
    // The half that kills the swap: the sibling this tab could have crossed with never fired.
    expect(onStatusDeleted).not.toHaveBeenCalled()
  })
})

/**
 * SPRIN-92 task 9, fix round 1 (Important). The exact mirror of `describe('SettingsTab custom
 * fields', ...)`'s own write tests above, one table over — and needed for the identical reason
 * those were added: `onOptionCreated`/`onOptionUpdated`/`onOptionDeleted` are stubbed
 * present-but-unasserted by `renderTab`'s defaults, which makes the SettingsTab → CustomFieldSettings
 * seam for OPTIONS look covered when nothing here actually drives a write across it.
 *
 * `CustomFieldSettings.test.tsx` closes the seam BELOW this one — from `CustomFieldSettings`'s
 * own top-level props down to the real, mounted `CustomFieldOptions` — but it renders
 * `CustomFieldSettings` directly and never renders `SettingsTab`, so it cannot see a swap at
 * THIS boundary (`<CustomFieldSettings onOptionCreated={onOptionCreated} ... />` in
 * `SettingsTab.tsx`). Verified by mutation: swapping those two props there is type-clean,
 * lint-clean, and left every test in the suite — 1217 of them — green.
 */
describe('SettingsTab custom field options (SPRIN-92 task 9, fix round 1)', () => {
  const SELECT_FIELD = {
    id: 'f1',
    project_id: 'p1',
    slug: 'urgency',
    name: 'Priority tier',
    type: 'select',
    created_at: '2026-08-07T10:00:00Z',
  } as unknown as ProjectField

  const LOW_OPTION: ProjectFieldOption = {
    project_id: 'p1',
    field_id: 'f1',
    slug: 'low',
    label: 'Low',
    position: 1,
  }
  const HIGH_OPTION: ProjectFieldOption = {
    project_id: 'p1',
    field_id: 'f1',
    slug: 'high',
    label: 'High',
    position: 2,
  }

  beforeEach(() => {
    vi.mocked(ticketCountsByStatus).mockReset().mockResolvedValue(new Map())
    vi.mocked(createProjectFieldOption).mockReset()
    vi.mocked(renameProjectFieldOption).mockReset()
    vi.mocked(deleteProjectFieldOption).mockReset()
    vi.mocked(countTicketsHoldingOption).mockReset()
  })

  /**
   * The seam one level ABOVE the callbacks: `SettingsTab` reads TWO independent read phases off
   * the outlet context and must hand each to the prop it belongs to. Crossing them
   * (`optionsPhase={fieldsPhase}`) is type-clean — both are `ReadPhase` — lint-clean, and
   * survived the whole suite, because every other fixture in this file leaves both phases
   * `'loaded'` and nothing there can tell one from the other.
   *
   * So this test needs a state where the two DISAGREE, and only one such state is renderable:
   * fields loaded, options failed. The mirror (fields failed, options loaded) proves nothing —
   * `CustomFieldBody` short-circuits to `LoadFailure` before the options notice is reached.
   *
   * The equivalent cross in the OTHER direction (`phase={optionsPhase}`) is already caught, by
   * "shows a failed fields read as a failure" above: that test leaves `optionsPhase` loaded, so
   * the crossed `phase` would render the list instead of the failure.
   *
   * This is the sixth instance of the class this branch has now paid for, and the second time
   * the hole sat one level ABOVE where it had been closed — `CustomFieldSettings.test.tsx`
   * kills the identical cross between its own props, and could not see this one.
   */
  it('takes the options notice from optionsPhase, never from fieldsPhase', () => {
    renderTab({
      fields: [SELECT_FIELD],
      fieldsPhase: 'loaded',
      options: [],
      optionsPhase: 'failed',
    })

    expect(screen.getByRole('alert')).toHaveTextContent(/^Could not load field options\.$/)
    // The FIELD list is still on screen: a failed OPTIONS read is not a failed fields read.
    expect(screen.getByText('Priority tier')).toBeInTheDocument()
    // And the editor is withheld, so the failure cannot impersonate "no options yet".
    expect(screen.queryByRole('button', { name: 'Add option' })).not.toBeInTheDocument()
  })

  it('adds, renames and removes an option through the tab, and never crosses the callbacks', async () => {
    const u = userEvent.setup()
    const created: ProjectFieldOption = {
      project_id: 'p1',
      field_id: 'f1',
      slug: 'medium',
      label: 'Medium',
      position: 3,
    }
    const renamedLow: ProjectFieldOption = { ...LOW_OPTION, label: 'Very low' }
    vi.mocked(createProjectFieldOption).mockResolvedValue({ ok: true, value: created })
    vi.mocked(renameProjectFieldOption).mockResolvedValue({ ok: true, value: renamedLow })
    vi.mocked(countTicketsHoldingOption).mockResolvedValue(0)
    vi.mocked(deleteProjectFieldOption).mockResolvedValue({ ok: true, value: undefined })
    const onOptionCreated = vi.fn()
    const onOptionUpdated = vi.fn()
    const onOptionDeleted = vi.fn()
    renderTab({
      fields: [SELECT_FIELD],
      options: [LOW_OPTION, HIGH_OPTION],
      onOptionCreated,
      onOptionUpdated,
      onOptionDeleted,
    })
    const row = screen.getByText('Priority tier').closest('li')!

    // ADD
    await u.type(within(row).getByRole('textbox', { name: 'Option label' }), 'Medium')
    await u.click(within(row).getByRole('button', { name: 'Add option' }))
    await waitFor(() => expect(onOptionCreated).toHaveBeenCalledWith(created))
    expect(onOptionUpdated).not.toHaveBeenCalled()
    expect(onOptionDeleted).not.toHaveBeenCalled()

    // RENAME
    await u.click(within(row).getByRole('button', { name: /edit .*low/i }))
    const input = within(row).getByRole('textbox', { name: /low/i })
    await u.clear(input)
    await u.type(input, 'Very low{Enter}')
    await waitFor(() => expect(onOptionUpdated).toHaveBeenCalledWith(renamedLow))
    // The add above is the only create so far — a swap would have routed it through update too.
    expect(onOptionCreated).toHaveBeenCalledTimes(1)
    expect(onOptionDeleted).not.toHaveBeenCalled()

    // REMOVE
    await u.click(within(row).getByRole('button', { name: 'Remove High' }))
    const dialog = await screen.findByRole('alertdialog')
    await u.click(within(dialog).getByRole('button', { name: 'Remove option' }))
    await waitFor(() => expect(onOptionDeleted).toHaveBeenCalledWith('f1', HIGH_OPTION.slug))
    // Neither create nor update grew — a swap onto either would have.
    expect(onOptionCreated).toHaveBeenCalledTimes(1)
    expect(onOptionUpdated).toHaveBeenCalledTimes(1)
  })
})
