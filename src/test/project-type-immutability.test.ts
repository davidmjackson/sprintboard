import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
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
 * WHY IT PARSES RATHER THAN GREPS. The first version of this guard matched
 * `/\bfrom\(\s*['"]projects['"]\s*\)/` and read the chain after it with a hand-rolled
 * scanner. Mutation testing shipped three real, type-valid, lint-clean `project_type`
 * writes straight past it: a backtick table name (JS has THREE quote characters and
 * the regex covered two), a table name held in a `const`, and an RPC — which contains
 * no `from(` at all, and is this repo's established pattern for exactly this sort of
 * write since SPRIN-77 added `reorder_project_statuses`. It also false-positived on a
 * doc comment that merely mentioned `from('projects')` in prose, and misreported it as
 * a builder assigned to a variable.
 *
 * All four failures are the same failure: a text scanner asks "does this look like a
 * write to projects?" and treats everything it cannot parse as innocent. It FAILS OPEN.
 * So this version parses the real TypeScript AST — comments are trivia and vanish for
 * free — and inverts the question. It asks, of every write in the tree, "which table
 * is this?", and an answer it cannot determine is a FAILURE, not a pass.
 *
 * THE THREE CHECKS, and what each one uniquely owns. They deliberately do not overlap:
 * every forbidden shape below is caught by exactly one of them, so removing any one of
 * them turns something red for its own reason rather than being masked by a neighbour.
 *
 *   1. RESOLVE — every `.update(`/`.upsert(` in non-test source must walk back through
 *      its own chain to a `from(<string literal>)`. A table name held in a variable, a
 *      call, or a concatenation is unresolvable, and unresolvable is red. So is a write
 *      whose chain contains no `from(` at all (`const q = …; q.update(…)`).
 *   2. FORBID — of the writes that DO resolve, none may resolve to `projects`. Writes to
 *      `tickets`, `sprints` and `project_statuses` are legitimate and stay green; there
 *      are seven of them today and the floors below prove the walk still sees them.
 *   3. ALLOWLIST — every `supabase.rpc(…)` must name an RPC on `ALLOWED_RPCS`. A new RPC
 *      reddens this until someone consciously adds it, which is the entire point: an RPC
 *      is a write path that no amount of table-chain analysis can see the inside of.
 *
 * Plus the guard-on-the-guard the original got right and this one keeps, generalised:
 * every `from('projects')` call must be FOLLOWABLE as a method chain. A builder assigned
 * to a variable, passed to a helper, or invoked through bracket notation
 * (`from('projects')['update'](…)`) is a shape this file cannot read, and it says so
 * rather than reporting a clean tree.
 *
 * WHEN A LEGITIMATE PROJECT UPDATE ARRIVES — renaming a project, say — check 2 goes red.
 * That red is the story asking the question, not an obstacle: narrow the guard so it
 * inspects the update's payload for `project_type`, or replace the app-layer claim with a
 * database one (a column grant, or a trigger that restores the old value). Deleting it
 * puts AC5 back to being prose.
 *
 * WHAT IT STILL CANNOT SEE: anything outside `src/` (`scripts/` and `e2e/` are tooling and
 * tests, and neither holds a supabase write path), the *body* of an allowlisted RPC, which
 * lives in the database rather than here, and the raw REST call the database would still
 * accept from a hostile client. It guards this repo's app code, which is the scope of AC5.
 */

// Resolved from this file, not the CWD: running vitest from a subdirectory would
// otherwise silently scan nothing and report a clean tree.
const SRC_ROOT = join(import.meta.dirname, '..')

/** The table whose rows AC5 forbids rewriting. */
const GUARDED_TABLE = 'projects'

/** The chained calls that write. `insert` is legitimate; these are the ones AC5 forbids. */
const WRITE_VERBS = new Set(['update', 'upsert'])

/**
 * RPCs this app is allowed to call. An RPC is an opaque write path — the guard can read
 * its name and nothing else — so the list is explicit and short on purpose. Adding to it
 * is a decision: satisfy yourself the function cannot write `projects.project_type`.
 *
 * `reorder_project_statuses` (SPRIN-77) writes `project_statuses.position` and is
 * `security invoker`, so it cannot reach past the caller's own RLS.
 */
const ALLOWED_RPCS = new Set(['reorder_project_statuses'])

/**
 * Every non-test source file under `src/`, recursively.
 *
 * The extension list is `{ts,tsx,js,jsx,mjs,cjs}` and not a bare `{ts,tsx}` for the reason
 * SPRIN-60 widened the lint glob: an exemption shaped like a file extension is still an
 * exemption, and "add the write in a `.js` file" is the cheapest bypass there is. `src/`
 * holds no JavaScript today, so this costs nothing and closes that door.
 */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry)) return []
    // Test files are excluded on purpose: the RLS suite deliberately attempts a
    // cross-tenant `projects.update` to prove the policy refuses it, and this file
    // itself names the forbidden verbs. Scanning them would be a permanent red.
    if (/\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry)) return []
    return [path]
  })
}

