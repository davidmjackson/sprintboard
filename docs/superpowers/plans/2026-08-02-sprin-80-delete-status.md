# SPRIN-80 — Delete a status without stranding tickets: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project owner delete a status, refusing the delete when it holds tickets or is the
project's last one, and auto-promoting a new initial status so ticket creation never breaks.

**Architecture:** One hand-applied migration adds a DELETE policy, a `BEFORE DELETE` guard, an
`AFTER DELETE` promotion, and a `BEFORE INSERT` trigger on `tickets` that resolves the status from
`is_initial` — replacing the bare `default 'todo'`. The client gets a `deleteProjectStatus` write
that maps three distinct database refusals to three distinct messages, plus pure helpers that keep
`ProjectShell` branch-free.

**Tech Stack:** React 19, TypeScript strict, Supabase (Postgres + RLS), Vitest, Testing Library,
shadcn/ui (`AlertDialog`).

**Spec:** `docs/superpowers/specs/2026-08-02-sprin-80-delete-status-design.md` — read it first.

## Global Constraints

- **Thresholds T1–T5 are errors, not warnings:** 30-line functions, cyclomatic 10, cognitive 15,
  4 parameters, 400-line files. `npm run lint` gates them over `**/*.{ts,tsx,mjs,js}`.
- **`ProjectShell.tsx` and `TicketDetailDialog.tsx` are already at cyclomatic 10 of 10.** eslint
  counts each default parameter as a branch. Any change to `ProjectShell` must add **zero**
  branches, or extract first.
- **Verification is `npm run verify`.** Never `npx tsc --noEmit` (it checks zero files here and
  still exits 0), never a hand-picked subset of test files.
- **Add no new `*.integration.test.ts` file.** The tripwire GAP must stay 7. Measured 2026-08-02:
  `npx vitest list --filesOnly` = 60, with `--exclude '**/*.integration.test.ts'` = 53. **This
  plan adds no new test files at all**, so both numbers must be unchanged at the end.
- **Never use a Postgres `ENUM`.** `text` + `check`, always.
- **Status/category values are named in `src/lib/domain.ts` and nowhere else.** Never inline a
  status literal in a component, filter or test assertion that could read it from the shared list.
- **Migrations are hand-applied.** The Supabase MCP is `read_only=true` deliberately. Produce SQL,
  hand David **one** copy-paste command, let him run it. Do not attempt `apply_migration`.
- **Commit messages are imperative.** No heredocs — write the message to a file and use
  `git commit -F`.
- Branch `sprin-80-delete-status` already exists with the design doc committed at `2ba9e86`.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `docs/migrations/sprin-80-status-deletes.sql` | create | The whole schema change, one transaction, with an in-transaction smoke test. |
| `docs/sprintboard_phase1_schema.sql` | modify | Keep the canonical schema truthful: new policy, three functions, three triggers, dropped default. |
| `src/lib/project-statuses.ts` | modify | `removeStatus`, `initialSlug`, `deleteBlockReason`, `ticketCountsByStatus`, `deleteProjectStatus`. |
| `src/lib/project-statuses.test.ts` | modify | Unit tests for all five. |
| `src/routes/StatusSettings.tsx` | modify | Count per row, Delete control with its reason, confirm dialog. |
| `src/routes/StatusSettings.test.tsx` | modify | Component tests. |
| `src/routes/SettingsTab.tsx` | modify | Owns the counts fetch and the delete flow. |
| `src/routes/SettingsTab.test.tsx` | modify | Component tests for the fetch + flow. |
| `src/routes/ProjectShell.tsx` | modify | One branch-free reducer + context entry. |
| `src/test/rls.integration.test.ts` | modify | Live delete behaviour, refusals, promotion, cross-tenant. |
| `src/test/tickets.integration.test.ts` | modify | Live `is_initial` resolution on ticket insert. |

---

## Task 1: Pure helpers on the status list

**Files:**
- Modify: `src/lib/project-statuses.ts`
- Test: `src/lib/project-statuses.test.ts`

**Interfaces:**
- Consumes: `ProjectStatus` from `@/lib/domain` (already imported in this module).
- Produces:
  - `initialSlug(statuses: readonly ProjectStatus[]): string | null`
  - `removeStatus(statuses: readonly ProjectStatus[], id: string): ProjectStatus[]`
  - `deleteBlockReason(ticketCount: number, isLast: boolean): string | null`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/project-statuses.test.ts`. Reuse the module's existing `ProjectStatus` factory
if one is present; if not, add this local one at the top of the new `describe`.

```ts
function status(over: Partial<ProjectStatus> & { id: string }): ProjectStatus {
  return {
    id: over.id,
    project_id: 'p1',
    slug: over.slug ?? over.id,
    name: over.name ?? over.id,
    category: over.category ?? 'todo',
    position: over.position ?? 1,
    is_initial: over.is_initial ?? false,
    created_at: '2026-08-02T00:00:00Z',
    ...over,
  } as ProjectStatus
}

describe('initialSlug', () => {
  it('returns the slug of the initial status', () => {
    expect(
      initialSlug([status({ id: 'a' }), status({ id: 'b', is_initial: true, slug: 'triage' })]),
    ).toBe('triage')
  })

  it('returns null when no status is initial', () => {
    expect(initialSlug([status({ id: 'a' })])).toBeNull()
  })
})

