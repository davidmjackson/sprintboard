# Testing notes

Read **when you hit one of these**, not every session. `CLAUDE.md` holds the standing
rules; this file holds the diagnosis you need at the moment something goes wrong.

---

## The gap between `npm test` and `test:unit` is the tripwire

`npm test` collects exactly **fourteen more files** than `test:unit` — the fourteen
`*.integration.test.ts` suites. **That difference is the invariant. The absolute counts
are not** — every story that adds a unit-test file moves both, and they have drifted in
this file more than once while the gap stayed correct.

If a CI run's file count equals the `test:unit` count — gap **zero** — the live suites
silently skipped and the run is a failure however green it looks.

- Re-derive with `npx vitest list --filesOnly | wc -l`, and the same command with
  `--exclude '**/*.integration.test.ts'`.
- **A story that adds a live suite owes two updates in the same commit:** the number
  above, and `verify-gate.test.mjs`'s `LIVE_SUITES` array. The prose is only half the
  control; the array is the executable half. SPRIN-105 updated the prose and left the
  array behind, so its own suite was collectable-but-unregistered for a whole story —
  precisely the state the array exists to make impossible.
- **Never wire CI to `npm run test:unit`.** It excludes the integration suites and needs
  no secrets, so CI would stay green while "RLS still holds" went unmet on every PR.
  CI needs the `RLS_TEST_*`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_DB_URL` secrets
  or the suites skip rather than run.

Last re-derived **2026-08-22**, after SPRIN-107: **90 vs 76**. Treat that as a
timestamped observation, not a constant.

---

## Live-suite failures: four signatures, and how to tell them apart

The live suites sign the real `RLS_TEST_{A,B}` users in against GoTrue. Classify on the
**shape** — status, error class, setup-vs-body, blast radius — before reaching for a
remedy. **"Neither documented flake matches, therefore it is my diff" is backwards.**

| # | Signature | Cause | Remedy |
|---|---|---|---|
| 1 | Bare `TypeError: Cannot read properties of null (reading 'id')` in a **`beforeAll`** | GoTrue auth rate limiter | 2–5 min with no sign-ins, then `gh run rerun <id> --failed` |
| 2 | `unrecognized JWT kid <nil> for algorithm ES256`, thrown by the suite's **own guard** | Service-role key copied into `Authorization` — see below | Fixed at source; should not recur |
| 3 | `AuthRetryableFetchError: fetch failed`, **`status: 0`**, `[cause] read ECONNRESET`, as an assertion failure **inside a test body** | Transport reset — no HTTP response ever came back | Same cool-down and rerun |
| 4 | Bare `Test timed out in 5000ms`, **victim moves between runs on the same SHA** | Starved database, not a broken one | **7-minute** quiet window, then one rerun |

**Anything not on this list is real.** Do not "fix" a flake by weakening a suite.

Notes that make the table usable:

- Signature 1 vs 3: the rate limiter returns a **429** or the bare null-`id` crash. A
  *named* GoTrue error means a bad credential. `status: 0` is neither.
- Signature 4's tell is decisive: **a defect does not move target on an unchanged
  commit; a starved backend does.** Re-read the second failure's file list before
  concluding anything. Confirm with `npm run keepalive` — one anon GET, no sign-in, so
  it cannot rate-limit. It answered in 426 ms against the 5000 ms budget once, settling
  that the endpoint was healthy and CI was merely starved.
- The usual cause is the session's own traffic. The `verify` concurrency group
  serialises CI against itself; it does nothing about a local pile-up of seeding,
  browser sessions, an E2E and a local `verify`.
- Confirm any rerun's `headSha` equals the PR head, and trust CI over a local run.

### Never follow `signIn()` with `auth.getUser()`

`signIn()` already established and validated the session. Read the id with
`userId(client)` in `src/test/supabase-clients.ts`, which reads the **in-memory**
session — no network call, nothing to rate-limit. Reintroducing a `getUser()` per
`beforeAll` (there were ~14) is what caused signature 1 in the first place.

---

## The service-role key travels in `apikey`, never `Authorization`

This project's API keys are the **opaque format** (`sb_publishable_…` / `sb_secret_…`),
not legacy HS256 JWTs, and the JWKS holds one ES256 key. supabase-js still copies the
key into `Authorization: Bearer` as well as `apikey`. GoTrue tries to verify that copy,
finds no `kid`, and intermittently fails the request — signature 2 above.

- **`adminClient()` passes `global: { fetch: apikeyOnlyFetch }`**, which deletes the
  `Authorization` header. `e2e/support/admin.ts` sends `apikey` alone for the same
  reason. Both are pinned by `src/test/supabase-clients.test.ts`.
- **Never apply that wrapper to `anonClient()` or a `signIn()` client.** There
  `Authorization` carries the **user's** access token; stripping it downgrades every
  request to the anon role, and RLS then *hides rows* rather than raising — a suite that
  passes for the wrong reason. A test goes red if anyone shares the wrapper.
- **It was never a key-rotation problem.** The key was healthy throughout; no dashboard
  change is required.

---

## The concurrency harness: two raw Postgres sessions

`src/test/pg-sessions.ts` is the only thing in this repo that talks to Postgres without
going through PostgREST. **Narrow and deliberate, not a precedent to widen.**

It exists for one class of defect the shipped path cannot express: **a window between
two statements inside one transaction.** PostgREST wraps every request in its own
transaction and lends the caller no handle on it, so no number of concurrent HTTP
requests can park a caller mid-function. For anything else, the PostgREST clients in
`supabase-clients.ts` are still correct.

**Nothing in it races, and that is the design.** The interleaving is pinned open by an
**uncommitted** write: session A updates a row and holds its transaction, so session B
blocks on that row lock, parked at the exact instruction under test. `waitUntilBlocked`
polls `pg_stat_activity`, so "B has reached the lock" is an *observed fact*, not a sleep
— and it **throws** if the interleaving never establishes, so a run that degraded into a
sequential one reports as an error, never as a pass. Do not replace it with a sleep.

**`actAs(userId)` is what makes a raw session faithful, and both halves matter.** It sets
`request.jwt.claims` — the entirety of what `auth.uid()` reads — *and* `set local role
authenticated`, because the RPC EXECUTE grants and the `project_members` revoke are
role-scoped. Left as `postgres`, a test sails through privilege checks the app cannot and
proves nothing. Both are `local`, so call it after `begin()`. **The observer session must
not call it**: `pg_stat_activity` hides other roles' state from a non-superuser, so an
`authenticated` poller waits forever.

### Three traps in wiring `SUPABASE_DB_URL`

- **Session-mode pooler, port 5432.** Transaction mode (6543) returns the server
  connection to the pool at every COMMIT, so a transaction cannot be parked across
  statements and `pg_backend_pid()` stops naming a stable backend. The direct
  `db.<ref>.supabase.co` host would serve but is **IPv6-only**, and neither WSL2 nor a
  GitHub runner has an IPv6 route — measured, `Network is unreachable`.
- **`vite.config.ts`'s `loadEnv` prefix list governs `.env.local` only.** An **exported**
  variable reaches the test worker whether or not it is named there, because Vitest
  merges `test.env` into `process.env` rather than replacing it. So omitting an entry
  changes **nothing in CI** (where `verify.yml` exports these) and silently skips the
  suite **locally, indefinitely**, because CI stays green. `requireOrExplain` does not
  backstop it — that fires on an *absent* secret, a different failure.
- **TLS is pinned, not disabled.** The pooler's chain is rooted in `Supabase Root 2021
  CA`, absent from Node's trust store, so strict verification fails with
  `SELF_SIGNED_CERT_IN_CHAIN`. The reflex fix — `rejectUnauthorized: false` — is wrong
  here: this connection carries a superuser-class password.
  `src/test/supabase-root-2021-ca.crt` is Supabase's published certificate, and pinning
  it accepts exactly one issuer, which is *stronger* than the default trust store. It
  expires **2031-04-26** and will then fail closed.

**Treat `SUPABASE_DB_URL` as the most privileged credential in the repo.** It bypasses
RLS *and* PostgREST, so it is strictly stronger than the service-role key, which at
least still passes through schema exposure.

---

## Accessible names under jsdom are not the names a browser computes

**Never assert an *exact* accessible name for an element whose name is composed from
several children whose `display` comes from the stylesheet** — with Tailwind, that is all
of them. Substring and regex name queries (`{ name: /assigned to/i }`) are fine. So is an
exact name on an element named by a single text node or an `aria-label`
(`{ name: 'Log in' }` — 181 such queries across `src/` and `e2e/`, all correct).

Two boundaries on that carve-out, both measured:

- **A `<div>`- or `<p>`-structured component is safe.** Its parts are block-level with no
  stylesheet, so both engines separate them identically. The rule is about CSS-derived
  layout, not about having multiple children.
- **A single text node is not automatically safe if `text-transform` applies.** Chrome's
  AX tree uppercases (`Story` → `STORY`); Playwright's accname does not. Nothing
  exact-name-queries such an element today — `TicketDetailSidebar.tsx:45`,
  `EditableText.tsx:11`, `BacklogTab.tsx:67`, `TicketCard.tsx:35` are the live
  candidates. Do not start.

**The mechanism.** `dom-accessibility-api` reads `getComputedStyle(child).display` and
inserts a separator for any non-inline child. The divergence needs **both** of: (1) the
test document loads no stylesheet, so Tailwind's `flex` never enters the cascade and
every `<span>` falls back to the UA default `inline`; and (2) jsdom does not blockify
flex children — even with `style="display:flex"` set inline it returns the same fused
name, measured. Chrome blockifies, and that is what separates the parts.

So the engines agree wherever the parts are already block-level and diverge exactly where
a `<span>` is a flex item — every ticket card and backlog row:

| Same ticket, blocked, 5 points, assigned | jsdom | Chrome |
|---|---|---|
| Board card | `MP-1 BlockedStory5story points Wire the board` | `MP-1 BLOCKED STORY 5 story points Wire the board` |
| Backlog row | `MP-1StoryWire the boardBlocked5story pointsAssigned todev@example.com` | `MP-1 STORY Wire the board BLOCKED 5 story points Assigned to dev@example.com` |

Chrome measured via CDP `Accessibility.getPartialAXTree`, jsdom via
`computeAccessibleName`. Chromium only — Firefox and WebKit are not installed here.

**The rules that follow:**

- **Assert DOM text and the container it sits in.** Both are true in every engine. Scope
  with `within(button)` — an unscoped `getByText` says the text exists and nothing about
  *where*. SPRIN-65's points badge was moved outside its button and all 12 tests stayed
  green.
- **DOM text alone is not enough.** `getByText` ignores only `<script>`/`<style>`, so it
  matches an `aria-hidden` subtree happily; an `aria-hidden="true"` on `sr-only` text
  reverts the fix entirely with every test green. Pair it with a **substring name query**,
  which honours `aria-hidden` and is engine-independent.
- **`toHaveClass` is a subset check.** `sr-only hidden` passes `toHaveClass('sr-only')`
  while the element stops rendering. For a span whose whole job is to be `sr-only`, assert
  the exact class.
- **`sr-only` text is still right** over `aria-label` on a `<span>` (`role="generic"`,
  where ARIA 1.2 prohibits it).
- **A browser is the only place an accessible name is real.** Measure there before
  believing a name is broken — and note `e2e.yml` is not the gate, so a Playwright
  assertion documents a name rather than protecting it.

**Open, deliberately:** what a screen reader does with an all-caps name is untested here.
Whether the type and blocked badges are worth changing is a real question, and its own
story if wanted.

---

## End-to-end suite (Playwright)

`e2e/` holds one real user's whole journey (signup → create project → create ticket → add
to sprint → start sprint → drag to Done → complete sprint). `npm run e2e` runs it. It
needs `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
(teardown only) and skips loudly without them. Each run signs up a fresh user and deletes
it in teardown, which cascades away everything it created.

