# SPRIN-101 — `projects` governed by membership

Epic SPRIN-75, story 4 of 8 in build order. Written 2026-08-20, before implementation.
Every decision below was taken with David in conversation and is recorded here so the
reasoning survives the story rather than being rediscovered.

---

## What changes

`projects_owner` — **one `for all` policy, no `TO` clause, `owner_id = auth.uid()` in both
clauses** — is replaced by four verb-scoped policies, all carrying `to authenticated`:

| Policy | Verb | Predicate |
|---|---|---|
| `projects_member_read` | SELECT | `app_auth.is_project_member(id)` |
| `projects_bootstrap_insert` | INSERT | `owner_id = (select auth.uid())` |
| `projects_admin_update` | UPDATE | `app_auth.is_project_admin(id)`, USING **and** WITH CHECK |
| `projects_admin_delete` | DELETE | `app_auth.is_project_admin(id)` |

Names follow the `project_statuses` convention (`statuses_owner_read/_insert/_update/_delete`)
rather than inventing a new one. `_member_` / `_bootstrap_` / `_admin_` says which authority
each policy rests on, which is the thing a reader most needs and the thing most easily got
wrong.

### `to authenticated` is mandatory, and this is why

Measured from `pg_class.relacl` on 2026-08-20:

```
projects  {postgres=arwdDxtm/postgres,anon=ardDxtm/postgres,
           authenticated=ardDxtm/postgres,service_role=arwdDxtm/postgres}
```

`anon` holds INSERT, SELECT and DELETE. Three of the four new policies call an `app_auth`
function, and `anon` holds neither USAGE on that schema nor EXECUTE on its functions. A policy
with no `TO` clause covers `public`, anon included, and policy expressions are evaluated as the
**calling** role — so omitting the clause turns every anonymous read of `projects` into
`permission denied for schema app_auth` (42501) where it used to be a clean empty array. This
is the standing rule SPRIN-100 added to `CLAUDE.md`; `projects` is the second table to need it.

With the clause, anon simply matches no policy: SELECT returns `[]`, INSERT and DELETE are
refused by RLS. That is the same observable behaviour as today.

### `auth_rls_initplan`, cleared as a side effect

`projects_owner` is one of the four remaining `auth_rls_initplan` WARNs. Every replacement
predicate is either a call to a `STABLE SECURITY DEFINER` function or the wrapped
`(select auth.uid())` form, both of which take the uid read out of the per-row path. `projects`
should leave that list entirely: **4 WARNs across 2 tables → 3 across 1** (`project_statuses`).

This is the third time a membership rewrite has cleared these for free (SPRIN-105 took one,
SPRIN-100 took three). It remains the argument for letting SPRIN-99 clear the last three rather
than paying for a separate mechanical sweep.

---

## The bootstrap problem, and why it is already solved

If authority came only from membership rows, creating a project would require a membership that
does not yet exist and every insert would fail. The INSERT policy therefore **stays**
`owner_id = (select auth.uid())`, purely to bootstrap.

Three facts were verified from the catalogue rather than assumed:

1. All three triggers on `projects` — `on_project_created` (`create_project_counter`),
   `on_project_created_admin` (`seed_project_admin`), `on_project_created_statuses`
   (`seed_project_statuses`) — are `AFTER INSERT` **and all three are `SECURITY DEFINER`**. None
   of them is exposed to the new policy's authority.
2. `seed_project_admin` inserts `(new.id, new.owner_id, 'admin')` — it reads **`new.owner_id`,
   not `auth.uid()`**. A service-role fixture insert (which has no `auth.uid()`) therefore still
   seeds an admin row. Every raw fixture insert across the live suites and the Playwright E2E
   keeps working.
3. No repair is owed: `select count(*) ... where not exists (admin row)` returns **0 of 3**
   projects. Every existing project already has its owner as admin.

---

## `owner_id` immutability now rests on the GRANT alone

The old `for all` policy's `WITH CHECK` (`owner_id = auth.uid()`) applied to UPDATE as well as
INSERT. The new `projects_admin_update` checks `is_project_admin(id)` and says nothing about
`owner_id` — deliberately, because an admin who is not the owner must be able to change the
cadence.

So on paper an admin could reassign ownership. They cannot, because the write is refused a layer
earlier: `projects` holds **no table-level UPDATE** for `authenticated` and exactly **two column
grants**, `sprint_length_weeks` and `sprint_start_weekday` (`{authenticated=w/postgres}` on those
two attributes and no others, measured 2026-08-20). `owner_id`, `name`, `key` and `project_type`
carry no UPDATE privilege at all.

