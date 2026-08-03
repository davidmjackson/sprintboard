import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * SPRIN-81 AC5 — "the project type cannot be changed after creation".
 *
 * There is no database control behind that sentence. `projects_owner` is a single
 * `FOR ALL` policy on `owner_id = auth.uid()`, so Postgres will happily accept an
 * owner's `PATCH /projects?id=eq.…` setting `project_type` to anything the check
 * constraint allows. Immutability here is a property of OUR CODE: no write path
 * exists. That is a claim about the source tree, so this is a test that reads the
 * source tree — the same idiom `src/lib/domain.test.ts` uses to pin the client
 * vocabulary against the schema doc, and `scripts/check-bundle.mjs` uses to pin a
 * credential out of `dist/`. A comment is not a control.
 *
 * WHAT IT ACTUALLY CHECKS, and why it is broader than AC5: no `.update(` or
 * `.upsert(` is chained onto `from('projects')` anywhere in non-test source. A
 * scanner cannot tell "an update that touches project_type" from "an update that
 * does not" without evaluating the payload, and an update path that exists is one
 * refactor away from carrying an extra key. Today there is no project update path
 * at all (an insert in `createProject` and a select in `listProjects`), so pinning
 * the absence is both cheap and exact.
 *
 * WHEN A LEGITIMATE PROJECT UPDATE ARRIVES — renaming a project, say — this test
 * goes red. That red is the story asking the question, not an obstacle: narrow the
 * guard so it inspects the update's payload for `project_type`, or replace the
 * app-layer claim with a database one (a column grant, or a trigger that restores
 * the old value). Deleting it puts AC5 back to being prose.
 *
 * WHAT IT CANNOT SEE: anything outside `src/`, a chain reached through a variable
 * (`const q = supabase.from('projects'); q.update(…)`) — pinned separately below —
 * and the raw REST call the database would still accept from a hostile client. It
 * guards this repo's code, which is exactly the scope of AC5.
 */

// Resolved from this file, not the CWD: running vitest from a subdirectory would
// otherwise silently scan nothing and report a clean tree.
const SRC_ROOT = join(import.meta.dirname, '..')

/** `.from('projects')`, tolerant of either quote style so a formatter change cannot blind it. */
const FROM_PROJECTS = /\bfrom\(\s*['"]projects['"]\s*\)/g

/** The chained calls that write. `insert` is legitimate; these are the ones AC5 forbids. */
const WRITE_VERBS = new Set(['update', 'upsert'])

/** Every non-test `.ts`/`.tsx` file under `src/`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (!/\.tsx?$/.test(entry)) return []
    // Test files are excluded on purpose: the RLS suite deliberately attempts a
    // cross-tenant `projects.update` to prove the policy refuses it, and this file
    // itself names the forbidden verbs. Scanning them would be a permanent red.
    if (/\.(test|spec)\.tsx?$/.test(entry)) return []
    return [path]
  })
}

/** Index just past the string literal whose opening quote is at `i`. */
function skipString(source: string, i: number): number {
  const quote = source[i]
  let j = i + 1
  while (j < source.length) {
    if (source[j] === '\\') j += 2
    else if (source[j] === quote) return j + 1
    else j += 1
  }
  return j
}

/** Index just past the balanced parenthesis group whose `(` is at `open`. */
function skipCall(source: string, open: number): number {
  let depth = 0
  let i = open
  while (i < source.length) {
    const ch = source[i]
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i)
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')' && --depth === 0) return i + 1
    i += 1
  }
  return i
}

/**
 * The method names chained onto whatever ends at `start`, in order.
 *
 * `.select().eq('id', x).single()` yields `['select', 'eq', 'single']`. Stops at the
 * first thing that is not a `.name(` continuation, so it never runs past the end of
 * the statement into an unrelated call — the failure mode a plain
 * `from\('projects'\)[\s\S]*?\.update\(` regex has, which would report the next
 * update anywhere in the file as this chain's.
 */
function chainedMethods(source: string, start: number): string[] {
  const methods: string[] = []
  let i = start
  for (;;) {
    const step = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(source.slice(i))
    if (step === null) return methods
    methods.push(step[1] as string)
    i = skipCall(source, i + step[0].length - 1)
  }
}

type ProjectsCall = { where: string; methods: string[] }

function projectsCalls(file: string): ProjectsCall[] {
  const source = readFileSync(file, 'utf8')
  const label = relative(SRC_ROOT, file)
  return [...source.matchAll(FROM_PROJECTS)].map((match) => ({
    where: `src/${label}:${source.slice(0, match.index).split('\n').length}`,
    methods: chainedMethods(source, match.index + match[0].length),
  }))
}

const FILES = sourceFiles(SRC_ROOT)
const CALLS = FILES.flatMap(projectsCalls)

describe('nothing in src/ writes projects.project_type after insert (SPRIN-81 AC5)', () => {
  /**
   * The guard on the guard. A scanner that reports "no violations" having read
   * nothing looks identical to a clean tree — and this one resolves its own root and
   * filters by extension, so a moved file or a renamed directory could silently empty
   * it. Floored loosely (74 files today) so ordinary deletions cannot trip it.
   */
  it('actually read the source tree', () => {
    expect(
      FILES.length,
      `Only ${FILES.length} non-test source file(s) found under ${SRC_ROOT}. This guard ` +
        'reports a clean tree by finding nothing, so a scan this small is a broken ' +
        'scan, not a clean result. Fix the walk rather than lowering the floor.',
    ).toBeGreaterThanOrEqual(40)
  })

  /**
   * The second half of the same problem: the walk can be healthy while the pattern
   * that finds the call sites has rotted (a rename of the table, a client wrapper
   * that hides `.from(`). Two call sites exist today — `createProject`'s insert and
   * `listProjects`' select — so zero means the pattern stopped matching.
   */
  it("still finds the known from('projects') call sites", () => {
    expect(
      CALLS.length,
      "Found no from('projects') call sites in non-test source. Either the data layer " +
        'stopped using the supabase client directly, or this pattern no longer matches ' +
        'it — in both cases the assertion below is now vacuous.',
    ).toBeGreaterThanOrEqual(2)
  })

  /**
   * Every call site must be a chain this parser can follow. If someone assigns the
   * builder to a variable first, `methods` comes back empty and the update on the
   * next line is invisible — a false green on exactly the thing being guarded. Fail
   * loudly instead and teach the parser the new shape.
   */
  it('can follow every call site as a method chain', () => {
    const opaque = CALLS.filter((call) => call.methods.length === 0).map((call) => call.where)
    expect(
      opaque,
      "A from('projects') call is not followed by a chained method, so this guard cannot " +
        'see what is done with it. Most likely the builder was assigned to a variable. ' +
        'Teach chainedMethods() that shape rather than accepting a blind spot.',
    ).toEqual([])
  })

  it('makes no update or upsert call against the projects table', () => {
    const offenders = CALLS.filter((call) =>
      call.methods.some((method) => WRITE_VERBS.has(method)),
    ).map((call) => `${call.where} — from('projects').${call.methods.join('().')}()`)

    expect(
      offenders,
      "SPRIN-81 AC5: a project's type is fixed at creation, and RLS does NOT enforce it — " +
        'the projects_owner policy is FOR ALL, so the database would accept this write. ' +
        'The absence of an update path is the whole control. If this update is legitimate, ' +
        'narrow this guard to inspect its payload for project_type; do not delete it.',
    ).toEqual([])
  })
})