It is the **only** test that exercises the native HTML5 drag for real: jsdom has no
`dataTransfer`, so every Vitest board test asserts the drag *wiring* but never the
*gesture*. Playwright dispatches the DOM drag events directly (mouse-based `dragTo` does
not fire them reliably), and the test waits on the `tickets` PATCH so it proves the move
*persisted*, not just the optimistic paint.

- **It is not the gate and must never become it.** `e2e.yml` is a separate, non-required
  check. A real browser plus a real signup against a remote database is inherently more
  flake-prone than `verify`. The required gate is `verify`, and only `verify`.
- **`e2e.yml` shares the global `verify` concurrency group on purpose**, so the E2E never
  runs concurrently with the RLS suite against the shared database. Do not give it its
  own group.
- **Vitest must never collect `e2e/**`.** Playwright specs are `*.spec.ts`, which matches
  Vitest's default include glob; `vite.config.ts` excludes `e2e/**` for exactly this
  reason. Restore the exclude, don't rename the specs.

---

## Review depth is chosen by the diff, not applied by default

**An ordinary story gets ONE reviewer on PR open.** A board tweak, a dialog, a copy change,
a refactor already covered by tests — one pass, and move on. The weight of earlier sessions
came from applying a security-boundary rule to ordinary UI work. Do not spin up a review
fleet for a form field.

