import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  DEFAULT_PROJECT_STATUSES,
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  SPRINT_CADENCE_COLUMNS,
  SPRINT_LENGTH_WEEKS,
  SPRINT_STATUSES,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  cadenceSummary,
  hasSprints,
  hasWipLimits,
  isCustomFieldType,
  isProjectType,
  isSprintStatus,
  isStatusCategory,
  isTicketType,
  ticketListLabels,
  type ProjectType,
  type TicketInsert,
  type TicketUpdate,
} from './domain'

/**
 * domain.ts restates, in TypeScript, vocabulary the database enforces with check
 * constraints. Two sources of truth drift. These tests read the schema and assert
 * they still agree, so a migration that adds a status without updating the client
 * fails here rather than in front of a user.
 *
 * What this does NOT cover: the schema file is not the database. It is applied by
 * hand in the Supabase SQL editor, so a value could reach the live database
 * without touching this file at all. Only S1.3's integration test can see that.
 */

// Resolved from this file, not the CWD: running vitest from a subdirectory would
// otherwise silently fail to find the schema.
const SCHEMA_PATH = join(import.meta.dirname, '..', '..', 'docs', 'sprintboard_phase1_schema.sql')
const SCHEMA = readFileSync(SCHEMA_PATH, 'utf8')

const MIGRATIONS_DIR = join(import.meta.dirname, '..', '..', 'docs', 'migrations')

/**
 * The `grant`/`revoke` statements naming one table, normalised and sorted.
 *
 * **Comments are stripped FIRST, and that is the whole trick.** Both the schema doc and the
 * migrations argue about grants in prose — the SPRIN-93 migration's header quotes the exact
 * WRONG form (`revoke …; grant delete …`) in order to warn against it — so a matcher that read
 * comments would compare documentation rather than SQL, and would go red on a correct file
 * because of a sentence. This project has already reddened CI once by scanning prose.
 *
 * Statements are split on `;`, whitespace-collapsed and lowercased, so the two files may format
 * and comment themselves however they like and still be compared on what they DO.
 *
 * **THE TABLE MATCH TOLERATES SCHEMA QUALIFICATION AND QUOTING, and that is a fix rather than
 * a nicety** (SPRIN-97 review). It used to be the literal `\bon <table>\b`, which drops
 * `on public.projects` and `on "projects"` before either side is compared. Most directions of
 * that failed closed — an unrecognised statement in the migration empties `fromMigration` and
 * trips the vacuity guard — but one did not: an EXTRA grant added to the schema doc in a
 * qualified form is invisible to `fromDoc`, so the equality passes while the doc quietly says
 * something the migrations never applied. On `projects` that is the difference between a
 * documented `project_type` immutability and a rebuilt database without one.
 *
 * Both spellings are legal SQL and Postgres treats them as the same relation, so the matcher
 * has to as well. The alternative — forbidding the qualified form by convention — is a
 * prose-only invariant, which is the footgun this project has recorded before.
 */
function grantStatements(sql: string, table: string): string[] {
  const onTable = new RegExp(`\\bon\\s+(?:public\\s*\\.\\s*)?"?${table}"?(?![\\w"])`)
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim().toLowerCase())
    .filter((statement) => /^(grant|revoke)\b/.test(statement) && onTable.test(statement))
    .sort()
}

/** The DDL body of one `create table` block. Scoping matters: `status` exists on
 *  both sprints and tickets, so an unscoped search silently reads the wrong one. */
function tableBody(table: string): string {
  const match = new RegExp(`create table ${table} \\(([\\s\\S]*?)\\n\\);`).exec(SCHEMA)
  if (match?.[1] === undefined) {
    throw new Error(`No "create table ${table}" block found in ${SCHEMA_PATH}.`)
  }
  return match[1]
}

