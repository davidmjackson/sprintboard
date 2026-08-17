import { createClient } from '@supabase/supabase-js'
import { getEnv } from './env'
import type { Database } from './database.types'

const env = getEnv()

/**
 * The browser client. Anon key only — every read and write is subject to the
 * RLS policies in the schema, which are the actual security boundary. Those
 * policies are mid-migration from owner-scoped to membership-scoped (epic
 * SPRIN-75): the board tables, `project_members` and `profiles` now resolve
 * through membership, the rest still resolve to `owner_id = auth.uid()`. Do not
 * describe the schema as uniformly one or the other. See CLAUDE.md.
 */
export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
