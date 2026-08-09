# SPRIN-93 — Delete a custom field, with its value count — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A project owner can delete a custom field from the Settings tab, behind a confirm that first tells them how many tickets hold a value for it.

**Architecture:** One grants-only migration (DELETE on `project_fields`, restating the whole grant state), two functions in the existing `src/lib/project-fields.ts`, one new component file `src/routes/CustomFieldDelete.tsx`, and a reducer in `ProjectShell` that patches two of the shell's lists because the database cascade removes rows from two tables. Every cascade this story relies on already exists — nothing schema-shaped is created.

**Tech Stack:** React 19, TypeScript strict (`noUncheckedIndexedAccess` ON), Vitest + Testing Library, Supabase JS, Tailwind, shadcn/ui.

Spec: `docs/superpowers/specs/2026-08-09-sprin-93-delete-custom-field-design.md`. Read it first.

## Global Constraints

Every task's requirements implicitly include all of this. **Violating any of it reddens the gate.**

- **Verify with `npm run verify`. Never a hand-assembled subset.** `npx tsc --noEmit -p tsconfig.json` checks **ZERO files and exits 0** on this repo — the root config is `"files": []` plus project references. Use `npm run typecheck`. For a fast loop, `npm run test:unit`.
- **The seven `*.integration.test.ts` suites CANNOT run in this environment.** `VITE_SUPABASE_URL` is a placeholder, so they fail with `ENOTFOUND` rather than skipping. Write live assertions carefully; you will not see them pass. Do not "fix" them by weakening anything.
- **Do not run `npm test`** (it tries the live suites). Use `npm run test:unit`.
- **Lint thresholds are errors, not warnings:** 30-line functions, cyclomatic 10, cognitive 15, 4 parameters, 400-line files. `npm run lint`. No inline disables — a genuine misfit is an ADR.
- **`ProjectShell` is at cyclomatic 10 of 10.** A `const` arrow reducer costs it zero; a conditional written inline in its body costs it one and reddens the gate. **Re-measure after editing:** `npx eslint src/routes/ProjectShell.tsx --rule '{"complexity":["error",1]}'`.
- **`CustomFieldSettings.tsx` counts 331 lines of its 400 budget.** Measure with `npx eslint <file> --rule '{"max-lines":["error",{"max":1,"skipBlankLines":true,"skipComments":true}]}'`.
- **Never inline a status/type vocabulary.** It lives in `src/lib/domain.ts` and nowhere else.
- **Never use a Postgres `ENUM`.** Not relevant to this story's SQL, but it is the single most damaging change anyone could make to this schema.
- **`git commit -F <file>`, never a heredoc** — a global guard hook rejects heredoc commit messages.
- **Imperative commit summaries.** Co-author trailer: `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
- **Props in the `onFieldDeleted` chain are REQUIRED — no default values anywhere.** An unplugged wire must be a `TS2741` compile error. A default parameter also costs a cyclomatic point here.
- **Assert DOM text AND the container it sits in** (`within(row)`), never a bare unscoped `getByText`. Never assert an *exact* accessible name for an element whose name is composed from several children — use a substring/regex name query.
- **`toHaveClass` is a subset check** and `toHaveTextContent` with a bare string is a substring match. Both have passed here while the thing under test was broken.
- **`queryByRole` excludes `aria-hidden` subtrees**, so an absence test can report "absent" for a control still in the DOM. Pair it with a raw DOM query.
- **Every absence assertion carries a positive control in the same test.**
- **Do not let a fixture's `slug` be its `name`/`label` lowercased.** SPRIN-87 cost three tests to that confound: it makes a read of `.slug` indistinguishable from a read of `.name`.

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/migrations/sprin-93-project-fields-delete.sql` | **Already written.** Grants only: restates the whole `project_fields` grant state and adds table-wide DELETE. |
| `docs/sprintboard_phase1_schema.sql` | Its `project_fields` grant block is stale (missing SPRIN-91's INSERT). Corrected to equal the migration. |
| `src/lib/project-fields.ts` | Gains `deleteProjectField` and `countTicketsHoldingField`. |
| `src/lib/project-fields.test.ts` | Their unit tests. |
| `src/routes/CustomFieldDelete.tsx` | **New.** The Remove trigger, the count-gated confirm dialog. One export: `CustomFieldDeleteControl`. |
| `src/routes/CustomFieldDelete.test.tsx` | **New.** Its tests. |
| `src/routes/CustomFieldSettings.tsx` | `CustomFieldRow` renders the control; `onFieldDeleted` threads through three components. |
| `src/routes/ProjectShell.tsx` | The `onFieldDeleted` reducer (patches fields **and** options), the context type, the Outlet value. |
| `src/routes/SettingsTab.tsx` | Reads `onFieldDeleted` off the context and passes it down. |
| `src/test/rls.integration.test.ts` | The tripwire is replaced by the delete proof; two stale comments corrected. |

---

## Task 1: The migration file and the schema doc it exposed

**Files:**
- Create: `docs/migrations/sprin-93-project-fields-delete.sql` — **already written, do not rewrite it**
- Modify: `docs/sprintboard_phase1_schema.sql:1120-1137`

**Interfaces:**
- Consumes: nothing.
- Produces: the DELETE privilege every later task's live test depends on.

**Context:** `docs/sprintboard_phase1_schema.sql`'s `project_fields` grant block reads:

```sql
revoke insert, update, delete on project_fields from authenticated, anon;
grant  update (name) on project_fields to authenticated;
```

SPRIN-91's `grant insert (project_id, slug, name, type)` was never added. A rebuild from that file yields a table `authenticated` cannot insert into at all. **A guard hook forbids `ALTER TABLE` in the schema doc** — this edit is `grant`/`revoke` statements only, which is what the surrounding block already is.

- [ ] **Step 1: Correct the schema doc's grant block**

Replace the two statements at `docs/sprintboard_phase1_schema.sql:1136-1137` with the migration's full four-statement state, and update the prose above them (which currently says "stories 2 and 6 grant them" in the future tense, and "UPDATE(name) alone is granted", both now false):

```sql
revoke insert, update, delete on project_fields from authenticated, anon;
grant insert (project_id, slug, name, type) on project_fields to authenticated;
grant update (name) on project_fields to authenticated;

-- Table-wide, because Postgres has no column-level DELETE — so fields_owner_delete is the ONLY
-- thing in front of it, which is why rls.integration.test.ts asserts a stranger's delete removes
-- ZERO ROWS rather than only that the owner's own delete works. Its blast radius is the largest
-- of the three tables holding one: this delete cascades into ticket data through tfv_field_fk AND
-- into option data through pfo_field_fk.
grant delete on project_fields to authenticated;
```

Keep the existing paragraphs about `pg_default_acl` and the REVOKE cascade — they are still true and still load-bearing. Correct only the sentences that describe the *current* grant set.

- [ ] **Step 2: Verify no ALTER TABLE was introduced**

Run: `git diff docs/sprintboard_phase1_schema.sql | grep -i "alter table"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add docs/migrations/sprin-93-project-fields-delete.sql docs/sprintboard_phase1_schema.sql
git commit -F .git/COMMIT_MSG_SPRIN93_1
```

Message: `Add the SPRIN-93 DELETE grant and correct the project_fields grant block`

---

## Task 2: `deleteProjectField` and `countTicketsHoldingField`

**Files:**
- Modify: `src/lib/project-fields.ts` (append; `writeError`, `FieldWriteResult` and `FIELD_COLUMNS` already exist there)
- Test: `src/lib/project-fields.test.ts`

**Interfaces:**
- Consumes: `FieldWriteResult<T>`, `writeError` — both already in `project-fields.ts`.
- Produces:
  - `deleteProjectField(id: string): Promise<FieldWriteResult<void>>`
  - `countTicketsHoldingField(fieldId: string): Promise<number>`

**Context:** Mirror `deleteProjectFieldOption` and `countTicketsHoldingOption` in `src/lib/project-field-options.ts:191-225`. Read them first. The existing test file mocks `@/lib/supabase` with `vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn() } }))` and gives **each chain its own link functions** — a shared `select` mock cannot say which call it saw, because `.select()` returns `{ eq }` starting a read and `{ single }` terminating a write.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/project-fields.test.ts`. Give the delete chain and the count chain their own mocks:

```ts
describe('deleteProjectField', () => {
  const delSelect = vi.fn()
  const delEq = vi.fn(() => ({ select: delSelect }))
  const del = vi.fn(() => ({ eq: delEq }))

  beforeEach(() => {
    vi.mocked(supabase.from).mockReturnValue({ delete: del } as never)
  })

  it('filters on the field id and asks for the deleted rows back', async () => {
    delSelect.mockResolvedValue({ data: [{ id: 'f1' }], error: null })
    await deleteProjectField('f1')
    expect(supabase.from).toHaveBeenCalledWith('project_fields')
    expect(delEq).toHaveBeenCalledWith('id', 'f1')
    // The returned rows are what makes the zero-row check possible at all.
    expect(delSelect).toHaveBeenCalledWith('id')
  })

  it('reports a zero-row delete as stale rather than as success', async () => {
    // RLS FILTERS a delete rather than raising on it, so another tenant's row (or one another
    // tab already removed) comes back as `error: null` with NO rows. Without the explicit
    // count this resolves `{ ok: true }` and the UI removes a row the database still holds.
    delSelect.mockResolvedValue({ data: [], error: null })
    await expect(deleteProjectField('f1')).resolves.toEqual({ ok: false, error: 'stale' })
  })

  it('reports a query failure as unknown', async () => {
    delSelect.mockResolvedValue({ data: null, error: { code: '42501', message: 'denied' } })
    await expect(deleteProjectField('f1')).resolves.toEqual({ ok: false, error: 'unknown' })
  })

  it('resolves ok when exactly one row was removed', async () => {
    delSelect.mockResolvedValue({ data: [{ id: 'f1' }], error: null })
    await expect(deleteProjectField('f1')).resolves.toEqual({ ok: true, value: undefined })
  })
})

describe('countTicketsHoldingField', () => {
  const countEq = vi.fn()
  const countSelect = vi.fn(() => ({ eq: countEq }))

  beforeEach(() => {
    vi.mocked(supabase.from).mockReturnValue({ select: countSelect } as never)
  })

  it('counts value rows for the field without fetching them', async () => {
    countEq.mockResolvedValue({ count: 3, error: null })
    await expect(countTicketsHoldingField('f1')).resolves.toBe(3)
    expect(supabase.from).toHaveBeenCalledWith('ticket_field_values')
    // `head: true` is what keeps this a COUNT rather than a full read of every value row.
    expect(countSelect).toHaveBeenCalledWith('*', { head: true, count: 'exact' })
    expect(countEq).toHaveBeenCalledWith('field_id', 'f1')
  })

  it('THROWS on a failed read rather than resolving to zero', async () => {
    // AC4. Zero is the value that UNLOCKS the destructive action, so a failed count reported as
    // zero offers a delete whose blast radius the user was told was nil.
    countEq.mockResolvedValue({ count: null, error: { message: 'boom' } })
    await expect(countTicketsHoldingField('f1')).rejects.toThrow(
      'Could not count tickets holding that field: boom',
    )
  })

  it('THROWS on a MISSING count, which is not the same as a failed read', async () => {
    // PostgREST can answer without a count header. `count: null` with `error: null` would
    // otherwise flow into the component as a number and land as `0`.
    countEq.mockResolvedValue({ count: null, error: null })
    await expect(countTicketsHoldingField('f1')).rejects.toThrow(
      'Could not count tickets holding that field: no count',
    )
  })
})
```

Add `deleteProjectField, countTicketsHoldingField` to the existing import from `./project-fields`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/project-fields.test.ts`
Expected: FAIL — `deleteProjectField is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/project-fields.ts`:

```ts
/**
 * Delete a custom field definition (AC1, AC3). Its value rows go with it via `tfv_field_fk` and
 * `tfv_type_fk`, and a `select` field's option rows via `pfo_field_fk` — all three cascades were
 * built by stories 3 and 5, so this function creates no schema behaviour of its own.
 *
 * Cascading rather than refusing is the AC: there is no in-app way to bulk-clear values, so a
 * field that ever held one would otherwise be permanently undeletable.
 *
 * The affected row count is checked EXPLICITLY, like `deleteProjectFieldOption` and
 * `deleteProjectStatus`, rather than leaning on `.single()`'s incidental zero-row error. RLS
 * FILTERS a delete rather than raising on it, so a cross-tenant or already-deleted row comes back
 * as a successful ZERO-row delete unless something counts. Stating it makes the guard survive
 * anyone swapping the terminator — a one-word change with nothing else to notice.
 */
export async function deleteProjectField(id: string): Promise<FieldWriteResult<void>> {
  const { data, error } = await supabase.from('project_fields').delete().eq('id', id).select('id')

  if (error) return { ok: false, error: writeError(error) }
  if ((data ?? []).length !== 1) return { ok: false, error: 'stale' }
  return { ok: true, value: undefined }
}

/**
 * How many tickets hold a value for this field (AC2 — shown BEFORE the user commits).
 *
 * THROWS rather than resolving to zero on a failed read, and treats a MISSING count the same way,
 * for the reason AC4 states outright: **zero is what UNLOCKS the destructive action**, so a
 * failed count reported as zero would offer a delete whose blast radius the user was told was
 * nil. Same rule as `ticketCountsByStatus` and `countTicketsHoldingOption`.
 *
 * No `distinct` and no join: `ticket_field_values_pkey` is `(ticket_id, field_id)`, so there is
 * exactly one row per ticket per field and a row count for a `field_id` IS the ticket count.
 */
export async function countTicketsHoldingField(fieldId: string): Promise<number> {
  const { count, error } = await supabase
    .from('ticket_field_values')
    .select('*', { head: true, count: 'exact' })
    .eq('field_id', fieldId)

  if (error) throw new Error(`Could not count tickets holding that field: ${error.message}`)
  if (count === null) throw new Error('Could not count tickets holding that field: no count')
  return count
}
```

- [ ] **Step 4: Run to verify they pass, then lint and typecheck**

```bash
npx vitest run src/lib/project-fields.test.ts
npm run lint && npm run typecheck
```

- [ ] **Step 5: Prove the zero-row guard is not vacuous**

Change `if ((data ?? []).length !== 1)` to `if (false)`. Run the test file. **Expected: the "reports a zero-row delete as stale" test FAILS.** Restore the line. If it stayed green, the test is not pinning the guard — report BLOCKED rather than continuing.

- [ ] **Step 6: Commit**

`git add src/lib/project-fields.ts src/lib/project-fields.test.ts && git commit -F <file>`
Message: `Add deleteProjectField and countTicketsHoldingField`

---

## Task 3: The delete control and its count-gated confirm

**Files:**
- Create: `src/routes/CustomFieldDelete.tsx`
- Test: `src/routes/CustomFieldDelete.test.tsx`

**Interfaces:**
- Consumes: `deleteProjectField`, `countTicketsHoldingField` (Task 2); `ProjectField` from `@/lib/domain`; `GENERIC_CREATE_ERROR` from `./CreateDialog`.
- Produces: `CustomFieldDeleteControl({ field, onDeleted }: { field: ProjectField; onDeleted: (id: string) => void })`

**Context:** This is a near-transcription of `OptionDeleteDialog` + `OptionDeleteControl` in `src/routes/CustomFieldOptions.tsx:168-321`. **Read that region before writing anything.** It lives in a new file because `CustomFieldSettings.tsx` has only 69 counted lines of headroom and this is ~95.

- [ ] **Step 1: Write the failing tests**

Create `src/routes/CustomFieldDelete.test.tsx`. Mock only the two network-touching functions, spreading the real module:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { CustomFieldDeleteControl } from './CustomFieldDelete'
import type { ProjectField } from '@/lib/domain'
import { countTicketsHoldingField, deleteProjectField } from '@/lib/project-fields'

// An unmocked write here would reach the LIVE database silently — `VITE_SUPABASE_URL` is a
// placeholder in this environment and the rejection is handled, so nothing would say so.
vi.mock('@/lib/project-fields', async (orig) => ({
  ...(await orig<typeof import('@/lib/project-fields')>()),
  countTicketsHoldingField: vi.fn(),
  deleteProjectField: vi.fn(),
}))

const mockCount = vi.mocked(countTicketsHoldingField)
const mockDelete = vi.mocked(deleteProjectField)

// The slug is NOT the name lowercased, deliberately: `ship_by`/`Ship by` would make a read of
// `.slug` indistinguishable from a read of `.name` (SPRIN-87 cost three tests to that confound).
const FIELD: ProjectField = {
  id: 'f1',
  project_id: 'p1',
  slug: 'target_date',
  name: 'Ship by',
  type: 'date',
  created_at: '2026-08-01T00:00:00+00:00',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCount.mockResolvedValue(0)
  mockDelete.mockResolvedValue({ ok: true, value: undefined })
})