**A security-boundary diff gets the deep multi-agent review** — many independent lenses,
each finding adversarially verified. The boundary is narrow and specific: **authentication,
RLS / tenant isolation, secret handling, or the CI gate workflow itself.** These are the
diffs where one missed defect is expensive, and the project has form: a 48-agent adversarial
pass once caught a broken `check-bundle` control that four conventional reviews missed.

**Read the KILLED findings, not just the survivors** — majority-vote has discarded a correct
finding before. If a diff sits on the line, ask rather than guess upward: a deep pass is not
free, and neither is a missed RLS defect.

**Give every mutation-testing reviewer its own worktree** (`isolation: "worktree"`). A
serious review breaks the code deliberately to prove a test can fail, so two reviewers in
one working tree observe each other's mutations and draw confident, wrong conclusions. This
has already happened: two reviewers of SPRIN-46 ran in the same tree and one found a foreign
edit mid-run. The cost of isolation is a few hundred ms; the cost of not isolating is a
review you cannot trust and cannot tell is untrustworthy.

**Ask a reviewer to mutate, not to read.** Across three reviews in one session, every
finding that changed the code came from breaking something and watching what did *not* go
red — vacuous tests, unguarded rejection paths, a dependency footgun measured at ~1.2M
invocations in five seconds. None was found by reading. A review that reports no findings
without having planted a single mutation has established very little.

