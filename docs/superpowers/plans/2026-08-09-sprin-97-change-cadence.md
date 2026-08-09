# SPRIN-97 — Change the sprint cadence — implementation plan

Design: `docs/superpowers/specs/2026-08-09-sprin-97-change-cadence-design.md`. Epic design:
`docs/superpowers/specs/2026-08-09-sprin-74-sprint-cadence-design.md`.

**The code in this plan has never been run.** It is a draft that reads like a specification.
Deviating from it to match an established repo pattern is *correct* — report the deviation
rather than silently following a shape that does not fit.

---

## Global constraints — these apply to every task

- **Coding standard is the gate.** T1–T5 as errors: 30-line functions, cyclomatic 10,
  cognitive 15, **4 parameters**, 400-line files. Write to them from the first line.
  A genuine misfit is an ADR, never an inline disable.
- **`npm run lint` covers `**/*.{ts,tsx,mjs,js}`** — every source file, tests included.
- **Never run `npm test`, `npm run verify` or any live suite.** The seven
  `*.integration.test.ts` suites need real Supabase credentials this machine does not have —
  a placeholder URL makes them fail hard with `ENOTFOUND`, not skip. Run
  **`npx vitest run <your files>`** for the files you touched, and nothing else. The owner
  runs the full gate.
- **Status/type/column vocabularies live in `src/lib/domain.ts` and nowhere else.** Never
  inline a column name, weekday label or length value in a component, schema or test.
- **No Postgres `ENUM`, ever.** Not relevant to this story's SQL, but do not "improve" any
  `text`+`check` you pass.
- **Validate at both edges**: zod at the client, `check` constraints in the database.
- Imperative commit summaries. Do not commit — hand the diff back.

## Task 1 — Migration B and the three recorded-instruction corrections

**Create `docs/migrations/sprin-97-project-cadence-update.sql`.** Follow the header-banner
style of `docs/migrations/sprin-94-project-cadence.sql` exactly (read it first).

```sql
grant update (sprint_length_weeks, sprint_start_weekday) on projects to authenticated;
```

The banner must state:

- The resulting ACL in full — `projects` keeps `anon=ardDxtm`, `authenticated=ardDxtm` plus
  the two column grants; **no table-level `w` is added**.
- **Why this migration does not restate the whole ACL** (SPRIN-93 migration E's precedent is
  deliberately not followed): a table-level `revoke` cascades and would demand every column
  privilege be re-granted, across `anon` privileges this story has no business touching.
- That the comment is documentation, enforced by nothing, and the real enforcement is the
  three live assertions named in the design spec.

**Then correct three recorded instructions that are now wrong.** All three say to restore the
cross-tenant line as `.update({ name: 'pwned' })`. This story grants only the two cadence
columns, so `name` stays revoked and that update returns `42501`/`data === null`, not `[]`.
Each site must instead say: restore it on a **granted** column
(`sprint_length_weeks`), because only a granted column lets UPDATE reach the policy, and a
row count is the honest assertion only when RLS filtering is what is holding.

1. `src/test/project-type-immutability.test.ts` — the "AND THERE IS A THIRD OBLIGATION"
   paragraph in the docblock.
2. `src/test/rls.integration.test.ts` — the deletion-site docblock around line 429.
3. `docs/sprintboard_phase1_schema.sql` — the note above the SPRIN-82 revoke.

Keep each correction in the voice of the file it lives in, and say *why* the original reading
was wrong, not merely what to do instead.

## Task 2 — The lib layer

### `src/lib/domain.ts`

Add beside the SPRIN-94 cadence block:

```ts
/** The only columns of `projects` that `authenticated` may UPDATE (SPRIN-97, migration B). */
export const SPRINT_CADENCE_COLUMNS = ['sprint_length_weeks', 'sprint_start_weekday'] as const
```

Single source for the zod schema, the write payload and the AST guard's allowlist.
`domain.ts` is ~654 physical lines but `max-lines` skips comments and blanks (~181 counted) —
there is headroom. If it ever gets close, **split it, never widen the max**.

### `src/lib/cadence-schemas.ts` — new

```ts
export const CadenceSchema = z.object({
  sprint_length_weeks: <coerced int, must be one of SPRINT_LENGTH_WEEKS>,
  sprint_start_weekday: <coerced int, must be one of SPRINT_WEEKDAYS' iso values>,
})
export type CadenceValues = z.infer<typeof CadenceSchema>
```