**This is a real narrowing of defence and is recorded as such rather than glossed.** Before this
story, ownership immutability had two independent controls (the grant and the policy's WITH
CHECK); after it, one. The remaining control is the stronger of the two — a privilege check
precedes RLS and cannot be filtered — but anyone who later grants `update (owner_id)` gets no
second refusal. That is the standing four-part obligation in `CLAUDE.md` for widening this
table, and it now matters more.

---

## Decision 1 — `assign_ticket_key` reverts to `SECURITY INVOKER`

**Settled: revert.**

`sprin-100b` made it `SECURITY DEFINER` for exactly one reason: it does
`select key into v_key from public.projects where id = new.project_id`, and `projects_owner` was
still owner-scoped, so a member got zero rows, `v_key` was NULL, and ticket creation died with
`23502` on `key`. That migration's own closing note asks this story to make the revert **a
decision, not an inheritance**.

The reason dies here. Once `projects` SELECT resolves to membership, a member's read inside the
trigger succeeds. Reverting:

- **restores a deliberate tripwire.** The original schema comment said the invoker context was
  chosen so that narrowing `counters_owner` to read-only would break ticket creation *loudly*.
  SPRIN-100b deleted that knowingly and said nothing replaced it.
- **shrinks the `SECURITY DEFINER` surface from four functions to three.** A definer function is
  a standing bypass of RLS; fewer is better, and this one no longer earns it.

### The one open question, stated as a hypothesis rather than a fact

For a **stranger** (authenticated, not a member), the invoker read returns zero rows, so `key`
is NULL. Whether Postgres then reports `42501` (the RLS `WITH CHECK` on `tickets_owner`) or
`23502` (the NOT NULL constraint) depends on which it evaluates first in `ExecInsert`.

I believe RLS `WITH CHECK` runs first — it is the security-sensible order, since a constraint
error would otherwise leak information to a caller RLS means to refuse. **But that is a
mechanistic rationale, and this project's own rule is that such a rationale is a hypothesis
until measured.** It is not built on: `board-membership.integration.test.ts` already asserts
`42501` *with the row-level-security message* for precisely this case, so the existing suite
settles the question empirically the first time it runs.

**If it comes back `23502`, the revert is wrong and `assign_ticket_key` keeps the definer** —
and that outcome gets written into this file rather than quietly worked around.

The `revoke execute ... from public, anon, authenticated` that `sprin-100b` added stays either
way. Postgres checks EXECUTE on a trigger function at `CREATE TRIGGER` time, not on each fire,
so the trigger keeps working with no grant — measured in SPRIN-100b against `seed_project_admin`
and `create_project_counter`, both of which already sit at `{postgres, service_role}`.

---

## Decision 2 — `SprintsTab.tsx:90` is a data-loss path this story opens

**Settled: fix it here, with a test that dies without the fix.**

This was carried in as "pinned in neither direction". It is worse than that. The chain:

1. `project_statuses` stays owner-scoped until SPRIN-99.
2. After this migration a **member** can SELECT the project, so `ProjectShell`'s
   `if (!project) return <Navigate to="/" replace />` no longer turns them away. The sprints tab
   renders.
3. `listProjectStatuses` succeeds and returns **zero rows** — so `statusesPhase === 'loaded'`
   and `statuses === []`. A successful read of nothing is indistinguishable from a project with
   nothing terminal.
4. `canComplete = statusesPhase === 'loaded'` is therefore **true**, and the Complete button
   renders.
5. `terminalSlugs = doneSlugs([])` is empty, and `sprints.ts:270` reads
   `terminalSlugs.size > 0 ? move.not(...) : move` — with an empty set the filter is **dropped**.

The result is that a member completing a sprint returns **every ticket in it to the backlog,
Done ones included**. That is data loss, reachable by an ordinary user through the UI, created
by this migration.

The fix is `canComplete = statusesPhase === 'loaded' && statuses.length > 0`. Hiding the button
is the honest degradation and is the same one the ticket-count badge already makes; the tab's
own Retry restores it once the read returns rows.

**Explicitly NOT done, per the ticket:** `completeSprint` is not changed to refuse an empty
`terminalSlugs`. That contradicts the documented fail-safe design and reddens two deliberate
tests. The guard belongs at the call site that can tell a degraded read from a real answer.

---

## Decision 3 — the build order stands, and the intermediate state is recorded

**Settled: keep 101 → 99. Ship the guard. Write the intermediate state down.**

Between this story and SPRIN-99 a member sees a **thin** project rather than a correct one:

