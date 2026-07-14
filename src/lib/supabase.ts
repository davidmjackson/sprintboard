import { createClient } from '@supabase/supabase-js'
import { getEnv } from './env'
import type { Database } from './database.types'

const env = getEnv()

/**
 * The browser client. Anon key only — every read and write is subject to the
 * owner-scoped RLS policies in the schema, which are the actual security
 * boundary. See CLAUDE.md.
 */
export const supabase = createClient<Database>(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
})
