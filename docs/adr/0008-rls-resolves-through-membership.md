# ADR 0008 — RLS resolves project access through membership, in four shapes

**Status:** Accepted, 2026-08-21. Records the schema as SPRIN-75 left it.
**Supersedes:** the owner-scoped model (`owner_id = auth.uid()` on every table).

## Context

Sprintboard has no backend. The database is the entire authorisation layer, so a
policy is not a defence-in-depth measure here — it is *the* control. Epic SPRIN-75
replaced owner-scoping with a membership model across all ten tables in `public`:
`project_members`, `profiles`, `project_counters`, `sprints`, `tickets`, `projects`,
`project_statuses`, `project_fields`, `project_field_options`, `ticket_field_values`.

## Decision

**Every table resolves project access through membership or configuration access,
and it does so in one of four shapes. "Harmonise them" is the wrong instinct — the
differences are load-bearing.**

### 1. Board tables — one `for all` policy asking **member**

`project_counters`, `sprints`, `tickets`. Read stays **co-extensive with write**
deliberately: `completeSprint`'s app-layer guard relies on `sprints_owner` being a
single `for all` policy. Split it by verb and that guard silently stops holding.

`board-membership.integration.test.ts` pins the equivalence directly, as set
equality over the project's rows on both `sprints` and `tickets`, so a verb-split
goes red there rather than quietly disarming the guard.

### 2. `projects` and three config tables — **member reads, admin writes**

`projects`, `project_statuses`, `project_fields`, `project_field_options`. Every
member reads the project and config they work with; only an **admin** reconfigures
it. On `projects` that is four policies: `projects_member_read`,
`projects_bootstrap_insert`, `projects_admin_update`, `projects_admin_delete`.

**Admin-only DELETE is not a nicety.** Deleting a project cascades through every
referencing fk, and **RLS is not enforced on cascaded child rows** — so a
membership-only DELETE would let a plain member destroy an entire board in one
request. This finding was killed twice during SPRIN-100 as "the actor is the owner
deleting their own project"; correct then, made wrong by SPRIN-101.

### 3. `ticket_field_values` — verb-split, but **member on every verb**

No admin gate. Setting a custom field's *value* on a ticket is ordinary board work,
the same act as editing `story_points`. *Defining* the field — a `project_fields` or
`project_field_options` row — is the admin act.

### 4. `project_members` — a **GRANT** shape, not a policy shape

See ADR 0010. Only its SELECT policy is reachable.

### Three self-scoped predicates survive on purpose

They are not leftovers to clean up:

- `projects_bootstrap_insert` — `owner_id = (select auth.uid())`, so creating a
  project does not require a membership row that cannot exist yet.
- The three `profiles` write verbs — `id = (select auth.uid())`. A self-write is not
  a project access decision made about anyone else.
- `projects_member_read`'s bootstrap disjunct —
  `owner_id = (select auth.uid()) and not app_auth.project_has_members(id)`, which
  lets a creator read their project for the instant between its INSERT and the
  AFTER-INSERT trigger seeding their own membership row.

### `profiles` read is co-membership

`id = (select auth.uid()) or app_auth.shares_project_with(profiles.id)` — mine, plus
anyone I share a project with. Writes did **not** widen; the old single `for all`
policy was split into four verb-scoped ones precisely so the widened read could not
smuggle a widened write alongside it.

## Consequences

- **Check the table *and* the verb before assuming a policy's shape.** Re-derive
  bodies from `pg_policies`, never from prose.
- **A policy calling an `app_auth` function must carry `to authenticated`.** The
  board tables grant `anon` full CRUD, and a policy with no `TO` clause covers
  `public`. Policy expressions evaluate as the *calling* role, and `anon` holds
  neither USAGE on `app_auth` nor EXECUTE on its functions — so without the clause
  an anonymous request raises `permission denied for schema app_auth` (42501) where
  it used to return a clean empty array. That breaks the keepalive cron's `200 []`
  contract on `tickets`, which pauses the free-tier database, which blocks every
  merge. Check `relacl` before writing the policy, every time.
- **A SECURITY INVOKER trigger depends on every table it READS, not only those it
  writes.** `assign_ticket_key` updates `project_counters` and also reads
  `projects`; membership on the first plus ownership on the second made every
  member's ticket creation fail with a `NOT NULL` violation on `key`. Grep the
  trigger functions on a table for what else they touch before changing its policy.
- **Re-audit every app-layer guard that leans on a policy's breadth**, not only the
  policies themselves. Where read is broader than write, a guard written against
  `for all` stops holding and the isolation suite will not flag it.
- **Extend the isolation suites, do not merely keep them green.** Owner-vs-stranger
  is no longer the only case: member-vs-non-member, role-vs-role and removed-member
  each need coverage, or the suite passes while the new boundary leaks.

## `projects` column grants: the four-part obligation

`projects` holds **no table-level UPDATE for `authenticated`, and exactly two column grants**
(`sprint_length_weeks`, `sprint_start_weekday`). That is what keeps `name`, `key`,
`project_type` and **`owner_id`** immutable in the database rather than only in our code.
`projects_admin_update` says nothing about `owner_id` — an admin who is not the owner must be
able to change the cadence — so **this GRANT is the sole control on it.** The old `for all`
policy's `WITH CHECK` used to pin it as well; it no longer does.

**A story that needs another writable column owes four things, and only the first announces
itself:**

1. `grant update (<column>) on projects to authenticated` in its migration.
2. That column added to `SPRINT_CADENCE_COLUMNS` in `domain.ts`, which is
   `satisfies readonly (keyof SprintCadence)[]` — so a non-cadence column needs the type
   widened and the constant renamed.
3. The doc-vs-migration matcher in `domain.test.ts` kept in step.
4. A live assertion that the column is genuinely writable.

**Deny by default, widen visibly.**

**A cross-tenant row-count assertion is only honest on a column the role may actually
UPDATE.** On an ungranted column the privilege layer refuses with 42501 *before* RLS is
consulted, so a row-count assertion there measures the grant instead of the policy.