describe('removeStatus', () => {
  it('drops the row and leaves the rest untouched', () => {
    const rows = [
      status({ id: 'a', position: 1, is_initial: true }),
      status({ id: 'b', position: 2 }),
    ]
    expect(removeStatus(rows, 'b')).toEqual([rows[0]])
  })

  // The promotion rule, mirroring the AFTER DELETE trigger. Pinned on BOTH sides:
  // rls.integration.test.ts asserts the DATABASE promotes by this same rule.
  it('promotes the lowest-position survivor when the initial status is removed', () => {
    const rows = [
      status({ id: 'a', position: 1, is_initial: true }),
      status({ id: 'c', position: 3 }),
      status({ id: 'b', position: 2 }),
    ]
    const next = removeStatus(rows, 'a')
    expect(next.find((s) => s.is_initial)?.id).toBe('b')
    expect(next).toHaveLength(2)
  })

  it('promotes nobody when the removed status was not initial', () => {
    const rows = [
      status({ id: 'a', position: 1, is_initial: true }),
      status({ id: 'b', position: 2 }),
    ]
    expect(removeStatus(rows, 'b').filter((s) => s.is_initial)).toHaveLength(1)
  })

  it('is a no-op for an id the list does not hold', () => {
    const rows = [status({ id: 'a', position: 1, is_initial: true })]
    expect(removeStatus(rows, 'nope')).toEqual(rows)
  })
})

describe('deleteBlockReason', () => {
  it('blocks the last status, and says why', () => {
    expect(deleteBlockReason(0, true)).toBe('A project must keep at least one status.')
  })

  it('blocks a status holding tickets, naming the count', () => {
    expect(deleteBlockReason(7, false)).toBe(
      'This status holds 7 tickets. Move them to another status first.',
    )
  })

  it('says "1 ticket", not "1 tickets"', () => {
    expect(deleteBlockReason(1, false)).toBe(
      'This status holds 1 ticket. Move them to another status first.',
    )
  })

  // Last-ness wins: a last status holding tickets is blocked for the reason the user
  // cannot resolve by moving tickets.
  it('reports last-ness ahead of the ticket count', () => {
    expect(deleteBlockReason(7, true)).toBe('A project must keep at least one status.')
  })

  it('returns null when the status can be deleted', () => {
    expect(deleteBlockReason(0, false)).toBeNull()
  })
})
```

Add `initialSlug`, `removeStatus`, `deleteBlockReason` to the existing import from
`./project-statuses` at the top of the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/project-statuses.test.ts`
Expected: FAIL — `initialSlug is not a function` (and the same for the other two).

- [ ] **Step 3: Implement**

Append to `src/lib/project-statuses.ts`:

```ts
/**
 * Where new tickets start, by slug. The single client-side derivation of "initial", mirroring
 * `doneSlugs`'s role for "terminal" — the confirm dialog's copy reads it rather than
 * re-deriving. `null` when the project has no initial status, which the database's
 * `project_statuses_one_initial_per_project` plus SPRIN-80's promotion trigger make
 * unreachable; it is typed anyway because the client cannot prove that locally.
 */
export function initialSlug(statuses: readonly ProjectStatus[]): string | null {
  return statuses.find((s) => s.is_initial)?.slug ?? null
}

/**
 * The list after a status is deleted, INCLUDING the promotion the database performs.
 *
 * This mirrors `project_statuses_promote_initial()`: deleting the initial status promotes the
 * lowest-`position` survivor. The rule is therefore expressed twice — once in SQL, once here —
 * which is the drift this codebase warns about with `doneSlugs`. It cannot be shared across the
 * two languages, so it is closed by test instead: `rls.integration.test.ts` asserts the DATABASE
 * promotes by this same rule, so a trigger rewritten to promote differently goes red.
 *
 * A pure function rather than logic in the shell's reducer, because `ProjectShell` is at
 * cyclomatic 10 of 10 and a promotion branch there would redden `npm run lint`.
 */
export function removeStatus(statuses: readonly ProjectStatus[], id: string): ProjectStatus[] {
  const removed = statuses.find((s) => s.id === id)
  const rest = statuses.filter((s) => s.id !== id)
  if (!removed?.is_initial) return rest

  const promoted = rest.reduce<ProjectStatus | null>(
    (lowest, s) => (lowest === null || s.position < lowest.position ? s : lowest),
    null,
  )
  return rest.map((s) => (s.id === promoted?.id ? { ...s, is_initial: true } : s))
}

/**
 * Why this status cannot be deleted, or `null` if it can — AC4's "the reason is stated in the
 * UI". Derived from data the tab already holds, so the control explains itself BEFORE the user
 * clicks rather than after the database refuses.
 *
 * The database is the real control; this only decides what to render. A stale count therefore
 * degrades to a wrong sentence, never to a wrong delete.
 *
 * Last-ness is reported ahead of the ticket count deliberately: a last status holding tickets is
 * blocked for a reason the user cannot fix by moving tickets, so naming the count would send
 * them to do work that would not unblock the button.
 */
export function deleteBlockReason(ticketCount: number, isLast: boolean): string | null {
  if (isLast) return 'A project must keep at least one status.'
  if (ticketCount > 0) {
    const plural = ticketCount === 1 ? 'ticket' : 'tickets'
    return `This status holds ${ticketCount} ${plural}. Move them to another status first.`
  }
  return null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/project-statuses.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/project-statuses.ts src/lib/project-statuses.test.ts
git commit -F .git/COMMIT_EDITMSG_SPRIN80_1
```

Write the message file first with `printf`, imperative summary:
`Add pure status-list helpers for deletion (SPRIN-80)`

---

## Task 2: The delete write and the ticket counts

**Files:**
- Modify: `src/lib/project-statuses.ts`
- Test: `src/lib/project-statuses.test.ts`

**Interfaces:**
- Consumes: `StatusWriteResult<T>` and the private `StatusWriteError` union, both already in this
  module.
