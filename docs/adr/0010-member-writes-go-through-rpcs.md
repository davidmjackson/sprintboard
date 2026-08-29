# ADR 0010 — Membership writes go through RPCs, enforced by a GRANT not a policy

**Status:** Accepted, 2026-08-21 (SPRIN-102); amended 2026-08-22 (SPRIN-107).
**Related:** ADR 0008 (the four policy shapes), ADR 0009 (`app_auth` predicates).

## Context

`project_members` decides who may do anything else in the schema. A row-level policy
governing writes to it would have to be correct against every direct
`INSERT`/`UPDATE`/`DELETE` PostgREST can express, including partial updates that move a
role and deletes that empty a project of admins.

## Decision

**SPRIN-102 revoked INSERT, UPDATE, DELETE and TRUNCATE from `authenticated` on
`project_members` and made three `SECURITY DEFINER` RPCs the only write path:**
`add_project_member_by_email`, `set_project_member_role`, `remove_project_member`.

**The control is a GRANT, not a policy.** Of the table's four policies, only
`members_read` (SELECT, membership) is reachable. `members_admin_insert`,
`members_admin_update` and `members_admin_delete` all sit behind a privilege check
that refuses first. They are kept so that re-granting a verb later cannot silently
reopen a row-level hole at the same moment.

**Reading `pg_policies` for this table therefore tells you something true and
useless.** Check `relacl` too. Two live consequences:

- A refused write earns `permission denied for table project_members` from the
  privilege layer, **not** the RLS wording. Only the *message* tells the two apart.
- Those three policies are a guard **no live suite can observe**, because
  `pg_catalog` is not exposed to PostgREST even for a service-role client.

Each RPC's **first statement** is `app_auth.is_project_admin`, checked before
anything is read. That is what carries the safety.

## The three lint 0029 WARNs are the design

One per RPC, `authenticated_security_definer_function_executable`. **Do not "fix"
them.** David's explicit call, 2026-08-21, after pricing the alternatives:

- `SECURITY INVOKER` defeats the email lookup outright — resolving an address
  belonging to someone the admin shares no project with is the whole point, and
  `profiles_read` deliberately refuses it.
- Revoking EXECUTE leaves them uncallable.
- Hiding the bodies in `app_auth` behind thin invoker wrappers in `public` would
  silence the lint while changing the security property not at all. Rejected as
  lint-laundering.

**A fourth public RPC adds a fifth WARN, by construction.** Expect it; it is not a
regression. SPRIN-102's own migration predicted "no new lints" because it reasoned
about what it *creates* rather than about the shape itself.

## SPRIN-107: deciding whether to lock, from an unlocked read, is not a lock

`remove_project_member` decided **whether to take its row lock** from an **unlocked**
read, and its DELETE carried no `role` predicate. Removing a plain member therefore
took no lock at all — and a member promoted to sole admin inside that window was
deleted straight past the last-admin guard, leaving the project with **zero admins**:
unadministerable, and (since ADR 0008 routes `projects_admin_delete` through
`app_auth.is_project_admin`) undeletable by any authenticated user.

SPRIN-102's migration asserted in prose that no path through the three functions
could empty a project. That was false for exactly this one.

**The fix re-asserts the role in the DELETE and re-runs the guard if it moved.** That
takes **no new lock**, so it raises no lock-ordering question. The rejected
alternative — locking the target row on the initial read — inverts acquisition order
against `set_project_member_role` and trades a race for a deadlock.

Its authorisation check sits **outside** the retry loop on purpose: in the very
interleaving that motivates the fix, the caller's own admin row is removed while they
are parked, so re-checking would turn a correct `last_admin` into a spurious 42501.

**The rule to carry: deciding whether to lock, from a read that is not itself locked,
is not a lock.**
