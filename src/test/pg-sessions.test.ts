// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { type LockObserver, connectionOptions, waitUntilBlocked } from './pg-sessions'

/**
 * SPRIN-107 REVIEW. `pg-sessions.ts` carries the strongest credential in this repo — a direct
 * Postgres connection that bypasses RLS *and* PostgREST — and before this file NOTHING asserted
 * anything about how it connects. Two mutations proved it: replacing the pinned-CA config with
 * `ssl: false` left the whole concurrency suite green, and appending `?sslmode=disable` to the
 * URL produced a CLEARTEXT superuser connection (`socket.encrypted === false`) while the source
 * still read `rejectUnauthorized: true`.
 *
 * That second one is the dangerous shape: the code says the pin is on, and the URL silently
 * overrides it. A reader auditing this file would see a correct-looking pin and be wrong. The
 * defence has to reject the URL rather than trust the explicit option to win, because it does not.
 *
 * These are unit tests on purpose — they need no database, so they run in `test:unit` and in every
 * worktree, unlike the live suite which is gated behind a third secret.
 */
describe('connectionOptions', () => {
  const BASE = 'postgresql://postgres.abc:pw@aws-0-eu-west-1.pooler.supabase.com:5432/postgres'

  it('pins the Supabase CA and demands verification', () => {
    const options = connectionOptions(BASE, 'a')

    expect(options.ssl).toMatchObject({ rejectUnauthorized: true })
    expect(options.ssl.ca).toContain('BEGIN CERTIFICATE')
  })

  it('names the session so a parked backend is identifiable in pg_stat_activity', () => {
    expect(connectionOptions(BASE, 'obs').application_name).toBe('sprintboard-test-obs')
  })

  // Every sslmode weaker than verify-full. `disable` is cleartext; `allow`, `prefer` and `require`
  // encrypt without authenticating the server, so they stop a passive eavesdropper and not an
  // active one; `no-verify` is node-postgres's own spelling of the same thing. None of them may
  // silently override a pin the source claims is on.
  it.each(['disable', 'allow', 'prefer', 'require', 'no-verify'])(
    'refuses a URL carrying sslmode=%s',
    (mode) => {
      expect(() => connectionOptions(`${BASE}?sslmode=${mode}`, 'a')).toThrow(/sslmode/i)
    },
  )

  it('refuses sslmode regardless of case or position among other parameters', () => {
    expect(() =>
      connectionOptions(`${BASE}?application_name=x&SSLMODE=DISABLE&connect_timeout=5`, 'a'),
    ).toThrow(/sslmode/i)
  })

  it('accepts sslmode=verify-full, which asks for exactly what the pin already enforces', () => {
    expect(() => connectionOptions(`${BASE}?sslmode=verify-full`, 'a')).not.toThrow()
  })

  it('accepts an ordinary URL with unrelated parameters', () => {
    expect(() => connectionOptions(`${BASE}?connect_timeout=10`, 'a')).not.toThrow()
  })
})

/**
 * SPRIN-107 REVIEW, MEDIUM. `waitUntilBlocked` is the single guarantee that makes the
 * concurrency suite a concurrency suite, and nothing tested it. A reviewer neutered it three
 * different ways — returning immediately, polling for the wrong condition — and the suite stayed
 * GREEN every time, silently degraded into a sequential test that proves nothing about locking.
 *
 * That is the worst failure mode available to a concurrency test: it does not go red, it stops
 * testing. So the property pinned here is FAILING CLOSED — an interleaving that never
 * established must raise, never return.
 */
function observerReturning(rows: Array<Record<string, unknown>>): LockObserver {
  return { query: async () => rows as never }
}

describe('waitUntilBlocked', () => {
  it('returns once the backend is waiting on a lock', async () => {
    const observer = observerReturning([{ wait_event_type: 'Lock', state: 'active' }])

    await expect(waitUntilBlocked(observer, 123, 500)).resolves.toBeUndefined()
  })

  // The three mutations that survived, as tests. Each is a backend that is alive and busy but
  // NOT parked on a lock, which is exactly what a lost interleaving looks like.
  it.each([
    { label: 'a backend that never blocks', rows: [{ wait_event_type: 'Client', state: 'idle' }] },
    {
      label: 'a backend waiting on something else',
      rows: [{ wait_event_type: 'IO', state: 'active' }],
    },
    { label: 'a backend not waiting at all', rows: [{ wait_event_type: null, state: 'active' }] },
    { label: 'no such backend', rows: [] },
  ])('throws rather than proceeding on $label', async ({ rows }) => {
    await expect(waitUntilBlocked(observerReturning(rows), 123, 150)).rejects.toThrow(
      /never blocked on a lock/,
    )
  })

  it('names the pid and what it saw instead, so a failure is diagnosable', async () => {
    const observer = observerReturning([
      { wait_event_type: 'Client', state: 'idle in transaction' },
    ])

    await expect(waitUntilBlocked(observer, 4242, 150)).rejects.toThrow(
      /4242.*idle in transaction/s,
    )
  })
})
