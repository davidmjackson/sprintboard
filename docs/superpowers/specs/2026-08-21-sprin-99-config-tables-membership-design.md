# SPRIN-99 — Config tables: admin-only writes, member reads

**Date:** 2026-08-21
**Epic:** SPRIN-75 (Teams, roles and permissions — the security boundary)
**Status:** design approved by David, 2026-08-21

## What this is

The last four owner-scoped tables in the schema move to the membership model:
`project_statuses`, `project_fields`, `project_field_options` and `ticket_field_values`.
Sixteen per-verb policies are rewritten. After this story, **no table in `public` resolves
to `owner_id = auth.uid()`**, and the epic's RLS rewrite is complete.

It also closes a **live regression**. Since SPRIN-101 put `projects` on membership, a
non-owner member sees the project in their list but the board renders **no columns** —
because `project_statuses` still answers only to the owner. This story is what makes a
member's board render at all.

## The measured starting state

Every fact below was read from the live catalog on 2026-08-21, not from documentation.

### Policies

Sixteen policies, four per table, **already split per verb**. That is the opposite of the
board tables, where the single `for all` shape is load-bearing; here the split already
exists, so read-broader-than-write needs no structural change. Every predicate is
`exists (select 1 from projects p where p.id = <t>.project_id and p.owner_id = auth.uid())`.

Three of them — `statuses_owner_read`, `statuses_owner_insert`, `statuses_owner_update` —
use a **bare** `auth.uid()` rather than `(select auth.uid())`. They are the last three
`auth_rls_initplan` advisor WARNs in the project.

### Grants — the fact that shapes the tests

All sixteen policies carry **no `TO` clause**, so they cover `public`, anon included. And
anon holds real grants here:

| Table | anon | authenticated (table) | authenticated (columns) |
|---|---|---|---|
| `project_statuses` | SELECT, **INSERT** | INSERT, SELECT, DELETE | UPDATE on `name`, `category`, `position`, `wip_limit` |
| `project_fields` | SELECT | SELECT, DELETE | INSERT on `project_id, slug, name, type`; UPDATE on **`name` only** |
| `project_field_options` | SELECT | SELECT, DELETE | INSERT on `project_id, field_id, slug, label, position`; UPDATE on **`label` only** |
| `ticket_field_values` | SELECT | SELECT, DELETE | INSERT + UPDATE on all seven payload columns |

Two consequences:

1. **Every rewritten policy must carry `to authenticated`.** `anon` holds neither USAGE on
   `app_auth` nor EXECUTE on its functions, so without the clause an anonymous request
   raises `42501: permission denied for schema app_auth` where it used to be filtered to an
   empty result. This is the SPRIN-100 rule, and it binds on all four tables.
2. **A member-denied row-count assertion is only honest on a column the role may actually
   UPDATE.** On an ungranted column the request is refused by the privilege layer with
   `42501` *before* RLS is consulted, so the test would measure the grant instead of the
   policy. The `project_fields` negative test must therefore write `name`, and the
   `project_field_options` one must write `label`.

### Triggers — the SPRIN-101 hazard is not present here

All three `projects` AFTER INSERT triggers are **SECURITY DEFINER**:
`create_project_counter`, `seed_project_admin`, `seed_project_statuses`. Seeding therefore
bypasses RLS entirely, so there is no ordering race between the membership row being seeded
and the statuses being seeded. (Their name order — `on_project_created` <
`on_project_created_admin` < `on_project_created_statuses` — would seed membership first
anyway, but nothing depends on that.)

`project_statuses_delete_guard` and `project_statuses_promote_initial` are also DEFINER, as
is `resolve_initial_ticket_status` on `tickets`, which reads `project_statuses`.

Exactly **one** INVOKER function touches any of the four tables: `reorder_project_statuses`.
Its body was read in full. It touches `project_statuses` alone and carries **no** hidden
ownership check, so RLS plus the `position` column grant are its only controls.

### Foreign keys — a vector that is already closed

Every fk on `ticket_field_values` is **composite on `project_id`**:

- `tfv_ticket_fk (ticket_id, project_id) -> tickets(id, project_id)`
- `tfv_field_fk (field_id, project_id) -> project_fields(id, project_id)`

RLS `WITH CHECK` fires before fk validation and a policy guards only the columns it reads,
so a policy reading `project_id` alone would normally leave the other fk columns
tenant-unguarded. Here it does not: the composite keys make it impossible to attach a value
to another tenant's ticket while claiming your own `project_id`. A predicate on
`project_id` is genuinely sufficient, and this is why.

## The design

Sixteen policies replaced one for one, keeping the verb split, all `to authenticated`, all
predicates resolving through `app_auth`.

For each of the three configuration tables — `project_statuses` (`statuses_*`),
`project_fields` (`fields_*`) and `project_field_options` (`options_*`):

```
<prefix>_member_read    SELECT  USING            app_auth.is_project_member(project_id)
<prefix>_admin_insert   INSERT  WITH CHECK       app_auth.is_project_admin(project_id)
<prefix>_admin_update   UPDATE  USING+WITH CHECK app_auth.is_project_admin(project_id)
<prefix>_admin_delete   DELETE  USING            app_auth.is_project_admin(project_id)
```