- **Coerce**: a native `<select>` yields strings, the columns are `int`.
- **Membership against the shared constants**, never a re-typed `.min(1).max(4)` — that would
  be a second source for a range the database already owns.
- Messages should be user-readable, matching the tone in `status-schemas.ts`.

### `src/lib/projects.ts` — `updateProjectCadence`

```ts
export type UpdateCadenceResult =
  { ok: true; project: Project } | { ok: false; error: 'forbidden' | 'unknown' }

export async function updateProjectCadence(
  projectId: string,
  cadence: SprintCadence,
): Promise<UpdateCadenceResult>
```

- `supabase.from('projects').update({...}).eq('id', projectId).select().single()`.
- **The payload object literal must spell both column names out as plain keys.** The AST guard
  in task 4 reads this literal statically; a spread or a computed key makes it unreadable and
  is a deliberate FAILURE there.
- **`42501` maps to `'forbidden'`, everything else to `'unknown'`.** That tag is the one
  user-visible signal migration B was not applied.
- Docblock must say why `'forbidden'` is not folded into `'unknown'`, and note that on this
  table `42501` has two possible authors (a revoked grant, and an RLS `WITH CHECK` violation
  on a spoofed `owner_id`) — this path can only produce the first, because it never writes
  `owner_id`.

Unit tests mock the supabase client the way `src/lib/project-statuses.test.ts` does — read it
and follow it. Cover: success returns the row; `42501` → `'forbidden'`; another code →
`'unknown'`.

## Task 3 — `CadenceSettings` becomes a form

Read `src/routes/StatusSettings.tsx` (`AddStatusForm`) and follow it exactly:
`useForm` + `zodResolver(CadenceSchema)`, `Form`/`FormField`/`FormItem`/`FormLabel`/
`FormControl`/`FormMessage`, native `<select className={selectClass}>`, `SubmitButton`,
`FormRootError`.

```tsx
export function CadenceSettings({
  projectId, cadence, onUpdated,
}: {
  projectId: string
  cadence: SprintCadence
  onUpdated: (project: Project) => void
})
```

- `defaultValues` from the `cadence` prop.
- Options from `SPRINT_LENGTH_WEEKS` and `SPRINT_WEEKDAYS` — **never inline literals.**
- **Keep the existing summary line** (`cadenceSummary(cadence)`) above the form so the current
  cadence is stated in words; it re-renders from the prop when the shell patches the project.
- **Keep SPRIN-94's "NO EXPLANATORY LINE, DELIBERATELY" comment.** The pre-fill is SPRIN-96;
  copy promising it is still a false claim a user can read.
- **No local mirror of the cadence.** A failed write simply never calls `onUpdated`, which is
  what makes AC3's "previous values remain shown" true with no rollback code.
- `'forbidden'` gets its own sentence in the banner, naming a permissions problem rather than
  inviting a retry that will fail identically forever (the reasoning `STALE_LIST` uses).
  Anything else takes the shared generic copy.
- Watch the **4-parameter** rule and the 30-line function rule; extract if needed.

`SettingsTab.tsx`: pass `projectId={project.id}` and an `onUpdated` that patches the shell's
project. **Keep the `hasSprints(project)` gate exactly where it is** — the project-type
comparison must stay in the one place `project-type-single-expression.test.ts` can see it.

Tests (`CadenceSettings.test.tsx`, extend the existing file):

- Both pickers render every option, sourced from the shared constants.
- Submitting calls `updateProjectCadence` with the chosen values and calls `onUpdated`.
- A `'forbidden'` result shows the permissions sentence; an `'unknown'` result shows generic
  copy; **in both cases `onUpdated` is not called and the summary still shows the old cadence.**
- **Accessible names**: never assert an *exact* accessible name on an element whose name is
  composed from several children — under jsdom that string is not what a browser computes.
  Substring/regex name queries are fine; an exact name on a single text node or `aria-label`
  is fine. Pair DOM-text assertions with a substring role-name query, because `getByText`
  matches `aria-hidden` subtrees happily.
- Native `<select>` in jsdom: drive with `userEvent.selectOptions`.

## Task 4 — The AST guard becomes a fail-closed allowlist

`src/test/project-type-immutability.test.ts`, check 5 (currently
`'makes no update or upsert call against the projects table'`).