- Produces:
  - `deleteProjectStatus(id: string): Promise<StatusWriteResult<void>>`
  - `ticketCountsByStatus(projectId: string, statuses: readonly ProjectStatus[]): Promise<Map<string, number>>`
  - `StatusWriteError` widens to `'duplicate' | 'stale' | 'unknown' | 'has_tickets' | 'last'`.

- [ ] **Step 1: Write the failing tests**

Follow the mocking style already used for `createProjectStatus` in this file (the module mocks
`./supabase`). Add:

```ts
describe('deleteProjectStatus', () => {
  it('reports has_tickets when the fk refuses the delete', async () => {
    mockDelete({ data: null, error: { code: '23503', message: 'tickets_status_fk' } })
    expect(await deleteProjectStatus('s1')).toEqual({ ok: false, error: 'has_tickets' })
  })

  it('reports last when the guard trigger refuses the delete', async () => {
    mockDelete({ data: null, error: { code: 'SB001', message: 'at least one status' } })
    expect(await deleteProjectStatus('s1')).toEqual({ ok: false, error: 'last' })
  })

  /**
   * THE ONE THAT MATTERS. RLS FILTERS a DELETE rather than raising on it, so a row that is not
   * ours comes back as exactly `error: null, data: []` — a delete that removed nothing, and
   * indistinguishable from success unless the row count is checked.
   */
  it('reports stale when the delete matched no row and did not error', async () => {
    mockDelete({ data: [], error: null })
    expect(await deleteProjectStatus('s1')).toEqual({ ok: false, error: 'stale' })
  })

  it('succeeds when exactly one row came back', async () => {
    mockDelete({ data: [{ id: 's1' }], error: null })
    expect(await deleteProjectStatus('s1')).toEqual({ ok: true, value: undefined })
  })

  it('falls back to unknown for an unrecognised error code', async () => {
    mockDelete({ data: null, error: { code: '42501', message: 'denied' } })
    expect(await deleteProjectStatus('s1')).toEqual({ ok: false, error: 'unknown' })
  })
})

describe('ticketCountsByStatus', () => {
  it('maps each status slug to its exact ticket count', async () => {
    mockCounts({ todo: 4, done: 0 })
    const counts = await ticketCountsByStatus('p1', [
      status({ id: 'a', slug: 'todo' }),
      status({ id: 'b', slug: 'done' }),
    ])
    expect(counts.get('todo')).toBe(4)
    expect(counts.get('done')).toBe(0)
  })

  // A failed count must not read as zero: zero unlocks the Delete button.
  it('throws when a count query fails', async () => {
    mockCountError('network down')
    await expect(
      ticketCountsByStatus('p1', [status({ id: 'a', slug: 'todo' })]),
    ).rejects.toThrow(/could not count/i)
  })
})
```

Implement `mockDelete`, `mockCounts` and `mockCountError` as thin local helpers over the existing
`supabase` mock in this file, matching how the existing insert/update tests are wired. **Read the
top of the file and follow what is there** rather than introducing a second mocking style.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/project-statuses.test.ts -t 'deleteProjectStatus'`
Expected: FAIL — `deleteProjectStatus is not a function`.

- [ ] **Step 3: Implement**

Widen the error union and append the two functions:

```ts
type StatusWriteError = 'duplicate' | 'stale' | 'unknown' | 'has_tickets' | 'last'

/** Postgres `foreign_key_violation` — here, always `tickets_status_fk`. */
const FK_VIOLATION = '23503'

/** Raised by `project_statuses_delete_guard()`. A custom SQLSTATE rather than the `P0001`
 *  default, so the client keys off a code that cannot be reworded. */
const LAST_STATUS = 'SB001'

/**
 * Delete a status.
 *
 * Three refusals, three tags, three different remedies — which is the whole reason this does not
 * collapse to a boolean:
 *
 *   * `has_tickets` — the fk refused it. Move the tickets, then retry.
 *   * `last`        — the guard trigger refused it. Nothing to retry; add a status first.
 *   * `stale`       — the delete matched NO row and did not error.
 *
 * That last one is the trap. **RLS FILTERS a DELETE rather than raising on it**, so a row
 * belonging to another tenant, or one another tab already deleted, returns exactly
 * `error: null, data: []` — a delete that changed nothing, indistinguishable from one that
 * worked unless the row COUNT is checked. `.select()` supplies that count, and this is the same
 * defect `reorderProjectStatuses` guards against for the same reason.
 *
 * The non-empty refusal is the EXISTING `tickets_status_fk`, not a new trigger. One rule, one
 * control: a second guard checking the same thing would mean removing either still goes red, and
 * the suite would stop being able to say which one works.
 */
export async function deleteProjectStatus(id: string): Promise<StatusWriteResult<void>> {
  const { data, error } = await supabase
    .from('project_statuses')
    .delete()
    .eq('id', id)
    .select('id')

  if (error) return { ok: false, error: deleteError(error) }
  if ((data ?? []).length !== 1) return { ok: false, error: 'stale' }
  return { ok: true, value: undefined }
}

function deleteError(error: { code?: string }): StatusWriteError {
  if (error.code === FK_VIOLATION) return 'has_tickets'
  if (error.code === LAST_STATUS) return 'last'
  return 'unknown'
}

/**
 * How many tickets sit on each of the project's statuses (AC2 — the count is shown BEFORE the
 * user commits).
 *
 * One `head: true, count: 'exact'` request per status, in parallel: exact, bounded by the number
 * of statuses, and no dependency on PostgREST's `select=status,count()` aggregate, which needs
 * `db-aggregates-enabled` and could not be verified from here.
 *
 * It THROWS rather than resolving to zero on error, for the same reason `listProjectStatuses`
 * throws instead of returning `[]`: zero is a meaningful value here — it is what UNLOCKS the
 * Delete button — so a failed count reported as zero would offer a delete the database is about
 * to refuse.
 */
