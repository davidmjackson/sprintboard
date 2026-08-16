# SPRIN-105 — `profiles` widening and `profiles.email` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `profiles` an `email` mirror of `auth.users.email`, and widen its SELECT policy from "my own row" to "my own row plus anyone I share a project with", with writes unchanged.

**Architecture:** One hand-applied migration adds the column, backfills it, adds a third `app_auth` definer predicate (`shares_project_with`), edits `handle_new_user`, replaces the single `for all` policy with four verb-split policies, and revokes `anon`'s full CRUD on the table. One new live integration suite proves the boundary from both sides. No application code changes.

**Tech Stack:** Postgres 15 / Supabase RLS, supabase-js, Vitest (node environment, live database).

## Global Constraints

Copied verbatim from the spec and `CLAUDE.md`. Every task's requirements include these.

- **Migrations are hand-applied.** The Supabase MCP is `read_only=true` on purpose; `apply_migration` is unavailable and that is not a fault to route around. Produce the SQL, hand David one copy-paste command.
- **Migration files are ASCII ONLY.** `clip.exe` transcodes by console codepage. No em dashes, no smart quotes, no arrows. (The `.md` and `.sql` *schema doc* are exempt — this rule is about the file that gets copied through the clipboard.)
- **Never a Postgres `ENUM`.** Not applicable here, but it remains the single most damaging change anyone could make to this schema.
- **Verify the applied state from the CATALOGUE**, never from the SQL editor reporting "Success".
- **T1-T5 lint thresholds are errors**: 30-line functions, cyclomatic 10, cognitive 15, 4 parameters, 400-line files. `npm run lint` gates every merge. Write to them from the first line.
- **`npm run verify` is the gate** — `lint && format:check && build && test`. Never a hand-assembled subset, never `tsc --noEmit`.
- **The shell exports placeholder Supabase config.** `~/.bashrc` sets `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` to placeholders and Vite's `loadEnv` outranks `.env.local`. **Every live-suite command must be prefixed** `env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY`. Without it the suite fails against a placeholder host, which is a *different* failure from a skip.
- **Never follow `signIn()` with `auth.getUser()`.** Read the id from the in-memory session via `userId(client)`. A second auth round-trip per `beforeAll` is the documented fuel for the GoTrue rate-limit flake.
- **RLS filters on USING and raises on WITH CHECK.** A refused SELECT/UPDATE/DELETE is `{ data: [], error: null }`; a refused INSERT is a thrown `42501`. Asserting the wrong one passes for the wrong reason.
- **A cross-tenant row-count assertion is only honest on a column the role may actually UPDATE.** `authenticated` holds table-wide `arwdDxtm` on `profiles`, so `display_name` qualifies — the refusal there is genuinely the policy, not the grant.
- **Every negative needs a positive control on the same table in the same shape.** A policy that hides everything from everyone passes every negative test.

---

## File Structure

| File | Responsibility |
|---|---|
| `docs/migrations/sprin-105-profiles-email-and-co-member-reads.sql` | **Create.** The whole schema change, in one transaction, ASCII only. |
| `docs/sprintboard_phase1_schema.sql` | **Modify.** The canonical schema doc: `profiles` table, `handle_new_user`, the policy block. Kept current — SPRIN-98's table is already in it at line 1309. |
| `src/test/supabase-clients.ts` | **Modify.** Extract `signInWithCredentials(email, password)` so a suite can sign in a throwaway user, not only `RLS_TEST_{A,B}`. |
| `src/test/profiles.integration.test.ts` | **Create.** The live boundary suite. The ninth `*.integration.test.ts`. |
| `src/lib/database.types.ts` | **Regenerate.** `profiles` gains `email`. |
| `CLAUDE.md` | **Modify.** Tripwire gap 8 -> 9; advisor baseline 16 -> 15; the `profiles` policy shape. |
| `docs/HANDOVER.md` | **Modify.** The disclosure decision and the unpinned email drift. |

---

## Task 1: A sign-in helper that is not limited to users A and B

**Files:**
- Modify: `src/test/supabase-clients.ts:140-155`
- Test: `src/test/supabase-clients.test.ts` (existing, must stay green)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `signInWithCredentials(email: string, password: string): Promise<SupabaseClient<Database>>`, used by Task 3's fixture. `signIn(user: RlsUser)` keeps its exact current signature and behaviour.

**Why this task exists:** Task 3 signs in throwaway users that have no entry in `RLS_USERS`. The existing `signIn` resolves credentials from that map and cannot. Extracting the transport half is a two-line refactor; inlining a second `createClient` in the test file would duplicate the "sessions are not persisted, keep the Authorization header" contract that `supabase-clients.test.ts` exists to pin.

- [ ] **Step 1: Extract the helper, leaving `signIn` delegating to it**

Replace `signIn` (`src/test/supabase-clients.ts:139-155`) with:

