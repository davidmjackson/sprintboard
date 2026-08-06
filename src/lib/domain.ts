/**
 * The domain vocabulary the database cannot express, and the guards that keep it
 * honest.
 *
 * `type`, `project_type` and `sprint.status` are text columns with check
 * constraints rather than Postgres enums, so the generated `database.types.ts`
 * types them as bare `string`. These unions restore the narrowing on the client —
 * at the cost of being a second source of truth, which is exactly the thing that
 * rots.
 *
 * `ticket.status` is no longer one of them. SPRIN-79 made the vocabulary
 * per-project, so its check constraint became a composite foreign key to
 * `project_statuses` — a constraint no regex can read off a column definition.
 * Its link to the schema now runs through `DEFAULT_PROJECT_STATUSES` and the
 * seeding trigger instead, which is why that constant exists.
 *
 * For `type`, `project_type` and `sprint.status`, three links hold the chain
 * together, and each is checked somewhere different:
 *
 *   union  ≡  runtime array   — `Exact<>` below, at compile time
 *   array  ≡  the schema file  — domain.test.ts, by parsing the DDL: a check
 *                                constraint for each
 *   column ≡  the live database — regenerating database.types.ts
 *
 * The middle link is the one that matters and the one a compiler cannot see, so
 * it is a test. `Assignable<>` alone is NOT sufficient for those three: the
 * generated column type is `string`, so *any* string union satisfies it, and
 * adding a value to a union would sail through. `Exact<>` is what actually bites.
 *
 * `TicketStatus` has neither guard. It was widened to `string` in Task 3 of
 * SPRIN-76 (see its docblock below), so there is no union for `Exact<>` to check
 * and no narrowing for `Assignable<>` to bite on. What still ties it to the
 * schema is `DEFAULT_PROJECT_STATUSES` and the two tests described on that
 * constant, not a type-level guard here.
 */

import type { Tables, TablesInsert, TablesUpdate } from './database.types'

export type TicketType = 'epic' | 'story' | 'bug' | 'task'

/**
 * Jira's status category — the bucket a status belongs to regardless of its name.
 *
 * This IS the "done is terminal" rule as of SPRIN-77, which moved both sites that
 * used to hardcode the slug `'done'` onto this column together: `completeSprint`'s
 * database filter in `src/lib/sprints.ts` and the optimistic reducer in
 * `src/routes/ProjectShell.tsx`. Neither move was useful alone — the filter without
 * the reducer paints a ticket back into the backlog that the database kept, and the
 * reducer without the filter does the reverse.
 *
 * Both read `doneSlugs` in `src/lib/project-statuses.ts`, and that single derivation
 * is the point: `completeSprint`'s correctness argument is that the database's rule
 * and the client's local patch are THE SAME RULE, so its patch is idempotent across
 * the fail-then-retry path. Two independent derivations could drift; one cannot.
 * **Re-inlining the slug `'done'` anywhere would compile, pass a seeded-vocabulary
 * test, and silently break every user-added terminal status** — a project whose
 * terminal status is called anything else would have its finished tickets dragged
 * back to the backlog on sprint completion.
 *
 * The empty case is a real state, not an error: a project with no done-category
 * status has nothing terminal, so every ticket is incomplete. See `completeSprint`,
 * which omits its filter entirely rather than emitting a malformed `in ()`.
 */
export type StatusCategory = 'todo' | 'in_progress' | 'done'
/**
 * A ticket's status: the `slug` of one of its project's `project_statuses` rows.
 *
 * Deliberately `string`, and deliberately NOT a union. The vocabulary is PER PROJECT as of
 * SPRIN-79, so no single union can describe it — and SPRIN-76's AC2 requires a new status row
 * to produce a new board column with no code change. Re-narrowing this to a union would
 * silently re-break that.
 *
 * What enforces it instead is stronger than the union ever was, because it is per-project and
 * lives in the database: the composite foreign key `tickets_status_fk (project_id, status) →
 * project_statuses (project_id, slug)`. The alias survives the widening only to say all of
 * this at the ~15 call sites that read it.
 */
export type TicketStatus = string
export type SprintStatus = 'future' | 'active' | 'complete'

