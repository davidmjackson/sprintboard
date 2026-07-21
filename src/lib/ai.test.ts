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

  it('sends the JWT and returns proposals with trace on 200', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    const proposals = [
      { title: 'T', description: 'd', type: 'story', rationale: 'r', covers: [0], estimate: 5, estimate_reason: 'why' },
    ]
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        proposals,
        coverage_gaps: [{ index: 1, deliverable: 'b' }],
        scope_creep: [{ proposal_index: 2, title: 'Extra' }],
        estimate_total: 5,
      }),
    } as Response)

    const result = await decomposeEpic(epic)
    expect(result).toEqual({
      ok: true,
      proposals,
      coverage_gaps: [{ index: 1, deliverable: 'b' }],
      scope_creep: [{ proposal_index: 2, title: 'Extra' }],
      estimate_total: 5,
    })

    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(url).toBe('http://localhost:8787/decompose')
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer jwt-123')
    expect(JSON.parse(init!.body as string)).toEqual({ epic })
  })

  it('defaults covers and trace fields to [] when the service omits them', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        proposals: [{ title: 'T', description: 'd', type: 'story', rationale: 'r' }],
      }),
    } as Response)
    const result = await decomposeEpic(epic)
    expect(result).toEqual({
      ok: true,
      proposals: [
        { title: 'T', description: 'd', type: 'story', rationale: 'r', covers: [], estimate: null, estimate_reason: '' },
      ],
      coverage_gaps: [],
      scope_creep: [],
      estimate_total: 0,
    })
  })

  it('returns request_failed on a non-ok response', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response)
    expect(await decomposeEpic(epic)).toEqual({ ok: false, error: 'request_failed' })
  })

  it('returns request_failed when the 200 body is malformed', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ notProposals: 1 }),
    } as unknown as Response)
    expect(await decomposeEpic(epic)).toEqual({ ok: false, error: 'request_failed' })
  })
})
