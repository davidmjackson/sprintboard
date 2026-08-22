import { readFileSync } from 'node:fs'
import type { ConnectionOptions } from 'node:tls'
import { Client, type ClientConfig, type QueryResultRow } from 'pg'
import { requireOrExplain } from './supabase-clients'

/**
 * TWO REAL POSTGRES SESSIONS — the one thing PostgREST cannot express.
 *
 * Every other live suite in this repo drives the database through PostgREST, and that is
 * the right default: it is how the app talks to Postgres, so a test that goes through it
 * proves something about the shipped path. But PostgREST wraps each request in its own
 * transaction and gives the caller no handle on it. A defect whose window is the gap
 * BETWEEN TWO STATEMENTS INSIDE one transaction is therefore invisible to every client in
 * `supabase-clients.ts`, however many requests you fire concurrently.
 *
 * SPRIN-107 is exactly that defect: `remove_project_member` decided whether to take its
 * row lock from an UNLOCKED read, so a member promoted to sole admin in the window between
 * that read and the DELETE was deleted straight past the last-admin guard, stranding the
 * project with zero admins — a state no authenticated user can administer or even delete,
 * because `projects_admin_delete` also resolves to `app_auth.is_project_admin`.
 *
 * WHY THIS IS NOT A FLAKY RACE TEST, which is the reasonable first suspicion. Nothing here
 * races. The interleaving is pinned open by an UNCOMMITTED write: session A updates the
 * target row and holds the transaction, so the row lock is held indefinitely and session
 * B's DELETE blocks on it for as long as we like. B is parked at the precise instruction
 * the defect lives at, deterministically, on every run. `waitUntilBlocked` turns "B has
 * reached the lock" into an observed fact rather than a sleep. The SPRIN-102 review lens
 * rated this defect LOW *because it could not reproduce the race* — it was trying to win
 * one. You do not have to win a race you can stop.
 *
 * SESSION MODE, NOT TRANSACTION MODE. `SUPABASE_DB_URL` must be the session-mode pooler
 * (port 5432). Transaction mode (6543) hands a server connection back to the pool at every
 * COMMIT, so `pg_backend_pid()` would not identify a stable backend and an open
 * transaction could not be parked across statements — both load-bearing here. The direct
 * `db.<ref>.supabase.co` host would also serve, but it is IPv6-only and neither WSL2 nor
 * a GitHub runner has an IPv6 route.
 *
 * THIS CONNECTION IS SUPERUSER-CLASS AND BYPASSES RLS AND PostgREST ENTIRELY. It is
 * strictly more powerful than the service-role key, which at least still passes through
 * PostgREST's schema exposure. Containment is the same and rests on the same one fact:
 * `SUPABASE_DB_URL` carries no `VITE_` prefix, so Vite never inlines it into a bundle, and
 * `scripts/check-bundle.mjs` fails the build if it ever reaches `dist/`. Application code
 * must never import this module. Only `*.integration.test.ts` may.
 */

const DB_URL = process.env.SUPABASE_DB_URL === '' ? undefined : process.env.SUPABASE_DB_URL

export const hasDbUrl = Boolean(DB_URL)

export function assertDbUrlOrExplain(): void {
  requireOrExplain(
    hasDbUrl,
    'the membership concurrency suite',
    'Membership concurrency test cannot run: missing SUPABASE_DB_URL. It must be the ' +
      'SESSION-mode pooler URI (port 5432), not transaction mode. See .env.example.',
  )
}

/**
 * Supabase's own root CA, pinned — NOT `rejectUnauthorized: false`.
 *
 * The pooler terminates TLS with a chain rooted in `Supabase Root 2021 CA`, which is not
 * in Node's trust store, so plain strict verification fails with
 * `SELF_SIGNED_CERT_IN_CHAIN`. The reflex fix is to switch verification off, and it is the
 * wrong one: this connection carries a superuser-class password, and an unverified TLS
 * session hands it to anyone who can sit in the path. Turning verification off also
 * accepts EVERY certificate forever, whereas pinning accepts exactly one issuer — a
 * strictly stronger position than the default trust store, which would accept any of
 * ~150 public CAs.
 *
 * The file is Supabase's published certificate, downloaded over a verified TLS connection
 * to supabase.com, and it is a PUBLIC certificate: committing it leaks nothing. It expires
 * 2031-04-26, at which point every connection here fails loudly and closed, which is the
 * correct direction for an expiry to fail in.
 */
const SUPABASE_CA = readFileSync(new URL('./supabase-root-2021-ca.crt', import.meta.url), 'utf8')

/**
 * A hung session must fail the test, not the run. Long enough that the deliberate block in
 * `waitUntilBlocked` is never the thing that trips it, short enough that a genuine hang
 * reports as a timeout on the statement that hung rather than as a dead Vitest worker.
 */
const STATEMENT_TIMEOUT = '20s'

/** Poll interval for `waitUntilBlocked`. Small: the block is already there, we are only
 *  waiting for the wait to become visible in `pg_stat_activity`. */
const POLL_INTERVAL_MS = 25

/**
 * sslmode values that weaken or remove server authentication. Anything not on this list is
 * accepted; `verify-full` and `verify-ca` ask for what the pin already enforces.
 */
const WEAK_SSLMODES = new Set(['disable', 'allow', 'prefer', 'require', 'no-verify'])

