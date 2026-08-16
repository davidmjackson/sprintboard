# SPRIN-105 — Co-members can see each other: `profiles` widening and `profiles.email`

Epic SPRIN-75 (teams, roles and permissions), story 2 of 8. Follows SPRIN-98, which built
`project_members`, the `app_auth` schema and the two membership predicates.

## Why

Two things block the rest of the epic, and both are properties of `profiles`:

- `profiles_self` restricts every user to their own row, so the app can never render
  "assigned to Alice" — which is why `BacklogTab.tsx:135` can only say *mine or not mine*.
- `profiles` holds `(id, display_name, created_at)` and no email, so **there is nothing to
  look an email up against**. SPRIN-102 grants membership by exact email address (David's
  settled design, 2026-08-16) and cannot be built until that column exists.

`display_name` cannot serve as the identity key. `handle_new_user` seeds it from
`new.email` as a *fallback*, and it stays user-editable through the self policy — so it is
a display string that merely happens to start life looking like an address. The new column
is a separate mirror of `auth.users.email`.

## Scope

Database and live tests only. All four ACs are schema-and-policy; no component changes.
`TicketDetailDialog.tsx:28` carries a comment about this exact limitation ("Assignee is
deliberately `{ Unassigned, current user }` — widening the profiles read would leak every
user's email"), and the assignee picker is a **later** story, not this one. Leave it.

## The disclosure decision, stated plainly

Joining a project makes your email address visible to everyone else in that project. That
is what Jira does and it is the point of the feature, but it is a real disclosure decision
and it belongs in the PR body rather than slipped in under a schema change.

The boundary this story establishes: **profile visibility is co-membership, and nothing
wider.** A user who shares no project with you learns nothing — asserted by counting rows,
not by expecting an error.

## Decisions

All three were put to David on 2026-08-16 and approved as recommended.

### 1. A new definer predicate, `app_auth.shares_project_with(uuid)`

```sql
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
```

**This departs from a written warning and must not be quietly slipped past.** SPRIN-98's
migration says, of `is_project_member` and `is_project_admin`:

> Both functions consult `(select auth.uid())` and NOTHING ELSE, so a caller can only ever
> learn about THEMSELVES. That property is what makes the definer privilege affordable,
> and it is load-bearing: adding a user_id parameter to either signature would turn a
> harmless self-query into an oracle about other people. Do not.

That warning stands, and this story does not touch either signature. What it adds is a
*third* function whose parameter is affordable for a different, weaker, and precisely
stateable reason:

- **One side of the join is pinned to `(select auth.uid())`.** The function answers "do
  *I* share a project with X". It cannot be made to answer "do X and Y share a project",
  which is the oracle the warning is about.
- **Its answer is exactly co-extensive with the policy that calls it.** Anything it
  reveals about X, a `select` on X's profile row already reveals. It opens no channel the
  ACs do not already open.
- **It is not independently reachable.** `app_auth` is absent from Supabase's exposed
  schema list, so PostgREST publishes no RPC for it; `EXECUTE` is revoked from `public`
  and granted to `authenticated` alone.

The alternative considered and rejected: an inline `exists` in the policy reusing
`is_project_member`, which adds no new signature but nests a definer call inside an
invoker subquery. Rejected because RLS defects live in exactly that kind of subtlety, and
the plan is worse.

### 2. `revoke all on profiles from anon`

Measured from the catalogue on 2026-08-16: `profiles.relacl` is
`{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}`
— **`anon` holds full CRUD**, and RLS is the only thing between an anonymous caller and
the table. That is survivable while the table holds a display name; it is not what we want
standing alone in front of a column of email addresses.

The revoke changes nothing observable — `anon` already sees zero rows, because
`id = auth.uid()` is `id = null` for an anonymous caller, which is `null`, which filters
everything. What changes is the *failure shape*, and a test must pick the right one:

- a **privilege** refusal is `42501` with `data === null`;
- an **RLS filter** is `error: null, data: []`.

Asserting the wrong one passes for the wrong reason. This is the same distinction recorded
in `docs/HANDOVER.md` for `project_statuses`.

Follows SPRIN-98's `revoke all on project_members from anon` exactly, including the
reasoning that the table was **born** with that grant rather than ever having been given
it deliberately.

### 3. `email text` — nullable, `unique`

- **Nullable.** A `not null` would put signup itself behind the constraint: any future
  auth path without an email (phone, an OAuth provider that withholds it) would fail
  inside `handle_new_user` and the user would never get a profile row at all. The failure
  mode of the weaker column is a null; the failure mode of the stronger one is a broken
  signup.
- **`unique`.** SPRIN-102 looks membership up by exact email. A unique index is what makes
  `.eq('email', …).single()` honest rather than hopeful. Verified safe against live data:
  9 users, 9 with an email, 9 distinct, 9 distinct under `lower()`, 9 profile rows.
- **Nulls do not collide.** Postgres treats nulls as distinct in a unique index, so any
  number of email-less profiles coexist. That is the behaviour we want and the reason the
  two halves of this decision do not fight each other.

**Known drift, deliberately not fixed here.** `auth.users.email` can change and nothing
re-syncs the mirror. There is no email-change path anywhere in the app, so a second
trigger on `auth.users` would be built for a state that cannot currently arise. Recorded
rather than built; SPRIN-102 should re-read this line before trusting the column as an
identity key.

**Case sensitivity is out of scope but named.** The mirror stores whatever `auth.users`
holds. If SPRIN-102 wants case-insensitive lookup it needs a `lower(email)` index and a
decision of its own; today all 9 addresses are already distinct under `lower()`, so
nothing is masked.

## The policy split

`profiles_self` is one `for all` policy. It is replaced by four, verb-split, the same
shape `project_statuses` uses and for the same reason: the verbs no longer share a
predicate.

| policy | verb | using | with check |
|---|---|---|---|
| `profiles_read` | select | `id = (select auth.uid()) or app_auth.shares_project_with(id)` | — |
| `profiles_self_insert` | insert | — | `id = (select auth.uid())` |
| `profiles_self_update` | update | `id = (select auth.uid())` | `id = (select auth.uid())` |
| `profiles_self_delete` | delete | `id = (select auth.uid())` | — |

**The split preserves current write behaviour verb-for-verb.** `for all` covers all four
verbs, so writing them out separately narrows nothing. In particular self-DELETE stays
permitted: it is a pre-existing footgun (delete your profile row and `handle_new_user`
will not rebuild it, because it fires on `auth.users` insert alone), but narrowing it
would be a scope change smuggled in under a widening story. Left as found, recorded here.

**No `TO` clause**, matching every other policy in this schema. The consequence, recorded
because it has caused a misdiagnosis before: a policy without `TO` covers `anon` too, so a
`42501` on an anonymous request has two possible authors. On this table the revoke above
settles it — `anon` holds nothing, so it is refused at the privilege layer before any
policy runs.

**`(select auth.uid())`, not bare `auth.uid()`.** `profiles_self` is currently one of the
eight `auth_rls_initplan` WARNs. Rewriting it in the wrapped form clears that one for free,
since the policy is being rewritten anyway. The broader sweep across the remaining tables
still belongs to SPRIN-75, not here.

## `handle_new_user`

```sql
insert into public.profiles (id, display_name, email)
values (new.id, coalesce(new.raw_user_meta_data->>'display_name', new.email), new.email);
```

The three properties that must survive the edit, all of them load-bearing:

1. `security definer` — the insert happens before the user can authenticate, so RLS must
   not apply.
2. `set search_path = ''` with every reference schema-qualified — a definer function
   otherwise inherits the *caller's* search_path.
3. `revoke execute … from public, anon, authenticated` — re-stated after the
   `create or replace`. **`create or replace function` preserves the existing ACL**, so
   this is belt-and-braces rather than strictly required; state it anyway, because the
   cost of being wrong about that is a definer function callable by anyone.

Note `display_name` keeps its `coalesce(…, new.email)` fallback unchanged. The two columns
diverge from the same source on purpose: one is editable, one is not.

## Statement order in the migration

Load-bearing, and the reason is recorded in SPRIN-98's migration: a `language sql` body is
**fully parsed and analysed at CREATE time** (`check_function_bodies` defaults to on), so a
forward reference to a table that does not exist yet fails the whole migration. A
`language plpgsql` body is only syntax-checked, which is why `handle_new_user` may be
edited anywhere in the file.

1. `alter table profiles add column email text` + the unique index — **before** anything
   reads the column.
2. Backfill from `auth.users`.
3. `create or replace function app_auth.shares_project_with` (sql — needs
   `project_members`, which already exists), then `revoke execute … from public`, then
   `grant execute … to authenticated`. **A new function in `app_auth` is born
   EXECUTE-to-PUBLIC**: `alter default privileges` was tried in SPRIN-98, reported
   "Success" and did nothing, so the hand-revoke is the pattern.
4. `create or replace function handle_new_user` (plpgsql).
5. Drop `profiles_self`; create the four policies.
6. `revoke all on profiles from anon`.
7. A post-state tripwire on the backfill, with its limitation stated: it reads back its own
   work inside the same transaction, so it proves the statement ran, not that the property
   holds against anything else.

ASCII only — `clip.exe` transcodes by console codepage. Verify the applied state from the
**catalogue**, never from the editor reporting "Success".

## Tests

A new `src/test/profiles.integration.test.ts`, live against the real database.

- **AC3, negative, by row count.** A user reads `profiles` and gets exactly their own row
  back: `error: null`, and the stranger's id absent from the returned set. Counting rows,
  never expecting an error — an RLS filter does not raise.
- **AC4, positive control.** A creates a project (which seeds A as admin via
  `on_project_created_admin`), A inserts B as a `member`, and then **each** reads the
  other's `display_name` and `email`. Both directions, because the predicate is a
  self-join and a one-directional test would pass on a broken half.
- **The negative must be re-asserted after the positive**, from a third relationship: the
  same two users must still be invisible to a user who shares nothing with either.
- **The revoke.** An anonymous client selecting `profiles` earns `42501` with
  `data === null` — the privilege shape, not the filter shape.
- **`email` is populated by the trigger**, asserted on a freshly signed-up user rather
  than on a backfilled one, since the backfill and the trigger are different mechanisms
  and only one of them runs again.

`rls.integration.test.ts:249` and `:489` already assert that A and B each see **exactly
one** profile row. Those two share no project, so both remain true — and they become the
standing guard that this widening did not over-fire. Do not weaken them; if they go red,
the predicate is wrong.

**The tripwire moves.** `npm test` currently collects **eight** more files than
`test:unit`. This story adds the ninth live suite, so the gap becomes **9**, and
`CLAUDE.md` must record that in the same commit — a gap that silently *shrinks* is the
failure the tripwire exists to catch.

## Advisors

Baseline re-measured from the live project on 2026-08-16: **16 performance / 1 security**
(8 `unindexed_foreign_keys` INFOs, 8 `auth_rls_initplan` WARNs, 1 leaked-password WARN).

Predicted after this story: **15 performance / 1 security** — the `profiles_self` WARN
clears, and nothing new arrives, because:

- the unique index on `email` covers no foreign key, so it cannot add an
  `unindexed_foreign_keys` INFO;
- the four new policies use `(select auth.uid())` and a `STABLE` function, so none of them
  can add an `auth_rls_initplan` WARN.

**Expect a transient 16th** — an `unused_index` INFO on the new email index, which is a
statement about *traffic*, not about schema. SPRIN-98 recorded exactly this and watched it
clear within the hour once its own suite scanned the index. **Measure again later.** Do
not write a first reading into `CLAUDE.md` as a standing decision.

## Out of scope

- The assignee picker and any "assigned to Alice" rendering.
- Adding or removing members by email (SPRIN-102).
- The `auth_rls_initplan` sweep across the other seven policies (SPRIN-75).
- An `auth.users` email-change sync trigger (recorded above, deliberately unbuilt).
