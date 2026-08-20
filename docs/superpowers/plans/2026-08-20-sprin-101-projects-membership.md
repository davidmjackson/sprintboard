# SPRIN-101 implementation plan

Design: `docs/superpowers/specs/2026-08-20-sprin-101-projects-membership-design.md`.
Migration: `docs/migrations/sprin-101-projects-membership.sql` (written, parse-validated,
**not yet applied** -- migrations are hand-applied by David).

Four tasks. Task 1 is written red before the migration is applied, deliberately: a suite that
has never failed against the old policy has proved nothing about the new one.

---

## Task 1 -- `src/test/projects-membership.integration.test.ts` (new live suite)

Model it on `src/test/board-membership.integration.test.ts`, which is the closest precedent and
already solves the fixture problems.

**Fixtures.** Three throwaway users created with `adminClient()`, signed in with
`signInWithCredentials`, ids read with `userId(client)`.

- `o` -- creates the project, so the seeding trigger makes them its **admin**.
- `m` -- given a `project_members` row with role **`member`** (service-role insert).
- `s` -- a stranger, and for the cross-project block, the owner of a *different* project.

⚠ **Never insert a second `admin` row.** `project-members.integration.test.ts` asserts a
whole-database invariant that every project has exactly one admin. The admin side of every
assertion is played by `o`, whose row the trigger seeds. Same constraint board-membership works
under.

⚠ **Never call `auth.getUser()`.** It is the documented cause of the rate-limit flake. Read ids
with `userId(client)`, which reads the in-memory session.

⚠ Module scope must call `assertServiceRoleOrExplain()` / `assertCredentialsOrExplain()`, matching
every sibling suite -- a suite that silently skips is a failure that looks like a pass.

**Blocks, one per AC.** Every negative asserts **row counts**, never `error === null` -- RLS
filters UPDATE and DELETE rather than raising, so a zero-row write is a "success".

| Block | Assertions |
|---|---|
| AC1 SELECT | `m` reads the project (1 row); `s` reads `[]`; positive control that `o` reads 1 row |
| AC2 UPDATE/DELETE need admin | `o` updates `sprint_length_weeks` -> **1 row**; `o` deletes a throwaway project -> **1 row** |
| AC3 INSERT bootstraps | a user belonging to nothing creates a project **and** a service-role re-read finds their seeded `admin` row |
| AC4 member cannot update | `m`'s cadence update -> **0 rows**, then a **service-role re-read proves the stored value is unchanged** |
| AC5 all four verbs | `m`'s DELETE -> **0 rows** and a service-role re-read proves the project still exists; anon SELECT `[]`; anon INSERT and DELETE refused |

**The cross-project block is the one that matters most and is not optional.** Every other
negative comes from a caller who is a member of *nothing*, so all of them are satisfied by a
predicate that merely asks "is this caller a member of anything?". Add a caller who is a member
of a **different** project and assert they read `[]` and write 0 rows against this one. Dropping
`is_project_member`'s `project_id` comparison must redden exactly this block. SPRIN-100 added the
equivalent in review and it caught the class.

**Use `sprint_length_weeks` for every row-count write assertion.** It is one of only two columns
`authenticated` may UPDATE. On an ungranted column (`name`, `key`, `project_type`) the write is
refused by the privilege layer with `42501` before RLS is consulted, so the assertion would
measure the grant instead of the policy -- the mistake SPRIN-82 refused and SPRIN-97 fixed.

**Teardown deletes go BEFORE assertions**, not after -- a failed assertion otherwise strands
fixture projects in the shared database.

---

## Task 2 -- register the suite (TWO edits, not one)

1. `verify-gate.test.mjs` -> add `'src/test/projects-membership.integration.test.ts'` to
   `LIVE_SUITES`.
2. `CLAUDE.md` -> the tripwire paragraph: gap **10 -> 11**, and re-measure both absolute counts
   with `npx vitest list --filesOnly | wc -l` and the same with
   `--exclude '**/*.integration.test.ts'`.

SPRIN-98 and SPRIN-105 each updated one half and left the other, one story apart. They are one
control with two halves.

---

## Task 3 -- `SprintsTab.tsx` guard + a test that dies without it

`src/routes/SprintsTab.tsx:90`:

```ts
const canComplete = statusesPhase === 'loaded' && statuses.length > 0
```

Extend the existing comment to say *why* the length check is there: after SPRIN-101 a member can
reach this tab while `project_statuses` is still owner-scoped, so a **successful read of zero
rows** yields an empty terminal set, and `completeSprint` drops its filter and returns every
ticket -- Done included -- to the backlog.

**Do NOT change `completeSprint`.** Making it refuse an empty `terminalSlugs` contradicts the
documented fail-safe design and reddens two deliberate tests.

The test renders `SprintsTab` with an **active sprint**, `statusesPhase === 'loaded'` and
`statuses === []`, and asserts the Complete control is **absent**. It must be checked by mutation:
remove `&& statuses.length > 0` and the new test must go red **on its own**. The ticket records
that every existing unit test stays green without the guard, so a test that does not die is
measuring nothing.

Use `queryByRole` **paired with a raw DOM query** for the absence assertion -- `queryByRole`
excludes `aria-hidden` subtrees, so it alone can report "absent" for an element that is merely
hidden from AT.

---

## Task 4 -- documentation

- `docs/sprintboard_phase1_schema.sql` -- replace the `projects_owner` policy block with the four
  new ones and update the `assign_ticket_key` comment. A rebuild from this file must produce the
  same database.
- `CLAUDE.md` -- the "five tables are already rewritten" paragraph becomes six; `projects` moves
  out of the "what is left" list, leaving only the four config tables (SPRIN-99); the
  `auth_rls_initplan` figures move to the **measured** post-apply numbers.
- `docs/HANDOVER.md` -- session entry, the intermediate-state note, and the follow-ups this story
  hands on.

---

## Global constraints for every task

- **T1-T5 are errors**: 30-line functions, cyclomatic 10, cognitive 15, 4 parameters, 400-line
  files, over `**/*.{ts,tsx,mjs,js}`. Write to them from the first line.
- `npm run verify` is the gate. Never `test:unit`, never `tsc --noEmit`, never a chosen subset.
- Live suites need `env -u VITE_SUPABASE_URL -u VITE_SUPABASE_ANON_KEY` in front of the command --
  `~/.bashrc` exports placeholder Supabase config and `loadEnv` outranks `.env.local`.
- Status/type/column vocabulary lives in `src/lib/domain.ts` and nowhere else.
- Never a Postgres `ENUM`.
