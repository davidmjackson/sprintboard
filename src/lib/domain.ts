/**
 * The domain vocabulary the database cannot express.
 *
 * `status`, `type` and `project_type` are text columns guarded by check
 * constraints, not Postgres enums, so `database.types.ts` (generated) types
 * them as bare `string`. These unions restore the narrowing on the client.
 *
 * They are therefore a second source of truth, which is exactly the thing that
 * rots. The `Assignable` assertions below are the guard: each union must remain
 * assignable to the generated column type, so if a migration ever turns one of
 * these columns into a real enum — or renames it — this file stops compiling
 * rather than quietly disagreeing with the database.
 *
 * The check constraints in docs/sprintboard_phase1_schema.sql remain the
 * authority. Keep the two in step by hand; the tests cover the values.
 */

import type { Tables } from './database.types'

export type TicketType = 'epic' | 'story' | 'bug' | 'task'
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

/** Fails to compile if `Narrow` is not a subset of the generated column type. */
type Assignable<Narrow extends Wide, Wide> = Narrow

type _TicketTypeMatchesColumn = Assignable<TicketType, Tables<'tickets'>['type']>
type _TicketStatusMatchesColumn = Assignable<TicketStatus, Tables<'tickets'>['status']>
type _SprintStatusMatchesColumn = Assignable<SprintStatus, Tables<'sprints'>['status']>
type _ProjectTypeMatchesColumn = Assignable<ProjectType, Tables<'projects'>['project_type']>

/** Row types with the text columns narrowed to the domain unions. */
export type Profile = Tables<'profiles'>
export type Project = Omit<Tables<'projects'>, 'project_type'> & { project_type: ProjectType }
export type Sprint = Omit<Tables<'sprints'>, 'status'> & { status: SprintStatus }
export type Ticket = Omit<Tables<'tickets'>, 'status' | 'type'> & {
  status: TicketStatus
  type: TicketType
}

export function isTicketStatus(value: string): value is TicketStatus {
  return (TICKET_STATUSES as readonly string[]).includes(value)
}

export function isTicketType(value: string): value is TicketType {
  return (TICKET_TYPES as readonly string[]).includes(value)
}