function renderControl(onDeleted = vi.fn()) {
  render(<CustomFieldDeleteControl field={FIELD} onDeleted={onDeleted} />)
  return onDeleted
}

const remove = () => screen.getByRole('button', { name: 'Remove Ship by' })
const confirm = () => screen.getByRole('button', { name: 'Remove field' })

describe('CustomFieldDeleteControl', () => {
  it('does not read the count until the confirm is opened', () => {
    renderControl()
    // A project with many fields must not fire one count query per field per paint.
    expect(mockCount).not.toHaveBeenCalled()
    // Positive control: the trigger really did render, so the absence above means something.
    expect(remove()).toBeInTheDocument()
  })

  it('shows how many tickets hold a value before committing', async () => {
    mockCount.mockResolvedValue(4)
    renderControl()
    await userEvent.click(remove())
    expect(mockCount).toHaveBeenCalledWith('f1')
    expect(await screen.findByText(/4 tickets will lose this value/)).toBeInTheDocument()
  })

  it('says "1 ticket", not "1 tickets", when exactly one holds a value', async () => {
    mockCount.mockResolvedValue(1)
    renderControl()
    await userEvent.click(remove())
    expect(await screen.findByText(/1 ticket will lose this value/)).toBeInTheDocument()
  })

  it('BLOCKS the delete when the count could not be read', async () => {
    mockCount.mockRejectedValue(new Error('boom'))
    renderControl()
    await userEvent.click(remove())
    // The alert AND the disabled button — the button alone cannot tell a failed count from a
    // count of zero, and AC4 is precisely that those are different states.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not check how many tickets hold this field',
    )
    expect(confirm()).toBeDisabled()
    expect(mockDelete).not.toHaveBeenCalled()
  })

  it('deletes a field no ticket uses, and hands the removal up', async () => {
    mockCount.mockResolvedValue(0)
    const onDeleted = renderControl()
    await userEvent.click(remove())
    await waitFor(() => expect(confirm()).toBeEnabled())
    await userEvent.click(confirm())
    expect(mockDelete).toHaveBeenCalledWith('f1')
    // The ID, not the field object — this is what ProjectShell's reducer filters on.
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('f1'))
  })

  it('explains a stale refusal in its own words, and hands nothing up', async () => {
    mockDelete.mockResolvedValue({ ok: false, error: 'stale' })
    const onDeleted = renderControl()
    await userEvent.click(remove())
    await waitFor(() => expect(confirm()).toBeEnabled())
    await userEvent.click(confirm())
    expect(await screen.findByRole('alert')).toHaveTextContent('This field no longer exists')
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('shows generic retry copy for a refusal the user cannot correct', async () => {
    mockDelete.mockResolvedValue({ ok: false, error: 'unknown' })
    const onDeleted = renderControl()
    await userEvent.click(remove())
    await waitFor(() => expect(confirm()).toBeEnabled())
    await userEvent.click(confirm())
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong')
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it('re-reads the count on a second open rather than flashing the first one', async () => {
    // The component stays mounted while the dialog is closed, so without a reset on the way OUT
    // a stale count renders as already-known ahead of the fresh fetch.
    mockCount.mockResolvedValue(2)
    renderControl()
    await userEvent.click(remove())
    expect(await screen.findByText(/2 tickets will lose this value/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    let resolve: (n: number) => void = () => {}
    mockCount.mockReturnValue(new Promise<number>((r) => (resolve = r)))
    await userEvent.click(remove())
    expect(screen.queryByText(/2 tickets will lose this value/)).not.toBeInTheDocument()
    expect(confirm()).toBeDisabled()
    resolve(7)
    expect(await screen.findByText(/7 tickets will lose this value/)).toBeInTheDocument()
  })
})
```

Confirm the exact text of `GENERIC_CREATE_ERROR` in `src/routes/CreateDialog.tsx` before relying on `'Something went wrong'`; if it differs, use the real string.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/routes/CustomFieldDelete.test.tsx`
Expected: FAIL — cannot resolve `./CustomFieldDelete`.

- [ ] **Step 3: Implement `src/routes/CustomFieldDelete.tsx`**

```tsx
import { useEffect, useState } from 'react'

import type { ProjectField } from '@/lib/domain'
import { countTicketsHoldingField, deleteProjectField } from '@/lib/project-fields'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { GENERIC_CREATE_ERROR } from './CreateDialog'

/** The `error` tag `deleteProjectField` can resolve with, read off its own return type rather
 *  than re-declared here — `FieldWriteError` is a private alias in `project-fields.ts`, and
 *  duplicating its literal union would drift the moment a tag is added there. Mirrors
 *  `CustomFieldOptions`'s `DeleteOptionError`. */
type DeleteFieldError = Extract<Awaited<ReturnType<typeof deleteProjectField>>, { ok: false }>['error']

/**
 * What each refusal means in words, keyed by tag rather than collapsed to one generic sentence.
 *
 * `'stale'` IS reachable: `deleteProjectField` returns it on its explicit zero-row check, and a
 * zero-row delete is a real production outcome — another tab already deleted this field. Retrying
 * reproduces it forever; only reloading shows the current list. Telling that user to "try again"
 * would be telling them to repeat an action that fails identically every time.
 */
const DELETE_FAILURE_COPY: Record<DeleteFieldError, string> = {
  stale: 'This field no longer exists — refresh the page to see the current list.',
  unknown: GENERIC_CREATE_ERROR,
}

/**
 * How many tickets hold a value for this field, at the point the confirm dialog owns it.
 *
 * THREE shapes, not `number | null`. `null` would make "the read failed" and "zero tickets hold a
 * value" the same value, and zero is exactly what UNLOCKS this destructive action: a failed read
 * must never be able to impersonate it (AC4).
 */
type FieldCountState = 'counting' | { count: number } | 'failed'

/**
 * The destructive confirm for deleting one custom field. Mirrors `OptionDeleteDialog`'s shape.
 *
 * The count is read HERE, lazily, on the `open` transition — never on render. A project with many
 * fields must not fire one count query per field per paint; only the field whose confirm the user
 * actually opened is ever counted.
 */
function FieldDeleteDialog({
  field,
  open,
  onOpenChange,
  onDeleted,
}: {
  field: ProjectField
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: (id: string) => void
}) {
  const [count, setCount] = useState<FieldCountState>('counting')
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    countTicketsHoldingField(field.id)
      .then((value) => {
        if (!cancelled) setCount({ count: value })
      })
      .catch(() => {
        if (!cancelled) setCount('failed')
      })
    return () => {
      cancelled = true
    }
  }, [open, field.id])

  async function submit() {
    setDeleting(true)
    setError(null)
    const result = await deleteProjectField(field.id)
    setDeleting(false)
    if (!result.ok) {
      setError(DELETE_FAILURE_COPY[result.error])
      return
    }
    onDeleted(field.id)
  }

  // The ONLY thing that unlocks the confirm button. An unknown count must never impersonate zero.
  const known = typeof count === 'object'

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (deleting) return
        setError(null)
        // Reset on the way OUT: this component stays mounted while the dialog is closed, so
        // without this a stale count from the LAST open flashes as already-known on the next one,
        // ahead of the fresh fetch the effect starts.
        if (!next) setCount('counting')
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {field.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {known
              ? `${count.count} ${count.count === 1 ? 'ticket' : 'tickets'} will lose this value. This can’t be undone.`
              : 'This can’t be undone.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {count === 'failed' ? (
          <p role="alert" className="text-destructive text-sm">
            Could not check how many tickets hold this field. Try again.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Button variant="outline" disabled={deleting}>
              Cancel
            </Button>
          </AlertDialogCancel>
          <Button variant="destructive" onClick={() => void submit()} disabled={deleting || !known}>
            {deleting ? 'Removing…' : 'Remove field'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * The Remove trigger plus the confirm above. Split so `CustomFieldRow` stays under its budget,
 * mirroring `OptionDeleteControl`; this owns the confirm-open state because only one field's
 * dialog is ever open at a time.
 *
 * **`onDeleted` has no default**, deliberately: an unplugged wire is then a `TS2741` compile error
 * rather than a silent no-op, which is the class that produced five of SPRIN-92's six findings.
 */
export function CustomFieldDeleteControl({
  field,
  onDeleted,
}: {
  field: ProjectField
  onDeleted: (id: string) => void
}) {
  const [confirming, setConfirming] = useState(false)

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        aria-label={`Remove ${field.name}`}
        onClick={() => setConfirming(true)}
      >
        Remove
      </Button>
      <FieldDeleteDialog
        field={field}
        open={confirming}
        onOpenChange={setConfirming}
        onDeleted={onDeleted}
      />
    </>
  )
}
```

- [ ] **Step 4: Run to verify they pass, then lint and typecheck**

```bash
npx vitest run src/routes/CustomFieldDelete.test.tsx
npm run lint && npm run typecheck
```

- [ ] **Step 5: Prove the `known` gate is not vacuous**

Change `disabled={deleting || !known}` to `disabled={deleting}`. **Expected: "BLOCKS the delete when the count could not be read" FAILS.** Restore it.

- [ ] **Step 6: Commit**

Message: `Add the custom-field delete control with its value count`

---

## Task 4: Render the control from the field row

**Files:**
- Modify: `src/routes/CustomFieldSettings.tsx` (`CustomFieldRow`, `CustomFieldList`, `CustomFieldBody`, `CustomFieldSettings`)
- Test: `src/routes/CustomFieldSettings.test.tsx`

**Interfaces:**
- Consumes: `CustomFieldDeleteControl` (Task 3).
- Produces: a required `onDeleted: (id: string) => void` prop on `CustomFieldSettings`.

**Context:** `onDeleted` threads through four components in this file. **Add it as a REQUIRED prop to each — no defaults.** The file has 69 counted lines of headroom; this task should use about 8 of them.

- [ ] **Step 1: Write the failing tests**

Add to `src/routes/CustomFieldSettings.test.tsx`. The existing file already mocks `@/lib/project-fields`; add `deleteProjectField` and `countTicketsHoldingField` to that mock, or the control's own calls will reach the live database.

```ts
it('offers a delete control on each field row', () => {
  renderSettings({ fields: [SHIP_BY, PRIORITY] })
  // Scoped to the row — an unscoped query says the button exists and nothing about where.
  const row = screen.getByRole('listitem', { name: /Ship by/i })
  expect(within(row).getByRole('button', { name: 'Remove Ship by' })).toBeInTheDocument()
})

it('hands the deleted field id up to its caller', async () => {
  const onDeleted = vi.fn()
  mockCount.mockResolvedValue(0)
  mockDeleteField.mockResolvedValue({ ok: true, value: undefined })
  renderSettings({ fields: [SHIP_BY], onDeleted })
  await userEvent.click(screen.getByRole('button', { name: 'Remove Ship by' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove field' })).toBeEnabled())
  await userEvent.click(screen.getByRole('button', { name: 'Remove field' }))
  // THE HOP TEST. `onDeleted` is required at every component in this file, so a MISSING wire is
  // a compile error — but requiredness cannot catch a CROSSED one, and this asserts the id
  // reaches the caller this component was handed, not some other callback.
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(SHIP_BY.id))
})
```

Match `renderSettings`'s existing signature in that file rather than inventing one; extend it with `onDeleted`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/routes/CustomFieldSettings.test.tsx`

- [ ] **Step 3: Implement**

Add `onDeleted: (id: string) => void` to the props type of `CustomFieldSettings`, `CustomFieldBody`, `CustomFieldList` and `CustomFieldRow`, thread it through each, and render it in `CustomFieldRow`'s header row beside the type label:

```tsx
        <span className="text-muted-foreground shrink-0 text-xs">
          {CUSTOM_FIELD_TYPE_LABELS[field.type]}
        </span>
        <CustomFieldDeleteControl field={field} onDeleted={onDeleted} />
```

Import it: `import { CustomFieldDeleteControl } from './CustomFieldDelete'`.

**`CustomFieldRow` is at cyclomatic 4 and takes 7 props already — T4 caps *parameters* at 4, but a single destructured object counts as one parameter, which is why this file passes today.** Adding a property to that object costs nothing. Do not add a second parameter.

Also update `CustomFieldSettings`'s docblock, which currently says *"Deleting a field is story 6 and there is no control for it here: `authenticated` holds no DELETE on `project_fields` at all"* — both halves are now false.

- [ ] **Step 4: Run tests, lint, typecheck, and re-measure the file**

```bash
npx vitest run src/routes/CustomFieldSettings.test.tsx
npm run lint && npm run typecheck
npx eslint src/routes/CustomFieldSettings.tsx --rule '{"max-lines":["error",{"max":1,"skipBlankLines":true,"skipComments":true}]}'
```
Expected: the reported count is comfortably under 400. If it is over, report BLOCKED — do not delete comments to fit.

- [ ] **Step 5: Commit**

Message: `Render the delete control on each custom field row`

---

## Task 5: Wire the shell — and patch two lists, not one

**Files:**
- Modify: `src/routes/ProjectShell.tsx` (context type, reducer, Outlet value)
- Modify: `src/routes/SettingsTab.tsx` (destructure and pass down)
- Test: `src/routes/ProjectShell.test.tsx`, `src/routes/SettingsTab.test.tsx`

**Interfaces:**
- Consumes: `CustomFieldSettings`'s required `onDeleted` (Task 4).
- Produces: `onFieldDeleted: (id: string) => void` on `ProjectShellContext`.

**Context:** `ProjectShell` is at **cyclomatic 10 of 10**. The reducer must be a `const` arrow (zero cost); a conditional written inline in `ProjectShell`'s own body costs a point and reddens the gate.

- [ ] **Step 1: Write the failing tests**

In `src/routes/ProjectShell.test.tsx`, following the existing reducer tests' shape:

```ts
it('removes a deleted field AND that field's options from the shared lists', async () => {
  // Two patches, because `pfo_field_fk` cascades: the database has ALREADY removed those option
  // rows, so leaving them in the shared list makes the client's copy disagree with it. `options`
  // is read by CreateTicketCustomFields and TicketDetailSidebar too, not just this tab.
  // ... render the shell with two fields, each holding an option ...
  // ... invoke the context's onFieldDeleted with the first field's id ...
  expect(fieldsSeenByTab).toEqual([SECOND_FIELD])
  expect(optionsSeenByTab).toEqual([SECOND_FIELDS_OPTION])
})

it('leaves another field's options alone', async () => {
  // The positive control for the assertion above: a filter keyed on the wrong column (or on
  // nothing) would take both fields' options with it and the first test alone would not say so.
})
```

In `src/routes/SettingsTab.test.tsx`:

```ts
it('passes the context's onFieldDeleted to the custom field settings', async () => {
  // THE CROSSED-WIRE TEST. `onFieldDeleted` and `onFieldUpdated` have different signatures, so
  // the compiler catches that particular swap — but this file has already seen a same-level
  // prop crossed (SPRIN-92 finding #2, `optionsPhase={fieldsPhase}`), and that is the sixth
  // instance of the class. Assert the identity of the function that arrives, not merely that
  // one did.
})
```

Match the existing test idiom in each file rather than inventing a harness.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Implement**

In `ProjectShell.tsx`, after `onFieldUpdated`:

```ts
  // A field was deleted (SPRIN-93). TWO lists are patched, because the database changes two
  // tables: `pfo_field_fk` cascades, so this field's option rows are already gone server-side and
  // leaving them in the shared list would make the client's copy disagree with the database.
  // `options` is read by `CreateTicketCustomFields` and `TicketDetailSidebar` as well as the
  // settings tab, so the staleness would not stay on the surface that caused it. Mirrors
  // `onSprintCompleted`, the existing precedent for one event patching two of the shell's lists.
  //
  // The VALUE rows also cascade (`tfv_field_fk`, `tfv_type_fk`), and there is deliberately no
  // third patch: the shell holds no value list — the detail sidebar fetches a ticket's values when
  // it opens — so there is nothing here to keep in step.
  //
  // A `const` arrow, not a conditional in `ProjectShell`'s own body: this component is at exactly
  // 10 of 10 cyclomatic, so a branch written INLINE would redden `npm run lint`. Re-measured for
  // this story, not recalled from the precedent.
  const onFieldDeleted = (id: string) => {
    fieldRead.patch(project.id, (fs) => fs.filter((f) => f.id !== id))
    optionRead.patch(project.id, (os) => os.filter((o) => o.field_id !== id))
  }
```

Add to `ProjectShellContext` with a docblock in the file's established style, and add `onFieldDeleted` to the Outlet `context` object beside `onFieldUpdated`.

In `SettingsTab.tsx`, destructure `onFieldDeleted` from the context and pass `onDeleted={onFieldDeleted}` to `<CustomFieldSettings>`.

- [ ] **Step 4: Run tests, lint, typecheck, and RE-MEASURE ProjectShell**

```bash
npm run test:unit
npm run lint && npm run typecheck
npx eslint src/routes/ProjectShell.tsx --rule '{"complexity":["error",1]}' 2>&1 | grep "'ProjectShell'"
```
Expected: still `complexity of 10`. **If it reads 11, `npm run lint` is already red** — report BLOCKED.

- [ ] **Step 5: Prove the second patch is not vacuous**

Delete the `optionRead.patch(...)` line. **Expected: the "removes ... AND that field's options" test FAILS.** Restore it. Then change the option filter's key from `o.field_id !== id` to `o.field_id !== 'nope'`; expected: the same test fails. Restore.

- [ ] **Step 6: Commit**

Message: `Remove a deleted field and its options from the shell's lists`

---

## Task 6: The live proof — replace the tripwire

**Files:**
- Modify: `src/test/rls.integration.test.ts`

**Interfaces:**
- Consumes: migration E (Task 1), applied by hand to the live database.
- Produces: nothing consumed by later tasks.

**Context — READ ALL OF THIS.**

`src/test/rls.integration.test.ts:1778` holds:

```ts
it('an authenticated owner still holds no DELETE on their own fields', async () => {
  const del = await a.from('project_fields').delete().eq('id', fieldA)
  expect(del.error?.code).toBe('42501')
  expect(del.error?.message).toMatch(/permission denied/)
})
```

**This is story 6's tripwire and migration E is what fires it.** Replace it; do not simply delete it — the surrounding docblock explains that its sibling INSERT half was already replaced by SPRIN-91 and that deleting the whole test would throw the tripwire away.

**You cannot run this file.** The live suites fail with `ENOTFOUND` here (placeholder Supabase URL). Write it correctly; CI is the first place it executes.

**RLS FILTERS a delete rather than raising on it.** Every cross-tenant assertion is on a **row count**, never on `error === null` — a vacuous `error === null` assertion is exactly what SPRIN-92's review found on this table's sibling, and CI would not have caught it either.

- [ ] **Step 1: Replace the tripwire with the delete proof**

Write assertions covering, each with its positive control:

1. **Owner A deletes their own field** — the delete returns one row (`.select('id')`, length 1), and a follow-up `adminClient()` read finds zero rows for that id.
2. **Stranger B's delete removes ZERO rows** — `b.from('project_fields').delete().eq('id', fieldA).select('id')` returns `[]`, and the positive control is an `adminClient()` read showing the row still exists. Do **not** assert on `error`.
3. **`anon`'s delete is refused with `42501` AND `/permission denied/`** — the message matters because `fields_owner_delete` has no `TO` clause and so covers `anon`, meaning an RLS refusal would also raise 42501; only the message separates a missing GRANT from a policy refusal.
4. **The cascade, through the APP ROLE not `adminClient`** — seed a field, a ticket value row for it, and (for a `select` field) an option row; delete the field as A; assert `ticket_field_values` and `project_field_options` both hold zero rows for that `field_id`, read back through `adminClient()` so RLS cannot be what makes them look absent.

Seed fixtures in the block's own `beforeAll`/`beforeEach` rather than reusing `fieldA`, whose id other tests in the file assert against — deleting it would retroactively break them. **This is the exact failure session 62 hit**: a migration re-judged fixtures written before it existed.

- [ ] **Step 2: Correct the two stale comments**

`grep -n "until story 6" src/test/rls.integration.test.ts` finds comments (near lines 2754 and 2855) reading *"`authenticated` holds no DELETE on project_fields until story 6"*. The `adminClient()` calls beneath them still work and should stay — only the reasons are now wrong.

- [ ] **Step 3: Confirm the file still collects, without running it**

Run: `npx vitest list --filesOnly | wc -l`
Expected: **75**. Then `npx vitest list --filesOnly --mode=... ` is not needed — compare against `npm run test:unit`'s own count of **68**. **The gap must be 7.** A gap of zero means the live suites silently skipped.

- [ ] **Step 4: Typecheck and lint**

```bash
npm run lint && npm run typecheck
```

- [ ] **Step 5: Commit**

Message: `Prove the field DELETE grant and its cascade against the live database`

---

## Self-Review Notes

- **Spec coverage.** AC1 → Tasks 3, 4. AC2 → Tasks 2, 3. AC3 → Tasks 1, 6 (the cascade is schema, proven live). AC4 → Tasks 2, 3 (three-state count, `known` gate, both mutation-tested). AC5 → Task 3's zero-count test. Migration → Task 1. Schema doc defect → Task 1. Shell staleness → Task 5. SPRIN-75 hand-off → recorded in the spec §8 and on the Jira issue; no code.
- **The riskiest task is 6**, because it cannot be run locally and is the only place AC3 is actually proven.
- **The riskiest single line is the migration's revoke**, and its detector is the pre-existing SPRIN-91 insert/rename tests rather than anything written here.