/** Pull the allowed values out of `check (<column> in ('a','b'))` on one table. */
function checkConstraintValues(table: string, column: string): string[] {
  const match = new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`).exec(tableBody(table))
  if (match?.[1] === undefined) {
    throw new Error(`No check constraint for "${column}" on table "${table}".`)
  }
  return [...match[1].matchAll(/'([^']+)'/g)].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))
}

/**
 * The rows `seed_project_statuses()` inserts, parsed out of its VALUES list.
 *
 * This replaces what `checkConstraintValues('tickets', 'status')` used to do.
 * SPRIN-79 dropped `tickets_status_check` — the status vocabulary is per-project
 * now, and a CHECK body may not contain a subquery — so the schema's statement of
 * the four statuses moved from a constraint into this trigger. The parser has to
 * move with it, or the assertions below would silently have nothing to read.
 */
function seededProjectStatuses(): {
  slug: string
  name: string
  category: string
  position: number
  is_initial: boolean
}[] {
  const fn = /create or replace function seed_project_statuses\(\)([\s\S]*?)\$\$;/.exec(SCHEMA)
  if (fn?.[1] === undefined) {
    throw new Error(`No "seed_project_statuses()" function found in ${SCHEMA_PATH}.`)
  }
  const rows = [
    ...fn[1].matchAll(
      /\(\s*new\.id,\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*(\d+),\s*(true|false)\)/gi,
    ),
  ]

  // Counted independently and loosely, because "parsed nothing" is the easy failure
  // and "parsed SOME" is the dangerous one: the assertion downstream compares the
  // parsed rows to DEFAULT_PROJECT_STATUSES, so four parsed rows match four constants
  // no matter what else the trigger inserts. A fifth seeded status the board cannot
  // render would otherwise be invisible here — which is precisely the disappearing
  // ticket the bridging assertions exist to prevent.
  const tuples = (fn[1].match(/\(\s*new\.id\b/gi) ?? []).length
  if (rows.length !== tuples) {
    throw new Error(
      `seed_project_statuses() inserts ${tuples} row(s) but this parser could only read ` +
        `${rows.length} of them. The VALUES shape changed; teach the parser the new one ` +
        'rather than deleting the assertions that depend on it.',
    )
  }
  if (rows.length === 0) {
    throw new Error(
      'Found seed_project_statuses() but parsed no VALUES rows out of it. The insert ' +
        'shape changed; teach this parser the new one rather than deleting the assertions.',
    )
  }
  return rows.map((m) => ({
    slug: m[1]!,
    name: m[2]!,
    category: m[3]!,
    position: Number(m[4]),
    is_initial: m[5] === 'true',
  }))
}

/**
 * Type-level regression guards. These assert at COMPILE time — `@ts-expect-error`
 * fails the build if the error it expects stops happening, so this test cannot
 * rot into a false green.
 *
 * The regression they guard: swapping the hand-written types for generated ones
 * made `key` and `number` writable from the client, and the type system then
 * *pushed* you to supply a key on insert — the exact road to generating keys
 * client-side, which CLAUDE.md forbids.
 */
describe('the trigger-owned ticket columns are unrepresentable from the client', () => {
  it('a ticket insert needs neither key nor number', () => {
    const insert: TicketInsert = { project_id: 'p', summary: 'Wire the board' }
    expect(insert.summary).toBe('Wire the board')
  })

  it('rejects an insert that tries to set key or number', () => {
    // @ts-expect-error `key` is assigned by the assign_ticket_key trigger.
    const withKey: TicketInsert = { project_id: 'p', summary: 's', key: 'SPB-1' }
    // @ts-expect-error `number` is assigned by the assign_ticket_key trigger.
    const withNumber: TicketInsert = { project_id: 'p', summary: 's', number: 1 }
    expect([withKey, withNumber]).toHaveLength(2)
  })

  it('rejects an update that tries to rewrite key, number, or project', () => {
    // @ts-expect-error the key is immutable; freeze_ticket_key restores it anyway.
    const rekey: TicketUpdate = { key: 'LOL-1' }
    // @ts-expect-error a ticket cannot move between projects.
    const reproject: TicketUpdate = { project_id: 'other' }
    expect([rekey, reproject]).toHaveLength(2)
  })

  it('rejects an update that touches a blocked field — those go through blockTicket', () => {
    // The three blocked fields move together under tickets_blocked_coherent; the
    // free-form edit path must never half-apply them. Only TicketBlockUpdate may.
    // @ts-expect-error is_blocked is owned by blockTicket/unblockTicket.
    const block: TicketUpdate = { is_blocked: true }
    // @ts-expect-error blocked_reason is owned by blockTicket/unblockTicket.
    const reason: TicketUpdate = { blocked_reason: 'x' }
    // @ts-expect-error blocked_since is trigger-owned (sync_blocked_fields).
    const since: TicketUpdate = { blocked_since: 'now' }
    expect([block, reason, since]).toHaveLength(3)
  })
})

describe('the schema parser can still see the whole truth', () => {
  /**
   * The tests below read `create table` blocks only. If a later migration is
   * APPENDED to the file as `alter table tickets add constraint ... check (...)`,
   * those blocks still hold the ORIGINAL values — so every test below would stay
   * green while the database had five statuses. That is a false green on the exact
   * drift this file exists to catch. Trip loudly instead.
   */
  it('contains no ALTER TABLE that the constraint parser cannot see', () => {
    const alters = SCHEMA.match(/^\s*alter table (?!\w+\s+enable row level security)/gim) ?? []
    expect(
      alters,
      'The schema now contains an ALTER TABLE. The parser in this file reads only ' +
        '`create table` blocks, so it can no longer see the real constraint values, ' +
        'and the assertions below would pass vacuously. Teach checkConstraintValues() ' +
        'to apply ALTERs before trusting them again.',
    ).toEqual([])
  })

  /**
   * THE SCHEMA DOC'S GRANT BLOCK MUST STATE WHAT THE MIGRATION APPLIES (SPRIN-93).
   *
   * Nothing else in this repo reads a `grant` or `revoke` line out of the schema doc. The live
   * database is built from `docs/migrations/*.sql` and **the doc is never applied**, so no live
   * assertion can observe doc drift at any point in the lifecycle — a reviewer deleted
   * `grant delete on project_fields to authenticated;` from the doc outright and the entire
   * gate stayed green.
   *
   * That is not hypothetical: this table family has drifted THREE times. SPRIN-91's INSERT
   * grant never reached the doc (found by SPRIN-93, which is why this test exists); session 62
   * found two grant blocks missing entirely on `ticket_field_values` and `project_field_options`.
   * A rebuild from the drifted doc produced a `project_fields` that `authenticated` could not
   * insert into at all — every "add a custom field" a 42501.
   *
   * SPRIN-93 then wrote "the two cannot drift again independently" into the doc and its own
   * design spec. **That sentence was enforced by nothing**, which is this project's recorded
   * footgun — a prose-only invariant — committed while fixing the third instance of the very
   * drift it claimed to prevent. This test is what makes the sentence true.
   *
   * The `toBeGreaterThan(0)` is the guard on the guard, the same shape the RLS test below uses:
   * if the statement matcher ever stops matching, both sides collapse to `[]` and the equality
   * passes while comparing nothing at all.
   */
  it('states the same project_fields grants as the migration that applied them', () => {
    const migration = readFileSync(
      join(MIGRATIONS_DIR, 'sprin-93-project-fields-delete.sql'),
      'utf8',
    )
    const fromMigration = grantStatements(migration, 'project_fields')
    const fromDoc = grantStatements(SCHEMA, 'project_fields')

    expect(
      fromMigration.length,
      'The grant-statement matcher found nothing in the migration. It has stopped matching, ' +
        'so the equality below would compare two empty lists and pass vacuously.',
    ).toBeGreaterThan(0)

    expect(
      fromDoc,
      'docs/sprintboard_phase1_schema.sql no longer states the same project_fields grants as ' +
        'docs/migrations/sprin-93-project-fields-delete.sql. A rebuild from the doc would ' +
        'produce a DIFFERENT database from the one the migrations built.',
    ).toEqual(fromMigration)
  })

  /**
   * THE SAME DRIFT, ON `projects` — the fourth sighting, and the first where the doc's
   * statements come from TWO migrations that must be read together.
   *
   * `projects` is the security-sensitive one. SPRIN-82 revoked UPDATE table-wide so
   * `project_type` could not be rewritten; SPRIN-97 granted UPDATE back on exactly the two
   * cadence columns. The doc has to state both, and a rebuild from a doc missing the revoke
   * would produce a database where any authenticated user can rewrite `name`, `key` and
   * `project_type` on their own project — the immutability CLAUDE.md calls non-negotiable,
   * silently gone, with every live test still green because the live database is built from
   * the migrations rather than from the doc.
   *
   * ORDER IS ASSERTED SEPARATELY, AND IT IS NOT PEDANTRY. `grantStatements` SORTS, so it
   * compares the two files as SETS and is blind to sequence — and on this pair sequence is
   * the whole meaning. A table-level `revoke update` CASCADES to column privileges, so
   * `grant (cadence…)` followed by `revoke update` leaves the table with NO update privilege
   * at all, while `revoke` followed by `grant` leaves the two columns writable. Those two
   * documents differ by nothing a sorted comparison can see — and sorted order happens to put
   * `grant` first, i.e. the broken sequence is the one the set comparison would bless. The
   * `project_fields` test above can ignore this because its statements are order-independent;
   * this one cannot.
   */
  it('states the same projects grants as the migrations that applied them', () => {
    // EVERY migration, discovered by reading the directory — NOT a hardcoded file list.
    // A hardcoded list inverts this control against the drift that actually happens: the
    // migration is the applied artefact and the doc is the transcript, so the realistic
    // failure is migration-leads-doc-lags. With a fixed list, a THIRD migration that widens
    // (or revokes) a projects grant is invisible and the test stays green while the doc is
    // wrong — and worse, the author who correctly DOES update the doc is punished with a red
    // that reads as "remove the line you just added". Globbing makes a new migration join the
    // comparison automatically, so the incentive points the right way.
    const fromMigrations = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort()
      .flatMap((file) =>
        grantStatements(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'), 'projects'),
      )
      .sort()
    const fromDoc = grantStatements(SCHEMA, 'projects')

    expect(
      fromMigrations.length,
      'No grant/revoke on projects was found in ANY file under docs/migrations. The matcher ' +
        'has stopped matching, so the equality below would compare two empty lists and pass ' +
        'vacuously.',
    ).toBeGreaterThanOrEqual(2)

    expect(
      fromDoc,
      'docs/sprintboard_phase1_schema.sql no longer states the same projects grants as the ' +
        'migrations under docs/migrations that applied them. A rebuild from the doc would ' +
        'produce a DIFFERENT database — and on this table that means project_type ' +
        'immutability, which nothing else in the gate would notice.',
    ).toEqual(fromMigrations)

    /**
     * THE APPLIED GRANT'S COLUMN LIST IS PINNED TO `SPRINT_CADENCE_COLUMNS`, and without this
     * the two halves of "which columns are writable" are joined by prose alone.
     *
     * Three independent review lenses found the same hole: widen the SQL to
     * `grant update (sprint_length_weeks, sprint_start_weekday, name) …` and the ENTIRE gate
     * stays green. The AST guard only polices what `src/` writes, not what the database
     * permits; the live suites only assert the two cadence columns ARE writable, never that
     * nothing else is; `docs/` is prettier-ignored and ESLint has no `.sql` glob. So the
     * privilege could widen in the applied artefact with nothing anywhere going red — the
     * precise shape of "a comment is not a control".
     */
    const grantMatch = /grant update \(([^)]*)\) on projects to authenticated/.exec(
      fromMigrations.join(';'),
    )
    expect(
      grantMatch,
      'No `grant update (<columns>) on projects to authenticated` statement was found in the ' +
        'migrations. Either it was removed — in which case the cadence form 42501s on every ' +
        'save — or it was reworded and this assertion is now reading nothing.',
    ).not.toBeNull()

    const grantedColumns = (grantMatch?.[1] ?? '')
      .split(',')
      .map((column) => column.trim())
      .sort()
    expect(
      grantedColumns,
      'The columns granted UPDATE on projects by the migrations no longer match ' +
        'SPRINT_CADENCE_COLUMNS in src/lib/domain.ts. These two must move together: the ' +
        'constant is what the AST guard allows the app to write, and the grant is what the ' +
        'database permits anyone to write. Widening only the grant opens a privilege the app ' +
        'never uses and no other test can see; widening only the constant ships a write that ' +
        'silently 42501s.',
    ).toEqual([...SPRINT_CADENCE_COLUMNS].sort())

    // Sequence, which the sorted comparison above cannot see. See the docblock: a table-level
    // revoke cascades to column privileges, so the revoke MUST precede the column grant.
    const docText = SCHEMA.replace(/--.*$/gm, '')
    const revokedAt = docText.search(/revoke\s+update\s+on\s+projects\b/i)
    const grantedAt = docText.search(/grant\s+update\s*\([^)]*\)\s*on\s+projects\b/i)

    expect(
      revokedAt,
      'The doc no longer contains a table-level UPDATE revoke on projects.',
    ).toBeGreaterThan(-1)
    expect(
      grantedAt,
      'The doc no longer contains a column-level UPDATE grant on projects.',
    ).toBeGreaterThan(-1)
    expect(
      revokedAt,
      'In docs/sprintboard_phase1_schema.sql the column-level UPDATE grant on projects now ' +
        'comes BEFORE the table-level revoke. A table-level revoke cascades to column ' +
        'privileges, so applied in that order it would wipe the cadence grant and leave ' +
        'projects with no update privilege at all — the cadence form would 42501 on every ' +
        'save. The revoke must come first.',
    ).toBeLessThan(grantedAt)
  })

  /**
   * CLAUDE.md: "Every table has RLS. Do not add a table without a policy." That was
   * prose until SPRIN-79 added the first new table since S1.1, and prose is not a
   * control — a table created without a policy is not merely unguarded, it is
   * world-writable, because ALTER DEFAULT PRIVILEGES in `public` grants anon and
   * authenticated full DML on every new table (measured against the live database,
   * not assumed).
   *
   * The length assertion is the guard on the guard: if the `create table` regex ever
   * stops matching, this test would otherwise iterate an empty list and pass while
   * checking nothing at all.
   */
  it('every table in the schema has RLS enabled and at least one policy', () => {
    // Tolerant of the spellings a migration is likely to be mirrored in. The
    // hand-pasted migration under docs/migrations/ writes `create table
    // public.project_statuses (`, so carrying that prefix across is the single most
    // likely way a new table arrives here — and a table this regex cannot see is a
    // table this test silently stops guarding.
    const tables = [
      ...SCHEMA.matchAll(/^create table (?:if not exists )?(?:public\.)?(\w+)\s*\(/gim),
    ].flatMap((m) => (m[1] === undefined ? [] : [m[1]]))

    // The real guard on the guard, and it must be an EQUALITY, not a floor. A floor
    // only catches the regex breaking for tables that already exist; it cannot catch
    // a NEW table spelled in a way the regex misses, which is the entire case this
    // test was written for. Counting `create table` loosely and demanding the strict
    // pattern match all of them turns any unrecognised spelling into a failure.
    const declared = (SCHEMA.match(/^create table /gim) ?? []).length
    expect(
      tables.length,
      `Found ${declared} "create table" statements but could only parse ${tables.length} ` +
        'table names out of them. A table is declared in a spelling this test cannot ' +
        'read, so it is NOT being checked for RLS — widen the regex, do not delete this.',
    ).toBe(declared)
    expect(declared).toBeGreaterThanOrEqual(6)

    for (const table of tables) {
      expect(
        new RegExp(`alter table ${table}\\s+enable row level security`).test(SCHEMA),
        `Table "${table}" has no "enable row level security".`,
      ).toBe(true)
      expect(
        new RegExp(`create policy \\w+ on ${table}\\b`).test(SCHEMA),
        `Table "${table}" has RLS but no policy, which denies everyone rather than ` +
          'guarding anything — or it was added without one at all.',
      ).toBe(true)
    }
  })
})