---

## Keepalive: why the cron exists and what its response means

Supabase's free tier pauses a project after ~7 days of inactivity, and **a paused database
blocks every merge** — including the PR that would fix it. A cron-job.org job keeps it awake.
Configured 2026-07-14, verified by test run:

| | |
|---|---|
| URL | `https://xcnmyhozmcopcpxlagrk.supabase.co/rest/v1/tickets?select=id&limit=1` |
| Method | `GET`, header `apikey: <VITE_SUPABASE_ANON_KEY>` |
| Schedule | Daily, 06:00 UTC |
| On failure | Email notification — the only monitoring, do not disable it |
| Healthy response | `200` with body `[]` |

The empty array is RLS filtering an anonymous caller to zero rows. **That is the success
signal, not an error:** PostgREST returns a result set (an array) on success and an error
object on failure, so the array proves the anon contract this cron depends on is intact,
rather than a `401`/`404`. It does not by itself prove the database is awake right now — a
cached response would also be an array. That is the external cron's job; the repo's job is
keeping the contract from rotting underneath it.

**Do not point the cron at `/rest/v1/`.** It returns 401 for the anon key ("Only the
`service_role` API key can be used"), and the only way to make it work is to ship the
service-role key to a third party. It is the endpoint you will instinctively reach for. Don't.

`src/test/keepalive.integration.test.ts` asserts this exact contract on every PR, so the
endpoint cannot rot underneath the cron. `npm run keepalive` triggers it manually.

---

## Jira board (project key `SPRIN`)

Claude Code owns the board through the **Composio** MCP connector — there is no native
Atlassian connector on this machine. The connection persists across sessions; check
`has_active_connection` before ever asking for a re-auth. **Transition ids are per-workflow —
fetch them, never hardcode.**

**The board is the source of truth for what is left to build.** Phase 1's epics and stories are
all created and Done, and Rung 3's five epics and their stories live there too, so query it
(`statusCategory != Done`) rather than a document. Confirm the Jira workflow columns map to the
app's statuses; if they do not, adjust the Jira workflow, not the app scope.

Move each issue as work progresses: In Progress on start, In Review on PR open, Done on merge.
**Done means the DoD is met, not just that code was written.**
