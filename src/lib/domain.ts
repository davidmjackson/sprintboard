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
export type ProjectType = 'scrum'

export const TICKET_TYPES = [
  'epic',
  'story',
  'bug',
  'task',
] as const satisfies readonly TicketType[]

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

export type AssertTicketTypeColumn = Assignable<TicketType, Tables<'tickets'>['type']>
/* No AssertTicketStatusColumn: `TicketStatus` is `string` as of Task 3 of SPRIN-76, so
 * `Assignable<string, string>` would be vacuous — it would compile without checking
 * anything, which is worse than no guard because it still reads like one. */
export type AssertSprintStatusColumn = Assignable<SprintStatus, Tables<'sprints'>['status']>
export type AssertProjectTypeColumn = Assignable<ProjectType, Tables<'projects'>['project_type']>
export type AssertStatusCategoryColumn = Assignable<
  StatusCategory,
  Tables<'project_statuses'>['category']
>

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
 * Read-only to every client in this slice: `statuses_owner_read` is a SELECT-only
 * policy, so there is no Insert or Update counterpart to this type on purpose.
 * SPRIN-77 adds them together with the write policy.
 */
export type ProjectStatus = Omit<Tables<'project_statuses'>, 'category'> & {
  category: StatusCategory
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
 */
export type TicketInsert = Omit<TablesInsert<'tickets'>, 'key' | 'number'>

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
