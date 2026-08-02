import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PROJECT_STATUSES,
  SPRINT_STATUSES,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_LABELS,
  TICKET_TYPES,
  TICKET_TYPE_LABELS,
  isSprintStatus,
  isStatusCategory,
  isTicketType,
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
  it("exactly one seeded status is the initial one, and tickets.status resolves it via a trigger — NOT a column default", () => {
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

  it('project_type is scrum only — kanban is Rung 3', () => {
    const projectTypes: ProjectType[] = ['scrum']
    expect(checkConstraintValues('projects', 'project_type')).toEqual(projectTypes)
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

  it('accepts every valid status category and rejects anything else', () => {
    for (const category of STATUS_CATEGORIES) expect(isStatusCategory(category)).toBe(true)
    // 'in_review' is a status SLUG, never a category — it buckets into in_progress.
    expect(isStatusCategory('in_review')).toBe(false)
    expect(isStatusCategory('')).toBe(false)
  })
})