export async function ticketCountsByStatus(
  projectId: string,
  statuses: readonly ProjectStatus[],
): Promise<Map<string, number>> {
  const entries = await Promise.all(
    statuses.map(async (s) => {
      const { count, error } = await supabase
        .from('tickets')
        .select('id', { count: 'exact', head: true })
        .eq('project_id', projectId)
        .eq('status', s.slug)
      if (error) throw new Error(`Could not count tickets: ${error.message}`)
      return [s.slug, count ?? 0] as const
    }),
  )
  return new Map(entries)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/project-statuses.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

`Add the status delete write and per-status ticket counts (SPRIN-80)`

---

## Task 3: Live tests for the database behaviour — written RED, before the migration

Per the project's own rule, the migration ships **with** its tests: applying it early to unblock
the work removes the very signal you need while doing the work.

**These tests will fail until Task 4's migration is applied. That is the point.**

**Files:**
- Modify: `src/test/rls.integration.test.ts`
- Modify: `src/test/tickets.integration.test.ts`

**Interfaces:**
- Consumes: the fixture idiom in the existing `describe('the owner can add, rename and reorder
  statuses (SPRIN-77)')` block at `src/test/rls.integration.test.ts:563` — `throwawayProject()`,
  `runKey()`, `settled()`, the signed-in clients `a` and `b`, and `adminClient()`.

- [ ] **Step 1: Add the live delete suite**

Add a **sibling** `describe` after the SPRIN-77 block in `src/test/rls.integration.test.ts`. Give
it its own `throwawayProject`-created project and the same **delete-first, assert-afterwards**
teardown — an assertion placed before the delete turns an obligation into a report and strands
fixture rows in the shared database.

```ts
describe('the owner can delete a status, safely (SPRIN-80)', () => {
  let dp: string

  beforeAll(async () => {
    dp = await throwawayProject('Status deletes')
  }, 30_000)

  afterAll(async () => {
    const gone = dp ? await settled(a.from('projects').delete().eq('id', dp).select()) : null
    expect(gone?.error).toBeNull()
    expect(gone?.data).toHaveLength(1)
  }, 30_000)

  /** POSITIVE CONTROL, first: every refusal below only means something if this passes. */
  it('deletes an EMPTY status, and no ticket is left referencing it (AC1, AC3)', async () => {
    const { data: added } = await a
      .from('project_statuses')
      .insert({ project_id: dp, slug: 'qa', name: 'Ready for QA', category: 'in_progress', position: 9 })
      .select()
      .single()

    const { data, error } = await a
      .from('project_statuses')
      .delete()
      .eq('id', added!.id)
      .select()
    expect(error).toBeNull()
    expect(data).toHaveLength(1)

    // AC3 asserted DIRECTLY against the database, not inferred from the UI looking right.
    // adminClient() bypasses RLS, so a stranded row cannot hide behind a policy.
    const { data: stranded } = await adminClient()
      .from('tickets')
      .select('id')
      .eq('project_id', dp)
      .eq('status', 'qa')
    expect(stranded).toHaveLength(0)
  })

  it('REFUSES to delete a status holding tickets, and the tickets survive (AC2, AC5)', async () => {
    const { data: t } = await a
      .from('tickets')
      .insert({ project_id: dp, owner_id: userAId, summary: 'Sits on todo', type: 'story' })
      .select()
      .single()

    const { data: todo } = await a
      .from('project_statuses')
      .select('id')
      .eq('project_id', dp)
      .eq('slug', 'todo')
      .single()

    const { error } = await a.from('project_statuses').delete().eq('id', todo!.id).select()
    expect(error?.code).toBe('23503')

    // The interrupted-delete path: the ticket is still there, still on its status.
    const { data: survivor } = await adminClient()
      .from('tickets')
      .select('status')
      .eq('id', t!.id)
      .single()
    expect(survivor!.status).toBe('todo')

    await a.from('tickets').delete().eq('id', t!.id)
  })

  it('REFUSES to delete the last remaining status (AC4)', async () => {
    const solo = await throwawayProject('Only one status left')
    try {
      const { data: rows } = await a.from('project_statuses').select('id, is_initial').eq('project_id', solo)
      const keep = rows!.find((r) => r.is_initial)!
      for (const r of rows!.filter((r) => r.id !== keep.id)) {
        await a.from('project_statuses').delete().eq('id', r.id)
      }

      const { error } = await a.from('project_statuses').delete().eq('id', keep.id).select()
      expect(error?.code).toBe('SB001')

      const { data: left } = await a.from('project_statuses').select('id').eq('project_id', solo)
      expect(left).toHaveLength(1)
    } finally {
      await a.from('projects').delete().eq('id', solo)
    }
  })

  /**
   * Pins the DATABASE's promotion rule against the same expectation `removeStatus`'s unit test
   * pins for the client's. The two derivations cannot be shared across SQL and TypeScript, so
   * this is what stops them drifting.
   */
  it('promotes the lowest-position survivor when the initial status is deleted', async () => {
    const p = await throwawayProject('Promotion')
    try {
      const { data: rows } = await a
        .from('project_statuses')
        .select('id, slug, position, is_initial')
        .eq('project_id', p)
        .order('position')

      const wasInitial = rows!.find((r) => r.is_initial)!
      const expected = rows!.filter((r) => r.id !== wasInitial.id).sort((x, y) => x.position - y.position)[0]

      const { error } = await a.from('project_statuses').delete().eq('id', wasInitial.id).select()
      expect(error).toBeNull()

      const { data: after } = await a
        .from('project_statuses')
        .select('id, slug, is_initial')
        .eq('project_id', p)
      expect(after!.filter((r) => r.is_initial)).toHaveLength(1)
      expect(after!.find((r) => r.is_initial)!.id).toBe(expected.id)

      // And the promotion is REAL: a ticket created now lands on the promoted status,
      // proving the BEFORE INSERT resolution and the AFTER DELETE promotion together.
      const { data: fresh } = await a
        .from('tickets')
        .insert({ project_id: p, owner_id: userAId, summary: 'After promotion', type: 'story' })
        .select('status')
        .single()
      expect(fresh!.status).toBe(expected.slug)
    } finally {
      await a.from('projects').delete().eq('id', p)
    }
  })

  it("user B cannot delete user A's status — zero rows, and no error", async () => {
    const { data: todo } = await adminClient()
      .from('project_statuses')
      .select('id')
      .eq('project_id', dp)
      .eq('slug', 'in_review')
      .single()

    // RLS FILTERS rather than raising. The row COUNT is the only evidence.
    const { data, error } = await b.from('project_statuses').delete().eq('id', todo!.id).select()
    expect(error).toBeNull()
    expect(data).toHaveLength(0)

    const { data: still } = await adminClient()
      .from('project_statuses')
      .select('id')
      .eq('id', todo!.id)
    expect(still).toHaveLength(1)
  })

})
```

**Where the `pg_constraint` assertion goes — and it is NOT here.** The issue's closing NOTE asks
that a database-enforced guard be verified against the catalog. PostgREST does not expose system
catalogs, so no Vitest suite can read `pg_constraint`, and **adding a SQL-executing RPC to the
production schema so that a test can reach one would be a far worse thing than the test is
worth.** The catalog assertion therefore lives in the migration's post-state block (Task 4,
Step 1), which runs SQL directly — exactly where SPRIN-77 put its equivalent shape assertions.
The Vitest side proves the same guard **behaviourally**: the `23503` refusal above is evidence
that the fk exists and is `NO ACTION`. Both halves are required; neither substitutes for the
other.