/**
 * How a project delivers work: in sprints, or continuously.
 *
 * A bare `'scrum'` until SPRIN-81 widened it to the two Rung 3 types. It gets the same
 * union + runtime array + label map shape as `TicketType` because the create-project
 * dialog has to render the values AND their display names — and this is the only file
 * either may live in.
 *
 * Still `text` + a `check` constraint in the database, never a Postgres enum: widening
 * the check is one line, altering an enum type is a migration. The check now reads
 * `check (project_type in ('scrum', 'kanban'))`, and `domain.test.ts` parses it out of
 * the schema doc and compares it to `PROJECT_TYPES` — ORDERED, so the constraint must
 * spell the values in the same order as the array below.
 */
export type ProjectType = 'scrum' | 'kanban'

/**
 * The type of a project-defined custom field (SPRIN-90, epic SPRIN-71).
 *
 * `text` is single-line and `paragraph` is multi-line. They share one storage primitive
 * and differ only in the control rendered and the length cap — Jira splits them the same
 * way ("Text Field (single line)" / "(multi-line)"), and keeping them apart here is what
 * lets the renderer be a map keyed by type rather than a chain of conditionals.
 *
 * Still `text` + a `check` constraint in the database, never a Postgres enum, for the same
 * reason as every other vocabulary in this file.
 *
 * **The order of the array below is load-bearing**: `domain.test.ts` parses the check
 * constraint out of `docs/sprintboard_phase1_schema.sql` and compares it ORDERED, so the
 * constraint must spell the values in the same order. That pins the doc, NOT the database —
 * migrations are hand-applied, so only `rls.integration.test.ts` (which asserts the
 * constraint by name on a real rejection) can see the live vocabulary.
 *
 * `select` is a member from the start even though story 5 is what renders it — the database
 * check accepts it already, and a client union narrower than the column would make
 * `isCustomFieldType` reject a value the database calls valid.
 */
export type CustomFieldType = 'text' | 'paragraph' | 'number' | 'date' | 'select'

export const TICKET_TYPES = [
  'epic',
  'story',
  'bug',
  'task',
] as const satisfies readonly TicketType[]

export const PROJECT_TYPES = ['scrum', 'kanban'] as const satisfies readonly ProjectType[]

export const CUSTOM_FIELD_TYPES = [
  'text',
  'paragraph',
  'number',
  'date',
  'select',
] as const satisfies readonly CustomFieldType[]

export const SPRINT_STATUSES = [
  'future',
  'active',
  'complete',
] as const satisfies readonly SprintStatus[]

export const STATUS_CATEGORIES = [
  'todo',
  'in_progress',
  'done',
] as const satisfies readonly StatusCategory[]

/**
 * What `seed_project_statuses()` writes for every new project — the client half of
 * the seed contract, and the reason the four column names still live in exactly one
 * TypeScript file now that the database owns the list.
 *
 * Two tests hold this honest, and they check different things:
 *   - `domain.test.ts` parses the trigger's VALUES list out of the schema doc and
 *     asserts it equals this. That catches the schema file drifting.
 *   - `rls.integration.test.ts` reads the rows the LIVE database actually seeded
 *     and asserts they equal this. That is the primary guard, because the schema
 *     file is not the database — a migration is applied by hand.
 *
 * This is also what keeps the four-column guarantee intact now that `tickets_status_check`
 * is gone (SPRIN-79): nothing in the database constrains a ticket to any particular set of
 * statuses any more, so this constant — checked against the schema doc by `domain.test.ts`
 * and against the live database by `rls.integration.test.ts` — is the only thing that still
 * pins "a new project gets exactly these four statuses". The board itself no longer reads
 * this constant; it renders `project_statuses` rows directly (SPRIN-76).
 */
export const DEFAULT_PROJECT_STATUSES = [
  { slug: 'todo', name: 'To Do', category: 'todo', position: 1, is_initial: true },
  {
    slug: 'in_progress',
    name: 'In Progress',
    category: 'in_progress',
    position: 2,
    is_initial: false,
  },
  { slug: 'in_review', name: 'In Review', category: 'in_progress', position: 3, is_initial: false },
  { slug: 'done', name: 'Done', category: 'done', position: 4, is_initial: false },
] as const satisfies readonly {
  slug: string
  name: string
  category: StatusCategory
  position: number
  is_initial: boolean
}[]

