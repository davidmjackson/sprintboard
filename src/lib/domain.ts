/**
 * The domain vocabulary the database cannot express, and the guards that keep it
 * honest.
 *
 * `status`, `type` and `project_type` are text columns with check constraints
 * rather than Postgres enums, so the generated `database.types.ts` types them as
 * bare `string`. These unions restore the narrowing on the client — at the cost
 * of being a second source of truth, which is exactly the thing that rots.
 *
 * Three links hold the chain together, and each is checked somewhere different:
 *
 *   union  ≡  runtime array   — `Exact<>` below, at compile time
 *   array  ≡  check constraint — domain.test.ts, by parsing the DDL
 *   column ≡  the live database — regenerating database.types.ts
 *
 * The middle link is the one that matters and the one a compiler cannot see, so
 * it is a test. `Assignable<>` alone is NOT sufficient: the generated column type
 * is `string`, so *any* string union satisfies it, and adding a value to a union
 * would sail through. `Exact<>` is what actually bites.
 */

import type { Tables, TablesInsert, TablesUpdate } from './database.types'

export type TicketType = 'epic' | 'story' | 'bug' | 'task'

/**
 * Jira's status category — the bucket a status belongs to regardless of its name.
 * This is where the "done is terminal" rule eventually lives; right now nothing
 * reads it, because the four seeded statuses make `'done'` unambiguous. SPRIN-77
 * must move `src/lib/sprints.ts`'s `.neq('status','done')` and
 * `src/routes/ProjectShell.tsx`'s `t.status !== 'done'` onto this column — BOTH of
 * them, together — before it opens write access to `project_statuses`.
 */
export type StatusCategory = 'todo' | 'in_progress' | 'done'
export type TicketStatus = 'todo' | 'in_progress' | 'in_review' | 'done'
export type SprintStatus = 'future' | 'active' | 'complete'
export type ProjectType = 'scrum'

/** The four fixed board columns, in board order. Editable columns are Rung 3. */
export const TICKET_STATUSES = [
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const satisfies readonly TicketStatus[]

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
 * This is also what keeps the four-column guarantee intact across SPRIN-79's seam:
 * `tickets_status_check` is gone, so the only thing still tying the board's
 * `TICKET_STATUSES` to the database is the assertion in `domain.test.ts` that these
 * slugs and that array are the same list. SPRIN-76 removes `TICKET_STATUSES` and
 * renders from these rows instead; until then, do not let the two diverge.
 */
export const DEFAULT_PROJECT_STATUSES = [
  { slug: 'todo', name: 'To Do', category: 'todo', position: 1, is_initial: true },
  { slug: 'in_progress', name: 'In Progress', category: 'in_progress', position: 2, is_initial: false },
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
 * Human-readable board-column labels, keyed by status. This is the single home for
 * the four column names — CLAUDE.md forbids inlining them in a component, filter, or
 * badge-colour map. The `Record<TicketStatus, string>` type makes it exhaustive by
 * construction: a new status cannot be added without giving it a label here.
 */
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
}

/**
 * Human-readable ticket-type labels, keyed by type. Same rule as
 * `TICKET_STATUS_LABELS`: type display names live only here (CLAUDE.md). Typed as an
 * exhaustive `Record<TicketType, string>` so a new type cannot ship without a label.
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
 *  fine — and `isTicketStatus` then rejects a value the type system calls valid. */
export type AssertTicketStatusesExhaustive = Expect<
  Exact<TicketStatus, (typeof TICKET_STATUSES)[number]>
>
export type AssertTicketTypesExhaustive = Expect<Exact<TicketType, (typeof TICKET_TYPES)[number]>>
export type AssertSprintStatusesExhaustive = Expect<
  Exact<SprintStatus, (typeof SPRINT_STATUSES)[number]>
>

export type AssertStatusCategoriesExhaustive = Expect<
  Exact<StatusCategory, (typeof STATUS_CATEGORIES)[number]>
>

export type AssertTicketTypeColumn = Assignable<TicketType, Tables<'tickets'>['type']>
export type AssertTicketStatusColumn = Assignable<TicketStatus, Tables<'tickets'>['status']>
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

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value)
}

export function isTicketType(value: string): value is TicketType {
  return (TICKET_TYPES as readonly string[]).includes(value)
}

export function isSprintStatus(value: string): value is SprintStatus {
  return (SPRINT_STATUSES as readonly string[]).includes(value)
}

export function isStatusCategory(value: string): value is StatusCategory {
  return (STATUS_CATEGORIES as readonly string[]).includes(value)
}
