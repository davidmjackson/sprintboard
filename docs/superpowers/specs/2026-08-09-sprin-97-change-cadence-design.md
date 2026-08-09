# SPRIN-97 — Change the sprint cadence

**Story 2 of 4 in epic SPRIN-74.** Depends on SPRIN-94 (shipped, `1464227`). Designed
2026-08-09. The epic design is
`docs/superpowers/specs/2026-08-09-sprin-74-sprint-cadence-design.md` — read it first; this
file records only what SPRIN-97 decides on top of it, and the **two places where building it
proved the epic design's paperwork wrong.**

---

## What this story is

The Settings cadence section stops being read-only. It becomes a form with a length picker
(1–4 weeks) and a weekday picker (Monday–Sunday), backed by the first UPDATE privilege
`projects` has carried since SPRIN-82 revoked the table-wide one.

That last clause is the story. The feature is a two-field form; the weight is the **security
boundary it reopens**, and the three debt items SPRIN-82 left behind for whichever story
first needed a project column to be writable.

## Verified live before designing, 2026-08-09

Read from `pg_class.relacl` and `pg_attribute.attacl`, **never `information_schema`** — whose
`column_privileges` and `role_table_grants` filter to grants the querying role is party to,
and the read-only MCP user is party to none, so they return zero rows whatever the ACL holds.
This is the trap's third sighting in this project.

```
projects.relacl → postgres=arwdDxtm, anon=ardDxtm, authenticated=ardDxtm, service_role=arwdDxtm
projects.attacl → EMPTY — no column on this table carries an ACL
```

No `w` for `authenticated`, and no column grants. The epic's claim holds, re-derived rather
than copied.

For contrast, and because story 4 will need it: `sprints.relacl` is `arwdDxtm` for both `anon`
and `authenticated` — full table CRUD. `projects` is the odd one out, deliberately.

## Migration B

`docs/migrations/sprin-97-project-cadence-update.sql`

```sql
grant update (sprint_length_weeks, sprint_start_weekday) on projects to authenticated;
```

**Named for the story that applies it (SPRIN-97), not the epic (`sprin-74-…` as the epic
design guessed).** Story 1 already set this precedent: its migration landed as
`docs/migrations/sprin-94-project-cadence.sql`. One convention, and the epic file is the one
that is out of step.

Column-level UPDATE with **no table-level UPDATE**. That is the whole point: `name`, `key` and
`project_type` stay immutable in the *database*, not merely in our code.

**It deliberately does not restate the whole ACL**, departing from SPRIN-93's migration E.
`projects` also carries `anon=ardDxtm`, and a table-level `revoke` to restate the ACL would
cascade across privileges this story has no business touching — and per
`column-revoke-cannot-hole-a-table-grant`, a table REVOKE cascades and would demand every
column be re-granted. The resulting ACL goes in the header comment instead.

**A comment is enforced by nothing.** So the enforcement here is behavioural, in three live
assertions: the owner can update the two cadence columns; the same owner still gets `42501`
on `project_type`; a cross-tenant cadence update matches zero rows.

## The three debt items

### 1. The AST guard becomes a fail-closed allowlist

`src/test/project-type-immutability.test.ts` check 5 currently reads "no update or upsert call
against the projects table at all". It becomes: an update to `projects` passes **only if every
key in its payload object literal is one of the two cadence columns.**

**It must fail closed.** An update whose keys cannot be read statically — a spread, a computed
key, an identifier standing in for the object — is a FAILURE, not a pass. That is the file's
own stated doctrine ("an answer it cannot determine is a FAILURE, not a pass"), and it is what
caught three type-valid `project_type` writes the earlier regex version waved through.

Concretely the new check must red on all of:

```ts
supabase.from('projects').update({ project_type: 'kanban' })   // forbidden key
supabase.from('projects').update(payload)                       // unreadable — identifier
supabase.from('projects').update({ ...cadence })                // unreadable — spread
supabase.from('projects').update({ [key]: value })              // unreadable — computed
supabase.from('projects').update({ sprint_length_weeks: 2, name: 'x' })  // one bad key
```

and stay green only on a literal whose every key is `sprint_length_weeks` or
`sprint_start_weekday`.

The allowed-key set is **derived from `SPRINT_CADENCE_COLUMNS` in `domain.ts`**, not re-typed
here. Two hand-maintained copies of "which columns are writable" is precisely the drift class
this project has now recorded three times.

`DOCUMENTED_CHECKS` / `DOCUMENTED_FLOORS` and the docblock prose move with the change — the
file's last test holds it to its own count.

### 2. The owner-side live pair

`src/test/projects.integration.test.ts`

- The existing `"refuses the owner's own project_type UPDATE (revoked grant -> 42501)"`
  **stays green, unmodified.** It is the proof the column grant did not widen to the table,
  and it fails disjointly from everything else here.
- A new sibling asserts the owner **can** update both cadence columns and read them back.

Together they are the load-bearing pair: one column set writable, the rest not.

### 3. The cross-tenant row-count assertion — restored with a DIFFERENT column than recorded

`src/test/rls.integration.test.ts:435`, the `'B cannot UPDATE any of it'` test, from which
SPRIN-82 removed the `projects` line.

**The recorded instruction is wrong for this story, and following it literally would ship a
test that passes for the wrong reason.** Three places — the guard docblock, the schema doc,
and the deletion site at `rls.integration.test.ts:429` — all say to restore the line as:

```ts
b.from('projects').update({ name: 'pwned' }).eq('id', projectA).select()   // ✗ NOT THIS
```