/**
 * The pg client options for one session — and the guard that stops the URL overriding the pin.
 *
 * SPRIN-107 REVIEW, HIGH. Appending `?sslmode=disable` to `SUPABASE_DB_URL` produced a
 * CLEARTEXT connection carrying a superuser-class password (`socket.encrypted === false`)
 * while this file still read `ssl: { rejectUnauthorized: true }`. `?sslmode=no-verify`
 * likewise connected against a deliberately WRONG CA. node-postgres lets the connection
 * string's sslmode win, so the explicit option is not the last word and cannot be trusted to
 * be — which makes the visible pin actively misleading to anyone auditing this file.
 *
 * So the URL is rejected rather than quietly corrected. Refusing is the right direction: an
 * sslmode in this variable is either a mistake or an attempt to weaken transport security on
 * the repo's most privileged credential, and neither should start a connection. Extracted from
 * `PgSession.open` purely so `pg-sessions.test.ts` can pin it without a database.
 */
export function connectionOptions(
  url: string,
  label: string,
): ClientConfig & { ssl: ConnectionOptions } {
  // Case-insensitive on the KEY as well as the value: libpq treats parameter names
  // case-insensitively, so `SSLMODE=DISABLE` is the same instruction as `sslmode=disable`
  // and a guard that only matched the lowercase spelling would be trivially stepped around.
  const [, sslmode] =
    [...new URL(url).searchParams].find(([key]) => key.toLowerCase() === 'sslmode') ?? []
  if (sslmode !== undefined && WEAK_SSLMODES.has(sslmode.toLowerCase())) {
    throw new Error(
      `SUPABASE_DB_URL carries sslmode=${sslmode}, which overrides the pinned-CA verification ` +
        'in this file and would send a superuser-class password over an unauthenticated ' +
        'connection. Remove it from the URL.',
    )
  }
  return {
    connectionString: url,
    application_name: `sprintboard-test-${label}`,
    ssl: { ca: SUPABASE_CA, rejectUnauthorized: true },
  }
}

export class PgSession {
  // Declared rather than written as constructor parameter properties: `erasableSyntaxOnly`
  // is on, and parameter properties emit runtime code that type stripping cannot erase.
  private readonly client: Client
  readonly pid: number
  readonly label: string

  private constructor(client: Client, pid: number, label: string) {
    this.client = client
    this.pid = pid
    this.label = label
  }

  static async open(label: string): Promise<PgSession> {
    if (!DB_URL) throw new Error('No SUPABASE_DB_URL. See .env.example.')
    const client = new Client(connectionOptions(DB_URL, label))
    await client.connect()
    await client.query(`set statement_timeout = '${STATEMENT_TIMEOUT}'`)
    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid')
    const pid = rows[0]?.pid
    if (pid === undefined) throw new Error(`Session ${label} reported no backend pid.`)
    return new PgSession(client, pid, label)
  }

  async query<R extends QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
    const { rows } = await this.client.query<R>(text, params)
    return rows
  }

  async begin(): Promise<void> {
    await this.query('begin')
  }

  async commit(): Promise<void> {
    await this.query('commit')
  }

  async rollback(): Promise<void> {
    await this.query('rollback')
  }

  /**
   * Become an authenticated user, the way PostgREST does it.
   *
   * `auth.uid()` is `current_setting('request.jwt.claims')::jsonb ->> 'sub'`, so setting
   * that GUC is the whole of what a signed-in request is, as far as every policy and every
   * `app_auth` predicate can tell. Switching the ROLE as well is not decoration: the three
   * membership RPCs are `SECURITY DEFINER` but their EXECUTE grants, and the SPRIN-102
   * revoke on direct writes to `project_members`, are all role-scoped. Left as `postgres`
   * a test would sail through privilege checks the app cannot, and prove nothing.
   *
   * Both settings are `local`, so they last exactly as long as the transaction — call this
   * AFTER `begin()`.
   */
  async actAs(userId: string): Promise<void> {
    await this.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ])
    await this.query('set local role authenticated')
  }

  async end(): Promise<void> {
    await this.client.end()
  }
}

/**
 * Block until `pid` is waiting on a lock, or fail saying what it was doing instead.
 *
 * This is the sync point that makes the whole harness deterministic, and it replaces the
 * sleep that would otherwise sit here. A sleep asserts nothing: too short and the test
 * races the very window it is trying to hold open, too long and it is dead time on every
 * run. Waiting on `pg_stat_activity` turns "the other session has reached the lock" from a
 * hope into an observation, so the step that follows can only run once the interleaving is
 * actually established.
 *
 * The observer must NOT be inside `actAs` — `pg_stat_activity` hides other roles' query
 * text and state from a non-superuser, so an `authenticated` poller would wait forever on
 * a row it can see but not read.
 */
export interface LockObserver {
  query<R extends QueryResultRow>(text: string, params?: unknown[]): Promise<R[]>
}

export async function waitUntilBlocked(
  observer: LockObserver,
  pid: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await observer.query<{ wait_event_type: string | null; state: string | null }>(
      `select wait_event_type, state from pg_stat_activity where pid = $1`,
      [pid],
    )
    const row = rows[0]
    if (row?.wait_event_type === 'Lock') return
    if (Date.now() > deadline) {
      const seen = row
        ? `${row.state} / ${row.wait_event_type ?? 'not waiting'}`
        : 'no such backend'
      throw new Error(
        `Session ${pid} never blocked on a lock within ${timeoutMs}ms (saw: ${seen}).`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
}