/**
 * Human-readable ticket-type labels, keyed by type. Type display names live only
 * here (CLAUDE.md). Typed as an exhaustive `Record<TicketType, string>` so a new
 * type cannot ship without a label. Status labels have no equivalent here any more:
 * a status's name is a column on its `project_statuses` row (SPRIN-76), not a map
 * keyed by slug.
 */
export const TICKET_TYPE_LABELS: Record<TicketType, string> = {
  epic: 'Epic',
  story: 'Story',
  bug: 'Bug',
  task: 'Task',
}

/**
 * Human-readable project-type labels, keyed by type. Here for the same reason as every
 * other label map in this file: display names live in `domain.ts` and nowhere else, so
 * the create-project dialog's `<option>` text and any future badge cannot word the same
 * type two ways. The exhaustive `Record<ProjectType, string>` makes a third project type
 * unshippable without a label — though not without a *meaningful* one, which is why
 * `domain.test.ts` also iterates `PROJECT_TYPES` and asserts each label is non-empty.
 */
export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  scrum: 'Scrum',
  kanban: 'Kanban',
}

/**
 * Human-readable custom-field-type labels, keyed by type. Same rule as every label map
 * above: display names live here and nowhere else, so the settings list and story 2's add
 * form cannot word the same type two ways.
 *
 * `paragraph` reads as "Text (multi-line)" rather than "Paragraph" because the pairing is
 * what makes the choice legible — a user picking between "Text" and "Paragraph" has to
 * guess what distinguishes them; one between "Text" and "Text (multi-line)" does not.
 */
export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'Text',
  paragraph: 'Text (multi-line)',
  number: 'Number',
  date: 'Date',
  select: 'Select',
}

/**
 * Human-readable category labels, keyed by category — the settings surface (SPRIN-77) shows a
 * status's category on its row and offers the three in the add form, and `in_progress` is not
 * a thing to put in front of a user.
 *
 * Here rather than in the component for the same reason as every other label map above:
 * status/type/column display names live in `domain.ts` and nowhere else, so a fourth category
 * cannot ship without a label and two surfaces cannot drift on the wording. The exhaustive
 * `Record<StatusCategory, string>` is what enforces the first half at compile time.
 */
export const STATUS_CATEGORY_LABELS: Record<StatusCategory, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  done: 'Done',
}

export const SPRINT_STATUS_LABELS: Record<SprintStatus, string> = {
  future: 'Future',
  active: 'Active',
  complete: 'Complete',
}

/* ------------------------------------------------------------------ *
 * Compile-time guards. Exported so they are "used" — `noUnusedLocals`
 * rejects an unreferenced type alias, and the `_`-prefix exemption
 * applies only to parameters, never to locals.
 * ------------------------------------------------------------------ */

/** True only if X and Y are the same type. Not merely mutually assignable. */
type Exact<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false

type Expect<T extends true> = T

/** Fails to compile if `Narrow` is not assignable to the generated column type.
 *  Catches a column being renamed, or narrowed to a real enum that drops a value. */
type Assignable<Narrow extends Wide, Wide> = Narrow

/** The union and the runtime array must be the SAME SET, in both directions.
 *  Without this, adding a value to a union and forgetting the array compiles
 *  fine — and `isTicketType` then rejects a value the type system calls valid.
 *  There is no such guard for `TicketStatus`: it was widened to `string` in Task 3
 *  of SPRIN-76 (the vocabulary is per-project), so `Exact<string, ...>` would be
 *  `false` and the guard would fail to compile while asserting nothing real. */
export type AssertTicketTypesExhaustive = Expect<Exact<TicketType, (typeof TICKET_TYPES)[number]>>
export type AssertSprintStatusesExhaustive = Expect<
  Exact<SprintStatus, (typeof SPRINT_STATUSES)[number]>
>

export type AssertStatusCategoriesExhaustive = Expect<
  Exact<StatusCategory, (typeof STATUS_CATEGORIES)[number]>
>

export type AssertProjectTypesExhaustive = Expect<
  Exact<ProjectType, (typeof PROJECT_TYPES)[number]>
>