```ts
/**
 * A fresh, signed-in client for arbitrary credentials. Sessions are not persisted:
 * each client is one user.
 *
 * NOT wrapped in `apikeyOnlyFetch`. For a signed-in client the `Authorization`
 * header carries the USER's access token, and stripping it would silently downgrade
 * every request to the anon role — RLS would then hide the caller's own rows rather
 * than raise. `supabase-clients.test.ts` goes red if anyone shares that wrapper here.
 */
export async function signInWithCredentials(
  email: string,
  password: string,
): Promise<SupabaseClient<Database>> {
  const client = createClient<Database>(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  })

  const { data, error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`Sign-in failed for ${email}: ${error.message}`)
  if (!data.user) throw new Error(`Sign-in for ${email} returned no user.`)

  return client
}

/** A fresh, signed-in client for one of the two fixed RLS test users. */
export async function signIn(user: RlsUser): Promise<SupabaseClient<Database>> {
  const { email, password } = RLS_USERS[user]
  if (email === undefined || password === undefined) {
    throw new Error(`No credentials for RLS test user ${user}.`)
  }
  return signInWithCredentials(email, password)
}
```

Note the error message for the `RlsUser` path changes from `Sign-in failed for user A: …` to `Sign-in failed for a@example.com: …`. Grep for the old string before assuming nothing reads it: `grep -rn "Sign-in failed" src/ e2e/`. If a test asserts it, update that assertion in this task, not later.

- [ ] **Step 2: Run the unit suite and the type check**

```bash
npm run test:unit -- src/test/supabase-clients.test.ts
npm run typecheck
```

Expected: PASS. This task changes no behaviour — it is a pure extraction, and the existing file's "the strip is scoped to the admin client" tests are the proof.

- [ ] **Step 3: Commit**

```bash
git add src/test/supabase-clients.ts
git commit -m "Extract signInWithCredentials from signIn"
```

---

## Task 2: The migration and the schema doc

**Files:**
- Create: `docs/migrations/sprin-105-profiles-email-and-co-member-reads.sql`
- Modify: `docs/sprintboard_phase1_schema.sql` (the `profiles` table ~line 23, `handle_new_user` ~line 36, the `profiles_self` policy ~line 806)

**Interfaces:**
- Consumes: nothing.
- Produces: the applied schema Task 3's suite asserts against — `profiles.email` (nullable, unique), `app_auth.shares_project_with(uuid)`, policies `profiles_read` / `profiles_self_insert` / `profiles_self_update` / `profiles_self_delete`, and `anon` holding nothing on `profiles`.

**Statement order is load-bearing.** A `language sql` body is fully parsed and analysed at CREATE time (`check_function_bodies` defaults to on), so it may not forward-reference. `language plpgsql` is only syntax-checked. That asymmetry is why `shares_project_with` (sql) must come after the objects it reads, while `handle_new_user` (plpgsql) may go anywhere.

- [ ] **Step 1: Write the migration**

Create `docs/migrations/sprin-105-profiles-email-and-co-member-reads.sql`. **ASCII only.**