- [ ] **Step 2: Add the ticket-creation test**

In `src/test/tickets.integration.test.ts`, add:

```ts
it('resolves a new ticket status from the project initial status, not a literal default', async () => {
  const { data: initial } = await a
    .from('project_statuses')
    .select('slug')
    .eq('project_id', projectId)
    .eq('is_initial', true)
    .single()

  const { data, error } = await a
    .from('tickets')
    .insert({ project_id: projectId, owner_id: userAId, summary: 'No status given', type: 'story' })
    .select('status')
    .single()

  expect(error).toBeNull()
  expect(data!.status).toBe(initial!.slug)
})
```

Use whatever project/user fixture that file already establishes — **read it first** rather than
assuming `projectId`/`userAId` are the names.

- [ ] **Step 3: Run them and confirm they fail for the RIGHT reason**

Run: `npx vitest run src/test/rls.integration.test.ts -t 'SPRIN-80'`
Expected: FAIL. The delete returns `data: []` (no DELETE policy yet), **not** an error. If a test
fails with a network or auth error instead, stop — that is the rate-limit flake, not the feature.

- [ ] **Step 4: Commit the red tests**

`Add live tests for status deletion, still red (SPRIN-80)`

---

## Task 4: The migration

**Files:**
- Create: `docs/migrations/sprin-80-status-deletes.sql`
- Modify: `docs/sprintboard_phase1_schema.sql`

- [ ] **Step 1: Write the migration**

Follow SPRIN-77's structure exactly: one `begin`/`commit`, timeouts, preconditions, the change,
an in-transaction smoke test, post-state assertions, `notify pgrst`.