export type AssertCustomFieldTypesExhaustive = Expect<
  Exact<CustomFieldType, (typeof CUSTOM_FIELD_TYPES)[number]>
>

export type AssertTicketTypeColumn = Assignable<TicketType, Tables<'tickets'>['type']>
/* No AssertTicketStatusColumn: `TicketStatus` is `string` as of Task 3 of SPRIN-76, so
 * `Assignable<string, string>` would be vacuous — it would compile without checking
 * anything, which is worse than no guard because it still reads like one. */
export type AssertSprintStatusColumn = Assignable<SprintStatus, Tables<'sprints'>['status']>
export type AssertProjectTypeColumn = Assignable<ProjectType, Tables<'projects'>['project_type']>
export type AssertCustomFieldTypeColumn = Assignable<
  CustomFieldType,
  Tables<'project_fields'>['type']
>
export type AssertStatusCategoryColumn = Assignable<
  StatusCategory,
  Tables<'project_statuses'>['category']
>

/** `ProjectStatusUpdate` mirrors a column-level GRANT (see its docblock), so its key set is the
 *  assertion — `Assignable<>` would be vacuous, since a wider Pick of the same table is still
 *  assignable to the generated update type. `Exact<>` is what makes adding `slug` back a
 *  compile error rather than a silent re-widening. */
export type AssertProjectStatusUpdateColumns = Expect<
  Exact<keyof ProjectStatusUpdate, 'name' | 'category' | 'position' | 'wip_limit'>
>

/** Same reasoning for `project_fields`, where the grant is narrower still: `name` and nothing
 *  else. A single-key `Pick` looks too small to be worth pinning, which is exactly why it is —
 *  adding `slug` or `type` back is a one-word edit, and `Assignable<>` would not notice it. */
export type AssertProjectFieldUpdateColumns = Expect<Exact<keyof ProjectFieldUpdate, 'name'>>

/* ------------------------------------------------------------------ *
 * Row types, with the text columns narrowed to the domain unions.
 * ------------------------------------------------------------------ */

export type Profile = Tables<'profiles'>
export type Project = Omit<Tables<'projects'>, 'project_type'> & { project_type: ProjectType }
export type Sprint = Omit<Tables<'sprints'>, 'status'> & { status: SprintStatus }

/**
 * One project's status row. A board column IS one of these, ordered by `position` —
 * there is deliberately no separate board-columns table while the mapping is 1:1.
 *
 * The UPDATE counterpart is `ProjectStatusUpdate` below. There is deliberately no
 * INSERT counterpart: an insert legitimately carries `project_id`, `slug` and
 * `is_initial`, so `TablesInsert<'project_statuses'>` is already the right shape and
 * an alias would only restate it.
 */
export type ProjectStatus = Omit<Tables<'project_statuses'>, 'category'> & {
  category: StatusCategory
}

/**
 * One project's custom field DEFINITION (SPRIN-90). The values themselves live in a
 * separate table added by story 3 — `tickets` is never reshaped, so core fields stay real
 * columns and only custom ones go in a flexible store.
 *
 * `type` is narrowed from the column's `string` to the domain union, the same narrowing
 * `ProjectStatus` makes for `category`. That narrowing is a CLAIM about data the database
 * returns, not a check — `listProjectFields` is where it is enforced, and it rejects a row
 * whose type is unrecognised rather than casting past it.
 *
 * The UPDATE counterpart is `ProjectFieldUpdate` below, added by story 2 (SPRIN-91) — the
 * story that actually renames a field. Story 1 deliberately left it unwritten: the type
 * mirrors a column-level GRANT, and adding it with no writer would have been an unpinned
 * claim about a privilege nothing exercised. There is still no INSERT counterpart, for the
 * same reason `ProjectStatus` has none: an insert legitimately carries `project_id`, `slug`
 * and `type`, so `TablesInsert<'project_fields'>` is already the right shape and an alias
 * would only restate it. What keeps `created_at` and `id` off an insert is the GRANT, which
 * omits them, plus `createProjectField` sending an exact four-key literal — not a type.
 */
export type ProjectField = Omit<Tables<'project_fields'>, 'type'> & {
  type: CustomFieldType
}
export type Ticket = Omit<Tables<'tickets'>, 'status' | 'type'> & {
  status: TicketStatus
  type: TicketType
}

