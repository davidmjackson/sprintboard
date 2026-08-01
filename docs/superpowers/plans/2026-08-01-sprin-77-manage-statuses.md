# SPRIN-77 — Manage a project's statuses (add, rename, reorder) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to
> implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a project owner add, rename and reorder their project's statuses from a settings
tab, with the board column order following, and move the hardcoded `'done'` slug onto
`project_statuses.category` first.

**Architecture:** The database half is **already applied live** (see
`docs/migrations/sprin-77-status-writes.sql`). This plan is the client half: a write layer in
`src/lib/project-statuses.ts` returning tagged results, zod schemas in a new
`src/lib/status-schemas.ts`, the `'done'` → `category` move across `sprints.ts` /
`ProjectShell.tsx`, and a fourth `/settings` tab.

**Tech Stack:** React 19, react-router-dom, TypeScript strict, zod, Tailwind, shadcn/ui,
Vitest + Testing Library, Supabase JS.

---

## Global Constraints

Every task's requirements implicitly include all of these.

- **Verification is `npm run verify`.** Never `npx tsc --noEmit` — it checks **zero files** in
  this repo and still exits 0. Never a hand-picked subset of test files.
- **Lint thresholds T1–T5 are ERRORS and gate the merge:** 30-line functions, cyclomatic 10,
  cognitive 15, **4 parameters**, 400-line files. Write to them from the first line.
  `TicketDetailDialog` already sits at cyclomatic 10 of 10 — do not touch it.
  **ESLint counts each default parameter as a branch.**
- **Never inline a status name, slug or category literal in a component.** Status/type/column
  definitions live in `src/lib/domain.ts` and the `project_statuses` rows, nowhere else.
  `'done'` as a *category* value comes from `STATUS_CATEGORIES` / the `doneSlugs` helper.
- **`TicketStatus` is `string` and must stay `string`.** Never re-narrow it to a union — the
  vocabulary is per-project. Same for any new status-slug type.
- **Never use a Postgres ENUM.** Not relevant to this plan's files, but it is the single most
  damaging change available in this repo.
- **Accessible names:** never assert an *exact* accessible name on an element whose name is
  composed from several children (all Tailwind-styled components). Use substring/regex name
  queries, plus `within(container)`-scoped DOM-text assertions. Exact names are fine when the
  name comes from a single text node or an `aria-label`.
- **`toHaveClass` is a subset check** — `sr-only hidden` passes `toHaveClass('sr-only')`.
  Assert the exact class for a span whose whole job is to be `sr-only`.
- **Do not add a new `*.integration.test.ts` file.** The tripwire GAP between `npm test` and
  `npm run test:unit` must stay **exactly 7**. New live coverage extends an existing suite.
- **Commit messages:** imperative summary. Write the message to a file and use
  `git commit -F <file>` — never a heredoc.
- **The plan's code below is a STARTING POINT, not gospel.** Deviating to match an established
  repo pattern is correct. Report every deviation. Prefer reporting BLOCKED over inventing.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/status-schemas.ts` **(new)** | zod rules for the add and rename forms |
| `src/lib/project-statuses.ts` **(modify)** | reads (existing) + `slugForName`, `doneSlugs`, and the three write functions |
| `src/lib/sprints.ts` **(modify)** | `completeSprint` takes the terminal-slug set |
| `src/routes/CompleteSprintButton.tsx` **(modify)** | passes it through |
| `src/routes/SprintsTab.tsx` **(modify)** | derives it once from context |
| `src/routes/ProjectShell.tsx` **(modify)** | `'done'` → category in the reducer; three new status reducers on the context |
| `src/routes/ProjectShellHeader.tsx` **(modify)** | fourth `NavLink` |
| `src/App.tsx` **(modify)** | `/settings` route |
| `src/routes/SettingsTab.tsx` **(new)** | thin context-reading shell |
| `src/routes/StatusSettings.tsx` **(new)** | the list, add form, rename, reorder |
| `src/test/rls.integration.test.ts` **(modify)** | live coverage of the new policies |
| `docs/sprintboard_phase1_schema.sql` **(modify)** | record the new policies, index and RPC |

---

## Task 1: The write layer and its schemas

**Files:**
- Create: `src/lib/status-schemas.ts`, `src/lib/status-schemas.test.ts`
- Modify: `src/lib/project-statuses.ts`, `src/lib/project-statuses.test.ts`

**Interfaces:**
- Consumes: `ProjectStatus`, `StatusCategory`, `STATUS_CATEGORIES` from `@/lib/domain`;
  `supabase` from `@/lib/supabase`.
- Produces, and later tasks depend on these EXACT names and signatures:

```ts
export function slugForName(name: string): string | null
export function uniqueSlugForName(name: string, taken: readonly string[]): string | null
export function doneSlugs(statuses: readonly ProjectStatus[]): Set<string>

export type StatusWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'duplicate' | 'unknown' }

export function createProjectStatus(input: {
  projectId: string
  name: string
  category: StatusCategory
  existing: readonly ProjectStatus[]
}): Promise<StatusWriteResult<ProjectStatus>>