- the project **does** now appear in their list (this story fixes SPRIN-100's inverse gap, where
  a member had board access to a project that was invisible to them);
- the **board renders no columns**, because `project_statuses` is still owner-scoped and
  `listProjectStatuses` returns zero rows (SPRIN-76 deleted `TICKET_STATUSES`, so columns come
  from rows);
- **Settings → Cadence fails with the generic retry copy**, forever. `updateProjectCadence`
  filters on `id` alone and leans wholly on the policy's USING breadth — a fresh, and now
  *reachable*, instance of the SPRIN-64 class. A non-admin member's patch matches zero rows,
  which the function maps to `'unknown'`.

The alternative considered and rejected was swapping to 99 → 101, which would make the member
view complete in one step and would mean the empty-`terminalSlugs` window never existed. It was
rejected because it reopens a settled build order and because 101's ACs are written assuming it
goes next — and because the guard in decision 2 is worth having regardless, as defence against a
degraded status read from any cause, not only from this one story's ordering.

The cadence path is **SPRIN-104's by name** ("re-audit app-layer guards for zero-row-write
blindness"). Widening this story to give `updateProjectCadence` a `'not_permitted'` tag was
considered and rejected: zero rows cannot honestly distinguish "not an admin" from "project
deleted in another tab" without a second read, and inventing a tag that lies about which is
worse than the generic copy.

---

## Test plan

A **new live suite**, `src/test/projects-membership.integration.test.ts`, mirroring
`board-membership.integration.test.ts`'s shape: three throwaway users (owner/admin, member,
stranger), its own project, `signInWithCredentials` + `userId(client)` — **never**
`auth.getUser()`, which is the documented cause of the rate-limit flake.

⚠ **It adds only `member` rows and never a second `admin`.** `project-members.integration.test.ts`
asserts a whole-database invariant that every project has exactly one admin; a second admin row
would redden a sibling suite. The admin side of every assertion is played by the **owner**, whose
admin row the seeding trigger creates. This is the same constraint board-membership works under.

Coverage, one block per AC:

| AC | Assertions |
|---|---|
| 1 — SELECT is membership | member reads the project; stranger reads `[]`; positive control that the owner reads 1 |
| 2 — UPDATE/DELETE need admin | owner (admin) updates `sprint_length_weeks` → 1 row; owner deletes → 1 row |
| 3 — INSERT still bootstraps | a user who belongs to nothing creates a project **and** gets an admin row seeded |
| 4 — member cannot update | member's cadence update → **0 rows**, re-read with service-role proves the value is unchanged |
| 5 — all four verbs | member's DELETE → 0 rows and the project still exists; anon SELECT `[]`, anon INSERT/DELETE refused |

**Every negative counts rows, never `error === null`.** RLS *filters* an UPDATE and a DELETE
rather than raising, so a zero-row write is a success unless the count is read — the failure
this project has recorded more than once.

**The cross-project case is not optional.** Every stranger-side negative is satisfied by a
predicate that merely asks "is this caller a member of *anything*" — so the suite includes a
caller who is a member of a *different* project, which is the only assertion that would redden
if `is_project_member`'s `project_id` comparison were dropped. SPRIN-100 added exactly this block
in review and it is the one that matters most.

**Anon coverage is new.** The RLS suite currently carries **no** anonymous assertion against
`projects` at all — grepped, not assumed. Since the policies are moving to `to authenticated`,
this story adds it.

Registering the suite is **two edits, not one**: `LIVE_SUITES` in `verify-gate.test.mjs` *and*
the prose tripwire in `CLAUDE.md`. SPRIN-98 and SPRIN-105 each updated one half and left the
other, one story apart. The gap goes **10 → 11**.

For decision 2, a unit test on `SprintsTab` that renders with `statusesPhase === 'loaded'` and
`statuses === []` and asserts the Complete control is absent — checked by mutation to die when
`&& statuses.length > 0` is removed, since the ticket records that every existing unit test
stays green without it.

---

## Not in this story, deliberately

- **Revoking `anon`'s `a`/`d` grants on `projects`.** Now pure liability — the policies are
  `to authenticated`, so anon can do nothing anyway — but the schema-wide anon sweep is
  **SPRIN-103's**, scoped from `pg_class.relacl` across all tables at once rather than
  piecemeal on whichever table a story happens to touch. The same sweep owns the pre-existing
  TRUNCATE grants.
- **Role-aware UI.** Hiding admin-only controls from members needs the app to know the caller's
  role, which is SPRIN-102's territory (add and remove members by email).
- **`updateProjectCadence`'s zero-row blindness.** SPRIN-104, by name.
