/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced from the live database (project xcnmyhozmcopcpxlagrk) via the
 * Supabase MCP `generate_typescript_types`. Regenerate after any migration.
 *
 * The schema stores `status` / `type` as text + check constraints rather than
 * Postgres enums, so those columns arrive here as plain `string`. The narrowed
 * domain unions live in `domain.ts`, which is hand-owned precisely so that
 * regenerating this file cannot clobber them.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.5'
  }
  public: {
    Tables: {
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
        }
        Relationships: []
      }
      project_counters: {
        Row: {
          last_number: number
          project_id: string
        }
        Insert: {
          last_number?: number
          project_id: string
        }
        Update: {
          last_number?: number
          project_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'project_counters_project_id_fkey'
            columns: ['project_id']
            isOneToOne: true
            referencedRelation: 'projects'
            referencedColumns: ['id']
          },
        ]
      }
      projects: {
        Row: {
          created_at: string
          id: string
          key: string
          name: string
          owner_id: string
          project_type: string
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          name: string
          owner_id: string
          project_type?: string
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          name?: string
          owner_id?: string
          project_type?: string
        }
        Relationships: []
      }
      sprints: {
        Row: {
          created_at: string
          end_date: string | null
          goal: string | null
          id: string
          name: string
          project_id: string
          start_date: string | null
          status: string
        }
        Insert: {
          created_at?: string
          end_date?: string | null
          goal?: string | null
          id?: string
          name: string
          project_id: string
          start_date?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          end_date?: string | null
          goal?: string | null
          id?: string
          name?: string
          project_id?: string
          start_date?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: 'sprints_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects'
            referencedColumns: ['id']
          },
        ]
      }
      tickets: {
        Row: {
          acceptance_criteria: string | null
          assignee_id: string | null
          blocked_reason: string | null
          blocked_since: string | null
          context: string | null
          created_at: string
          deliverables: Json
          description: string | null
          id: string
          is_blocked: boolean
          key: string
          labels: string[]
          number: number
          parent_epic_id: string | null
          project_id: string
          sprint_id: string | null
          status: string
          story_points: number | null
          summary: string
          type: string
          updated_at: string
        }
        Insert: {
          acceptance_criteria?: string | null
          assignee_id?: string | null
          blocked_reason?: string | null
          blocked_since?: string | null
          context?: string | null
          created_at?: string
          deliverables?: Json
          description?: string | null
          id?: string
          is_blocked?: boolean
          key: string
          labels?: string[]
          number: number
          parent_epic_id?: string | null
          project_id: string
          sprint_id?: string | null
          status?: string
          story_points?: number | null
          summary: string
          type?: string
          updated_at?: string
        }
        Update: {
          acceptance_criteria?: string | null
          assignee_id?: string | null
          blocked_reason?: string | null
          blocked_since?: string | null
          context?: string | null
          created_at?: string
          deliverables?: Json
          description?: string | null
          id?: string
          is_blocked?: boolean
          key?: string
          labels?: string[]
          number?: number
          parent_epic_id?: string | null
          project_id?: string
          sprint_id?: string | null
          status?: string
          story_points?: number | null
          summary?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: 'tickets_epic_fk'
            columns: ['parent_epic_id', 'project_id']
            isOneToOne: false
            referencedRelation: 'tickets'
            referencedColumns: ['id', 'project_id']
          },
          {
            foreignKeyName: 'tickets_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'tickets_sprint_fk'
            columns: ['sprint_id', 'project_id']
            isOneToOne: false
            referencedRelation: 'sprints'
            referencedColumns: ['id', 'project_id']
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
