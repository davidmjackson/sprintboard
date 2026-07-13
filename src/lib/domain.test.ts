import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  TICKET_STATUSES,
  TICKET_TYPES,
  isTicketStatus,
  isTicketType,
  type SprintStatus,
  type ProjectType,
} from './domain'

/**
 * domain.ts restates, in TypeScript, vocabulary the database enforces with check
 * constraints. Two sources of truth drift. These tests read the schema and
 * assert they still agree, so a migration that adds a status without updating
 * the client fails here rather than at runtime in front of a user.
 */

const SCHEMA = readFileSync('docs/sprintboard_phase1_schema.sql', 'utf8')

/** The DDL body of one `create table` block. Scoping matters: `status` exists on
 *  both sprints and tickets, so an unscoped search silently reads the wrong one. */
function tableBody(table: string): string {
  const match = new RegExp(`create table ${table} \\(([\\s\\S]*?)\\n\\);`).exec(SCHEMA)
  if (match?.[1] === undefined) {
    throw new Error(`No "create table ${table}" block found in the schema.`)
  }
  return match[1]
}

/** Pull the allowed values out of `check (<column> in ('a','b'))` on one table. */
function checkConstraintValues(table: string, column: string): string[] {
  const match = new RegExp(`check \\(${column} in \\(([^)]*)\\)\\)`).exec(tableBody(table))
  if (match?.[1] === undefined) {
    throw new Error(`No check constraint for "${column}" on table "${table}".`)
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('domain vocabulary matches the database check constraints', () => {
  it('ticket statuses are exactly the four fixed board columns, in board order', () => {
    expect(checkConstraintValues('tickets', 'status')).toEqual([...TICKET_STATUSES])
  })

  it('ticket types match the schema', () => {
    expect(checkConstraintValues('tickets', 'type')).toEqual([...TICKET_TYPES])
  })

  it('sprint statuses match the schema', () => {
    const sprintStatuses: SprintStatus[] = ['future', 'active', 'complete']
    expect(checkConstraintValues('sprints', 'status')).toEqual(sprintStatuses)
  })

  it('project_type is scrum only — kanban is Rung 3', () => {
    const projectTypes: ProjectType[] = ['scrum']
    expect(checkConstraintValues('projects', 'project_type')).toEqual(projectTypes)
  })
})

describe('type guards', () => {
  it('accepts every valid ticket status and rejects anything else', () => {
    for (const status of TICKET_STATUSES) expect(isTicketStatus(status)).toBe(true)
    expect(isTicketStatus('blocked')).toBe(false)
    expect(isTicketStatus('')).toBe(false)
  })

  it('does not treat blocked as a status — it is a flag on the ticket', () => {
    expect(TICKET_STATUSES).not.toContain('blocked')
  })

  it('accepts every valid ticket type and rejects anything else', () => {
    for (const type of TICKET_TYPES) expect(isTicketType(type)).toBe(true)
    expect(isTicketType('subtask')).toBe(false)
  })
})