/** TypeScript's parser needs to be told which dialect a file is. */
function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX
  // JSX for every flavour of JavaScript: unlike `.ts`, plain JS has no `<T>` generic for
  // JSX parsing to misread, so it is the safe superset.
  if (/\.(?:[cm]?js|jsx)$/.test(file)) return ts.ScriptKind.JSX
  return ts.ScriptKind.TS
}

/**
 * A parsed source file, with parent links — `chainedMethods` walks UP the tree, and the
 * position helpers need the file. `.ts` is parsed as TS and `.tsx` as TSX deliberately:
 * parsing a `.ts` file as TSX misreads `<T>(x: T) => x` as JSX and loses the rest of it.
 */
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  )
}

/** Every call expression in a file, in source order. */
function callExpressions(source: ts.SourceFile): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) found.push(node)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

/**
 * The text of a plain string argument — `'x'`, `"x"` and `` `x` `` all count, which is the
 * hole the regex version had. Anything computed (a variable, a call, a concatenation, a
 * template with a substitution) returns null, and null means "unknown", which means red.
 */
function literalText(node: ts.Node | undefined): string | null {
  if (node === undefined) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

/** The method name of `x.name(…)`. Null for `x[expr](…)` and for a bare `f(…)`. */
function methodName(call: ts.CallExpression): string | null {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null
}

/** `src/<path>:<line>` for a node, for a message someone can act on without grepping. */
function at(node: ts.Node): string {
  const file = node.getSourceFile()
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
  return `src/${relative(SRC_ROOT, file.fileName)}:${line + 1}`
}

/** `src/<path>:<line> — <the offending source, on one line>`. */
function describeCall(call: ts.CallExpression): string {
  const text = call.getText().replace(/\s+/g, ' ')
  return `${at(call)} — ${text.length > 90 ? `${text.slice(0, 89)}…` : text}`
}

/**
 * The table a chained call acts on, found by walking BACK down its own receiver chain to
 * the `from(…)` that started it. `supabase.from('tickets').update(p).eq('id', x)` resolves
 * to `tickets` from the `.update(` node. Null when the chain holds no `from(`, or when the
 * table name is not a plain string literal — both of which are "unknown", never "fine".
 */
function tableOf(call: ts.CallExpression): string | null {
  let node: ts.Expression = call
  while (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    if (node.expression.name.text === 'from') return literalText(node.arguments[0])
    node = node.expression.expression
  }
  return null
}

/**
 * A chain that ends anywhere other than another `.method(` — assigned to a variable, passed
 * to a helper, or continued through bracket notation — is a shape this file cannot read.
 * `from('projects')['update']({ project_type: 'kanban' })` is valid TypeScript and has no
 * `.update` property access anywhere in it, so `tableOf` above will never be asked about it.
 * This is where that shape dies.
 */
function endOfChain(parent: ts.Node, methods: string[]): string[] | null {
  if (ts.isElementAccessExpression(parent)) return null
  return methods.length === 0 ? null : methods
}

/** The methods chained onto a `from(…)`, in order, or null if the chain cannot be followed. */
function chainedMethods(from: ts.CallExpression): string[] | null {
  const methods: string[] = []
  let node: ts.Node = from
  for (;;) {
    const access = node.parent
    if (!ts.isPropertyAccessExpression(access) || access.expression !== node) {
      return endOfChain(access, methods)
    }
    const call = access.parent
    if (!ts.isCallExpression(call) || call.expression !== access) return null
    methods.push(access.name.text)
    node = call
  }
}

const FILES = sourceFiles(SRC_ROOT)
const CALLS = FILES.map(parse).flatMap(callExpressions)

/** Every `.update(` / `.upsert(` in non-test source, whatever it turns out to act on. */
const WRITES = CALLS.filter((call) => WRITE_VERBS.has(methodName(call) ?? ''))
/** Every `.rpc(` in non-test source. */
const RPCS = CALLS.filter((call) => methodName(call) === 'rpc')
/** Every `from('projects')` — the only entry point a chain-following guard can start from. */
const PROJECT_FROMS = CALLS.filter(
  (call) => methodName(call) === 'from' && literalText(call.arguments[0]) === GUARDED_TABLE,
)

describe('nothing in src/ writes projects.project_type after insert (SPRIN-81 AC5)', () => {
  /**
   * The guard on the guard. A scanner that reports "no violations" having read nothing
   * looks identical to a clean tree — and this one resolves its own root and filters by
   * extension, so a moved file or a renamed directory could silently empty it. Floored
   * loosely (74 files today) so ordinary deletions cannot trip it.
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
   * The other half of the same problem, once per thing this file polices: the walk can be
   * healthy while the parse has rotted underneath it, and every assertion below reports a
   * clean tree by finding nothing. So each floor names a call site that provably exists.
   */
  it("still finds the known from('projects') call sites", () => {
    expect(
      PROJECT_FROMS.length,
      `Only ${PROJECT_FROMS.length} from('projects') call site(s) found in non-test source. ` +
        'There are two (createProject inserts, listProjects selects), so a number this low ' +
        'means the data layer stopped using the supabase client directly, or the AST walk no ' +
        'longer sees it — in both cases the chain-following assertion below is now vacuous.',
    ).toBeGreaterThanOrEqual(2)
  })

  it('still finds the legitimate writes it exists to classify', () => {
    expect(
      WRITES.length,
      `Only ${WRITES.length} update/upsert call(s) found in non-test source. There are ` +
        'seven legitimate ones (tickets, sprints, project_statuses), so a number this low ' +
        'means the AST walk stopped seeing writes — and a guard that sees no writes ' +
        'approves every write. Fix the walk, do not lower the floor.',
    ).toBeGreaterThanOrEqual(5)
  })

  it('still finds the known rpc call site', () => {
    expect(
      RPCS.map(at),
      'Found no supabase.rpc(…) call in non-test source. reorder_project_statuses ' +
        '(SPRIN-77) is called from src/lib/project-statuses.ts, so zero means the walk ' +
        'no longer sees rpc calls — and the allowlist below then approves every RPC.',
    ).not.toHaveLength(0)
  })

  /**
   * Check 1 — UNKNOWN IS A FAILURE. This is the inversion the regex version lacked, and
   * it is what makes the other checks trustworthy: a write whose table cannot be named
   * cannot be cleared either.
   */
  it('resolves every update and upsert to a named table', () => {
    const unresolved = WRITES.filter((call) => tableOf(call) === null).map(describeCall)

    expect(
      unresolved,
      'This update/upsert cannot be traced back to a from(<string literal>), so this guard ' +
        'cannot tell whether it writes the projects table. That is a FAILURE, not a pass — ' +
        'the whole point of SPRIN-81 AC5 is that no unreadable write path exists. Either ' +
        'write the table name as a plain literal in the same chain, or teach tableOf() the ' +
        'new shape. Do not delete the call site from the walk.',
    ).toEqual([])
  })

  /** Check 2 — the actual AC. */
  it('makes no update or upsert call against the projects table', () => {
    const offenders = WRITES.filter((call) => tableOf(call) === GUARDED_TABLE).map(describeCall)

    expect(
      offenders,
      "SPRIN-81 AC5: a project's type is fixed at creation, and RLS does NOT enforce it — " +
        'the projects_owner policy is FOR ALL, so the database would accept this write. ' +
        'The absence of an update path is the whole control. If this update is legitimate, ' +
        'narrow this guard to inspect its payload for project_type; do not delete it.',
    ).toEqual([])
  })

  /**
   * Check 3 — an RPC is a write path with its body in the database. The name is all this
   * file can see, so the name is what it pins.
   */
  it('calls only allowlisted rpcs', () => {
    const offenders = RPCS.filter(
      (call) => !ALLOWED_RPCS.has(literalText(call.arguments[0]) ?? ''),
    ).map(describeCall)

    expect(
      offenders,
      'This supabase.rpc(…) is not on ALLOWED_RPCS (or its name is not a plain string ' +
        'literal, which is the same thing: unknown). An RPC runs SQL this guard cannot ' +
        'read, so it is a write path to every table including projects — which is exactly ' +
        'how a project_type update would arrive without a from(…) anywhere near it. Add ' +
        'the name to ALLOWED_RPCS once you have satisfied yourself it cannot write ' +
        "projects.project_type, and say so in the constant's comment.",
    ).toEqual([])
  })

  /**
   * The guard on the guard, kept from the original and widened. If a `from('projects')`
   * escapes into a variable, an argument, or bracket notation, everything downstream of it
   * is invisible to check 2 — a false green on exactly the thing being guarded. Fail loudly
   * instead and teach the parser the new shape.
   */
  it("can follow every from('projects') call as a method chain", () => {
    const opaque = PROJECT_FROMS.filter((call) => chainedMethods(call) === null).map(describeCall)

    expect(
      opaque,
      "This from('projects') is not continued by a chained `.method(`, so this guard cannot " +
        'see what is done with it. Most likely the builder was assigned to a variable, passed ' +
        "to a helper, or called through bracket notation (`from('projects')['update']`). " +
        'Teach chainedMethods() that shape rather than accepting a blind spot.',
    ).toEqual([])
  })
})