describe('domain vocabulary matches the database check constraints', () => {
  it('the seeded project statuses match DEFAULT_PROJECT_STATUSES exactly', () => {
    expect(seededProjectStatuses()).toEqual(
      DEFAULT_PROJECT_STATUSES.map((s) => ({
        slug: s.slug,
        name: s.name,
        category: s.category,
        position: s.position,
        is_initial: s.is_initial,
      })),
    )
  })

  // Repinned by SPRIN-80. This used to assert `tickets.status` carried the bare literal
  // default `'todo'`, matching the one seeded initial status. SPRIN-80 removed that default
  // deliberately — `alter table tickets alter column status drop default`, applied live — and
  // the schema doc's comment on the column now says why: the bare literal was only ever safe
  // while the 'todo' row could not be deleted, and the same migration that dropped the default
  // also opened DELETE on `project_statuses`. Deleting this test instead of repinning it would
  // leave "how does a new ticket get its initial status" unguarded by anything but the live
  // integration suite, which does not run here.
  it('exactly one seeded status is the initial one, and tickets.status resolves it via a trigger — NOT a column default', () => {
    const initial = seededProjectStatuses().filter((s) => s.is_initial)
    expect(initial).toHaveLength(1)
    expect(initial[0]?.slug).toBe('todo')

    // The bare literal is GONE. Asserted both ways: `status` is `not null` with nothing
    // after the comma, AND no `default` clause appears immediately after it — a regex that
    // only checked the first half would still pass if a default had crept back in on a
    // later line via some other mechanism this pattern cannot see.
    expect(tableBody('tickets')).toMatch(/status\s+text not null,/)
    expect(tableBody('tickets')).not.toMatch(/status\s+text not null default/)

    // What supplies the value instead — a BEFORE INSERT trigger that fills a NULL status
    // from the project's `is_initial` row. Without this half, the two assertions above only
    // prove the default was removed, not that anything safe replaced it.
    expect(SCHEMA).toMatch(/create or replace function resolve_initial_ticket_status\(\)/)
    expect(SCHEMA).toMatch(
      /create trigger resolve_initial_ticket_status\s+before insert on tickets/,
    )
  })

  it('status categories match the schema', () => {
    expect(checkConstraintValues('project_statuses', 'category')).toEqual([...STATUS_CATEGORIES])
  })

  /**
   * The function is parsed above; without this, nothing checks that anything FIRES it.
   *
   * Deleting the trigger block leaves a schema whose own comment claims "a project
   * with no statuses is not a reachable state" while a fresh apply produces exactly
   * that — and the first ticket insert then fails 23503, because `tickets.status`
   * defaults to the bare literal 'todo' and that row would no longer exist. Other
   * triggers in this file have the same gap; this one is newly load-bearing.
   */
  it('the seeding trigger is wired to projects, not merely defined', () => {
    expect(SCHEMA).toMatch(
      /create trigger on_project_created_statuses\s+after insert on projects\s+for each row execute function seed_project_statuses\(\)/i,
    )
  })

  it('ticket types match the schema', () => {
    expect(checkConstraintValues('tickets', 'type')).toEqual([...TICKET_TYPES])
  })

  it('sprint statuses match the schema', () => {
    expect(checkConstraintValues('sprints', 'status')).toEqual([...SPRINT_STATUSES])
  })

  /**
   * Was "project_type is scrum only — kanban is Rung 3", asserting a hard-coded
   * `['scrum']`. SPRIN-81 is that Rung 3 story, so the claim is now false — and a
   * hard-coded literal here would have gone red the moment the schema doc was widened,
   * inside a file no later task of this story owns. Derived from `PROJECT_TYPES`
   * instead, exactly like the ticket-type and sprint-status assertions either side of
   * it, so the schema doc and the union are pinned to each other rather than to a
   * third copy of the list. ORDER MATTERS — `toEqual` on arrays is ordered, so the
   * check constraint must spell the values in `PROJECT_TYPES` order.
   *
   * WHAT KEEPS THIS FROM BEING CIRCULAR is not in this test. Both sides are derived, so
   * on its own it would pass just as happily if `PROJECT_TYPES` and the schema doc drifted
   * to the same wrong pair. The anchor is one hard-coded assertion further down — "lists
   * both project types", `expect([...PROJECT_TYPES]).toEqual(['scrum', 'kanban'])`. Delete
   * that and this assertion pins the two lists to each other and to nothing else.
   */
  it('project types match the schema', () => {
    expect(checkConstraintValues('projects', 'project_type')).toEqual([...PROJECT_TYPES])
  })

  /**
   * SPRIN-90. Same shape and same caveat as the assertion above: both sides are derived,
   * so the anchor that stops it being circular is the hard-coded list in "lists every
   * custom field type" below. Delete that and this pins the two to each other and to
   * nothing else.
   *
   * ORDER MATTERS — `toEqual` on arrays is ordered, so the check constraint must spell the
   * values in `CUSTOM_FIELD_TYPES` order.
   *
   * What this does NOT cover, and it is the same gap the file's own header records: the
   * schema doc is not the database. This migration was applied by hand, so a sixth value
   * could reach the live database without touching this file. Only the live integration
   * test can see that, which is why `rls.integration.test.ts` asserts the constraint by
   * NAME on a real rejection rather than trusting this.
   */
  it('custom field types match the schema', () => {
    expect(checkConstraintValues('project_fields', 'type')).toEqual([...CUSTOM_FIELD_TYPES])
  })
})