/* ------------------------------------------------------------------ *
 * Write types. These exist to make the trigger-owned columns
 * unrepresentable from the client.
 * ------------------------------------------------------------------ */

/**
 * `key` and `number` are assigned by the `assign_ticket_key` BEFORE INSERT
 * trigger, atomically and race-safely, from `project_counters`. **Never send
 * them from the client.** CLAUDE.md: "Never generate keys with count(*)."
 *
 * The generated `TablesInsert<'tickets'>` cannot express this — it sees two
 * columns with defaults and offers them to you. Omitting them here makes the
 * wrong call untypeable. The database backstops it anyway: a BEFORE UPDATE
 * trigger restores both columns if anyone tries to change them.
 *
 * `status` is a different category from `key`/`number`, and is handled differently:
 * SPRIN-80 dropped the column's `DEFAULT` so that `resolve_initial_ticket_status()`, a
 * BEFORE INSERT trigger, is the single source of a new ticket's status — but that trigger
 * only fills `status` **when the caller omits it**; it never overwrites one the caller
 * sent. A client value is never wrong the way a client-chosen `key` is, so the column is
 * re-admitted here as OPTIONAL rather than excluded: a caller may choose a starting
 * status, and if it does not, the database resolves the project's initial one. The
 * generated type cannot express "required unless a trigger fills it", so it types the
 * now-defaultless NOT NULL column as required on insert — over-constraining a contract
 * that is actually optional. `ticketInsertPayload` in `tickets.ts` bridges that gap.
 */
export type TicketInsert = Omit<TablesInsert<'tickets'>, 'key' | 'number' | 'status'> & {
  status?: TicketStatus
}

/** Same reasoning as TicketInsert, plus `id`/`project_id` (a ticket cannot change
 *  project) and the trigger-owned timestamps: `updated_at` is set by the
 *  `tickets_set_updated_at` trigger on every write, `created_at` is fixed at insert.
 *  Sending any of them is either overwritten or wrong, so make it untypeable.
 *
 *  The three blocked fields are also excluded: they move together under an invariant
 *  (`tickets_blocked_coherent`) that the free-form edit path must never half-apply.
 *  `blocked_since` is trigger-owned (`sync_blocked_fields` stamps/clears it), and
 *  `is_blocked`/`blocked_reason` are owned by the intent-named `blockTicket`/
 *  `unblockTicket` calls, which enforce the app-layer "a reason is required" rule.
 *  Sending them here would let a caller set `is_blocked` without a reason — the DB
 *  check would then reject it. `TicketBlockUpdate` is the only shape that may. */
export type TicketUpdate = Omit<
  TablesUpdate<'tickets'>,
  | 'key'
  | 'number'
  | 'id'
  | 'project_id'
  | 'updated_at'
  | 'created_at'
  | 'is_blocked'
  | 'blocked_reason'
  | 'blocked_since'
>

/** The block/unblock write, and the ONLY shape that may touch the blocked fields.
 *  `blocked_since` is omitted deliberately — `sync_blocked_fields` stamps it on block
 *  and clears it (with `blocked_reason`) on unblock, so a client value is meaningless.
 *  Block sends `{ is_blocked: true, blocked_reason }`; unblock sends `{ is_blocked:
 *  false }` and lets the trigger clear the rest. */
export type TicketBlockUpdate = Pick<TablesUpdate<'tickets'>, 'is_blocked' | 'blocked_reason'>

export type ProjectInsert = TablesInsert<'projects'>
export type SprintInsert = TablesInsert<'sprints'>

/**
 * The shape a client may insert into `sprints`. `status` is omitted deliberately: the
 * column defaults to `'future'` and the database owns it. S6.3 makes `'active'` mean
 * "the one active sprint in this project", enforced by the `sprints_one_active_per_project`
 * partial unique index — a client that sets status on create would route around that rule
 * before it is even built. Omitting it here makes that a compile error, not a code review.
 */
export type SprintCreateInsert = Omit<SprintInsert, 'status'>