```sql
-- =============================================================================
-- SPRIN-80  Delete a status without stranding the tickets on it
--           (Rung 3 epic SPRIN-72, slice 4 — the last)
--
-- BOTH HALVES SHIP HERE, AND NEITHER IS SAFE ALONE. Adding a DELETE policy while
-- tickets.status still defaults to the bare literal 'todo' breaks ticket creation
-- permanently for any project whose `todo` row is deleted — and a NEW project's
-- `todo` holds no tickets, so it is deletable even under the "refuse a non-empty
-- status" rule this story implements.
--
-- RUN: paste this ENTIRE file into the Supabase SQL editor and run it once.
-- RE-RUN: safe. Every statement is idempotent.
-- =============================================================================

begin;

set local lock_timeout      = '5s';
set local statement_timeout = '120s';

-- 1. Preconditions.
do $$
declare v_bad int;
begin
  if not exists (select 1 from pg_policy
                 where polrelid = 'public.project_statuses'::regclass
                   and polname  = 'statuses_owner_update') then
    raise exception 'SPRIN-80: statuses_owner_update is missing. Apply SPRIN-77 first.';
  end if;

  -- The promotion trigger and the insert resolution both assume exactly one initial
  -- status per project. Prove it BEFORE depending on it.
  select count(*) into v_bad from public.projects p
   where (select count(*) from public.project_statuses s
           where s.project_id = p.id and s.is_initial) <> 1;
  if v_bad > 0 then
    raise exception 'SPRIN-80: % project(s) do not have exactly one is_initial status.', v_bad;
  end if;
end $$;

-- 2. The DELETE policy. project_statuses now carries FOUR policies split by verb:
--    read, insert, update, delete. NEVER collapse them into `for all` — the split is
--    the security model and a live test goes red.
--
--    `(select auth.uid())` rather than a bare `auth.uid()` is DELIBERATE and differs
--    from the surrounding policies: it keeps this policy out of the auth_rls_initplan
--    advisor. The existing eight warnings are pre-existing and are SPRIN-75's to fix
--    together; this story must not add a ninth. Do not "make it consistent".
drop policy if exists statuses_owner_delete on public.project_statuses;
create policy statuses_owner_delete on public.project_statuses
  for delete
  using (exists (select 1 from public.projects p
                 where p.id = project_statuses.project_id
                   and p.owner_id = (select auth.uid())));

grant  delete on public.project_statuses to authenticated;
revoke delete on public.project_statuses from anon;

-- 3. A project must keep at least one status. Nothing but a trigger can express this:
--    it is a statement about the SIBLING rows, which no constraint can see.
--
--    SECURITY DEFINER so the count is of ALL sibling rows rather than the rows the
--    caller's policies happen to expose. Under SPRIN-75's membership model, where read
--    may be broader or narrower than write, an invoker-side count would silently start
--    guarding the wrong thing.
create or replace function public.project_statuses_delete_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.project_statuses s
       where s.project_id = old.project_id) <= 1 then
    raise exception 'A project must keep at least one status.'
      using errcode = 'SB001';
  end if;
  return old;
end;
$$;

revoke execute on function public.project_statuses_delete_guard() from public, anon, authenticated;

drop trigger if exists project_statuses_delete_guard on public.project_statuses;
create trigger project_statuses_delete_guard
  before delete on public.project_statuses
  for each row execute function public.project_statuses_delete_guard();

-- 4. Deleting the initial status promotes the lowest-position survivor.
--
--    AFTER, NOT BEFORE, and that is forced rather than stylistic:
--    project_statuses_one_initial_per_project is a PARTIAL unique index, a partial index
--    cannot be a constraint, and only a constraint can be DEFERRABLE. During a BEFORE
--    DELETE the outgoing row still holds is_initial = true, so setting it on another row
--    collides immediately. After the delete there is nothing to collide with.
--
--    The guard in step 3 has already run, so a survivor is guaranteed to exist.
create or replace function public.project_statuses_promote_initial()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_initial then
    update public.project_statuses
       set is_initial = true
     where id = (select s.id from public.project_statuses s
                  where s.project_id = old.project_id
                  order by s.position asc
                  limit 1);
  end if;
  return null;
end;
$$;

revoke execute on function public.project_statuses_promote_initial() from public, anon, authenticated;

drop trigger if exists project_statuses_promote_initial on public.project_statuses;
create trigger project_statuses_promote_initial
  after delete on public.project_statuses
  for each row execute function public.project_statuses_promote_initial();

-- 5. A new ticket's status resolves from is_initial, replacing the bare 'todo' default.
--
--    A BEFORE INSERT trigger fires before the NOT NULL check, so an insert that omits
--    `status` arrives here as NULL and leaves with a slug. An insert that NAMES a status
--    is left alone.
--
--    SECURITY DEFINER for the same reason as step 3: this read must not depend on
--    statuses_owner_read staying broad enough for whoever is inserting.
create or replace function public.resolve_initial_ticket_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is null then
    select s.slug into new.status
      from public.project_statuses s
     where s.project_id = new.project_id and s.is_initial;

    if new.status is null then
      raise exception 'Project % has no initial status.', new.project_id
        using errcode = 'SB002';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.resolve_initial_ticket_status() from public, anon, authenticated;

drop trigger if exists resolve_initial_ticket_status on public.tickets;
create trigger resolve_initial_ticket_status
  before insert on public.tickets
  for each row execute function public.resolve_initial_ticket_status();

alter table public.tickets alter column status drop default;
```

Then a `do $$ ... $$` smoke block, as a real `authenticated` user inside this transaction, proving
at minimum:

- (a) **positive control** — an empty added status deletes, one row;
- (b) a status holding a ticket refuses with `foreign_key_violation`, and the ticket survives;
- (c) deleting down to one status, then deleting that one, raises `SB001`;
- (d) deleting the initial status promotes the lowest-position survivor, and a ticket inserted
  with no `status` lands on it;
- (e) `tickets.status` has no column default any more
  (`pg_attribute.atthasdef` is false for that column).

Then post-state assertions, which are also where the issue's **`pg_constraint` requirement** is
satisfied — SQL can read the catalog, a Vitest suite cannot:

```sql
do $$
declare v_cmds text; v_confdel char;
begin
  select string_agg(polcmd::text, ',' order by polcmd::text) into v_cmds
    from pg_policy where polrelid = 'public.project_statuses'::regclass;
  -- r select, a insert, w update, d delete. No '*' (for all).
  if v_cmds is distinct from 'a,d,r,w' then
    raise exception 'SPRIN-80: project_statuses policies are (%), expected exactly '
                    'select+insert+update+delete. A `for all` policy has appeared.', v_cmds;
  end if;

  -- THE GUARD THE STORY ASKS TO BE PROVEN. The non-empty-status refusal IS this fk, so its
  -- shape is the control: composite (project_id, status) and NO ACTION on delete. A cascade
  -- here would DELETE tickets when a status is removed — silent data loss.
  select confdeltype into v_confdel
    from pg_constraint where conname = 'tickets_status_fk'
                        and conrelid = 'public.tickets'::regclass;
  if v_confdel is null then
    raise exception 'SPRIN-80: tickets_status_fk does not exist. The non-empty guard is gone.';
  end if;
  if v_confdel <> 'a' then
    raise exception 'SPRIN-80: tickets_status_fk on delete is %, expected NO ACTION (a).', v_confdel;
  end if;

  if (select count(*) from pg_constraint
       where conname = 'tickets_status_fk' and cardinality(conkey) <> 2) > 0 then
    raise exception 'SPRIN-80: tickets_status_fk is no longer composite.';
  end if;
end $$;
```