/**
 * The same pair every other vocabulary in this file gets — one hard-coded (the anchor that
 * keeps the schema assertion above from being circular) and one derived.
 */
describe('custom field types and their labels', () => {
  it('lists every custom field type', () => {
    expect([...CUSTOM_FIELD_TYPES]).toEqual(['text', 'paragraph', 'number', 'date', 'select'])
  })

  it('has a non-empty label for every custom field type', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      expect(CUSTOM_FIELD_TYPE_LABELS[type]).toBeTruthy()
    }
  })

  /**
   * `paragraph` reads as "Text (multi-line)" rather than "Paragraph" deliberately: paired
   * with "Text" it explains itself, where "Text" vs "Paragraph" asks the user to guess what
   * distinguishes them. Pinned so the wording is a decision rather than an accident.
   */
  it('labels the two text types as a pair', () => {
    expect(CUSTOM_FIELD_TYPE_LABELS.text).toBe('Text')
    expect(CUSTOM_FIELD_TYPE_LABELS.paragraph).toBe('Text (multi-line)')
  })

  it('accepts every declared type and rejects one outside the union', () => {
    for (const type of CUSTOM_FIELD_TYPES) {
      expect(isCustomFieldType(type)).toBe(true)
    }
    expect(isCustomFieldType('checkbox')).toBe(false)
  })
})