```sql
-- SPRIN-105 -- profiles.email and co-member profile reads (epic SPRIN-75, story 2).
--
-- ASCII ONLY. clip.exe transcodes by the console codepage, so a non-ASCII character in
-- this file can arrive in the SQL editor as mojibake. Verify the applied state from the
-- CATALOG afterwards, never from the editor reporting "Success".
--
-- ============================================================================
-- WHAT THIS WIDENS, STATED PLAINLY
-- ============================================================================
-- Joining a project makes your email address visible to everyone else in that project.
-- That is what Jira does and it is the point of the feature, but it is a real disclosure
-- decision rather than an implementation detail. The boundary this establishes is:
-- profile visibility is CO-MEMBERSHIP and nothing wider. Writes do not widen at all.
--
-- ============================================================================
-- STATEMENT ORDER IS LOAD-BEARING -- do not "tidy" it
-- ============================================================================
-- A `language sql` body is fully PARSED AND ANALYSED at CREATE time, because
-- check_function_bodies defaults to on. shares_project_with is `language sql` and reads
-- public.project_members, so it must come after that table exists (it does -- SPRIN-98).
-- handle_new_user is `language plpgsql` and only syntax-checked, so it may be replaced
-- anywhere. The policies come last, after the function they call.

begin;

-- ============================================================================
-- 1. The column
-- ============================================================================
-- NULLABLE, deliberately. A `not null` would put signup itself behind the constraint:
-- any future auth path without an email (phone, an OAuth provider that withholds it)
-- would fail inside handle_new_user and the user would get no profile row at all. The
-- failure mode of the weaker column is a null; the failure mode of the stronger one is
-- a broken signup.
--
-- This is a SEPARATE MIRROR of auth.users.email, not a reuse of display_name.
-- handle_new_user seeds display_name from new.email as a FALLBACK and display_name stays
-- user-editable through the self policy below -- so it is a display string that merely
-- happens to start life looking like an address. It can NEVER be an identity key.
alter table profiles add column email text;

-- UNIQUE because SPRIN-102 grants membership by exact email, and a unique constraint is
-- what makes `.eq('email', x).single()` honest rather than hopeful. Verified safe against
-- live data before writing this: 9 users, 9 with an email, 9 distinct, 9 distinct under
-- lower(), 9 profile rows.
--
-- Postgres treats NULLs as distinct in a unique index, so any number of email-less
-- profiles coexist. That is why "nullable" and "unique" do not fight each other.
alter table profiles add constraint profiles_email_key unique (email);

-- ============================================================================
-- 2. Backfill
-- ============================================================================
update profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is distinct from u.email;

-- ============================================================================
-- 3. The co-membership predicate
-- ============================================================================
-- READ THIS BEFORE COPYING THE PATTERN. SPRIN-98's migration says of is_project_member
-- and is_project_admin:
--
--   "Both functions consult (select auth.uid()) and NOTHING ELSE, so a caller can only
--    ever learn about THEMSELVES. That property is what makes the definer privilege
--    affordable, and it is load-bearing: adding a user_id parameter to either signature
--    would turn a harmless self-query into an oracle about other people. Do not."
--
-- That warning STANDS and this migration does not touch either signature. What it adds is
-- a THIRD function that does take another user's id, and the parameter is affordable here
-- for a different, weaker, and precisely stateable reason:
--
--   * ONE SIDE OF THE JOIN IS PINNED TO (select auth.uid()). It answers "do I share a
--     project with X". It cannot be made to answer "do X and Y share a project", which is
--     the oracle the warning is about.
--   * ITS ANSWER IS EXACTLY CO-EXTENSIVE WITH THE POLICY THAT CALLS IT. Anything it
--     reveals about X, a select on X's profile row already reveals. No new channel.
--   * IT IS NOT INDEPENDENTLY REACHABLE. app_auth is absent from the exposed-schema list,
--     so PostgREST publishes no RPC for it.
--
-- If a future story wants a predicate WITHOUT those three properties, it is a different
-- decision and needs its own argument. Do not read this function as a precedent for
-- "parameters are fine now".
--
-- STABLE, not VOLATILE: the result cannot change within a statement, so the uid read
-- happens once. That is also why the policies below need no (select auth.uid()) wrapper
-- around THIS call for auth_rls_initplan purposes.
--
-- search_path pinned empty, every reference schema-qualified, matching the two siblings.
create or replace function app_auth.shares_project_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.project_members mine
    join public.project_members theirs on theirs.project_id = mine.project_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = p_user_id
  );
$$;

-- *** A NEW FUNCTION IN app_auth IS BORN EXECUTE-TO-PUBLIC. *** There are no default
-- privileges on this schema -- SPRIN-98 tried to add them, the editor reported "Success"
-- every time, and pg_default_acl still held zero rows for app_auth afterwards. So the
-- hand-revoke below is the only thing standing between this function and every signed-in
-- user. anon is deliberately absent: it holds USAGE on neither the schema nor, after
-- section 6, anything on profiles.
revoke execute on function app_auth.shares_project_with(uuid) from public;
grant execute on function app_auth.shares_project_with(uuid) to authenticated;

-- ============================================================================
-- 4. handle_new_user -- now mirrors the email as well
-- ============================================================================
-- THREE PROPERTIES MUST SURVIVE THIS EDIT, all load-bearing:
--   1. security definer -- the insert happens before the user can authenticate, so RLS
--      must not apply.
--   2. set search_path = '' with every reference schema-qualified -- a definer function
--      otherwise inherits the CALLER's search_path, and a role able to create objects in
--      a schema searched first could shadow public.profiles.
--   3. the explicit revoke below.
--
-- display_name keeps its coalesce(..., new.email) fallback UNCHANGED. The two columns
-- diverge from the same source on purpose: one is editable, one is not.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email), new.email);
  return new;
end;
$$;

-- create or replace PRESERVES the existing ACL, so this is belt-and-braces rather than
-- strictly required. State it anyway: the cost of being wrong about that is a SECURITY
-- DEFINER function callable by anyone.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ============================================================================
-- 5. Policies -- one `for all` becomes four, split by verb
-- ============================================================================
-- The split PRESERVES CURRENT WRITE BEHAVIOUR VERB FOR VERB. `for all` covers all four
-- verbs, so writing them out separately narrows nothing. In particular self-DELETE stays
-- permitted: it is a pre-existing footgun (delete your profile row and handle_new_user
-- will not rebuild it, because it fires on auth.users INSERT alone), but narrowing it
-- would be a scope change smuggled in under a widening story. Left as found.
--
-- No TO clause, matching every other policy in this schema. The consequence, recorded
-- because it has caused a misdiagnosis before: a policy without TO covers anon as well,
-- so a 42501 on an anonymous request has two possible authors. Section 6 settles it on
-- this table -- anon holds nothing, so it is refused at the privilege layer before any
-- policy runs.
--
-- (select auth.uid()), not bare auth.uid(): profiles_self is currently one of the eight
-- auth_rls_initplan WARNs, and rewriting it in the wrapped form clears that one for free
-- since the policy is being rewritten anyway. The sweep across the remaining tables still
-- belongs to SPRIN-75, not here.
drop policy profiles_self on profiles;

create policy profiles_read on profiles
  for select
  using (id = (select auth.uid()) or app_auth.shares_project_with(profiles.id));

create policy profiles_self_insert on profiles
  for insert
  with check (id = (select auth.uid()));

create policy profiles_self_update on profiles
  for update
  using      (id = (select auth.uid()))
  with check (id = (select auth.uid()));

create policy profiles_self_delete on profiles
  for delete
  using (id = (select auth.uid()));

-- ============================================================================
-- 6. GRANTS
-- ============================================================================
-- Measured from the catalog before this migration: profiles.relacl was
--   {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,
--    authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}
-- -- anon held FULL CRUD. The table was BORN that way; nobody granted it deliberately.
-- That is survivable while the table holds a display name. It is not what we want
-- standing alone in front of a column of email addresses.
--
-- This changes nothing observable: anon already saw zero rows, because id = auth.uid() is
-- id = null for an anonymous caller, which is null, which filters everything. What
-- changes is the FAILURE SHAPE, and a test must pick the right one -- a privilege refusal
-- is 42501 with data === null, whereas an RLS filter is error: null, data: [].
--
-- Table-wide, not column-level: `revoke ... (col)` against a table-wide grant is a SILENT
-- NO-OP, while a table-level revoke cascades. Same reasoning as SPRIN-98.
revoke all on profiles from anon;

-- ============================================================================
-- 7. Post-state tripwire
-- ============================================================================
-- STATED LIMITATION: this reads back its own work inside this same transaction, so it
-- proves the backfill statement RAN -- not that the property holds against anything else.
-- It is a tripwire on a silently-empty backfill, not a test. The live suite is the test.
do $$
declare
  unmirrored int;
begin
  select count(*) into unmirrored
  from public.profiles p
  join auth.users u on u.id = p.id
  where u.email is not null
    and p.email is distinct from u.email;

  if unmirrored > 0 then
    raise exception 'Backfill incomplete: % profile(s) do not mirror auth.users.email', unmirrored;
  end if;
end;
$$;

commit;

-- ============================================================================
-- AFTER APPLYING -- verify from the CATALOG, not from "Success"
-- ============================================================================
-- Expected end state:
--   * profiles has 4 columns; email is nullable with a unique constraint
--     profiles_email_key
--   * 4 policies on profiles: profiles_read (SELECT), profiles_self_insert (INSERT),
--     profiles_self_update (UPDATE), profiles_self_delete (DELETE); profiles_self GONE
--   * profiles relacl: anon ABSENT; authenticated=arwdDxtm; no column-level acls
--   * app_auth.shares_project_with: prosecdef = true, provolatile = 's',
--     search_path = '', proacl {postgres, authenticated} -- PUBLIC revoked
--   * handle_new_user: prosecdef = true, search_path = '',
--     proacl {postgres, service_role}
--   * zero profiles whose email does not mirror auth.users
--
-- ADVISORS. Baseline before this story, measured 2026-08-16: 16 performance, 1 security.
-- Predicted after: 15 performance (the profiles_self auth_rls_initplan WARN clears),
-- 1 security (unchanged).
--
-- EXPECT A TRANSIENT 16th: an unused_index INFO on profiles_email_key. unused_index is a
-- statement about TRAFFIC, not about schema -- a brand-new index earns one until
-- something scans it. SPRIN-98 recorded exactly this and watched it clear within the hour
-- once its own suite ran. MEASURE AGAIN LATER. Do not write a first reading into
-- CLAUDE.md as a standing decision; that is the mistake SPRIN-98 made two paragraphs
-- below its own warning about it.
```