New rule: a `.update(`/`.upsert(` resolving to `projects` passes **only if its first argument
is an object literal every one of whose keys is a plain, statically-readable name present in
`SPRINT_CADENCE_COLUMNS`.** Anything else is a failure, including — and especially — a payload
whose keys cannot be read.

Must go RED on each of these, and there should be a comment listing them as the mutation set
the check is built against:

```ts
supabase.from('projects').update({ project_type: 'kanban' })            // forbidden key
supabase.from('projects').update(payload)                                // identifier
supabase.from('projects').update({ ...cadence })                         // spread
supabase.from('projects').update({ [key]: value })                       // computed key
supabase.from('projects').update({ sprint_length_weeks: 2, name: 'x' })  // one bad key
supabase.from('projects').upsert({ project_type: 'kanban' })             // upsert too
```

Must stay GREEN only on a literal whose every key is in `SPRINT_CADENCE_COLUMNS`.

- **Import `SPRINT_CADENCE_COLUMNS` from `domain.ts`.** Do not re-type the two names — two
  hand-maintained copies of "which columns are writable" is the drift class this project has
  now recorded three times.
- Reuse the helpers in `src/test/source-ast.ts`; add one there if a new primitive is needed
  (a "read an object literal's static keys, or null" helper is the likely shape), and give it
  the same fail-closed docblock discipline as its neighbours.
- **Rewrite check 5's failure message.** It currently argues "no write to this table at all";
  it must now argue "only the cadence columns, and an unreadable payload is a failure". Say
  what a future story owes if it needs another column (a grant AND an addition to
  `SPRINT_CADENCE_COLUMNS`).
- Update the numbered list in the docblock (item 5) and the "WHEN A LEGITIMATE PROJECT UPDATE
  ARRIVES" paragraph — a legitimate update has now *arrived*, so that paragraph describes
  history plus what remains true for `name`/`key`/`project_type`.
- **`DOCUMENTED_CHECKS` / `DOCUMENTED_FLOORS` must still match the real test count** — the
  file's last test holds it to its own docblock. If you add a test, move the number.
- Floors: check whether the existing floor constants (e.g. the count of legitimate writes to
  other tables) still hold once `projects` has a permitted write, and move them with a comment
  if they do not.

## Task 5 — The two live suites

**You cannot run these.** Write them, reason them through, and hand them back; CI is the only
place they execute.

### `src/test/projects.integration.test.ts`

Leave `"refuses the owner's own project_type UPDATE (revoked grant -> 42501)"`
**completely unmodified** — it is the proof the grant did not widen to the table.

Add a sibling immediately after it:

- Insert a project as A, assert it starts at the defaults (2, 1).
- Update **both** cadence columns as A in one call, `.select()`, assert `error === null` and
  exactly **one row** returned with the new values.
- Re-read as A and assert the persisted values — a `.select()` on the update alone does not
  prove the row settled.
- Docblock: why this pair is load-bearing (one column set writable, the rest not), and that it
  is the only local-or-CI observation that migration B was applied at all.

### `src/test/rls.integration.test.ts`

In `it('B cannot UPDATE any of it')` (~line 435) add the `projects` line back:

```ts
const project = await b
  .from('projects')
  .update({ sprint_length_weeks: 4 })
  .eq('id', projectA)
  .select()
expect(project.data).toEqual([])
```

- **`sprint_length_weeks`, not `name`** — the reasoning is in the design spec; `name` is still
  revoked and would return `42501`, making the assertion pass off the grant rather than off
  RLS filtering.
- **Use a value that differs from the default** so a no-op update cannot be mistaken for a
  filtered one. The fixture project is at the default 2; write 4.
- Add a **re-read as A** asserting `sprint_length_weeks` is still what A set: `[]` alone is
  satisfied both by a write that matched nothing and by one whose `.select()` was filtered
  afterwards. Row count plus unchanged value is the pair that distinguishes them.
- Replace the deletion-site docblock's "PUT THIS LINE BACK" warning with a short note saying
  it *was* put back, by SPRIN-97, on a granted column and why that column choice matters.

## Task 6 — Owner-run (not a subagent task)

Whole-branch adversarial review, security review, `npm run verify` in full, the migration
hand-off to David, advisors against the 16 performance / 1 security baseline, then ship.