And for `ticket_field_values`, member on every verb:

```
tfv_member_read     SELECT  USING            app_auth.is_project_member(project_id)
tfv_member_insert   INSERT  WITH CHECK       app_auth.is_project_member(project_id)
tfv_member_update   UPDATE  USING+WITH CHECK app_auth.is_project_member(project_id)
tfv_member_delete   DELETE  USING            app_auth.is_project_member(project_id)
```

Policy names change from `*_owner_*` to `*_member_read` / `*_admin_*` so the name states the
predicate, matching SPRIN-101's `projects_member_read` / `projects_admin_update`.

**UPDATE repeats its predicate in `WITH CHECK`** rather than letting it default. It matters
most on `ticket_field_values`, whose `project_id` is itself writable: without it a member
could update a row *into* a project, and the composite fk would not stop a move between two
projects the member belongs to.

### Why `ticket_field_values` is member-writable

Setting a custom field's **value** on a ticket is daily board work; defining the **field**
is the administrative act. The three definition tables are admin-write; the value table is
member-write. This boundary was proposed in the story as "open to veto" and was **confirmed
by David on 2026-08-21**. The cost is accepted knowingly: a member can overwrite any
teammate's custom field values, because there is no per-field permission model and building
one is not in this epic.

### Decisions made without asking

- **Policy renaming** as above. The old names would survive a rewrite intact and would then
  describe a predicate they no longer have, which is worse than churn.
- **New live suite `config-membership.integration.test.ts`**, following
  `board-membership` and `projects-membership`. This takes the unit-vs-all test-file gap
  from **11 to 12**, so `LIVE_SUITES` in `verify-gate.test.mjs` and the CLAUDE.md prose must
  be updated **in the same commit** — SPRIN-105 updated the prose and left the array, and its
  own suite was collectable-but-unregistered for a whole story.
- **No grant changes at all.** The column grants already encode the writable surface and are
  orthogonal to *who* may write. Changing both in one migration would make a failure
  ambiguous between the two layers.

### Explicitly out of scope

- **The zero-row-write audit is SPRIN-104's**, deliberately fenced off by the story so it
  cannot be skipped by being buried here. This story makes zero-row writes *routine* — that
  is the point of read being broader than write — but auditing every app-layer write path for
  blindness to them is the other story. The one existing defence
  (`reorderProjectStatuses`' row-count assertion, `src/lib/project-statuses.ts`) is verified
  to still hold, and nothing more.
- **anon's stray INSERT grant on `project_statuses`** stays. It is inert twice over: RLS
  blocks it today, and after this change anon matches no policy at all and is default-denied.
  Revoking it is a privilege change this story did not ask for, and the other three tables'
  anon SELECT grants would raise the same question. Confirmed with David, 2026-08-21.
- **`updateProjectCadence`'s failure for members** — a different table (`projects`) and
  SPRIN-104's to own.

## Testing

A member-vs-admin suite mirroring `board-membership.integration.test.ts`, with positive
controls throughout — a denial proves nothing unless the same call succeeds for someone.

1. **A member reads all configuration**: every status, field and option of a project they
   belong to but do not own.
2. **A member cannot write configuration.** Per table and per verb, and asserting the *right
   failure shape*: INSERT is refused by `WITH CHECK` and **raises**; UPDATE and DELETE are
   filtered by `USING` and **change zero rows** without erroring. Asserting the wrong one of
   those passes for the wrong reason.
3. **An admin can**, on each of the same calls. This is the positive control that makes (2)
   meaningful.
4. **A member reads and writes `ticket_field_values`** — insert, update, clear.
5. **A stranger sees nothing and touches nothing** on all four tables.
6. **Membership is project-scoped, not global**: admin of project A gets no configuration
   write on project B.
7. **Anonymous callers are filtered, not errored** — no `42501` from `app_auth`, which is the
   regression the `to authenticated` clause exists to prevent.
8. **`reorder_project_statuses` under the new policy**: an admin reorders; a member's call
   returns zero rows and the app-layer row-count assertion converts that into an error.

## Risks

| Risk | Why it is closed |
|---|---|
| anon breaks with `42501` on the `app_auth` schema | `to authenticated` on all sixteen; test 7 asserts the filtered shape directly |
| A negative test measures a grant, not a policy | Column-grant table above; negative UPDATEs use `name` / `label` / a granted column |
| Project creation breaks, as in SPRIN-101 | Seeding triggers are all SECURITY DEFINER — measured, not assumed; test 3 creates a project end to end |
| A member's board still renders no columns | Test 1 is exactly that read |
| The new suite is collectable but unregistered | `LIVE_SUITES` and CLAUDE.md updated in the same commit as the file |

## Expected advisor delta

Performance lints **11 -> 8**. The three `auth_rls_initplan` WARNs on `project_statuses`
clear because a `STABLE SECURITY DEFINER` call takes the uid read out of the per-row path,
exactly as `(select auth.uid())` does. This is the fourth story in a row to clear its WARNs
as a side effect of doing the membership rewrite properly rather than by a mechanical sweep,
and it retires that sweep from CLAUDE.md.

No new `unindexed_foreign_keys` — no schema is added. Do not record an `unused_index` reading
taken straight after applying; that advisor is about traffic, not schema.