Assert the three new triggers exist, then finish with `notify pgrst, 'reload schema';` and
`commit;`.

- [ ] **Step 2: Update the canonical schema doc**

In `docs/sprintboard_phase1_schema.sql`:
- Replace the comment block at lines 251-264 — it currently explains why the default is a safe
  bare literal and names SPRIN-80 as the story that changes it. It has now changed.
- Remove `default 'todo'` from the `status` column.
- Add the DELETE policy, the three functions and the three triggers.

- [ ] **Step 3: Hand David ONE copy-paste command**

Do not run it. Do not attempt `apply_migration` — the MCP is `read_only=true` on purpose.
Present exactly one short command, fenced with `---` rules, and wait.

- [ ] **Step 4: After David confirms, run the live tests**

Run: `npm test -- src/test/rls.integration.test.ts src/test/tickets.integration.test.ts`
Expected: PASS, including every test from Task 3.

Then check advisors: `get_advisors` for `performance`. Expected **8** `auth_rls_initplan` WARN and
**3** `unindexed_foreign_keys` INFO — unchanged. **A ninth WARN means the new policy was written
with a bare `auth.uid()`**; fix it before going on.

- [ ] **Step 5: Commit**

`Delete statuses safely and resolve new ticket status from is_initial (SPRIN-80)`

---

## Task 5: The Delete control and its confirmation

**Files:**
- Modify: `src/routes/StatusSettings.tsx`
- Test: `src/routes/StatusSettings.test.tsx`

**Interfaces:**
- Consumes: `deleteProjectStatus`, `removeStatus`, `deleteBlockReason` from `@/lib/project-statuses`;
  the `AlertDialog` set from `@/components/ui/alert-dialog` (see `TicketActionDialogs.tsx:92-121`
  for the established destructive-confirm shape).
- Produces: `StatusSettings` gains two props —
  `counts: ReadonlyMap<string, number>` and `onDeleted: (id: string) => void`.

- [ ] **Step 1: Write the failing component tests**

Rows are located by **their Delete button's `aria-label`** (a single `aria-label`, so it is safe to
name exactly) and then walked up to the `<li>`. Do **not** use
`getByRole('listitem', { name: /to do/i })`: a listitem's accessible name is computed from its
composed children, which is precisely the jsdom-vs-browser fusion SPRIN-67 established is not real.

```tsx
/** The row containing a given status's controls. Anchored on the Delete button's aria-label —
 *  one text node, one element, no composed name — then scoped with `within`. */
function rowFor(name: string): HTMLElement {
  const button = screen.getByRole('button', { name: `Delete ${name}` })
  const row = button.closest('li')
  if (!row) throw new Error(`No row found for "${name}"`)
  return row
}

it('shows each status ticket count', () => {
  renderSettings({ counts: new Map([['todo', 4]]) })
  expect(within(rowFor('To Do')).getByText('4 tickets')).toBeInTheDocument()
})

it('disables Delete on a status holding tickets, and states the reason', () => {
  renderSettings({ counts: new Map([['todo', 4]]) })
  const row = rowFor('To Do')
  expect(within(row).getByRole('button', { name: 'Delete To Do' })).toBeDisabled()
  expect(within(row).getByText(/holds 4 tickets/i)).toBeInTheDocument()
})

it('disables Delete on the last remaining status, and states the reason', () => {
  renderSettings({ statuses: [todoStatus], counts: new Map([['todo', 0]]) })
  const row = rowFor('To Do')
  expect(within(row).getByRole('button', { name: 'Delete To Do' })).toBeDisabled()
  expect(within(row).getByText(/at least one status/i)).toBeInTheDocument()
})

it('names the status that will take over when deleting the initial one', async () => {
  renderSettings({ counts: new Map() })
  await userEvent.click(screen.getByRole('button', { name: 'Delete To Do' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent(/will start in/i)
  expect(dialog).toHaveTextContent(/in progress/i)
})

it('calls onDeleted after a successful delete', async () => {
  vi.mocked(deleteProjectStatus).mockResolvedValue({ ok: true, value: undefined })
  const onDeleted = vi.fn()
  renderSettings({ counts: new Map(), onDeleted })
  await userEvent.click(screen.getByRole('button', { name: 'Delete In Review' }))
  // Scoped to the dialog: an unscoped /delete/i would match every row's button too.
  const dialog = await screen.findByRole('alertdialog')
  await userEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }))
  await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('s3'))
})

it('surfaces a has_tickets refusal without calling onDeleted', async () => {
  vi.mocked(deleteProjectStatus).mockResolvedValue({ ok: false, error: 'has_tickets' })
  const onDeleted = vi.fn()
  renderSettings({ counts: new Map(), onDeleted })
  await userEvent.click(screen.getByRole('button', { name: 'Delete In Review' }))
  const dialog = await screen.findByRole('alertdialog')
  await userEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/move them/i)
  expect(onDeleted).not.toHaveBeenCalled()
})
```

