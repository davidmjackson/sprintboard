/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Produced from the live database (project xcnmyhozmcopcpxlagrk) via the
 * Supabase MCP `generate_typescript_types`. Regenerate after any migration.
 *
 * The schema stores `type` / `project_type` / `sprints.status` as text + check
 * constraints rather than Postgres enums, so those columns arrive here as plain
 * `string`. `tickets.status` is text too, but as of SPRIN-79 it is constrained by
 * a COMPOSITE FOREIGN KEY to `project_statuses (project_id, slug)` — the status
 * vocabulary is per-project, and a check constraint cannot express that.
 *
 * Either way the column still arrives as `string`, so nothing in the type system
 * forces this file to be regenerated after a status migration. That is precisely
 * how it gets forgotten: `.from('project_statuses')` failing to type-check is the
 * only symptom.
 *
 * `Functions` is no longer empty. SPRIN-77's migration added the
 * `reorder_project_statuses` RPC, and unlike a column widening, an RPC DOES force
 * this regeneration: `Functions` keys the only overload of `supabase.rpc`, so
 * calling a function this file has never seen is a compile error rather than a
 * silent `string`.
 *
 * SPRIN-85 added `project_statuses.wip_limit`, which arrives as `number | null` —
 * a NULLABLE column, and the nullability is the meaning rather than an accident:
 * `null` is "no limit". Note it also appears in `reorder_project_statuses`'
 * `Returns`, because that RPC returns `setof project_statuses` and so widens
 * whenever the table does.
 *
 * SPRIN-88 added the `ticket_field_values` table. A NEW TABLE is the one schema
 * change that cannot be forgotten the way a widened column can: `.from('x')` is
 * keyed on the `Tables` keys, so calling it for a table this file has never seen
 * is a compile error — the same forcing property `reorder_project_statuses` has,
 * and for the same reason.
 *
 * What is NOT expressed here is that table's central invariant. Its four
 * `value_*` columns all arrive independently nullable, so the type system will
 * happily accept a row with two values or none; `tfv_one_value_matching_type`
 * rejects both, and `tfv_type_fk` rejects a `field_type` that is not the
 * definition's own. Those are database-side controls with no client-side shadow,
 * which is why the live tests asserting their constraint NAMES are the only
 * evidence they hold.
 *
 * The narrowed domain unions live in `domain.ts`, which is hand-owned precisely so
 * that regenerating this file cannot clobber them.
 *
 * SPRIN-92 added the `project_field_options` table (single-select custom field
 * options) and the `tfv_option_fk` composite foreign key on `ticket_field_values`
 * (`field_id, value_option`) -> `project_field_options (field_id, slug)`. Both are
 * new `Tables`/`Relationships` keys, so the same forcing property applies: calling
 * `.from('project_field_options')` before this regeneration would have been a
 * compile error rather than a silent `string`.
 *
 * SPRIN-94 added `projects.sprint_length_weeks` and `projects.sprint_start_weekday`,
 * both `not null` with defaults (`2` and `1`), so they arrive here as plain `number`
 * — not `number | null` — on `Row`, `Insert` and `Update` alike. Their range checks
 * (`projects_sprint_length_weeks_range`, 1-4; `projects_sprint_start_weekday_range`,
 * 1-7) are, like every other check constraint in this schema, invisible here: the
 * columns are unconstrained `number` on the client, and `SPRINT_LENGTH_WEEKS` /
 * `SPRINT_WEEKDAYS` in `domain.ts` are what keep a picker built on them honest.
 *
 * SPRIN-98 added the `project_members` table — the first table in this schema whose
 * policies do NOT resolve to `owner_id = auth.uid()`. `role` arrives as plain `string`,
 * constrained only by `project_members_role_check` ('admin' | 'member'), so the narrowed
 * union belongs in `domain.ts` like every other text + check column.
 *
 * TWO things are absent here. Only ONE of them means anything, and an earlier version of
 * this comment got that exactly backwards — it is left corrected rather than deleted,
 * because the wrong version is the tempting one.
 *
 *   - **The `app_auth` helper functions.** `Functions` lists `reorder_project_statuses`
 *     alone. It is TEMPTING to read that as proof PostgREST does not expose `app_auth`,
 *     and this file said so. **It proves nothing.** The generator emits the `public`
 *     schema regardless of what is exposed, so a non-`public` schema is absent whether or
 *     not it is reachable. The disproof is in this same database: `graphql_public` IS
 *     exposed and is likewise absent from this file. A tripwire that cannot fire is worse
 *     than none, because it is believed. The real check is a live one —
 *     `project-members.integration.test.ts` sends `Accept-Profile: app_auth` and asserts
 *     PostgREST answers 406 / PGRST106 `Invalid schema`, which flips the instant the
 *     schema is added to the exposed list.
 *   - **The `user_id` foreign key.** `Relationships` lists only `project_id`, because
 *     `auth.users` is outside `public` and the generator cannot see across. The cascade
 *     is real regardless — deleting a user still removes their memberships.
 *
 * Column-level grants are invisible here too, as always: `Update` shows every column as
 * optional, but only `role` is actually granted to `authenticated`. A patch touching
 * `project_id` or `user_id` type-checks and then earns 42501 at runtime.
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
      project_field_options: {
        Row: {
          field_id: string
          label: string
          position: number
          project_id: string
          slug: string
        }
        Insert: {
          field_id: string
          label: string
          position: number
          project_id: string
          slug: string
        }
        Update: {
          field_id?: string
          label?: string
          position?: number
          project_id?: string
          slug?: string
        }
        Relationships: [
          {
            foreignKeyName: 'pfo_field_fk'
            columns: ['field_id', 'project_id']
            isOneToOne: false
            referencedRelation: 'project_fields'
            referencedColumns: ['id', 'project_id']
          },
        ]
      }
      project_fields: {
        Row: {
          created_at: string
          id: string
          name: string
          project_id: string
          slug: string
          type: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          project_id: string
          slug: string
          type: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          project_id?: string
          slug?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: 'project_fields_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects'
            referencedColumns: ['id']
          },
        ]
      }
      project_members: {
        Row: {
          created_at: string
          project_id: string
          role: string
          user_id: string
        }
        Insert: {
          created_at?: string
          project_id: string
          role: string
          user_id: string
        }
        Update: {
          created_at?: string
          project_id?: string
          role?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: 'project_members_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
            referencedRelation: 'projects'
            referencedColumns: ['id']
          },
        ]
      }
      project_statuses: {
        Row: {
          category: string
          created_at: string
          id: string
          is_initial: boolean
          name: string
          position: number
          project_id: string
          slug: string
          wip_limit: number | null
        }
        Insert: {
          category?: string
          created_at?: string
          id?: string
          is_initial?: boolean
          name: string
          position: number
          project_id: string
          slug: string
          wip_limit?: number | null
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          is_initial?: boolean
          name?: string
          position?: number
          project_id?: string
          slug?: string
          wip_limit?: number | null
        }
        Relationships: [
          {
            foreignKeyName: 'project_statuses_project_id_fkey'
            columns: ['project_id']
            isOneToOne: false
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
          sprint_length_weeks: number
          sprint_start_weekday: number
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          name: string
          owner_id: string
          project_type?: string
          sprint_length_weeks?: number
          sprint_start_weekday?: number
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          name?: string
          owner_id?: string
          project_type?: string
          sprint_length_weeks?: number
          sprint_start_weekday?: number
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
      ticket_field_values: {
        Row: {
          field_id: string
          field_type: string
          project_id: string
          ticket_id: string
          value_date: string | null
          value_number: number | null
          value_option: string | null
          value_text: string | null
        }
        Insert: {
          field_id: string
          field_type: string
          project_id: string
          ticket_id: string
          value_date?: string | null
          value_number?: number | null
          value_option?: string | null
          value_text?: string | null
        }
        Update: {
          field_id?: string
          field_type?: string
          project_id?: string
          ticket_id?: string
          value_date?: string | null
          value_number?: number | null
          value_option?: string | null
          value_text?: string | null
        }
        Relationships: [
          {
            foreignKeyName: 'tfv_field_fk'
            columns: ['field_id', 'project_id']
            isOneToOne: false
            referencedRelation: 'project_fields'
            referencedColumns: ['id', 'project_id']
          },
          {
            foreignKeyName: 'tfv_option_fk'
            columns: ['field_id', 'value_option']
            isOneToOne: false
            referencedRelation: 'project_field_options'
            referencedColumns: ['field_id', 'slug']
          },
          {
            foreignKeyName: 'tfv_ticket_fk'
            columns: ['ticket_id', 'project_id']
            isOneToOne: false
            referencedRelation: 'tickets'
            referencedColumns: ['id', 'project_id']
          },
          {
            foreignKeyName: 'tfv_type_fk'
            columns: ['field_id', 'field_type']
            isOneToOne: false
            referencedRelation: 'project_fields'
            referencedColumns: ['id', 'type']
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
          key?: string
          labels?: string[]
          number?: number
          parent_epic_id?: string | null
          project_id: string
          sprint_id?: string | null
          status: string
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
          {
            foreignKeyName: 'tickets_status_fk'
            columns: ['project_id', 'status']
            isOneToOne: false
            referencedRelation: 'project_statuses'
            referencedColumns: ['project_id', 'slug']
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      reorder_project_statuses: {
        Args: { p_project_id: string; p_slugs: string[] }
        Returns: {
          category: string
          created_at: string
          id: string
          is_initial: boolean
          name: string
          position: number
          project_id: string
          slug: string
          wip_limit: number | null
        }[]
        SetofOptions: {
          from: '*'
          to: 'project_statuses'
          isOneToOne: false
          isSetofReturn: true
        }
      }
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