/**
 * The same pair every other vocabulary in this file gets. The derived test is the one
 * that matters: `Record<ProjectType, string>` already makes a MISSING key a compile
 * error, so a second hard-coded list here would only drift with the thing it guards.
 * Iterating `PROJECT_TYPES` means adding a third project type cannot ship a blank
 * `<option>` in the create-project dialog.
 */
describe('project types and their labels', () => {
  it('lists both project types', () => {
    expect([...PROJECT_TYPES]).toEqual(['scrum', 'kanban'])
  })

  it('has a non-empty label for every project type', () => {
    for (const type of PROJECT_TYPES) {
      expect(PROJECT_TYPE_LABELS[type]).toBeTruthy()
    }
  })

  it('labels both types in the expected words', () => {
    expect(PROJECT_TYPE_LABELS).toEqual({ scrum: 'Scrum', kanban: 'Kanban' })
  })
})

/**
 * `hasSprints` is the single expression of "does this project deliver work in sprints"
 * (SPRIN-82 AC5), so these two tests are the only place the mapping from a project type
 * to that answer is written down outside the function itself.
 *
 * They come as a pair for the same reason the label tests above do, and the pair is not
 * redundant. The DERIVED one iterates `PROJECT_TYPES`, so a third project type lands in
 * the verdict map automatically and the hard-coded expectation then no longer matches —
 * which is the whole point: `hasSprints` returns `false` for anything that is not
 * `'scrum'`, so a new type would silently inherit "no sprints" as a default nobody chose.
 * This test is what turns that silence into a red. The LITERAL one states today's two
 * answers in words, and is the anchor that stops the derived test pinning the function to
 * a list derived from the same file and to nothing else.
 *
 * Neither is a substitute for the behaviour tests: these say what the predicate returns,
 * not that any component consults it.
 */