/**
 * The shape of an owner-scoped status transition on a sprint (S6.3 start, S6.4 complete).
 * `status` is the only column these intent-named writes touch; `Pick` makes any other
 * field untypeable at the write site, the same guarantee `TicketBlockUpdate` gives the
 * blocked fields. The one-active rule is enforced by the `sprints_one_active_per_project`
 * partial unique index, not here.
 */
export type SprintStatusUpdate = Pick<TablesUpdate<'sprints'>, 'status'>

/**
 * The ONLY columns a client may UPDATE on `project_statuses` — and unlike every other write
 * type here, this one mirrors a **column-level GRANT**, not a policy or a trigger.
 *
 * SPRIN-77's migration revoked the table-level UPDATE and granted it back on
 * (name, category, position) alone, so Postgres refuses a patch touching `slug`, `is_initial`,
 * `project_id`, `id` or `created_at` with a 42501 before any policy is consulted — `slug` above
 * all, because `tickets_status_fk` references (project_id, slug) and moving it would strand
 * every ticket sitting on that status.
 *
 * The generated `TablesUpdate<'project_statuses'>` cannot express that: it sees a table with
 * updatable columns and offers all of them, so `.update({ slug })` compiled cleanly and failed
 * only at runtime, against the live database, on a path a unit test with a mocked client never
 * reaches. `Pick` makes the wrong write untypeable instead — the same move `TicketBlockUpdate`
 * and `SprintStatusUpdate` make for their invariants. `AssertProjectStatusUpdateColumns` above
 * pins the key set, so widening this alias is itself a compile error rather than a quiet
 * loosening of the grant's client-side mirror.
 *
 * SPRIN-85 added `wip_limit`, and the grant was rewritten in the same commit
 * (docs/migrations/sprin-85-wip-limit.sql). The two must move together: a table REVOKE
 * cascades to column grants, so that migration re-grants ALL FOUR columns, and this alias
 * is the client-side mirror of exactly that list. `slug` and `is_initial` remain absent
 * from both.
 */
export type ProjectStatusUpdate = Pick<
  TablesUpdate<'project_statuses'>,
  'name' | 'category' | 'position' | 'wip_limit'
>

/**
 * The ONLY column a client may UPDATE on `project_fields` — and, like `ProjectStatusUpdate`
 * above, this mirrors a **column-level GRANT** rather than a policy or a trigger.
 *
 * `docs/migrations/sprin-91-project-fields-insert.sql` restates `grant update (name)` and
 * nothing else, so Postgres refuses a patch touching any other column with a 42501 before any
 * policy is consulted. Two of those absences are load-bearing rather than tidy:
 *
 *   * `slug` is the machine identity story 5's value rows key on. A movable slug would undo
 *     "renaming a field rewrites no value rows" — the same division `tickets_status_fk` makes
 *     for statuses, and the reason a rename is a cheap operation at all.
 *   * `type` immutability is what makes story 3's denormalised `field_type` copy sound. A
 *     field whose type changed under stored values would leave that copy describing data it
 *     no longer matches.
 *
 * The generated `TablesUpdate<'project_fields'>` cannot express that: it sees a table with
 * updatable columns and offers all of them, so `.update({ slug })` COMPILES and fails only at
 * runtime, against the live database, on a path a mocked-client unit test never reaches.
 * `Pick` makes the wrong write untypeable instead — the same move `TicketBlockUpdate` and
 * `SprintStatusUpdate` make for their invariants. `AssertProjectFieldUpdateColumns` pins the
 * key set, so widening this alias is itself a compile error rather than a quiet loosening of
 * the grant's client-side mirror.
 *
 * This alias and the migration must move together. A table-level REVOKE **cascades** to
 * column grants, which is why every migration touching this table restates the complete grant
 * set; this is the client-side mirror of exactly that list, and story 6 (which grants DELETE)
 * is the next place both can drift apart in one edit.
 */
export type ProjectFieldUpdate = Pick<TablesUpdate<'project_fields'>, 'name'>

/* ------------------------------------------------------------------ */

export function isTicketType(value: string): value is TicketType {
  return (TICKET_TYPES as readonly string[]).includes(value)
}

export function isSprintStatus(value: string): value is SprintStatus {
  return (SPRINT_STATUSES as readonly string[]).includes(value)
}

