# ADR 0009 — Policy predicates live in `app_auth` as SECURITY DEFINER functions

**Status:** Accepted, 2026-08-21.
**Related:** ADR 0008 (the four policy shapes), ADR 0010 (the membership RPCs).

## Context

A membership model asks, inside a policy on `project_members`, whether the caller is
a member of the project — which reads `project_members`, which triggers its own
policy. That recursion has to be broken by a predicate the policy can call without
re-entering RLS.

## Decision

**Predicates live in `app_auth`, a schema PostgREST does not expose, as `STABLE
SECURITY DEFINER` functions.** There are four:

| Function | Takes | Used by |
|---|---|---|
| `is_project_member(uuid)` | project id | board tables, config reads, `projects` read |
| `is_project_admin(uuid)` | project id | config writes, `projects` update/delete, all three RPCs |
| `shares_project_with(uuid)` | **another user's** id | `profiles` SELECT |
| `project_has_members(uuid)` | project id | `projects_member_read`'s bootstrap disjunct |

The schema must be **unexposed**. "Absent from `database.types.ts`" proves nothing;
an exposed schema answers 404, not 406.

`project_has_members` is `security definer` for a different reason from the others:
inlining its `not exists` lets `project_members`' own RLS filter the subquery to
empty and collapse the policy into the rejected variant.

## A foreign-id parameter is the dangerous part

`is_project_member` and `is_project_admin` are affordable as `security definer`
**because they take no other-user parameter** — they can only ever answer a question
about the caller. SPRIN-98's migration states the rule plainly: adding one "would
turn a harmless self-query into an oracle about other people. Do not."

`shares_project_with` **does** take another user's id and is still affordable, but
for a narrower and different reason, not a relaxation of that rule: **one side of its
join is pinned to `(select auth.uid())`**, so it can only answer "do I share a project
with X", never "do X and Y share a project". The full three-point argument is in
`docs/migrations/sprin-105-profiles-email-and-co-member-reads.sql` §3.

**Read that argument before adding a fifth `app_auth` function with a foreign-id
parameter.** It is not a precedent that "parameters are fine now."

## Consequences

- **Any policy calling one of these must carry `to authenticated`** — see ADR 0008.
  `anon` holds neither USAGE on the schema nor EXECUTE on the functions.
- **A `STABLE SECURITY DEFINER` predicate clears the `auth_rls_initplan` advisor WARN
  for free**, exactly as `(select auth.uid())` does, by taking the uid read out of the
  per-row path. Four stories cleared eight WARNs this way as a side effect of doing
  the membership rewrite properly, never as a dedicated sweep. A policy written
  against `app_auth` never raises the WARN in the first place.
- **These four do not trip advisor lint 0029** (`authenticated_security_definer_function_executable`),
  which is reachability-gated on `/rest/v1/rpc/`. They are authenticated-executable but
  sit in an unexposed schema. The three `public` RPCs in ADR 0010 do trip it, by design.