export function renameProjectStatus(id: string, name: string): Promise<StatusWriteResult<ProjectStatus>>

export function reorderProjectStatuses(
  projectId: string,
  orderedSlugs: readonly string[],
): Promise<StatusWriteResult<ProjectStatus[]>>

// status-schemas.ts
export const AddStatusSchema: z.ZodType<{ name: string; category: StatusCategory }>
export const RenameStatusSchema: z.ZodType<{ name: string }>
export type AddStatusValues = z.input<typeof AddStatusSchema>
```

**Note on the parameter limit:** `createProjectStatus` takes **one object**, not four
positional parameters — T4 caps parameters at 4 and an object is the repo's existing idiom
(`createProject({ ownerId, name, key })`).

- [ ] **Step 1: Write the failing tests for `slugForName` / `uniqueSlugForName`**

Add to `src/lib/project-statuses.test.ts`. The existing mock harness at the top of that file
stays as it is; these are pure functions and need no mock.

```ts
describe('slugForName', () => {
  it('lowercases and joins words with underscores', () => {
    expect(slugForName('Ready For QA')).toBe('ready_for_qa')
  })

  it('collapses runs of punctuation and strips the edges', () => {
    expect(slugForName('  Ready -- for  QA!! ')).toBe('ready_for_qa')
  })

  it('truncates to the 30 characters the slug_format check allows', () => {
    // The DB check is ^[a-z][a-z0-9_]{0,29}$ — 30 characters total.
    const slug = slugForName('a'.repeat(50))
    expect(slug).toHaveLength(30)
  })

  // Truncation must not leave a trailing underscore-run that the strip would have removed.
  it('does not end in an underscore after truncating', () => {
    expect(slugForName('abcdefghijklmnopqrstuvwxyzabc def')).not.toMatch(/_$/)
  })

  it('returns null when the name cannot produce a slug starting with a letter', () => {
    expect(slugForName('42')).toBeNull()
    expect(slugForName('!!!')).toBeNull()
    expect(slugForName('   ')).toBeNull()
  })
})

