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
      {
        title: 'T',
        description: 'd',
        type: 'story',
        rationale: 'r',
        covers: [0],
        estimate: 5,
        estimate_reason: 'why',
      },
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
        {
          title: 'T',
          description: 'd',
          type: 'story',
          rationale: 'r',
          covers: [],
          estimate: null,
          estimate_reason: '',
        },
      ],
      coverage_gaps: [],
      scope_creep: [],
      estimate_total: 0,
    })
  })

  it('returns request_failed on a non-ok response', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    // The body is deliberately WELL-FORMED and parseable. With a bare `{ ok: false }` mock
    // that has no `json`, deleting the status check still yields request_failed — via a
    // TypeError caught downstream — so the test would pass for the wrong reason and the
    // check it exists to protect would be unpinned. Here, only the status check can
    // produce this result.
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ proposals: [{ title: 'leaked', description: 'd', type: 'story' }] }),
    } as unknown as Response)
    expect(await decomposeEpic(epic)).toEqual({ ok: false, error: 'request_failed' })
  })

  it('returns request_failed when the request never completes', async () => {
    // The transport-failure path: the AI service is local, so "not running" is the
    // ordinary case, not an exotic one. Nothing exercised this before.
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    vi.mocked(fetch).mockRejectedValue(new TypeError('fetch failed'))
    expect(await decomposeEpic(epic)).toEqual({ ok: false, error: 'request_failed' })
  })

  it('returns request_failed when a 200 body will not parse as JSON', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON')
      },
    } as unknown as Response)
    expect(await decomposeEpic(epic)).toEqual({ ok: false, error: 'request_failed' })
  })

  it('dedupes covers so the trace chips cannot collide on React keys', async () => {
    // R2.1 added the dedupe for exactly this reason. The server sanitises, but a
    // malformed or forward-compatible service could still send duplicates, and duplicate
    // keys in the chip list are a React warning plus a rendering bug — not cosmetic.
    getSession.mockResolvedValue({ data: { session: { access_token: 'jwt-123' } } } as never)
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        proposals: [
          { title: 'T', description: 'd', type: 'story', rationale: 'r', covers: [0, 1, 0, 1, 0] },
        ],
      }),
    } as unknown as Response)

    const result = await decomposeEpic(epic)
    if (!result.ok) throw new Error('expected a successful decomposition')
    expect(result.proposals[0]!.covers).toEqual([0, 1])
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
