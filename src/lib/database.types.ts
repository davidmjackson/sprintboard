/**
 * Mirrors docs/sprintboard_phase1_schema.sql.
 *
 * Hand-written rather than generated: the Supabase CLI is not installed and
 * generating requires credentials we deliberately do not hold. Regenerate with
 * `supabase gen types typescript` once the CLI is available, and treat any diff
 * against this file as a bug in one of the two.
 */

export type TicketType = 'epic' | 'story' | 'bug' | 'task'
export type TicketStatus = 'todo' | 'in_progress' | 'in_review' | 'done'
export type SprintStatus = 'future' | 'active' | 'complete'

/** The four fixed board columns. Locked in Phase 1; editable columns are Rung 3. */
export const TICKET_STATUSES = [
  'todo',
  'in_progress',
  'in_review',
  'done',
] as const satisfies readonly TicketStatus[]

export interface Profile {
  id: string
  display_name: string | null
  created_at: string
}

export interface Project {
  id: string
  owner_id: string
  name: string
  /** PROJECTKEY, e.g. SPB. Matches ^[A-Z][A-Z0-9]{1,3}$, unique per owner. */
  key: string
  project_type: 'scrum'
  created_at: string
}

export interface Sprint {
  id: string
  project_id: string
  name: string
  goal: string | null
  status: SprintStatus
  start_date: string | null
  end_date: string | null
  created_at: string
}

export interface Ticket {
  id: string
  project_id: string
  /** Assigned by the assign_ticket_key trigger. Never set these client-side. */
  number: number
  key: string
  summary: string
  description: string | null
  type: TicketType
  status: TicketStatus
  assignee_id: string | null
  story_points: number | null
  acceptance_criteria: string | null
  labels: string[]
  /** null = backlog. */
  sprint_id: string | null
  parent_epic_id: string | null
  /** Epic-only. Feeds the Rung 2 AI decomposition feature. */
  context: string | null
  deliverables: unknown[]
  /** Kept coherent by the sync_blocked_fields trigger and a check constraint. */
  is_blocked: boolean
  blocked_reason: string | null
  blocked_since: string | null
  created_at: string
  updated_at: string
}

/** number/key are trigger-assigned; the rest have defaults or are nullable. */
type TicketInsert =
  Omit<Ticket, 'id' | 'number' | 'key' | 'created_at' | 'updated_at'> extends infer T
    ? { [K in keyof T]?: T[K] } & Pick<Ticket, 'project_id' | 'summary'>
    : never

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: Profile
        Insert: Pick<Profile, 'id'> & Partial<Profile>
        Update: Partial<Profile>
      }
      projects: {
        Row: Project
        Insert: Pick<Project, 'owner_id' | 'name' | 'key'> & Partial<Project>
        Update: Partial<Project>
      }
      project_counters: {
        Row: { project_id: string; last_number: number }
        Insert: { project_id: string; last_number?: number }
        Update: { last_number?: number }
      }
      sprints: {
        Row: Sprint
        Insert: Pick<Sprint, 'project_id' | 'name'> & Partial<Sprint>
        Update: Partial<Sprint>
      }
      tickets: {
        Row: Ticket
        Insert: TicketInsert
        Update: Partial<Omit<Ticket, 'id' | 'number' | 'key'>>
      }
    }
    Views: Record<never, never>
    Functions: Record<never, never>
    Enums: {
      ticket_type: TicketType
      ticket_status: TicketStatus
      sprint_status: SprintStatus
    }
    CompositeTypes: Record<never, never>
  }
}