describe('uniqueSlugForName', () => {
  it('returns the plain slug when nothing has taken it', () => {
    expect(uniqueSlugForName('To Do', ['done'])).toBe('to_do')
  })

  // Two DIFFERENT names can derive to ONE slug ("To Do" / "To-Do"), and the
  // duplicate-NAME index does not catch that — these are different names.
  it('suffixes until free when a different name already took the slug', () => {
    expect(uniqueSlugForName('To-Do', ['to_do'])).toBe('to_do_2')
    expect(uniqueSlugForName('To-Do', ['to_do', 'to_do_2'])).toBe('to_do_3')
  })

  it('keeps the suffixed slug inside the 30-character limit', () => {
    const taken = ['a'.repeat(30)]
    const slug = uniqueSlugForName('a'.repeat(50), taken)
    expect(slug!.length).toBeLessThanOrEqual(30)
  })

  it('returns null when the name has no derivable slug at all', () => {
    expect(uniqueSlugForName('42', [])).toBeNull()
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/project-statuses.test.ts`
Expected: FAIL — `slugForName is not a function` (an import error, not an assertion failure).

- [ ] **Step 3: Implement the two slug functions**

Append to `src/lib/project-statuses.ts`:

```ts
/** The DB's project_statuses_slug_format check: ^[a-z][a-z0-9_]{0,29}$ — 30 chars total. */
const SLUG_MAX = 30

/**
 * The machine identity derived from a display name. Users rename `name`, never `slug` — the
 * same division `projects.key` already uses, and the reason a rename never rewrites a ticket
 * row: `tickets_status_fk` references (project_id, slug).
 *
 * Returns `null` rather than a best-effort string when the name cannot produce a legal slug
 * (it starts with a digit, or is all punctuation). The caller reports a field error; sending
 * it would earn a constraint violation naming a column the user has never seen.
 *
 * The truncate happens BEFORE the edge strip, so a 30-character cut landing mid-underscore
 * cannot leave a trailing `_` and fail the check it was trying to satisfy.
 */
export function slugForName(name: string): string | null {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .slice(0, SLUG_MAX)
    .replace(/^_+|_+$/g, '')

  return /^[a-z][a-z0-9_]{0,29}$/.test(slug) ? slug : null
}

/**
 * `slugForName` plus collision avoidance within one project.
 *
 * Two DIFFERENT names can derive to ONE slug — "To Do" and "To-Do" both give `to_do` — and the
 * duplicate-NAME index does not catch that, because those are not duplicate names. The
 * `project_statuses_project_slug_unique` constraint would, as a 23505 the user cannot act on.
 * So the suffix is applied client-side; the constraint remains the backstop for the race.
 *
 * The suffix is applied INSIDE the length limit, not appended past it.
 */
export function uniqueSlugForName(name: string, taken: readonly string[]): string | null {
  const base = slugForName(name)
  if (base === null) return null
  if (!taken.includes(base)) return base

  for (let n = 2; n <= 99; n++) {
    const suffix = `_${n}`
    const candidate = base.slice(0, SLUG_MAX - suffix.length) + suffix
    if (!taken.includes(candidate)) return candidate
  }
  return null
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/lib/project-statuses.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing test for `doneSlugs`**

```ts
describe('doneSlugs', () => {
  it('selects exactly the rows whose category is done, by slug', () => {
    const rows = [
      { slug: 'triage', category: 'todo' },
      { slug: 'shipped', category: 'done' },
      { slug: 'live', category: 'done' },
    ] as unknown as ProjectStatus[]
    expect(doneSlugs(rows)).toEqual(new Set(['shipped', 'live']))
  })

  // The empty set is a REAL state, not an error: a project with nothing terminal has
  // nothing complete, so every ticket is incomplete. sprints.ts depends on this.
  it('returns an empty set when no status is terminal', () => {
    const rows = [{ slug: 'triage', category: 'todo' }] as unknown as ProjectStatus[]
    expect(doneSlugs(rows).size).toBe(0)
  })

  // The slug 'done' is NOT what makes a status terminal — the category is. A renamed or
  // re-categorised row must follow the category, which is the whole point of this story.
  it('ignores a status whose SLUG is done but whose category is not', () => {
    const rows = [{ slug: 'done', category: 'in_progress' }] as unknown as ProjectStatus[]
    expect(doneSlugs(rows).size).toBe(0)
  })
})
```

- [ ] **Step 6: Run it, watch it fail, implement, watch it pass**

```ts
/**
 * The project's terminal statuses, by slug.
 *
 * ONE exported derivation, used by the sprint-completion DB filter, the shell's optimistic
 * reducer and the tests alike. The correctness argument in `completeSprint`'s docblock rests
 * on the database's rule and the client's local patch being THE SAME RULE — two independent
 * derivations could drift, one cannot.
 *
 * Before SPRIN-77 both sites hardcoded the slug `'done'`. That was only true while the
 * vocabulary was immutable; a user-added terminal status would have had its tickets dragged
 * back to the backlog on sprint completion.
 */
export function doneSlugs(statuses: readonly ProjectStatus[]): Set<string> {
  return new Set(statuses.filter((s) => s.category === 'done').map((s) => s.slug))
}
```

Run: `npx vitest run src/lib/project-statuses.test.ts` — Expected: PASS.

- [ ] **Step 7: Write `src/lib/status-schemas.ts` and its failing test**

`src/lib/status-schemas.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { AddStatusSchema, RenameStatusSchema } from './status-schemas'

describe('AddStatusSchema', () => {
  it('accepts a name and a category', () => {
    expect(AddStatusSchema.safeParse({ name: 'Ready for QA', category: 'in_progress' }).success).toBe(true)
  })

  it('trims, so surrounding space cannot smuggle a name past the length rule', () => {
    const parsed = AddStatusSchema.parse({ name: '  Ready  ', category: 'todo' })
    expect(parsed.name).toBe('Ready')
  })

  it('rejects a name that is empty after trimming', () => {
    expect(AddStatusSchema.safeParse({ name: '   ', category: 'todo' }).success).toBe(false)
  })

  // 40 is project_statuses_name_nonempty's `length(name) <= 40`. Pinned AT the boundary:
  // 40 passes, 41 fails. A one-sided test would not notice an off-by-one.
  it('accepts exactly 40 characters and rejects 41', () => {
    expect(AddStatusSchema.safeParse({ name: 'a'.repeat(40), category: 'todo' }).success).toBe(true)
    expect(AddStatusSchema.safeParse({ name: 'a'.repeat(41), category: 'todo' }).success).toBe(false)
  })

  it('rejects a category outside the three the check constraint allows', () => {
    expect(AddStatusSchema.safeParse({ name: 'QA', category: 'blocked' }).success).toBe(false)
  })
})

describe('RenameStatusSchema', () => {
  it('applies the same name rule', () => {
    expect(RenameStatusSchema.safeParse({ name: '' }).success).toBe(false)
    expect(RenameStatusSchema.safeParse({ name: 'In QA' }).success).toBe(true)
  })
})
```

- [ ] **Step 8: Implement `src/lib/status-schemas.ts`**

```ts
import { z } from 'zod'

import { STATUS_CATEGORIES } from './domain'

/**
 * The status add/rename form rules — the client edge of CLAUDE.md's validate-at-both-edges.
 *
 * The 40-character cap and the trim both mirror the database's
 * `project_statuses_name_nonempty` check (`btrim(name) <> '' and length(name) <= 40`), so a
 * name this schema accepts is one the database accepts. Uniqueness is deliberately NOT here:
 * it is not knowable client-side without a race, so it is the index's job and surfaces as a
 * `'duplicate'` write result.
 */
const name = z
  .string()
  .trim()
  .min(1, 'Give the status a name')
  .max(40, 'Keep the name to 40 characters or fewer')

// Spread from the shared constant rather than re-listing the three values: a fourth category
// must not be addable here without the database's check constraint agreeing.
const category = z.enum(STATUS_CATEGORIES)

export const AddStatusSchema = z.object({ name, category })
export const RenameStatusSchema = z.object({ name })

export type AddStatusValues = z.input<typeof AddStatusSchema>
```

Run: `npx vitest run src/lib/status-schemas.test.ts` — Expected: PASS.

- [ ] **Step 9: Write the failing tests for the three write functions**

Extend the mock harness in `src/lib/project-statuses.test.ts`. The existing harness only wires
`select().eq().order()`; add `insert`, `update` and `rpc` chains alongside it, and add `rpc` to
the `vi.mock` factory:

```ts
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }))
```

```ts
describe('createProjectStatus', () => {
  const existing = [
    { slug: 'todo', name: 'To Do', category: 'todo', position: 1 },
    { slug: 'done', name: 'Done', category: 'done', position: 2 },
  ] as unknown as ProjectStatus[]

  it('appends at max(position) + 1 so an add never reorders the board', async () => {
    single.mockResolvedValue({ data: { slug: 'qa' }, error: null })

    await createProjectStatus({ projectId: 'p1', name: 'QA', category: 'in_progress', existing })

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'p1', slug: 'qa', name: 'QA', position: 3 }),
    )
  })

  // is_initial is sent EXPLICITLY, not left to the column default: the default is the thing
  // SPRIN-80 changes, and this row must not silently follow it.
  it('sends is_initial false explicitly', async () => {
    single.mockResolvedValue({ data: { slug: 'qa' }, error: null })
    await createProjectStatus({ projectId: 'p1', name: 'QA', category: 'in_progress', existing })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ is_initial: false }))
  })

  it('maps 23505 to duplicate, so the form can point at the name field', async () => {
    single.mockResolvedValue({ data: null, error: { code: '23505', message: 'dup' } })
    await expect(
      createProjectStatus({ projectId: 'p1', name: 'Done', category: 'todo', existing }),
    ).resolves.toEqual({ ok: false, error: 'duplicate' })
  })

  it('maps any other error to unknown', async () => {
    single.mockResolvedValue({ data: null, error: { code: '08006', message: 'boom' } })
    await expect(
      createProjectStatus({ projectId: 'p1', name: 'QA', category: 'todo', existing }),
    ).resolves.toEqual({ ok: false, error: 'unknown' })
  })

  it('fails as duplicate WITHOUT a request when the name yields no legal slug', async () => {
    const result = await createProjectStatus({ projectId: 'p1', name: '42', category: 'todo', existing })
    expect(result).toEqual({ ok: false, error: 'unknown' })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('renameProjectStatus', () => {
  it('updates ONLY name — slug is the fk target and is not client-writable', async () => {
    single.mockResolvedValue({ data: { slug: 'qa', name: 'In QA' }, error: null })
    await renameProjectStatus('s1', 'In QA')
    expect(update).toHaveBeenCalledWith({ name: 'In QA' })
    expect(eqUpdate).toHaveBeenCalledWith('id', 's1')
  })

  it('maps 23505 to duplicate', async () => {
    single.mockResolvedValue({ data: null, error: { code: '23505', message: 'dup' } })
    await expect(renameProjectStatus('s1', 'Done')).resolves.toEqual({ ok: false, error: 'duplicate' })
  })
})

describe('reorderProjectStatuses', () => {
  it('calls the RPC with the COMPLETE ordered slug list', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: [], error: null } as never)

    await reorderProjectStatuses('p1', ['done', 'todo'])

    expect(supabase.rpc).toHaveBeenCalledWith('reorder_project_statuses', {
      p_project_id: 'p1',
      p_slugs: ['done', 'todo'],
    })
  })

  it('maps an error to unknown', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: { message: 'boom' } } as never)
    await expect(reorderProjectStatuses('p1', ['todo'])).resolves.toEqual({ ok: false, error: 'unknown' })
  })
})
```

- [ ] **Step 10: Run, watch fail, implement the three write functions**

```ts
/**
 * Writes return a tagged result rather than throwing, matching `createProject` and
 * `startSprint`: a duplicate name is an expected, user-correctable outcome, not an exception.
 *
 * `23505` is the only code mapped, and within this table it can only mean the
 * `project_statuses_project_name_unique` index (AC4) or the slug unique constraint — both of
 * which the user fixes by choosing a different name, so one tag serves both.
 */
export type StatusWriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: 'duplicate' | 'unknown' }

export async function createProjectStatus(input: {
  projectId: string
  name: string
  category: StatusCategory
  existing: readonly ProjectStatus[]
}): Promise<StatusWriteResult<ProjectStatus>> {
  const slug = uniqueSlugForName(
    input.name,
    input.existing.map((s) => s.slug),
  )
  if (slug === null) return { ok: false, error: 'unknown' }

  // Append. NOT derived from the list length — a project whose positions are 1,2,5 must not
  // produce another 5. max+1 is the only value that is free by construction.
  const position = input.existing.reduce((max, s) => Math.max(max, s.position), 0) + 1

  const { data, error } = await supabase
    .from('project_statuses')
    .insert({
      project_id: input.projectId,
      slug,
      name: input.name,
      category: input.category,
      position,
      is_initial: false,
    })
    .select()
    .single()

  if (error) return { ok: false, error: error.code === '23505' ? 'duplicate' : 'unknown' }
  return { ok: true, value: data as ProjectStatus }
}

/**
 * Rename. `name` is the ONLY column sent, and that is a security property rather than
 * tidiness: `authenticated` holds UPDATE on exactly (name, category, position), so a patch
 * touching `slug` is refused by Postgres before any policy is consulted. Sending only what
 * changes keeps the request inside that grant.
 */
export async function renameProjectStatus(
  id: string,
  name: string,
): Promise<StatusWriteResult<ProjectStatus>> {
  const { data, error } = await supabase
    .from('project_statuses')
    .update({ name })
    .eq('id', id)
    .select()
    .single()

  if (error) return { ok: false, error: error.code === '23505' ? 'duplicate' : 'unknown' }
  return { ok: true, value: data as ProjectStatus }
}

/**
 * Reorder, through an RPC rather than N patches.
 *
 * `project_statuses_project_position_unique` is DEFERRABLE INITIALLY DEFERRED, and that
 * deferral only helps within ONE transaction. PostgREST gives each request its own, so N
 * separate `PATCH position=` calls collide on the very first swap. One statement inside one
 * function is the only shape where the deferral does its job.
 *
 * The list must be COMPLETE and in the intended order: the function assigns `ordinality`, so
 * a partial list would leave the omitted rows on their old positions and could collide at
 * commit. Callers pass every slug the project has.
 */
export async function reorderProjectStatuses(
  projectId: string,
  orderedSlugs: readonly string[],
): Promise<StatusWriteResult<ProjectStatus[]>> {
  const { data, error } = await supabase.rpc('reorder_project_statuses', {
    p_project_id: projectId,
    p_slugs: orderedSlugs as string[],
  })

  if (error) return { ok: false, error: 'unknown' }
  return { ok: true, value: (data ?? []) as ProjectStatus[] }
}
```

**If `supabase.rpc` is not typed for this function name**, the generated
`src/lib/database.types.ts` does not yet know it. Regenerate it if the repo has a script for
that; otherwise a single narrowly-scoped cast at the call site is acceptable — **report this
as a deviation** either way.

- [ ] **Step 11: Run the FULL gate**

Run: `npm run verify`
Expected: PASS, 0 lint errors, 0 warnings.

- [ ] **Step 12: Commit**

```bash
git add src/lib/status-schemas.ts src/lib/status-schemas.test.ts src/lib/project-statuses.ts src/lib/project-statuses.test.ts
git commit -F <message-file>
```

---

## Task 2: Move `'done'` off the slug and onto `category`

This is the prerequisite `domain.ts:44-47` and the schema doc both name. **Both sites move
together** — neither is useful alone.

**Files:**
- Modify: `src/lib/sprints.ts` (~line 222), `src/lib/sprints.test.ts`
- Modify: `src/routes/CompleteSprintButton.tsx`, `src/routes/CompleteSprintButton.test.tsx`
- Modify: `src/routes/SprintsTab.tsx`, `src/routes/SprintsTab.test.tsx`
- Modify: `src/routes/ProjectShell.tsx` (~line 161-171), `src/routes/ProjectShell.test.tsx`
- Modify: `src/lib/domain.ts` (the `StatusCategory` docblock — delete the now-satisfied
  "SPRIN-77 must move …" instruction and record that it HAS moved)

**Interfaces:**
- Consumes: `doneSlugs` from Task 1.
- Produces:
```ts
export function completeSprint(id: string, terminalSlugs: ReadonlySet<string>): Promise<CompleteSprintResult>
// CompleteSprintButton gains prop: terminalSlugs: ReadonlySet<string>
```

- [ ] **Step 1: Write the failing tests in `src/lib/sprints.test.ts`**

```ts
it('excludes the project\'s TERMINAL statuses from the backlog return, by category not slug', async () => {
  await completeSprint('s1', new Set(['shipped', 'live']))
  expect(not).toHaveBeenCalledWith('status', 'in', '(shipped,live)')
})

// A project with nothing terminal has nothing complete, so EVERY ticket returns. Emitting
// `in ()` would be malformed SQL — the filter must be omitted entirely.
it('applies NO status filter at all when the project has no terminal status', async () => {
  await completeSprint('s1', new Set())
  expect(not).not.toHaveBeenCalled()
})

// The literal slug 'done' must no longer be special.
it('returns a ticket whose slug is done when done is NOT a terminal category', async () => {
  await completeSprint('s1', new Set(['shipped']))
  expect(not).toHaveBeenCalledWith('status', 'in', '(shipped)')
})
```

- [ ] **Step 2: Run, watch fail, implement in `src/lib/sprints.ts`**

```ts
export async function completeSprint(
  id: string,
  terminalSlugs: ReadonlySet<string>,
): Promise<CompleteSprintResult> {
  const guard = await requireSprintStatus(id, 'active')
  if (!guard.ok) return guard

  // The "incomplete" rule, which as of SPRIN-77 is CATEGORY-based rather than the literal
  // slug 'done'. Terminal tickets keep their sprint_id (that retained id IS the sprint
  // history AC3 asks for) and their status — we never touch them.
  //
  // An EMPTY set is a real state, not an error: a project with no done-category status has
  // nothing terminal, so every ticket is incomplete and every one returns to the backlog.
  // `in ()` is malformed, so the filter is omitted entirely — which produces exactly that.
  //
  // The raw join is safe because project_statuses_slug_format constrains every slug to
  // ^[a-z][a-z0-9_]{0,29}$: there is no comma, paren or quote in a slug to escape. The check
  // constraint is what makes this safe, not the caller's good manners.
  const base = supabase.from('tickets').update({ sprint_id: null } satisfies TicketUpdate).eq('sprint_id', id)
  const filtered =
    terminalSlugs.size > 0 ? base.not('status', 'in', `(${[...terminalSlugs].join(',')})`) : base

  const { data: moved, error: ticketsError } = await filtered.select()
  // ... rest unchanged
}
```

- [ ] **Step 3: Thread the prop through `CompleteSprintButton` and `SprintsTab`**

`CompleteSprintButton` gains `terminalSlugs: ReadonlySet<string>` and passes it to
`completeSprint(sprint.id, terminalSlugs)`. `SprintsTab` derives it **once** from the context
it already reads:

```ts
const terminalSlugs = doneSlugs(statuses)
```

and passes it to each rendered `CompleteSprintButton`.

- [ ] **Step 4: Move `ProjectShell.tsx`'s reducer onto the same helper**

```ts
const onSprintCompleted = (updated: Sprint, returnedTickets: Ticket[]) => {
  sprintRead.patch(project.id, (ss) => ss.map((s) => (s.id === updated.id ? updated : s)))
  // The SAME rule the database applied, from the SAME derivation (`doneSlugs`) the DB filter
  // used — see completeSprint. Two independent derivations of "terminal" could drift; one
  // cannot, and this patch's idempotency argument depends on them agreeing.
  const terminal = doneSlugs(statuses)
  const returnedById = new Map(returnedTickets.map((t) => [t.id, t]))
  ticketRead.patch(project.id, (ts) =>
    ts.map(
      (t) =>
        returnedById.get(t.id) ??
        (t.sprint_id === updated.id && !terminal.has(t.status) ? { ...t, sprint_id: null } : t),
    ),
  )
}
```

- [ ] **Step 5: Write the shell test that proves the category drives it**

```ts
// The point of the whole story: a status named/slugged anything, categorised done, is terminal.
it('leaves a ticket on a NON-done-slugged terminal status attached to the sprint', () => {
  // statuses fixture: [{ slug: 'shipped', category: 'done' }, ...]
  // ticket on 'shipped' must KEEP its sprint_id after onSprintCompleted.
})

it('is idempotent when re-applied with an empty returnedTickets list', () => {
  // The fail-then-retry path: the DB already moved the ticket and returned [] on the retry.
})
```

- [ ] **Step 6: Update the `StatusCategory` docblock in `src/lib/domain.ts`**

Delete the "SPRIN-77 must move …" instruction — it is now satisfied, and a stale instruction
reads as outstanding work. Replace it with what is now true: the category **is** the terminal
rule, `doneSlugs` in `project-statuses.ts` is its single derivation, and re-inlining the slug
`'done'` anywhere would silently break user-added terminal statuses.

- [ ] **Step 7: `npm run verify`, then commit**

---

## Task 3: The settings tab

**Files:**
- Create: `src/routes/SettingsTab.tsx`, `src/routes/SettingsTab.test.tsx`,
  `src/routes/StatusSettings.tsx`, `src/routes/StatusSettings.test.tsx`
- Modify: `src/App.tsx` (add `<Route path="settings" element={<SettingsTab />} />` inside the
  `/projects/:projectId` route), `src/routes/ProjectShellHeader.tsx` (fourth `NavLink`),
  `src/routes/ProjectShell.tsx` (three new context reducers)

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces, on `ProjectShellContext`:
```ts
onStatusCreated: (status: ProjectStatus) => void
onStatusUpdated: (status: ProjectStatus) => void
onStatusesReordered: (statuses: ProjectStatus[]) => void
```

- [ ] **Step 1: Add the three reducers to `ProjectShell.tsx`**

Local mutations via `statusRead.patch`, never a refetch — same rule as every other reducer in
that file, and for the same reason (an unguarded refetch resolving after a project switch
clobbers the new project's list).

```ts
// Append: a new status always takes max(position)+1, so appending keeps the column order the
// board renders. Same shape as onTicketCreated.
const onStatusCreated = (status: ProjectStatus) =>
  statusRead.patch(project.id, (ss) => [...ss, status])

// Replace by id. A rename touches exactly one row and no other row's position.
const onStatusUpdated = (updated: ProjectStatus) =>
  statusRead.patch(project.id, (ss) => ss.map((s) => (s.id === updated.id ? updated : s)))

// Reorder returns the DATABASE's own post-update rows (the RPC's RETURNING), not a guess —
// same discipline as onSprintCompleted's returnedTickets. Merge by id and re-sort by
// position, because `position` order IS the board's column order and the RPC returns rows in
// no guaranteed order.
const onStatusesReordered = (rows: ProjectStatus[]) => {
  const byId = new Map(rows.map((s) => [s.id, s]))
  statusRead.patch(project.id, (ss) =>
    [...ss.map((s) => byId.get(s.id) ?? s)].sort((a, b) => a.position - b.position),
  )
}
```

- [ ] **Step 2: Write `StatusSettings.test.tsx` failing tests**

Cover, at minimum:
- add: submitting the form calls `createProjectStatus` with the typed name and chosen category,
  and calls `onStatusCreated` with the returned row;
- add: a `'duplicate'` result renders a field-level message naming the conflict, and does NOT
  call `onStatusCreated`;
- rename: calls `renameProjectStatus` and `onStatusUpdated`;
- reorder: "Move up" on the second row calls `reorderProjectStatuses` with the **complete**
  swapped slug list, and "Move up" is absent/disabled on the first row;
- pending state disables the control while in flight;
- a failed write leaves the list unchanged and shows the retry copy.

**Name queries must be substring/regex** (`{ name: /move .* up/i }`), never exact composed
names. Scope DOM-text assertions with `within(row)`.

- [ ] **Step 3: Implement `StatusSettings.tsx` and `SettingsTab.tsx`**

`SettingsTab` is a thin `useOutletContext<ProjectShellContext>()` reader that checks
`statusesPhase` before treating `[]` as "no statuses" (the phase-before-empty rule every other
tab follows) and renders `<StatusSettings />`. `StatusSettings` owns the list, the add form and
the async calls.

**Watch the lint thresholds.** `StatusSettings` will want to grow past 30 lines per function
and cyclomatic 10. Extract the row into its own component in the same file, or a second file,
rather than fighting the limit. **Measure the budget before assuming** — the repo's technique is
`npx eslint <file> --rule '{"complexity":["error",1]}'`, which prints each function's actual
count.

- [ ] **Step 4: Add the route and the nav link**

`src/App.tsx`: `<Route path="settings" element={<SettingsTab />} />`.
`ProjectShellHeader.tsx`: a fourth `<NavLink to="settings" className={tabClass}>`, matching the
existing three exactly.

- [ ] **Step 5: `npm run verify`, then commit**

---

## Task 4: Live RLS coverage, and the schema doc

**Files:**
- Modify: `src/test/rls.integration.test.ts` (**extend — do NOT create a new integration file**;
  the tripwire GAP must stay 7)
- Modify: `docs/sprintboard_phase1_schema.sql`

- [ ] **Step 1: Extend `rls.integration.test.ts`**

Each negative paired with a positive control — RLS **filters**, it does not raise, so a
zero-row result is meaningless without a positive control proving the fixture works:

```ts
// POSITIVE CONTROL FIRST. Every refusal below is only evidence if this passes.
it('the owner can insert a status into their own project', async () => { /* expect data, no error */ })

it('a stranger cannot insert a status into another owner\'s project', async () => {
  // RLS WITH CHECK RAISES on insert (42501) — unlike select, which filters.
})

// The assertion that keeps SPRIN-80's door shut. If anyone "simplifies" the three policies
// into one `for all`, this is what goes red.
it('NOBODY can delete a status, not even the owner — count the rows, do not trust the absence of an error', async () => {
  // delete, then re-SELECT and assert the row is still there. A DELETE matching zero rows
  // returns NO error, so "error is null" proves nothing here.
})

// The column revoke. Paired with a name update on the SAME row that MUST succeed, which is
// what proves the failure is the revoke and not a broken fixture.
it('the owner can update name but NOT slug', async () => { /* 42501 on slug, success on name */ })

it('a duplicate name differing only by case is rejected within one project', async () => { /* 23505 */ })
it('the same name in a DIFFERENT project is accepted', async () => { /* no error */ })
```

- [ ] **Step 2: Update `docs/sprintboard_phase1_schema.sql`**

The file is the schema of record and currently states project_statuses is **read-only to every
client** and that "write access arrives with SPRIN-77". That is now false. Update:
- the `project_statuses` header comment (line ~105) — it says "SERVER-OWNED in this slice";
- the `statuses_owner_read` policy block (~line 470-496) — add the two new policies, the
  column revoke/grant, and the reorder function, carrying the reasoning across;
- the note on `tickets.status`'s bare-literal default (~line 249-254) — it says the default is
  "safe only while the vocabulary is immutable to clients". The vocabulary is now mutable but
  **the `todo` row still cannot be deleted**, which is what keeps it safe. Say that precisely,
  and keep SPRIN-80's obligation.
- **Keep the "DO NOT add force row level security" warning.** It is more load-bearing now.

- [ ] **Step 3: `npm run verify`, then commit**

Confirm the file count is **57+ / GAP 7** and **0 skipped** — a run whose count equals the
`test:unit` number means the live suites silently skipped, which is a failure however green.
Re-derive with `npx vitest list --filesOnly | wc -l`.

---

## Plan corrections, made during execution

Recorded rather than silently edited, because each was a real defect in the plan as written.

**1. Task 4 Step 1 is PULLED FORWARD, to run immediately after Task 1.** The plan sequenced
the migration (applied before Task 1) ahead of the tests that assert the *old* SELECT-only
world, so the branch was red from `d2b901a` onward and Tasks 1-3's "Expected: PASS" steps were
unachievable as written. Found by Task 1's implementer, which re-derived it two independent
ways (a `git stash` run at the parent commit, and a live `pg_policy` query). **The lesson is
sequencing: a migration that changes observable behaviour must land in the same task as the
tests that pin that behaviour, never before them.**

**2. A pre-existing teardown defect, now reachable, is folded into that task.**
`rls.integration.test.ts`'s `afterAll` asserts `expect(before.data).toHaveLength(4)` **before**
issuing the cleanup delete. Any failure of that assertion skips the delete and leaks the
fixture project into the shared database permanently — which has now happened four times. The
assertion may keep its pre-delete *read*; it must not keep its pre-delete *throw*. This was
latent long before SPRIN-77 and would have bitten any future teardown assertion.

**3. Two of the four failures were collateral, not independent.** The first test now genuinely
plants a status row, so the two later `toHaveLength(4)` assertions saw 5. Only two of the four
were real. Worth stating because "four things are broken" would have produced four fixes.

**4. `database.types.ts` DOES need regenerating for the RPC** — the plan offered "regenerate or
cast" as if either would do. `Functions` was `{ [_ in never]: never }`, which keys the only
`supabase.rpc` overload, so the call was a hard type error and no cast was avoidable. Task 1
regenerated via the Supabase MCP (a read, so it works under `read_only=true`) and proved the
typing non-vacuous by mutation: a misspelled RPC name gives TS2345, a misspelled parameter
TS2561.

**5. A legal name can have no legal slug, and the plan made that report `'unknown'`.**
`slugForName` returns `null` for any name not starting with a letter — but **"2026 Review"** and
**"3rd Party Blocked"** are entirely plausible status names. `AddStatusSchema` accepts them, the
write then fails with the not-user-correctable tag, and the form shows generic retry copy for a
name the user could trivially fix.

**Decision (mine, recorded per the autonomy standing decision):** `slugForName` **prefixes
`s_`** when the derived slug does not start with a letter, so every name containing at least one
alphanumeric character yields a legal slug. The slug is machine identity and is never shown to
a user, so a prefix costs nothing and rejecting the name costs a legitimate one. `null` is then
reserved for names with **no** alphanumeric character at all (`"!!!"`), and `AddStatusSchema`
gains a `.refine` so that case surfaces as a **field-level message on the name input** rather
than as a write failure. Validation belongs at the edge that can explain itself.

**6. `renameProjectStatus` does not trim.** Trimming lives only in the zod schemas, so a direct
caller sending `'  Done  '` passes the database's `btrim(name) <> ''` check and then collides on
`lower(btrim(name))` — the right outcome reached by luck rather than design. Trim in the write
function too, so the property holds for every caller rather than only the form.

**7. `reorderProjectStatuses` reports success on a no-op.** It returns `{ ok: true, value: [] }`
whenever `error` is null — and a cross-tenant or stale-project call returns exactly
`error: null, data: []`, because RLS **filters** an UPDATE rather than raising. So a reorder that
changed nothing reads as success in the UI. Not exploitable today (the app only ever reorders
the project it is displaying), but it is a textbook green-for-the-wrong-reason shape, and it
gets worse under SPRIN-75's membership model where "read is broader than write" makes zero-row
writes routine. **Fix:** treat a returned row count that does not match the requested slug count
as `'unknown'`. The RPC's `RETURNING` gives the count for free.

**8. The leak was TEN rows, not four.** The throwing assertion sat above **both** cleanup
deletes, so `B's project` leaked on every occurrence too — five pairs. Corrected here because
the first count was mine and it was wrong in the direction that matters (understating a
shared-database leak).

## Self-Review Notes

- **Spec coverage:** §4 (migration) is applied and verified live, out of this plan's scope by
  design. §5.1 → Task 1. §5.2 → Task 1 step 7-8. §5.3 → Task 2. §5.4 → Task 3. §5.5 → Task 3
  step 2. §6 → Tasks 1-4. §7 out-of-scope items are not built.
- **Type consistency:** `StatusWriteResult<T>` uses `value`, not `status`/`sprint`, and is used
  that way in Tasks 1 and 3. `doneSlugs` returns `Set<string>`; `completeSprint` and
  `CompleteSprintButton` both take `ReadonlySet<string>`.
- **Known gap, deliberate:** `BoardTab`'s `lg:grid-cols-4` is a fixed class under a dynamic
  column count. Five statuses render five columns that wrap. Recorded in the spec's §7 as its
  own decision, not fixed here.
