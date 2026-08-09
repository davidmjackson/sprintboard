import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CadenceSettings } from './CadenceSettings'
import type { Project, SprintCadence } from '@/lib/domain'
import { SPRINT_LENGTH_WEEKS, SPRINT_WEEKDAYS } from '@/lib/domain'
import { updateProjectCadence } from '@/lib/projects'

// Only the write is mocked; `createProject`/`listProjects` are not used here and everything
// this component reads out of `domain.ts` stays real, so the pickers are still built from the
// genuine constants rather than from a fixture that could drift from them.
vi.mock('@/lib/projects', async (orig) => ({
  ...(await orig<typeof import('@/lib/projects')>()),
  updateProjectCadence: vi.fn(),
}))

const mockUpdate = vi.mocked(updateProjectCadence)

/**
 * The cadence every test starts from. TWO confounds are deliberately broken here, and the
 * second was found by mutation rather than by reading — treat the list as open.
 *
 * 1. **It is not the column defaults (2, 1).** With those, "the form opened on the project's
 *    cadence" and "the form opened on a hardcoded 2/Monday" render identically.
 * 2. **The length is not the weekday.** This started as 3/3, and with the two equal, crossing
 *    the two `FormField` names — a type-clean, lint-clean swap — left "opens on the cadence it
 *    was given" green, because both pickers then showed 3. Saturday is 6, so the two values can
 *    no longer stand in for one another. (Three other tests killed that mutation anyway; the
 *    point is that the one test named for the behaviour could not.)
 */
const CADENCE: SprintCadence = { sprint_length_weeks: 3, sprint_start_weekday: 6 }

/** What a successful write returns: the DATABASE's row, not the form's submission. */
const SAVED = {
  id: 'p1',
  name: 'Sprintboard',
  key: 'SPB',
  project_type: 'scrum',
  sprint_length_weeks: 1,
  sprint_start_weekday: 5,
} as Project

function renderSettings(cadence: SprintCadence = CADENCE) {
  const onUpdated = vi.fn()
  render(<CadenceSettings projectId="p1" cadence={cadence} onUpdated={onUpdated} />)
  return { onUpdated }
}

const lengthPicker = () => screen.getByRole('combobox', { name: /sprint length/i })
const weekdayPicker = () => screen.getByRole('combobox', { name: /start day/i })

/** An option list read as the browser sees it: what each option SUBMITS, in render order. */
function optionValues(select: HTMLElement): string[] {
  return within(select)
    .getAllByRole('option')
    .map((option) => (option as HTMLOptionElement).value)
}

describe('CadenceSettings (SPRIN-94)', () => {
  beforeEach(() => {
    mockUpdate.mockReset()
  })

  it('states the cadence under its own heading', () => {
    renderSettings({ sprint_length_weeks: 2, sprint_start_weekday: 1 })

    // Scoped to the section, not a bare getByText: an unscoped query says the text exists
    // somewhere and nothing about where. SPRIN-65's points badge moved outside its button
    // and all twelve of its tests stayed green.
    const section = screen.getByRole('region', { name: /sprint cadence/i })
    expect(within(section).getByText('2 weeks, starting Monday')).toBeInTheDocument()
  })

  it('renders the cadence it is given, not a fixed default', () => {
    renderSettings({ sprint_length_weeks: 1, sprint_start_weekday: 4 })

    const section = screen.getByRole('region', { name: /sprint cadence/i })
    expect(within(section).getByText('1 week, starting Thursday')).toBeInTheDocument()
  })
})

/**
 * SPRIN-97: the section stops being read-only.
 *
 * The old third test — "says the cadence is not editable yet", asserting no button in the
 * section — is DELETED rather than adapted. Its whole claim was that this story had not
 * happened, and it is the last line of SPRIN-94 that this story is supposed to falsify.
 *
 * **Accessible names are queried by REGEX**, never exactly. Each picker's name comes from a
 * `<label>` this repo styles with Tailwind, and jsdom loads no stylesheet, so an exact string
 * here would be a name no browser computes.
 */