That was written anticipating a **rename** story, which would grant `name`. This story grants
only the two cadence columns, so `name` remains revoked and that update returns **`42501` with
`data === null`** — not the `[]` the assertion expects. Written as `toEqual([])` it fails; and
the tempting repair (assert the error instead) reproduces the exact defect the deletion site
argues against: the line would then pass off the *grant*, so dropping the `projects_owner`
policy would not redden it, and the assertion could no longer tell you which control was
holding.

So the line is restored on a **granted** column:

```ts
const project = await b
  .from('projects')
  .update({ sprint_length_weeks: 4 })
  .eq('id', projectA)
  .select()
expect(project.data).toEqual([])
```

Now UPDATE genuinely reaches the policy, RLS *filters* on `USING`, and a row count is once
again the honest assertion — which is the condition the deletion site set for restoring it.

Paired with a **re-read as A** proving the value is unchanged, because `[]` alone is satisfied
by a write that matched nothing *and* by one whose `.select()` was filtered after the fact.

All three recorded instructions get corrected in place, so the next reader is not sent down
the same path.

## Code shape

### `src/lib/domain.ts` — one new constant

```ts
/** The only columns of `projects` that `authenticated` may UPDATE (SPRIN-97, migration B). */
export const SPRINT_CADENCE_COLUMNS = ['sprint_length_weeks', 'sprint_start_weekday'] as const
```

The single source for: the zod schema's shape, the write path's payload, and the AST guard's
allowlist. Its whole job is to stop those three drifting.

### `src/lib/cadence-schemas.ts` — new

One domain per file, matching `sprint-`, `status-`, `field-`. Both values validated against
`SPRINT_LENGTH_WEEKS` and `SPRINT_WEEKDAYS` from `domain.ts` rather than re-typed ranges, so
the client edge cannot accept a value the `check` constraints reject.

**Coerced from the `<select>`'s string.** A native `<select>` yields strings; the columns are
`int`. `z.coerce.number()` then a membership check against the shared constant — not
`z.number().min(1).max(4)`, which would restate the range as a second source.

### `src/lib/projects.ts` — `updateProjectCadence`

Tagged-result shape, matching its neighbours:

```ts
{ ok: true; project: Project } | { ok: false; error: 'forbidden' | 'unknown' }
```

**`42501` gets its own tag (`'forbidden'`).** It is the one user-visible signal that migration
B has not been applied; folding it into `'unknown'` would make a mis-applied migration
indistinguishable from a network blip. This is the single case where a database error code
earns a distinct tag on this path.

Returns the updated row via `.select().single()`, so the section reflects what the *database*
now holds rather than what the form submitted — which is also what makes AC2 ("reflects them
after a reload") true without a refetch.

### `src/routes/CadenceSettings.tsx` — read-only becomes a form

Follows `AddStatusForm` exactly: `useForm` + `zodResolver`, two native `<select>`s with
`selectClass`, `SubmitButton`, `FormRootError` for the failure banner.

- Takes `projectId` in addition to `cadence`, and an `onUpdated` callback — the shell owns the
  project object, the same way `StatusSettings` hands every write result up rather than
  keeping a second copy. **No local mirror of the cadence**, so AC3's "previous values remain
  shown" needs no rollback code: a failed write simply never calls `onUpdated`.
- `defaultValues` come from the `cadence` prop.
- The failure banner distinguishes the two tags. `'forbidden'` gets its own sentence naming a
  permissions problem rather than inviting a retry that will fail identically forever — the
  same reasoning `STALE_LIST` uses in `StatusSettings`.
- **Still renders nothing for Kanban**: `SettingsTab` keeps the `hasSprints` gate, so the
  project-type comparison stays in the one place `project-type-single-expression.test.ts` can
  see it.

The deliberate no-explanatory-line comment from SPRIN-94 **stays**. The pre-fill is still
SPRIN-96; a form that saves a cadence nothing reads yet is honest, a sentence promising the
pre-fill is not.

## Decisions taken alone, recorded for veto

1. **Migration named `sprin-97-…`, not the epic's guessed `sprin-74-…`** — matches SPRIN-94's
   shipped precedent.
2. **The restored RLS line uses `sprint_length_weeks`, not `name`** — reasoned above. This is
   a correction to three recorded instructions, not a deviation from them by convenience.
3. **`SPRINT_CADENCE_COLUMNS` is a new shared constant** rather than the guard re-typing the
   two names. Costs one export; removes a drift class the project has hit three times.
4. **`'forbidden'` rather than `'permission_denied'`** for the 42501 tag — shorter, and the
   neighbouring unions use single plain words (`'duplicate'`, `'stale'`, `'unknown'`).
5. **No optimistic update.** The section shows the server's returned row. A two-field settings
   form is not where latency hiding earns its rollback complexity.

## What this story does NOT do

- It does not make `name`, `key` or `project_type` updatable. The grant is two columns, and
  debt item 1 reds on any attempt to widen it from the app side.
- It does not touch the `auth_rls_initplan` advisor sweep — that is SPRIN-75.
- It does not add the pre-fill (SPRIN-96) or the date-order check (SPRIN-95).

## Verification

- `npm run verify` in full, by me, not a subagent and not a subset.
- Test-count tripwire: `npm test` must collect exactly **seven more files** than
  `test:unit`, and 0 skipped. A gap of zero means the live suites silently skipped.
- Advisors after the migration: baseline **16 performance / 1 security** as of 2026-08-09.
  Add none. Re-derive rather than trusting that number.
- The live suites **cannot run locally** (placeholder URL → `ENOTFOUND`), so every claim about
  the grant is one only CI can falsify. Get it in front of CI early.