- [ ] **Step 2: Prove the SQL parses, without applying it**

The MCP is read-only, so DDL cannot run — but it still *parses* before the read-only check rejects it. That is the free syntax check:

```
mcp__supabase__execute_sql with the whole file's body (without begin/commit)
```

Expected: an error whose code is `25006` (`cannot execute … in a read-only transaction`) or `42501`. **That is a PASS** — the statement parsed. A `42601` (syntax error) is a real failure and must be fixed before handing anything to David. Do not accept "it looks right".

- [ ] **Step 3: Update the schema doc**

`docs/sprintboard_phase1_schema.sql` is kept current (SPRIN-98's table is in it at line 1309). Three edits, mirroring the migration:

1. The `profiles` table (~line 23) gains `email text` and a note that it is a separate mirror of `auth.users.email`, never `display_name`.
2. `handle_new_user` (~line 36) gains the third column in its insert.
3. The `profiles_self` policy (~line 806) is replaced by the four policies, with the disclosure decision and the `anon` revoke stated.

This file is documentation, not the applied artefact — em dashes are fine here.

- [ ] **Step 4: Commit**

```bash
git add docs/migrations/sprin-105-profiles-email-and-co-member-reads.sql docs/sprintboard_phase1_schema.sql
git commit -m "Add the SPRIN-105 migration: profiles.email and co-member reads"
```

---

## Task 3: The live boundary suite, written RED

**Files:**
- Create: `src/test/profiles.integration.test.ts`

**Interfaces:**
- Consumes: `signInWithCredentials` (Task 1); the schema Task 2 defines.
- Produces: nothing later tasks import.

**THE FIXTURE MUST NOT USE USERS A OR B, AND THIS IS THE MOST IMPORTANT LINE IN THE TASK.**
`rls.integration.test.ts:249` asserts A sees **exactly one** profile row, and `:489` asserts B sees exactly `[{ id: userBId }]`. Vitest runs suites in parallel against one shared database. Making A and B co-members — even briefly, even in a `beforeAll` that tears down — flips those two assertions red at random, on a branch whose code is fine. Three throwaway users created through the service role keep A and B's visibility exactly as it is, which keeps those assertions true **and** promotes them to the standing guard that this widening did not over-fire. If they ever go red, the predicate is wrong; do not weaken them.

> **CORRECTED by SPRIN-105 (post-hoc, same story).** This is the plan's draft reasoning,
> left as written — it is what motivated the fixture, and it was wrong about which
> assertions end up doing the guarding. Commit 33c6c6f, later on this same branch, rewrote
> both `rls.integration.test.ts:249` and `:489` into scoped `.eq('id', …)` selects, because
> `project-members.integration.test.ts`'s own fixture makes A and B co-members while it
> runs concurrently with `rls.integration.test.ts` — a sibling suite unrelated to this
> file's fixture, not this suite's own users. Those two assertions are no longer a
> whole-table count and are no longer "the standing guard that this widening did not
> over-fire"; that guard now lives in `profiles.integration.test.ts`'s own `shows a member
> exactly themselves and their co-members` test. "If they ever go red, the predicate is
> wrong; do not weaken them" turned out to be exactly wrong about *those* two assertions —
> they went red for an unrelated, correct reason, and weakening them (scoping the select)
> was the right fix, not a compromise. The `git status`/`git log -p` sequence is the record
> if the detail is needed again.

**Guard the secrets this suite actually needs.** It needs `SUPABASE_SERVICE_ROLE_KEY` and the public config — it does **not** need `RLS_TEST_{A,B}`. So it gates on `hasServiceRoleKey` and calls `assertServiceRoleOrExplain()`. A missing key must never look like a pass.

- [ ] **Step 1: Write the failing suite**

Create `src/test/profiles.integration.test.ts`:

```ts
// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/database.types'
import {
  adminClient,
  anonClient,
  assertServiceRoleOrExplain,
  hasServiceRoleKey,
  signInWithCredentials,
} from './supabase-clients'

assertServiceRoleOrExplain()

/**
 * SPRIN-105 -- profile visibility is CO-MEMBERSHIP, and nothing wider.
 *
 * Two properties are asserted throughout, and both have burned this project before:
 *
 *   * RLS FILTERS on USING and RAISES on WITH CHECK. A refused SELECT, UPDATE or DELETE
 *     comes back as `{ data: [], error: null }` -- a write that changed nothing, which is
 *     indistinguishable from one that changed everything unless the row COUNT is checked.
 *     A refused INSERT is a thrown 42501. Asserting the wrong one passes for the wrong
 *     reason.
 *   * A policy that hides everything from everyone passes every negative test. So every
 *     negative below is paired with a POSITIVE control in the same shape.
 *
 * WHY THIS SUITE CREATES ITS OWN USERS INSTEAD OF USING A AND B.
 * rls.integration.test.ts asserts that A and B EACH see exactly one profile row. Vitest
 * runs suites in parallel against one shared database, so making A and B co-members --
 * even inside a beforeAll that tears down -- would flip those assertions red at random.
 * Three throwaway users leave A and B untouched, which keeps those two assertions true
 * and makes them the standing guard that this widening did not over-fire.
 *
 * CORRECTED by SPRIN-105 (post-hoc, same branch) -- this plan draft is left as written,
 * but the last sentence above is what the implemented suite's docblock originally copied
 * verbatim, and it was wrong. Commit 33c6c6f rescoped rls.integration.test.ts:249 and :489
 * to per-user selects because of project-members.integration.test.ts's co-membership
 * fixture, not because of anything this suite's own users do -- so they stopped being a
 * whole-table count and stopped being "the standing guard" at all. The actual guard is
 * this suite's own 'shows a member exactly themselves and their co-members' test. See
 * src/test/profiles.integration.test.ts's docblock for the corrected version.
 */
const PASSWORD = 'password123'

function freshEmail(tag: string): string {
  return `sprin105-${tag}-${crypto.randomUUID()}@example.com`
}

function runKey(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const pick = () => alphabet[Math.floor(Math.random() * alphabet.length)]!
  return `P${pick()}${pick()}${pick()}`
}

/** Turns a thrown transport error into the `{ data, error }` shape. Teardown only. */
async function settled<T>(call: PromiseLike<T>): Promise<T | { data: null; error: Error }> {
  try {
    return await call
  } catch (cause) {
    return { data: null, error: cause instanceof Error ? cause : new Error(String(cause)) }
  }
}

const INSUFFICIENT_PRIVILEGE = '42501'

describe.skipIf(!hasServiceRoleKey)('profiles visibility is co-membership', () => {
  const admin = hasServiceRoleKey ? adminClient() : (undefined as never)
  const createdUserIds: string[] = []

  /** Co-member, project owner, seeded as admin by on_project_created_admin. */
  let cClient: SupabaseClient<Database>
  let cId: string
  let cEmail: string

  /** Co-member, added to C's project as a plain `member`. */
  let dClient: SupabaseClient<Database>
  let dId: string
  let dEmail: string

  /** Shares nothing with anyone, and never signs in. The stranger. */
  let eId: string
  let eEmail: string

  let sharedProject: string

  async function createUser(email: string, displayName: string): Promise<string> {
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    })
    if (error) throw new Error(`createUser failed for ${email}: ${error.message}`)
    const id = data.user?.id
    if (!id) throw new Error(`createUser returned no user for ${email}`)
    createdUserIds.push(id)
    return id
  }

  beforeAll(async () => {
    cEmail = freshEmail('c')
    dEmail = freshEmail('d')
    eEmail = freshEmail('e')

    cId = await createUser(cEmail, 'Co-member C')
    dId = await createUser(dEmail, 'Co-member D')
    eId = await createUser(eEmail, 'Stranger E')

    cClient = await signInWithCredentials(cEmail, PASSWORD)
    dClient = await signInWithCredentials(dEmail, PASSWORD)

    const { data, error } = await cClient
      .from('projects')
      .insert({ owner_id: cId, name: 'SPRIN-105 shared project', key: runKey() })
      .select('id')
      .single()
    if (error) throw new Error(`Fixture: could not create the shared project: ${error.message}`)
    sharedProject = data.id

    // D joins as a plain member, written with the SERVICE-ROLE client on purpose: the app
    // path for this is SPRIN-102 and does not exist yet, and using C's client would build
    // the fixture out of members_admin_insert -- a policy a SIBLING suite is trying to
    // prove. A fixture must not be built out of the thing under test.
    const { error: joinError } = await admin
      .from('project_members')
      .insert({ project_id: sharedProject, user_id: dId, role: 'member' })
    if (joinError) throw new Error(`Fixture: could not add D to the project: ${joinError.message}`)
  }, 60_000)

  afterAll(async () => {
    if (!hasServiceRoleKey) return
    // Deletes FIRST, before anything that could throw. Deleting the users cascades the
    // project and the membership row, since every owned table is `on delete cascade` from
    // auth.users. A teardown assertion that fails before the delete strands fixture rows
    // in the shared database -- that has already cost this project ten orphaned projects.
    const failures: string[] = []
    for (const id of createdUserIds) {
      const { error } = await settled(admin.auth.admin.deleteUser(id))
      if (error) failures.push(`${id}: ${error.message}`)
    }
    if (failures.length > 0) {
      throw new Error(`Failed to delete ${failures.length} test user(s):\n${failures.join('\n')}`)
    }
  }, 60_000)

  describe('the email mirror', () => {
    // Asserted on a FRESHLY CREATED user, not a backfilled one: the trigger and the
    // backfill are different mechanisms and only one of them runs again.
    it('handle_new_user mirrors auth.users.email onto the new profile row', async () => {
      const { data, error } = await admin
        .from('profiles')
        .select('email, display_name')
        .eq('id', eId)
        .single()

      expect(error).toBeNull()
      expect(data!.email).toBe(eEmail)
      // display_name keeps its own source -- the metadata name, NOT the email. The two
      // columns diverging here is the point: display_name is editable, email is not.
      expect(data!.display_name).toBe('Stranger E')
    }, 30_000)

    it('leaves no profile row without an email (the backfill, from outside its own transaction)', async () => {
      const { data, error } = await admin.from('profiles').select('id').is('email', null)

      expect(error).toBeNull()
      expect(data).toEqual([])
    }, 30_000)
  })

  describe('reads', () => {
    it('lets two members of one project read each other, in BOTH directions', async () => {
      // Both directions, because the predicate is a self-join and a one-directional test
      // would pass on a broken half.
      const cReadsD = await cClient
        .from('profiles')
        .select('id, display_name, email')
        .eq('id', dId)
      const dReadsC = await dClient
        .from('profiles')
        .select('id, display_name, email')
        .eq('id', cId)

      expect(cReadsD.error).toBeNull()
      expect(cReadsD.data).toEqual([{ id: dId, display_name: 'Co-member D', email: dEmail }])
      expect(dReadsC.error).toBeNull()
      expect(dReadsC.data).toEqual([{ id: cId, display_name: 'Co-member C', email: cEmail }])
    }, 30_000)

    // AC3, by ROW COUNT. An RLS USING clause FILTERS; it does not raise. Expecting an
    // error here would pass for the wrong reason -- and would keep passing if the policy
    // were replaced with `using (true)`.
    it('hides the profile of someone sharing no project, without raising', async () => {
      const { data, error } = await cClient.from('profiles').select('id').eq('id', eId)

      expect(error).toBeNull()
      expect(data).toEqual([])
    }, 30_000)

    // The strongest assertion in the file: not "C cannot see E" but "C sees C and D and
    // NOBODY ELSE". There are other users in this database; a policy that widened too far
    // passes the test above and fails this one.
    it('shows a member exactly themselves and their co-members', async () => {
      const { data, error } = await cClient.from('profiles').select('id')

      expect(error).toBeNull()
      expect([...(data ?? [])].map((row) => row.id).sort()).toEqual([cId, dId].sort())
    }, 30_000)
  })

  describe('writes do not widen', () => {
    // The positive control for every negative below: the same verb, the same table,
    // succeeding on the caller's own row.
    it('lets a user rename themselves', async () => {
      const { data, error } = await cClient
        .from('profiles')
        .update({ display_name: 'C, renamed' })
        .eq('id', cId)
        .select('display_name')

      expect(error).toBeNull()
      expect(data).toEqual([{ display_name: 'C, renamed' }])
    }, 30_000)

    // display_name is a column `authenticated` may genuinely UPDATE (the table grant is
    // arwdDxtm), so a zero-row result here measures the POLICY and not the grant. On an
    // ungranted column this would 42501 at the privilege layer and prove nothing.
    it('refuses to let a co-member rename their co-member, by changing zero rows', async () => {
      const refused = await cClient
        .from('profiles')
        .update({ display_name: 'renamed by C' })
        .eq('id', dId)
        .select('display_name')

      expect(refused.error).toBeNull()
      expect(refused.data).toEqual([])

      // Zero rows returned is not the same claim as zero rows changed. Read D's row back
      // with a client that bypasses RLS and confirm it is untouched.
      const after = await admin.from('profiles').select('display_name').eq('id', dId).single()
      expect(after.data!.display_name).toBe('Co-member D')
    }, 30_000)

    // A refused INSERT RAISES rather than filtering -- the WITH CHECK path. `authenticated`
    // holds INSERT privilege on this table, so the 42501 here can only be the policy; the
    // message match is what discriminates the two possible authors of that code.
    it('refuses to let a user insert a profile row for someone else', async () => {
      const { error } = await cClient
        .from('profiles')
        .insert({ id: eId, display_name: 'inserted by C' })

      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/row-level security/i)
    }, 30_000)
    // NOTE ON EXECUTION ORDER, since this test leans on it. E already has a profile row,
    // so this insert violates the primary key as well as the policy. Postgres evaluates
    // the RLS WITH CHECK before the tuple reaches the index, so 42501 is expected to win
    // over 23505 -- the same ordering that puts WITH CHECK ahead of foreign-key
    // validation. If the run comes back 23505, that assumption is wrong: switch the id to
    // `crypto.randomUUID()` (a user who does not exist), where the ordering IS documented,
    // and say so in the review rather than silently loosening the matcher.

    it('refuses to let a co-member delete their co-member, by deleting zero rows', async () => {
      const refused = await cClient.from('profiles').delete().eq('id', dId).select('id')

      expect(refused.error).toBeNull()
      expect(refused.data).toEqual([])

      const after = await admin.from('profiles').select('id').eq('id', dId)
      expect(after.data).toEqual([{ id: dId }])
    }, 30_000)
  })

  describe('anon holds nothing on this table', () => {
    // SPRIN-105 revoked anon's full CRUD. This is the PRIVILEGE shape -- 42501 with
    // data === null -- and NOT the filter shape (error: null, data: []) that RLS produces.
    // Asserting the wrong one would pass identically before the revoke, proving nothing.
    it('refuses an anonymous select at the privilege layer', async () => {
      const { data, error } = await anonClient().from('profiles').select('id')

      expect(data).toBeNull()
      expect(error?.code).toBe(INSUFFICIENT_PRIVILEGE)
      expect(error?.message).toMatch(/permission denied/i)
    }, 30_000)
  })

  // LAST, AND DELIBERATELY SO. This is the positive control for profiles_self_delete, and
  // it destroys C's profile row -- so every assertion that reads C's profile must already
  // have run. Vitest runs a file's tests in source order. If you add a test that reads C,
  // add it ABOVE this one.
  describe('the self-delete positive control', () => {
    it('lets a user delete their own profile row', async () => {
      const { data, error } = await cClient.from('profiles').delete().eq('id', cId).select('id')

      expect(error).toBeNull()
      expect(data).toEqual([{ id: cId }])
    }, 30_000)
  })
})
```

- [ ] **Step 2: Run it and watch it FAIL, for the right reason**

```bash
env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY npx vitest run src/test/profiles.integration.test.ts
```

Expected: **RED**. Before the migration is applied, `profiles` has no `email` column, so the mirror tests fail on a PostgREST error naming the missing column, the co-member reads return `[]`, and the anon select still succeeds with `data: []` instead of `42501`.

**Check the failure messages read like that.** A suite that fails because the whole file could not load (a bad import, a missing export from Task 1) is not the red you want, and it will go "green" for the wrong reason once the import is fixed. A suite reporting `SKIPPING` means the service-role key is missing — fix the environment, do not proceed.

- [ ] **Step 3: Commit the red suite**

```bash
git add src/test/profiles.integration.test.ts
git commit -m "Add the SPRIN-105 profile-visibility suite (red until the migration lands)"
```

---

## Task 4: Apply the migration, regenerate types, go green

**Files:**
- Modify: `src/lib/database.types.ts` (regenerated)

**Interfaces:**
- Consumes: Task 2's migration file, Task 3's suite.
- Produces: a green live suite.

**This task is NOT delegated to a subagent.** It needs David to paste the migration into the SQL editor, and it needs the MCP to verify the catalogue afterwards.

- [ ] **Step 1: Hand David one copy-paste command**

One command, one terminal line, fully concrete — no placeholders.

- [ ] **Step 2: Verify the applied state from the CATALOGUE**

Not from the editor's "Success". Query for each item on the migration's own AFTER APPLYING list: four columns on `profiles`; the `profiles_email_key` constraint; four policies with `profiles_self` gone; `anon` absent from `relacl`; `shares_project_with` with `prosecdef`, `provolatile = 's'`, empty search_path and `PUBLIC` revoked; `handle_new_user` unchanged in all three properties; zero unmirrored emails.

- [ ] **Step 3: Regenerate the database types**

```bash
npx supabase gen types typescript --project-id xcnmyhozmcopcpxlagrk > src/lib/database.types.ts
```

If that CLI is unavailable, use `mcp__supabase__generate_typescript_types` and write the result. Then check the diff is **only** the `profiles` email additions (`Row`, `Insert`, `Update`) — a regeneration that rewrites unrelated tables means the checked-in file had drifted and that is worth saying out loud, not silently absorbing.

- [ ] **Step 4: Run the suite and watch it go GREEN**

```bash
env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY npx vitest run src/test/profiles.integration.test.ts
```

Expected: all tests pass, **0 skipped**.

- [ ] **Step 5: Run the two suites this could break**

```bash
env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY npx vitest run src/test/rls.integration.test.ts src/test/project-members.integration.test.ts
```

Expected: green. `rls.integration.test.ts:249` and `:489` are the "did not over-fire" guard — if either goes red, the predicate is wrong and the migration needs revisiting, not the test.

> **CORRECTED by SPRIN-105 (post-hoc, same branch).** They did go red running this step, and
> the predicate was not the problem: `project-members.integration.test.ts`'s own fixture makes
> A and B co-members while it runs concurrently with `rls.integration.test.ts`, which is
> exactly the "sibling suite doing something to A/B" case this plan didn't anticipate. Commit
> 33c6c6f rescoped both assertions to `.eq('id', …)` selects instead of revisiting the
> migration. The "did not over-fire" guard now lives in `profiles.integration.test.ts`'s own
> `shows a member exactly themselves and their co-members` test, which uses throwaway users no
> sibling suite touches.

- [ ] **Step 6: Re-measure the advisors**

`mcp__supabase__get_advisors` for both `security` and `performance`. Expected: 15 performance, 1 security. A 16th that is an `unused_index` INFO on `profiles_email_key` is the documented transient — **re-measure later**, do not record it as a standing finding.

- [ ] **Step 7: Commit**

```bash
git add src/lib/database.types.ts
git commit -m "Regenerate database types for profiles.email"
```

---

## Task 5: The documentation the next story reads

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/HANDOVER.md`