describe('hasSprints', () => {
  it('is true for scrum and false for kanban', () => {
    expect(hasSprints({ project_type: 'scrum' })).toBe(true)
    expect(hasSprints({ project_type: 'kanban' })).toBe(false)
  })

  it('has a verdict for every project type', () => {
    const verdicts = Object.fromEntries(
      PROJECT_TYPES.map((type) => [type, hasSprints({ project_type: type })]),
    )

    expect(
      verdicts,
      'A project type has been added to PROJECT_TYPES without deciding whether it has ' +
        'sprints. hasSprints() answers false for anything that is not scrum, so the new ' +
        'type has just inherited "no sprints" by default — state the answer here ' +
        'deliberately, and check hasSprints() still expresses the rule you want.',
    ).toEqual({ scrum: true, kanban: false })
  })

  /**
   * THE DIRECTION of the predicate, which the two tests above cannot see. Both pass
   * unchanged if `hasSprints` is rewritten as `project_type !== 'kanban'` — over today's
   * two-value union the two spellings are the same function — and so did all 849 tests in
   * the repo when a reviewer made exactly that change. They are not the same function on
   * any OTHER input, and the message on the derived test above already claims the
   * fail-closed half ("hasSprints() answers false for anything that is not scrum"), so
   * until this test existed that claim was prose rather than a control.
   *
   * `=== 'scrum'` fails CLOSED: an unrecognised type gets "no sprints", which is the
   * conservative answer — a Sprints tab that should be there is a visible bug someone
   * reports, where a sprint row written against a project that cannot show sprints is
   * invisible damage (see SprintsTab's redirect docblock). `!== 'kanban'` fails OPEN: the
   * same input gets the whole sprint surface, CreateSprintDialog included.
   *
   * THE CAST IS THE POINT, not a workaround for it. `ProjectType` is a client-side union
   * restoring narrowing the database cannot express — the column is `text` with a check
   * constraint, so `database.types.ts` types it as a bare `string` and every row arrives
   * from the network unvalidated. The check constrains what can be WRITTEN; nothing
   * constrains what an already-persisted row, a mid-migration row, or a row from a
   * database whose constraint has been widened ahead of the client hands to this function.
   * `undefined` is the same class of input from the other end: a partially-built fixture,
   * a `select()` that did not ask for the column, a row shape that drifted. The type
   * system stops neither, and this predicate has to answer both without opening the door.
   */
  it('answers false for an unrecognised or missing project type (fails CLOSED)', () => {
    expect(hasSprints({ project_type: 'waterfall' as ProjectType })).toBe(false)
    expect(hasSprints({ project_type: undefined as unknown as ProjectType })).toBe(false)
  })
})