export function isStatusCategory(value: string): value is StatusCategory {
  return (STATUS_CATEGORIES as readonly string[]).includes(value)
}

export function isProjectType(value: string): value is ProjectType {
  return (PROJECT_TYPES as readonly string[]).includes(value)
}

export function isCustomFieldType(value: string): value is CustomFieldType {
  return (CUSTOM_FIELD_TYPES as readonly string[]).includes(value)
}

/**
 * Whether a project delivers work in sprints. THE single expression of the rule
 * (SPRIN-82 AC5) — no component, filter or test may write `project_type === 'kanban'`
 * itself, and `src/test/project-type-single-expression.test.ts` says so in a form that
 * goes red rather than in prose.
 *
 * Same discipline as `doneSlugs()` being the single derivation of "terminal" (SPRIN-77):
 * two call sites reading the raw string can drift, one predicate cannot. There are three
 * consumers in SPRIN-82 alone, and SPRIN-83, -85 and -86 add more.
 *
 * Deliberately not `isKanban`. "Has sprints" and "has WIP limits" are two different
 * questions that share an answer only while there are exactly two project types; a third
 * would separate them, and a single negated predicate would not survive it. `hasWipLimits`
 * arrives in SPRIN-85 with its first caller rather than now, when it would be an
 * unreferenced export — which is what `npx knip` (SPRIN-63's dead-code pass) is for.
 *
 * Takes the narrowest shape it reads so a test can pass `{ project_type: 'kanban' }`
 * without inventing eight irrelevant columns; a full `Project` is assignable. Same reason
 * `statusOptions` and `doneSlugs` take rows rather than a project.
 */
export function hasSprints(project: Pick<Project, 'project_type'>): boolean {
  return project.project_type === 'scrum'
}

/**
 * Whether a project's board columns carry WIP limits. THE single expression of the rule —
 * no component, filter or test may write the comparison itself, and
 * `src/test/project-type-single-expression.test.ts` says so in a form that goes red.
 *
 * Deliberately a SECOND predicate rather than `!hasSprints(project)`. They are two
 * different questions that happen to share an answer while there are exactly two project
 * types; a third would separate them, and a single negated predicate would not survive it.
 * `hasSprints`'s own docblock promised this function would arrive in SPRIN-85 with its
 * first caller rather than earlier as an unreferenced export.
 *
 * Takes the narrowest shape it reads, matching `hasSprints`, so a test can pass
 * `{ project_type: 'kanban' }` without inventing eight irrelevant columns.
 */
export function hasWipLimits(project: Pick<Project, 'project_type'>): boolean {
  return project.project_type === 'kanban'
}

/** What the flat ticket-list tab is called, and what it says when it is empty. */
export type TicketListLabels = { tab: string; empty: string }

/**
 * The wording for the project's flat ticket list — the nav link and the tab's own empty
 * state — decided in one place so the two cannot drift.
 *
 * A project WITH sprints has a backlog in the Scrum sense: the tickets waiting outside a
 * sprint. A project WITHOUT sprints has no such distinction — `selectBacklogTickets`'
 * `sprint_id is null` rule is true of every one of its tickets — so the tab is an honest
 * flat list of everything and says so. The rule itself is unchanged; only the label is.
 *
 * A FUNCTION, not a `Record<ProjectType, …>` like the label maps above, and the reason is
 * structural rather than stylistic: a map must be indexed at the call site, and indexing it
 * means a component reading the project's type — which `project-type-single-expression.test.ts`
 * permits in exactly one place in the tree, the header's `PROJECT_TYPE_LABELS` index, and
 * asserts the count is 1. Taking the project keeps the read in here, where `hasSprints`
 * already lives. The guard shaped the design rather than being worked around.
 *
 * The empty copy deliberately does NOT reuse `BoardColumnEmpty`'s "No tickets yet.": there
 * that sentence is a claim about a COLUMN, here it would be a claim about the PROJECT. Same
 * words, two scopes — and a distinct state must never wear another state's face.
 */
export function ticketListLabels(project: Pick<Project, 'project_type'>): TicketListLabels {
  return hasSprints(project)
    ? { tab: 'Backlog', empty: 'Nothing in the backlog.' }
    : { tab: 'All tickets', empty: 'This project has no tickets.' }
}
