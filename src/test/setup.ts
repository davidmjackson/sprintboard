import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(cleanup)

// Node 20 (this project's runtime) has no native WebSocket global; Node only
// ships it unconditionally from v22. @supabase/supabase-js constructs a
// RealtimeClient on every createClient() call, even when realtime is never
// used, and that constructor throws immediately without one. This affects
// test-only code: production still runs in the browser, which always has
// WebSocket. Remove once the project's Node baseline reaches 22.
if (typeof globalThis.WebSocket === 'undefined') {
  const { default: WebSocket } = await import('ws')
  // @ts-expect-error -- ws's WebSocket is a structural match for the DOM type
  // supabase-js expects, but the two libraries' type definitions don't align.
  globalThis.WebSocket = WebSocket
}