describe('hasWipLimits', () => {
  /**
   * A SECOND predicate, not a negated `hasSprints`. "Has sprints" and "has WIP limits" are
   * two different questions that share an answer only while there are exactly two project
   * types; a third would separate them. Asserted independently here for that reason —
   * writing `expect(hasWipLimits(p)).toBe(!hasSprints(p))` would encode the coincidence
   * this design exists to avoid.
   */
  it('is true for a Kanban project', () => {
    expect(hasWipLimits({ project_type: 'kanban' })).toBe(true)
  })

  it('is false for a Scrum project', () => {
    expect(hasWipLimits({ project_type: 'scrum' })).toBe(false)
  })

  it('covers every project type', () => {
    // The exhaustiveness control: if a third type ships, this fails until someone decides
    // which side of the predicate it falls on, rather than silently defaulting to false.
    expect(PROJECT_TYPES.filter((t) => hasWipLimits({ project_type: t }))).toEqual(['kanban'])
  })
})

/**
 * The wording of the flat ticket-list tab lives in one place so the nav link and the tab's
 * own empty state cannot word the same thing two ways (SPRIN-83 AC4).
 *
 * Same pair as every vocabulary above: a hard-coded test that states today's words, and a
 * derived one that iterates `PROJECT_TYPES` so a third type cannot ship a blank label. The
 * derived test is also the control on the pair — a stub returning one object for every
 * project satisfies the two literal tests when each is read alone.
 */
describe('ticketListLabels', () => {
  it('calls it the backlog on a project with sprints', () => {
    expect(ticketListLabels({ project_type: 'scrum' })).toEqual({
      tab: 'Backlog',
      empty: 'Nothing in the backlog.',
    })
  })

  it('calls it all tickets on a project without sprints', () => {
    expect(ticketListLabels({ project_type: 'kanban' })).toEqual({
      tab: 'All tickets',
      empty: 'This project has no tickets.',
    })
  })

  // The control. A stub returning one object for every project passes both tests above only
  // if they are read in isolation; this one says the two types actually disagree, on BOTH
  // fields. Derived from PROJECT_TYPES so a third type cannot quietly share a neighbour's
  // wording.
  it('gives every project type a non-empty label, and the two types differ on both', () => {
    for (const type of PROJECT_TYPES) {
      const labels = ticketListLabels({ project_type: type })
      expect(labels.tab).toBeTruthy()
      expect(labels.empty).toBeTruthy()
    }
    const scrum = ticketListLabels({ project_type: 'scrum' })
    const kanban = ticketListLabels({ project_type: 'kanban' })
    expect(scrum.tab).not.toBe(kanban.tab)
    expect(scrum.empty).not.toBe(kanban.empty)
  })
})