**Two name-matching rules, both from SPRIN-67 and both load-bearing:** a regex must be written as
a regex (`/^delete$/i`, never the string `'^Delete$'`, which matches a literal caret); and never
assert an *exact* accessible name on an element whose name is composed from several `<span>`
children, because under jsdom those fuse into a string no browser produces.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/routes/StatusSettings.test.tsx`
Expected: FAIL — no Delete button exists.

- [ ] **Step 3: Implement**

Add to `StatusRow`: the count text, a `Delete` button (`variant="outline"`, `aria-label={`Delete
${status.name}`}`), disabled when `deleteBlockReason(...)` is non-null, with that reason rendered
beneath. Add an `AlertDialog` mirroring `TicketDeleteDialog`, whose description names the promoted
status when `status.is_initial` — derive that name from `removeStatus(statuses, status.id)` rather
than re-implementing the promotion rule.

**Watch the thresholds.** `StatusRow` will approach 30 lines and cyclomatic 10. If it does,
extract the dialog into its own `StatusDeleteDialog` component in the same file — do **not**
add an eslint disable, and do **not** widen a threshold.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/routes/StatusSettings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

`Add a guarded Delete control to the status settings list (SPRIN-80)`

---

## Task 6: Wire the counts fetch and the delete through the shell

**Files:**
- Modify: `src/routes/SettingsTab.tsx`
- Modify: `src/routes/ProjectShell.tsx`
- Test: `src/routes/SettingsTab.test.tsx`, `src/routes/ProjectShell.test.tsx`

**Interfaces:**
- Consumes: `ticketCountsByStatus`, `removeStatus` from `@/lib/project-statuses`;
  `statusRead.patch(projectId, fn)` in `ProjectShell`.
- Produces: `ProjectShellContext` gains `onStatusDeleted: (id: string) => void`.

- [ ] **Step 1: Write the failing tests**

```tsx
// SettingsTab
it('fetches ticket counts for the project statuses and passes them down', async () => {
  vi.mocked(ticketCountsByStatus).mockResolvedValue(new Map([['todo', 3]]))
  renderTab()
  expect(await screen.findByText('3 tickets')).toBeInTheDocument()
})

it('does not claim a count of zero when the count read fails', async () => {
  vi.mocked(ticketCountsByStatus).mockRejectedValue(new Error('down'))
  renderTab()
  // Delete stays blocked rather than unlocking on a count we do not have.
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: /^delete /i })[0]).toBeDisabled(),
  )
})

// ProjectShell
it('removes a deleted status from the shared list and promotes the next initial', () => {
  // Drive onStatusDeleted through the context and assert the board loses the column.
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/routes/SettingsTab.test.tsx src/routes/ProjectShell.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `ProjectShell.tsx`, add **exactly this**, beside the other status reducers — it must add **zero
branches**, because the file is at cyclomatic 10 of 10:

```ts
// The promotion the AFTER DELETE trigger performs, mirrored locally. Branch-free HERE on
// purpose: the rule lives in `removeStatus`, because a ternary in this file would push
// ProjectShell past its cyclomatic budget and redden `npm run lint`.
const onStatusDeleted = (id: string) =>
  statusRead.patch(project.id, (ss) => removeStatus(ss, id))
```

Add `onStatusDeleted` to `ProjectShellContext` and to the context object passed to `<Outlet>`.

In `SettingsTab.tsx`, fetch the counts with the codebase's existing set-state-in-effect idiom,
keyed on `project.id` and the status list, and pass `counts` and `onDeleted={onStatusDeleted}`
into `StatusSettings`. **Counts default to an empty map on failure, which leaves every Delete
blocked** — the failure must not read as zero.

If `SettingsTab` approaches a threshold, extract the fetch into a `useTicketCounts` hook rather
than widening anything.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/routes/SettingsTab.test.tsx src/routes/ProjectShell.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

`Wire status deletion through the settings tab and project shell (SPRIN-80)`

---

## Task 7: Full verification and the PR

- [ ] **Step 1: Re-derive the tripwire**

```bash
npx vitest list --filesOnly | grep -c .
npx vitest list --filesOnly --exclude '**/*.integration.test.ts' | grep -c .
```
Expected: **60** and **53** — unchanged, because this plan adds no test files. A different number
means a new test file was created; move those tests into the existing suite.

- [ ] **Step 2: Run the real gate**

Run: `npm run verify`
Expected: PASS. Not `tsc --noEmit`, not a subset.

If a live suite fails, classify before re-running. Only three signatures are transient: the bare
`TypeError: Cannot read properties of null (reading 'id')` in a `beforeAll`; the ES256
`unrecognized JWT kid`; and `AuthRetryableFetchError` with `status: 0` / `ECONNRESET`. **Anything
else is real** — do not re-run it away, and never weaken a suite to make it pass.

- [ ] **Step 3: Update the stale SPRIN-77 comment**

`src/test/rls.integration.test.ts:582-587` says "project_statuses has no DELETE policy, so a
skipped cascade leaves rows that no client of this application can ever remove." That stops being
true in this story. Correct it rather than leaving a confidently wrong comment behind.

- [ ] **Step 4: Push and open the PR**

Push `sprin-80-delete-status`, open one PR, move SPRIN-80 to **In Review**. Then **watch CI and
diagnose any red before doing anything else** — a red required `verify` blocks the merge.

- [ ] **Step 5: Review depth — ask, do not assume**

This diff adds an **RLS policy** and three **`SECURITY DEFINER`** functions, which is squarely in
the project's security-boundary category, where the standing rule is a deep multi-agent review
with each finding adversarially verified rather than a single reviewer. **Ask David which he
wants** before dispatching either. If a fleet is dispatched: every mutating reviewer gets its own
worktree (`isolation: "worktree"`), each dispatch names the exact SHA and the verification
command, reviewers are asked to **mutate rather than read**, and the **KILLED findings get read**,
not just the survivors.

---

## Definition of Done

- All ACs covered by a test that fails when the behaviour is removed.
- `npm run verify` green in CI on the PR's own head commit; tripwire 60/53, GAP 7.
- Migration applied; `get_advisors` shows no new lint against the measured 8 WARN / 3 INFO baseline.
- `docs/sprintboard_phase1_schema.sql` matches the live database.
- One PR, squash merged. SPRIN-80 → Done **after** merge, which closes epic SPRIN-72.