**Interfaces:**
- Consumes: the measured results from Task 4. **Write measurements, not predictions.**

- [ ] **Step 1: Update `CLAUDE.md`**

Three edits, each of which a later story will rely on:

1. **The tripwire gap moves 8 -> 9.** The section says `npm test` collects exactly eight more files than `test:unit`, and that "a story adding one owes this line an update in the same commit". This is that story. Re-derive the absolute counts rather than trusting the existing numbers: `npx vitest list --filesOnly | wc -l`.
2. **The advisor baseline moves 16 -> 15**, with the date re-stamped and the reason named (the `profiles_self` `auth_rls_initplan` WARN cleared because the policy was rewritten in the `(select auth.uid())` form). The `auth_rls_initplan` sweep still belongs to SPRIN-75 — say that the count is now **seven** across four tables, not eight across five.
3. **The `profiles` policy shape**, in the RLS paragraph: profile visibility is now co-membership, `anon` holds nothing on the table, and `app_auth` has a **third** function whose parameter is affordable for a narrower reason than the other two — with a pointer to the migration for the argument, so it is not re-derived as "parameters are fine now".

- [ ] **Step 2: Update `docs/HANDOVER.md`**

Add, under the known-unpinned invariants: **`profiles.email` can drift from `auth.users.email`.** Nothing re-syncs the mirror on an email change; there is no email-change path in the app today, so the trigger was deliberately not built. SPRIN-102 must re-read that before trusting the column as an identity key. Note the case-sensitivity question alongside it: the mirror stores whatever `auth.users` holds, and a case-insensitive lookup would need its own `lower(email)` index and its own decision.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/HANDOVER.md
git commit -m "Record the SPRIN-105 boundary, the moved tripwire and the measured advisor baseline"
```

---

## Self-review against the spec

| Spec requirement | Task |
|---|---|
| AC1 — `email` column, populated by the trigger, backfilled | Task 2 §1-2, §4; asserted Task 3 "the email mirror" |
| AC2 — read widens to co-members, write stays self | Task 2 §5; asserted Task 3 "reads" + "writes do not widen" |
| AC3 — stranger invisible, **by row count** | Task 3, "hides the profile of someone sharing no project" + the exact-visible-set test |
| AC4 — positive control, both members, `display_name` **and** `email` | Task 3, "in BOTH directions" |
| `handle_new_user` keeps definer / empty search_path / revoke | Task 2 §4, verified from the catalogue in Task 4 §2 |
| The disclosure decision is stated, not slipped in | Migration header, spec, and the PR body |
| `revoke all on profiles from anon` | Task 2 §6; asserted Task 3 "anon holds nothing" |
| Nullable + unique `email` | Task 2 §1 |
| `(select auth.uid())` clears one advisor WARN | Task 2 §5; measured Task 4 §6; recorded Task 5 |
| Tripwire gap 8 -> 9 | Task 5 §1 |
| Email drift recorded, not built | Task 5 §2 |