describe('ticket type labels', () => {
  it('has a label for every ticket type', () => {
    for (const type of TICKET_TYPES) {
      expect(TICKET_TYPE_LABELS[type]).toBeTruthy()
    }
  })

  it('labels the four types in the expected words', () => {
    expect(TICKET_TYPE_LABELS).toEqual({ epic: 'Epic', story: 'Story', bug: 'Bug', task: 'Task' })
  })
})

/**
 * The same pair the ticket-type labels get, and for the same reason: `Record<StatusCategory,
 * string>` makes a MISSING key a compile error and says nothing whatever about the value. An
 * empty string, or `'ZZZ'`, type-checks — and these labels are the entire user-visible wording
 * of a category, on a status row's badge and in the add form's `<option>` list, so a blank one
 * ships a blank badge and a blank option with the gate green.
 */
describe('status category labels', () => {
  it('has a non-empty label for every status category', () => {
    for (const category of STATUS_CATEGORIES) {
      expect(STATUS_CATEGORY_LABELS[category]).toBeTruthy()
    }
  })

  // `in_progress` is the point of the map — a raw slug is not a thing to put in front of a user.
  it('labels the three categories in the expected words', () => {
    expect(STATUS_CATEGORY_LABELS).toEqual({
      todo: 'To do',
      in_progress: 'In progress',
      done: 'Done',
    })
  })
})

describe('type guards', () => {
  it('accepts every valid ticket type and rejects anything else', () => {
    for (const type of TICKET_TYPES) expect(isTicketType(type)).toBe(true)
    expect(isTicketType('subtask')).toBe(false)
  })

  it('accepts every valid sprint status and rejects anything else', () => {
    for (const status of SPRINT_STATUSES) expect(isSprintStatus(status)).toBe(true)
    expect(isSprintStatus('cancelled')).toBe(false)
  })

  it('accepts every valid project type and rejects anything else', () => {
    for (const type of PROJECT_TYPES) expect(isProjectType(type)).toBe(true)
    expect(isProjectType('waterfall')).toBe(false)
    expect(isProjectType('')).toBe(false)
  })

  it('accepts every valid status category and rejects anything else', () => {
    for (const category of STATUS_CATEGORIES) expect(isStatusCategory(category)).toBe(true)
    // 'in_review' is a status SLUG, never a category — it buckets into in_progress.
    expect(isStatusCategory('in_review')).toBe(false)
    expect(isStatusCategory('')).toBe(false)
  })
})

describe('cadenceSummary (SPRIN-94)', () => {
  it('names the length and the start weekday', () => {
    expect(cadenceSummary({ sprint_length_weeks: 2, sprint_start_weekday: 1 })).toBe(
      '2 weeks, starting Monday',
    )
  })

  it('uses the singular for a one-week cadence', () => {
    expect(cadenceSummary({ sprint_length_weeks: 1, sprint_start_weekday: 5 })).toBe(
      '1 week, starting Friday',
    )
  })

  // Every ISO weekday, so a transposed or off-by-one label table goes red. Monday must be
  // 1 and Sunday 7 — matching Postgres `isodow` — because SPRIN-96 will do date arithmetic
  // against these numbers and a shifted table would silently move every suggested sprint.
  it.each([
    [1, 'Monday'],
    [2, 'Tuesday'],
    [3, 'Wednesday'],
    [4, 'Thursday'],
    [5, 'Friday'],
    [6, 'Saturday'],
    [7, 'Sunday'],
  ])('maps ISO weekday %i to %s', (iso, label) => {
    expect(cadenceSummary({ sprint_length_weeks: 3, sprint_start_weekday: iso })).toBe(
      `3 weeks, starting ${label}`,
    )
  })

  // Unreachable through the database, which constrains the column to 1-7 — but reachable
  // through this function, so the branch is covered rather than vacuous. A fallback that
  // threw, or that silently rendered "undefined", would be worse than a plain number.
  it('falls back to the ISO number for a weekday outside 1-7', () => {
    expect(cadenceSummary({ sprint_length_weeks: 2, sprint_start_weekday: 9 })).toBe(
      '2 weeks, starting day 9',
    )
  })
})

describe('SPRINT_LENGTH_WEEKS (SPRIN-94)', () => {
  // Pinned against the database's own range check. If migration A's constraint and this
  // list ever disagree, the picker SPRIN-97 builds from it offers a value the database
  // refuses, or hides one it allows.
  it('is exactly the range projects_sprint_length_weeks_range permits', () => {
    expect([...SPRINT_LENGTH_WEEKS]).toEqual([1, 2, 3, 4])
  })
})
