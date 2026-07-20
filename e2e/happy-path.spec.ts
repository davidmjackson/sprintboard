import { test, expect, type Locator, type Page } from '@playwright/test'
import { deleteAuthUser } from './support/admin'

/**
 * S8.1 — the end-to-end happy path, in a real browser against the live Supabase
 * project. One user's whole journey, exactly as they'd click it:
 *
 *   sign up → create project → create ticket → add ticket to a sprint →
 *   start the sprint → drag the ticket to Done → complete the sprint.
 *
 * This is the only test that exercises the native HTML5 drag-and-drop for real —
 * jsdom has no `dataTransfer` and cannot fire a genuine drag, so every board test
 * under Vitest can only assert the wiring, never the gesture. Here the gesture is
 * real.
 *
 * Isolation: each run signs up a fresh, unique user, so it never collides with
 * another run or with the shared RLS test users. Teardown deletes that user, which
 * cascades away the project, sprint and tickets created beneath it.
 */

// The app needs the public config to reach Supabase; teardown needs the admin key
// to delete the throwaway user. Missing any of these means we cannot run — skip
// loudly in local dev, but the CI job supplies them, so there it will actually run.
const HAS_ENV = Boolean(
  process.env.VITE_SUPABASE_URL &&
  process.env.VITE_SUPABASE_ANON_KEY &&
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

// Mirror the integration suites' "refuse to skip in CI" rule (src/test/supabase-clients
// requireOrExplain): locally a missing env skips loudly, but in CI a dropped variable
// must go red, not silently green — a vanished check is the exact false-safety CLAUDE.md
// warns about ("the check that ran was not the check that was claimed").
if (process.env.CI && !HAS_ENV) {
  throw new Error(
    'E2E cannot run in CI: missing VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY or ' +
      'SUPABASE_SERVICE_ROLE_KEY. Refusing to skip in CI.',
  )
}

test.describe('S8.1 end-to-end happy path', () => {
  test.skip(
    !HAS_ENV,
    'Missing Supabase env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY and ' +
      'SUPABASE_SERVICE_ROLE_KEY (see .env.example).',
  )

  // Every user signed up across attempts. Retries (CI runs one) execute the test body
  // again but afterAll runs ONCE, after the final attempt — so a single mutable id
  // would let a failed-then-retried run strand its first attempt's user in the shared
  // database. Accumulate all ids and delete every one.
  const createdUserIds: string[] = []

  test.afterAll(async () => {
    for (const id of createdUserIds) await deleteAuthUser(id)
  })

  test('signup → project → ticket → sprint → start → drag to Done → complete', async ({ page }) => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const email = `e2e-${stamp}@example.com`
    const password = 'e2e-Password-123!'
    const ticketSummary = `E2E ticket ${stamp}`
    const sprintName = `E2E sprint ${stamp}`

    // 1. Sign up. Email confirmation is off on this project, so signup yields a
    //    session immediately and the app navigates to the authed home.
    await page.goto('/signup')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Create account' }).click()

    // Capture the new user's id ASAP. The session lands in localStorage right after
    // signup; capturing it BEFORE any later assertion means a mid-test flake can't
    // strand the account — every captured id is deleted in afterAll.
    await page.waitForFunction(() =>
      Object.keys(window.localStorage).some((k) => /^sb-.*-auth-token$/.test(k)),
    )
    const userId = await readSupabaseUserId(page)
    expect(userId, 'expected a Supabase session after signup').toBeTruthy()
    if (userId) createdUserIds.push(userId)

    // Signup lands on the authed home; the sidebar "New project" affordance confirms it.
    const newProject = page.getByRole('button', { name: 'New project' })
    await expect(newProject).toBeVisible()

    // 2. Create a project. Key is auto-derived from the name; set it explicitly to a
    //    valid 2–4 char key. It is unique per owner, and this owner is brand new.
    await newProject.click()
    const projectDialog = page.getByRole('dialog', { name: 'Create a project' })
    await projectDialog.getByLabel('Name').fill('E2E happy path')
    await projectDialog.getByLabel('Key').fill('E2E')
    await projectDialog.getByRole('button', { name: 'Create project' }).click()

    // Landed on the project's board; capture its id to navigate by URL thereafter.
    await page.waitForURL(/\/projects\/[0-9a-f-]+/)
    const projectId = page.url().match(/\/projects\/([0-9a-f-]+)/)![1]

    // 3. Create a ticket. It defaults to To Do and lands in the backlog (no sprint).
    await page.getByRole('button', { name: 'New ticket' }).click()
    const ticketDialog = page.getByRole('dialog', { name: 'Create a ticket' })
    await ticketDialog.getByLabel('Summary').fill(ticketSummary)
    await ticketDialog.getByRole('button', { name: 'Create ticket' }).click()
    await expect(ticketDialog).toBeHidden()

    // 4a. Create a sprint (status: future).
    await page.goto(`/projects/${projectId}/sprints`)
    await page.getByRole('button', { name: 'New sprint' }).click()
    const sprintDialog = page.getByRole('dialog', { name: 'Create a sprint' })
    await sprintDialog.getByLabel('Name').fill(sprintName)
    await sprintDialog.getByRole('button', { name: 'Create sprint' }).click()
    await expect(sprintDialog).toBeHidden()

    // 4b. Add the ticket to that sprint from its detail dialog. The sprint <select>
    //     is Backlog (index 0) then each sprint; there is exactly one, at index 1.
    //     Changing it commits immediately — no save button.
    await page.goto(`/projects/${projectId}/backlog`)
    await page.getByRole('button', { name: new RegExp(escapeRegExp(ticketSummary)) }).click()
    const detailDialog = page.getByRole('dialog')
    // The select commits optimistically then PATCHes tickets. Wait for that write to
    // land before navigating away — a navigation cancels the in-flight request, and
    // the ticket would silently stay in the backlog.
    const [assignResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/rest/v1/tickets') && r.request().method() === 'PATCH',
      ),
      detailDialog.getByLabel('sprint').selectOption({ index: 1 }),
    ])
    expect(assignResponse.ok()).toBeTruthy()
    await page.keyboard.press('Escape')
    await expect(detailDialog).toBeHidden()

    // 5. Start the sprint. Its row gains an "Active" badge and a "Complete" button.
    await page.goto(`/projects/${projectId}/sprints`)
    const sprintRow = page.getByRole('listitem').filter({ hasText: sprintName })
    await sprintRow.getByRole('button', { name: 'Start' }).click()
    await expect(sprintRow.getByRole('button', { name: 'Complete' })).toBeVisible()

    // 6. On the board (which shows only the active sprint's tickets), drag the card
    //    to Done. This is the real gesture the jsdom suite cannot perform.
    await page.goto(`/projects/${projectId}/board`)
    const card = page.getByRole('button', { name: new RegExp(escapeRegExp(ticketSummary)) })
    await expect(card).toBeVisible()
    const doneColumn = page.locator('section', {
      has: page.getByRole('heading', { name: 'Done' }),
    })
    // The move is optimistic then persisted. Wait for the PATCH so we assert the real
    // write, not just the optimistic paint — otherwise a failed drag-write would slip
    // past (the card shows in Done for a beat before reverting).
    const [moveResponse] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/rest/v1/tickets') && r.request().method() === 'PATCH',
      ),
      dragCardToColumn(page, card, doneColumn),
    ])
    expect(moveResponse.ok()).toBeTruthy()

    // The card now lives under Done, and no move-failure alert appeared.
    await expect(
      doneColumn.getByRole('button', { name: new RegExp(escapeRegExp(ticketSummary)) }),
    ).toBeVisible()
    await expect(page.getByRole('alert')).toHaveCount(0)

    // 7. Complete the sprint. The Complete button unmounts and the row's status badge
    //    flips from Active to Complete. Assert the button is gone FIRST: that is the
    //    load-bearing check (a no-op complete leaves the button visible) AND it
    //    disambiguates the badge below from the button, which also renders "Complete".
    await page.goto(`/projects/${projectId}/sprints`)
    await sprintRow.getByRole('button', { name: 'Complete' }).click()
    await expect(sprintRow.getByRole('button', { name: 'Complete' })).toBeHidden()
    await expect(sprintRow.getByText('Active', { exact: true })).toBeHidden()
    await expect(sprintRow.getByText('Complete', { exact: true })).toBeVisible()
  })
})

/** Read the authenticated user's id from the persisted Supabase session. */
async function readSupabaseUserId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (/^sb-.*-auth-token$/.test(key)) {
        const raw = window.localStorage.getItem(key)
        if (!raw) continue
        const parsed = JSON.parse(raw)
        return parsed?.user?.id ?? parsed?.currentSession?.user?.id ?? null
      }
    }
    return null
  })
}

/**
 * Drive the app's native HTML5 drag-and-drop. Playwright's mouse-based dragTo() does
 * not reliably fire the browser's drag events, so dispatch them directly. The board's
 * drop handler reads the dragged ticket from React state set in onDragStart (nothing
 * reads dataTransfer back), so firing dragstart on the card before drop on the column
 * is what makes the move happen; a shared DataTransfer keeps the events well-formed.
 */
async function dragCardToColumn(page: Page, card: Locator, column: Locator): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  await card.dispatchEvent('dragstart', { dataTransfer })
  await column.dispatchEvent('dragover', { dataTransfer })
  await column.dispatchEvent('drop', { dataTransfer })
  await card.dispatchEvent('dragend', { dataTransfer })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
