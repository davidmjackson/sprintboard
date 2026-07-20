import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { decomposeEpic } from './ai'
import { supabase } from './supabase'

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } },
}))
vi.mock('@/lib/env', () => ({ getEnv: () => ({ VITE_AI_API_URL: 'http://localhost:8787' }) }))

const getSession = vi.mocked(supabase.auth.getSession)
const epic = { summary: 'Auth', context: 'c', deliverables: ['auth UI'] }

beforeEach(() => {
  getSession.mockReset()
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('decomposeEpic', () => {
  it('returns unauthenticated when there is no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } } as never)
    expect(await decomposeEpic(epic)).toEqual({ ok: false, error: 'unauthenticated' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends the JWT and returns proposals on 200', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    const proposals = [{ title: 'T', description: 'd', type: 'story', rationale: 'r' }]
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ proposals }) } as Response)

    const result = await decomposeEpic(epic)
    expect(result).toEqual({ ok: true, proposals })

    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('http://localhost:8787/decompose')
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer jwt-123')
    expect(JSON.parse(init!.body as string)).toEqual({ epic })
  })

  it('returns request_failed on a non-ok response', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response)
    expect(await decomposeEpic(epic)).toEqual({ ok: false, error: 'request_failed' })
  })
})