describe('CadenceSettings edits the cadence (SPRIN-97)', () => {
  beforeEach(() => {
    mockUpdate.mockReset()
  })

  /**
   * Both pickers, asserted against the SHARED CONSTANTS rather than a hand-typed list — a list
   * retyped here would agree with a component that had also stopped reading `domain.ts`.
   *
   * The assertion is on each option's VALUE (what it submits), which is what the write and the
   * `check` constraints actually see; the weekday's LABELS are asserted too, from the same
   * constant, because a weekday whose value is right and whose label is wrong is a picker that
   * lies. The length picker's labels are pluralised prose around the same numbers, so its
   * values carry the whole claim.
   */
  it('offers every sprint length from the shared constant', () => {
    renderSettings()

    expect(optionValues(lengthPicker())).toEqual(SPRINT_LENGTH_WEEKS.map(String))
  })

  it('offers every weekday from the shared constant, in ISO order, with its label', () => {
    renderSettings()

    const picker = weekdayPicker()
    expect(optionValues(picker)).toEqual(SPRINT_WEEKDAYS.map((day) => String(day.iso)))
    expect(
      within(picker)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(SPRINT_WEEKDAYS.map((day) => day.label))
  })

  // The form opens on the project's OWN cadence, not on the first option of each list and not
  // on the column defaults — see the fixture's note on why 3 weeks / Saturday, and on which
  // mutation the earlier 3/3 let through.
  it('opens on the cadence it was given', () => {
    renderSettings()

    expect(lengthPicker()).toHaveValue(String(CADENCE.sprint_length_weeks))
    expect(weekdayPicker()).toHaveValue(String(CADENCE.sprint_start_weekday))
  })

  /**
   * AC1/AC2. Two claims in one test because they are one behaviour: the chosen values reach the
   * write AS NUMBERS — a `<select>` submits strings and the columns are `int`, so `'1'` would be
   * a payload the database rejects — and the row the DATABASE returned is what goes up, not the
   * values the form submitted.
   *
   * `toHaveBeenCalledWith` is exact on primitives (`'1' !== 1`), so the coercion is genuinely
   * pinned here rather than incidentally satisfied — end to end, through the resolver. What it
   * does NOT pin is the `CadenceSchema.parse(values)` CALL: `zodResolver` already hands
   * `handleSubmit` the schema's output, so replacing that line with a cast leaves this green
   * (measured). See the line's own comment; the coercion rule itself lives in
   * `cadence-schemas.test.ts`.
   */
  it('writes the chosen cadence as numbers and hands the saved row up', async () => {
    const u = userEvent.setup()
    mockUpdate.mockResolvedValue({ ok: true, project: SAVED })
    const { onUpdated } = renderSettings()

    await u.selectOptions(lengthPicker(), '1')
    await u.selectOptions(weekdayPicker(), '5')
    await u.click(screen.getByRole('button', { name: 'Save cadence' }))

    // Barrier on the CALLBACK: the write is called strictly before it, so waiting on the write
    // would leave the assertion that matters outside the barrier.
    await waitFor(() => expect(onUpdated).toHaveBeenCalledWith(SAVED))
    expect(mockUpdate).toHaveBeenCalledTimes(1)
    expect(mockUpdate).toHaveBeenCalledWith('p1', {
      sprint_length_weeks: 1,
      sprint_start_weekday: 5,
    })
  })

  // The project id is the component's, not a value it invents — and it reaches the write.
  it('writes against the project it was given', async () => {
    const u = userEvent.setup()
    mockUpdate.mockResolvedValue({ ok: true, project: SAVED })
    const onUpdated = vi.fn()
    render(<CadenceSettings projectId="p-distinct" cadence={CADENCE} onUpdated={onUpdated} />)

    await u.click(screen.getByRole('button', { name: 'Save cadence' }))

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1))
    expect(mockUpdate.mock.calls[0]![0]).toBe('p-distinct')
  })

  /**
   * AC3, first half. A `42501` means the column grant is missing: permanent, fixed only by
   * running SQL, so the generic "try again" would invite a retry that fails identically
   * forever.
   *
   * Asserted three ways, because any one alone would pass on the collapsed branch: the copy
   * names a permissions problem, it is explicitly NOT the generic sentence, and — the half AC3
   * is actually about — nothing was handed up and the summary still states the OLD cadence.
   */
  it('names a permissions problem when the write is forbidden, and changes nothing', async () => {
    const u = userEvent.setup()
    mockUpdate.mockResolvedValue({ ok: false, error: 'forbidden' })
    const { onUpdated } = renderSettings()

    await u.selectOptions(lengthPicker(), '1')
    await u.click(screen.getByRole('button', { name: 'Save cadence' }))

    const alert = await screen.findByRole('alert')
    // Anchored rather than a /permission/i fragment: an additive reword has slipped past a
    // fragment in this repo before.
    expect(alert).toHaveTextContent(
      /^You do not have permission to change this project’s sprint cadence — retrying will not help\.$/,
    )
    expect(alert).not.toHaveTextContent(/^Something went wrong/)
    expect(onUpdated).not.toHaveBeenCalled()
    const section = screen.getByRole('region', { name: /sprint cadence/i })
    expect(within(section).getByText('3 weeks, starting Saturday')).toBeInTheDocument()
  })

  // AC3, second half: everything that is not a missing grant is a failure the user cannot
  // diagnose, so it takes the shared generic copy — and, identically, changes nothing.
  it('shows the generic retry copy for any other failure, and changes nothing', async () => {
    const u = userEvent.setup()
    mockUpdate.mockResolvedValue({ ok: false, error: 'unknown' })
    const { onUpdated } = renderSettings()

    await u.selectOptions(weekdayPicker(), '6')
    await u.click(screen.getByRole('button', { name: 'Save cadence' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/^Something went wrong\. Please try again\.$/)
    expect(alert).not.toHaveTextContent(/permission/i)
    expect(onUpdated).not.toHaveBeenCalled()
    const section = screen.getByRole('region', { name: /sprint cadence/i })
    expect(within(section).getByText('3 weeks, starting Saturday')).toBeInTheDocument()
  })

  /**
   * The comment SPRIN-94 argued for, pinned as behaviour rather than left to a code comment a
   * refactor can lift out. The pre-fill is SPRIN-96; until it lands, copy on this surface
   * promising that a saved cadence drives anything is a false claim a user can read.
   *
   * Paired with a role-based check that the section IS exposed, so this cannot pass on a
   * section that failed to render at all.
   */
  it('promises nothing about what the cadence is used for', () => {
    renderSettings()

    const section = screen.getByRole('region', { name: /sprint cadence/i })
    expect(within(section).getByRole('button', { name: 'Save cadence' })).toBeInTheDocument()
    expect(section.textContent).not.toMatch(/suggest|pre-?fill|next sprint|new sprints/i)
  })
})
