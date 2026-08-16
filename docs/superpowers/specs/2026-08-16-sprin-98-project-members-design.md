# SPRIN-98 — Membership table, roles and admin seeding

Foundation story for epic **SPRIN-75** (teams, roles and permissions). Additive only: it
changes no existing policy, so the app keeps running off `owner_id` until SPRIN-100/101/99
flip the predicates.

## The design David settled (2026-08-16)

Four decisions, taken in conversation before any code:

1. **Two roles, `admin` and `member`, and BOTH read and write.** A read-only viewer role was
   proposed and rejected. A viewer makes read broader than write on the board tables, which
   re-arms the SPRIN-64 trap — `completeSprint`'s guard is correct only because
   `sprints_owner` is one `for all` policy where read and write share a predicate.
2. **Membership is granted by exact email address** (SPRIN-102), which is why SPRIN-105 adds
   `profiles.email` and widens `profiles_self`.
3. **`owner_id` stays** on `projects`, `not null`, as an audit record of who created it. It
   grants nothing once the epic lands. The `projects` INSERT policy keeps `owner_id =
   auth.uid()` purely to bootstrap.
4. **Admins configure, members do board work.**

## What this story builds

- `public.project_members (project_id, user_id, role, created_at)`, primary key
  `(project_id, user_id)`.
- `role` is `text` + a `check`. **Never a Postgres `ENUM`** — CLAUDE.md calls that the single
  most damaging change anyone could make to this schema.
- Four RLS policies: any member of a project may read its membership rows; only an admin may
  insert, update or delete them.
- A trigger seeding one `admin` row on `projects` INSERT, and a backfill for existing rows.

## The decision that needs David's eye: breaking the RLS recursion

**A policy on `project_members` cannot ask "is the caller a member of this project?" by
querying `project_members`.** Postgres raises `infinite recursion detected in policy for
relation project_members`.

Routing the question through `projects` instead only defers it. At SPRIN-101 the `projects`
policy starts checking membership, so `project_members` -> `projects` -> `project_members`
becomes *mutual* recursion. Anything built on that basis breaks two stories later, when the
migration is much more expensive to unpick.

Three options were considered:

| Option | Cost |
|---|---|
| **Definer helper in a non-exposed schema** (chosen) | A new schema and two `security definer` functions — real surface, deliberately minimal. |
| Definer helper in `public` | PostgREST publishes every `public` function as an RPC. The schema already records this hazard at line 394. Rejected. |
| Read policy restricted to `user_id = auth.uid()` | No recursion and no definer — but a member cannot see who else is in the project, so SPRIN-102's member list is unbuildable. Rejected. |

**Chosen shape.** A schema `app_auth`, which is *not* in Supabase's PostgREST exposed-schema
list, holding two `stable security definer` functions with a pinned empty `search_path` and
schema-qualified references, following `handle_new_user`:

- `app_auth.is_project_member(p_project_id uuid) returns boolean`
- `app_auth.is_project_admin(p_project_id uuid) returns boolean`

Both consult `(select auth.uid())` and nothing else, so **a caller can only ever learn about
themselves**. Even if the schema were exposed, neither is an oracle about anyone else. That
property is what makes the definer privilege affordable here, and it must be preserved: a
future signature taking a `user_id` parameter would destroy it.

## Deliberate choices, recorded so they are not "tidied up"

- **`anon` gets no privilege on `project_members` at all.** Elsewhere in this schema anon
  receives an empty array from an `EXISTS` that matches nothing; here it is refused at the
  privilege layer with `42501`. That is a departure from the local convention and is
  intentional — membership is the one table where "who belongs to what" should not even reach
  a policy for an unauthenticated caller. Documented so the inconsistency reads as a decision.
- **`grant update (role)` only.** Postgres has no column-level DELETE, but it does have
  column-level UPDATE, so granting `role` alone makes "a membership row can never be
  re-pointed at a different user or project" a *database* property rather than a client
  convention. Same technique as SPRIN-92's `grant update (label)`.
- **An index on `user_id`.** The primary key `(project_id, user_id)` already covers the
  `project_id` foreign key as a prefix, but the `user_id` foreign key to `auth.users` needs
  its own. Without it the advisor gains an `unindexed_foreign_keys` INFO; with it the story
  should add **zero** new lints. Compare against the measured baseline — **16 performance, 1
  security** as of 2026-08-09 — never against zero, and re-derive it with `get_advisors`.
- **The seeding trigger must be `SECURITY DEFINER`.** The INSERT policy requires an admin, and
  at project-creation time there is no admin yet. An invoker function would deadlock the
  bootstrap exactly as `seed_project_statuses` would have against the select-only policy.
- **No "last admin" guard in this story.** SPRIN-102 AC6 wants one, and the obvious
  implementation — a row trigger counting sibling rows — is a known trap: a row trigger that
  counts siblings sees a fresh SPI snapshot and breaks the delete cascade, so deleting a
  project or a user would fail. It belongs with the UI story that needs it, designed properly.

## Out of scope

No client library and no UI. `listProjectMembers` and friends belong to SPRIN-102. This story
is a migration, the schema document, and live tests — which keeps the diff small enough to
review adversarially, on the one table where a leak would originate.

## Acceptance criteria

1. `project_members` exists with the shape above and RLS enabled.
2. A trigger seeds an `admin` row on `projects` INSERT, in the parent transaction, so "a
   project with no admin" is not a reachable state.
3. The migration backfills exactly one admin row per existing project, verified from the
   catalog after apply.
4. A member of project A cannot read project B's membership rows; a non-admin member cannot
   insert, update or delete one.
5. Positive controls throughout: RLS *filters* rather than raising, so a policy that hides
   everything from everyone passes every negative test. Every negative is paired with a
   positive, and cross-tenant assertions count rows.
