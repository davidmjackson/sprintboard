import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  SRC_ROOT,
  at,
  calleeName,
  chainCallNames,
  chainedMethods,
  clientImportNames,
  describeNode,
  literalText,
  nodesOf,
  parse,
  rootIdentifier,
  sourceFiles,
  tableOf,
  unwrapExpression,
} from './source-ast'

/**
 * SPRIN-81 AC5 — "the project type cannot be changed after creation".
 *
 * THERE ARE TWO LAYERS BEHIND THAT SENTENCE, and this file is the second of them.
 * When SPRIN-81 shipped there was only one, and this paragraph used to open "there is
 * no database control behind that sentence": `projects_owner` is a single `FOR ALL`
 * policy on `owner_id = auth.uid()`, so Postgres happily accepted an owner's
 * `PATCH /projects?id=eq.…` setting `project_type` to anything the check constraint
 * allowed, and immutability was purely a property of OUR CODE — no write path exists.
 * SPRIN-82 added the database half (`docs/migrations/sprin-82-projects-immutable.sql`):
 * `revoke update on projects from authenticated, anon`, with no columns granted back,
 * so that PATCH is now refused with 42501 before any policy is consulted. It landed in
 * that story rather than this one because SPRIN-82 is where behaviour first came to
 * depend on the column — `hasSprints(project)` decides whether the Sprints tab, the
 * `/sprints` route and the ticket sprint picker exist at all.
 *
 * BOTH LAYERS STAY, AND NEITHER MASKS THE OTHER — which is the question worth asking of
 * any two controls on one property, because the usual answer is that one is quietly
 * doing all the work. Here they fail on DISJOINT mutations. Restore the grant and the
 * live assertion in `src/test/projects.integration.test.ts` goes red while every check
 * below stays green. Add a `.update({ project_type })` to `src/` and check 5 below goes
 * red while that live assertion stays green — the app would simply be shipping a write
 * that earns a 42501 nobody handles. Neither is the other's backstop, so deleting either
 * loses coverage nothing else provides.
 *
 * WHY A SOURCE-TREE TEST AT ALL, now that the database refuses the write. Because "the
 * app never attempts it" and "the database would refuse it" are different claims, and
 * only the first is about this repo. A `project_type` write in `src/` is a real defect —
 * a user-visible failure the code does not handle — and it is a claim about the source
 * tree, so this is a test that reads the source tree: the same idiom
 * `src/lib/domain.test.ts` uses to pin the client vocabulary against the schema doc, and
 * `scripts/check-bundle.mjs` uses to pin a credential out of `dist/`. A comment is not a
 * control — and neither is a privilege that one line in the next migration can hand back.
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
 * WHY THE READABILITY CHECKS COME FIRST, and the hole that put them there. The second
 * version kept the inversion but applied it only to TABLE NAMES: every check began by
 * reading a `.name(` property access, and a call it could not name simply never entered
 * the sets those checks ran over. So this file — a live post-insert write —
 * was reported clean, eight assertions green:
 *
 *     supabase['from']('projects')['update']({ project_type: 'kanban' }).eq('id', id)
 *
 * Each bracket alone was caught: `supabase['from']('projects').update(…)` failed the
 * table walk, and `supabase.from('projects')['update'](…)` failed the chain walk. Only
 * the CONJUNCTION escaped, because both halves of the shape defeat the same shared
 * precondition — a readable name. `supabase['rpc'](…)` walked past the allowlist for
 * the same reason, and `supabase.rpc.bind(supabase)` never became a call at all.
 *
 * The docblock this replaces boasted that the checks "deliberately do not overlap".
 * That is what made it fragile: with zero overlap, one shared precondition is a single
 * point of failure. The fix is not more table analysis — it is to apply the same
 * inversion to the SHAPE of a call before asking what it does. Checks 1-3 below are
 * that: they refuse the unreadable outright, so checks 4-7 can trust that anything
 * still standing is something they can actually read.
 *
 * THE SEVEN CHECKS, and what each one uniquely owns. Each has its own red, and each
 * red says a different thing:
 *
 *   1. READABLE CALLEE — no call in non-test `src/` may be made through bracket notation
 *      or through anything else standing in for a method name (`(cond ? a : b)()`). This
 *      is the check the conjunction above defeats nothing of: it needs no name to fire,
 *      because "there is no name" IS the finding.
 *   2. READABLE MEMBER — `from`, `rpc`, `update` and `upsert` may only appear as calls.
 *      A bare reference (`supabase.rpc.bind(…)`, `const write = supabase.from`) hands
 *      the method to code this file cannot follow.
 *   3. THE CLIENT IS A RECEIVER — an imported supabase client may only be used as
 *      `client.something`. Passing it (`Reflect.get(supabase, 'from')`), aliasing it
 *      (`const db = supabase`) or destructuring it (`const { from } = supabase`) all
 *      move the client somewhere provenance cannot follow.
 *   4. RESOLVE — every `.update(`/`.upsert(` ON A SUPABASE CHAIN must walk back to a
 *      `from(<string literal>)`. A table name held in a variable, a call, or a
 *      concatenation is unresolvable, and unresolvable is red.
 *   5. FORBID — of the writes that DO resolve, none may resolve to `projects`. Writes to
 *      `tickets`, `sprints` and `project_statuses` are legitimate and stay green; there
 *      are seven of them today and the floors below prove the walk still sees them.
 *   6. ALLOWLIST — every `rpc(…)` must name an RPC on `ALLOWED_RPCS`. A new RPC reddens
 *      this until someone consciously adds it, which is the entire point: an RPC is a
 *      write path that no amount of table-chain analysis can see the inside of.
 *   7. FOLLOWABLE CHAIN — every `from(…)` on a client, and every `from('projects')`
 *      whoever it is called on, must be continued by a chained `.method(`.
 *      `const q = supabase.from('projects')` binds the one builder that still exposes
 *      `.update`, and everything done to `q` afterwards is invisible here.
 *
 * WHAT CHECK 4 IS ANCHORED TO, and why it is not "every `.update(` in the tree". It used
 * to be exactly that, which made an ordinary `cache.update(id, value)` — a Map wrapper,
 * no supabase anywhere near it — fail with a message telling its author to name a table.
 * `react-hook-form`'s `useFieldArray()` returns an `update(index, value)`, and this repo
 * is react-hook-form throughout, so that was a matter of time. A call now counts as a
 * supabase write when it starts from an imported client OR its chain contains a `from(`.
 * That second anchor is what keeps a client this file cannot trace — a factory return, a
 * renamed re-export, a `SupabaseClient` parameter — inside check 4 rather than outside it.
 *
 * WHEN A LEGITIMATE PROJECT UPDATE ARRIVES — renaming a project, say — TWO things stop it,
 * one per layer, and that is the design working rather than an obstacle. Check 5 below goes
 * red, AND the write fails live with 42501, because SPRIN-82 revoked the table UPDATE
 * outright and granted no columns back. That story has to do both: `grant update (name) on
 * projects to authenticated` in its migration, and narrow this guard so it inspects the
 * update's payload for `project_type` rather than forbidding every write to the table. The
 * grant without the narrowing leaves check 5 blocking the merge; the narrowing without the
 * grant ships a rename that silently 42501s. Deleting either layer instead puts AC5 back to
 * being prose — and note which one is now the cheaper to lose by accident: a stray `grant
 * update on projects` in an unrelated migration undoes the database half silently, and no
 * check in CI can read pg_catalog to notice. What would notice is the live 42501 assertion
 * in `src/test/projects.integration.test.ts`, which is why it exists.
 *
 * WHAT IT STILL CANNOT SEE, stated without flattery:
 *   - Anything outside `src/`. `scripts/` and `e2e/` are tooling and tests, and neither
 *     holds a supabase write path.
 *   - The *body* of an allowlisted RPC, which lives in the database rather than here.
 *   - A raw REST call. `fetch('…/rest/v1/projects?id=eq.…', { method: 'PATCH', … })` is a
 *     complete `project_type` write and is invisible to every check below — and that is
 *     true of one written in OUR OWN `src/`, not only of a hostile client poking the API
 *     directly. Nothing in `src/` calls `fetch` today; the day something does, this guard
 *     needs a check that reads its URL, and until then the honest statement is that the
 *     supabase client is the only write path it polices.
 *   - A builder that escapes AFTER at least one chained call: `const q =
 *     supabase.from('projects').select()` passes check 7 by design. Only the raw
 *     `from()` result exposes `.update`/`.upsert`; what `.select()` returns is a filter
 *     builder with no write verb on it, and `completeSprint` in `src/lib/sprints.ts`
 *     legitimately binds one to apply a conditional `.not(…)`. If supabase-js ever grows
 *     a write verb on the filter builder, check 7 has to widen to every escape.
 */

/** The table whose rows AC5 forbids rewriting. */
const GUARDED_TABLE = 'projects'

/** The chained calls that write. `insert` is legitimate; these are the ones AC5 forbids. */
const WRITE_VERBS = new Set(['update', 'upsert'])

/**
 * Members that may only ever be CALLED, never referenced. Deliberately checked by name
 * across all of `src/` rather than only on a receiver this file can prove is a supabase
 * client: proving that is exactly what a `.bind`, a factory or a re-export defeats, and
 * there are zero bare references to any of these four names in the tree today, so the
 * strict reading costs nothing. If a legitimate non-supabase `.update` reference ever
 * arrives (react-hook-form's `useFieldArray().update` passed as a prop is the plausible
 * one), narrow this to client-rooted receivers — do not delete the check.
 */
const CALL_ONLY_MEMBERS = new Set(['from', 'rpc', 'update', 'upsert'])

/**
 * RPCs this app is allowed to call. An RPC is an opaque write path — the guard can read
 * its name and nothing else — so the list is explicit and short on purpose. Adding to it
 * is a decision: satisfy yourself the function cannot write `projects.project_type`.
 *
 * `reorder_project_statuses` (SPRIN-77) writes `project_statuses.position` and is
 * `security invoker`, so it cannot reach past the caller's own RLS. NOTE THAT THIS FILE
 * CANNOT SEE THAT: `security invoker` is a property of the function in the database, and
 * flipping it to `definer` is a one-token change in a migration that would not touch a
 * line of TypeScript. What holds it is one live test — "a stranger's reorder call changes
 * nothing" in `src/test/rls.integration.test.ts`, which asserts the order is UNCHANGED
 * after user B calls it on user A's project. Any name added here needs the same kind of
 * evidence somewhere, and a note saying where.
 */
const ALLOWED_RPCS = new Set(['reorder_project_statuses'])

/**
 * The docblock above says SEVEN checks. These two numbers are that claim in a form a
 * test can hold to it — see the last `it` in this file. Change the prose and the
 * numbers together, or the suite says so.
 */
const DOCUMENTED_CHECKS = 7
const DOCUMENTED_FLOORS = 5

type Scan = { nodes: ts.Node[]; clients: Set<string> }

const FILES = sourceFiles(SRC_ROOT)
const SCANS: Scan[] = FILES.map(parse).map((source) => ({
  nodes: nodesOf(source),
  clients: clientImportNames(source),
}))

function callsIn(scan: Scan): ts.CallExpression[] {
  return scan.nodes.filter((node): node is ts.CallExpression => ts.isCallExpression(node))
}

/** Does this expression start from an identifier the file binds the supabase client to? */
function isClientRooted(expr: ts.Expression, clients: Set<string>): boolean {
  const root = rootIdentifier(expr)
  return root !== null && clients.has(root)
}

/**
 * A supabase write: a write verb on a chain that either starts at an imported client or
 * passes through a `from(`. Two anchors rather than one because either can be defeated
 * alone — a client this file cannot name still writes through `from(`, and a destructured
 * `from` still starts from a name it can.
 */
function isSupabaseWrite(call: ts.CallExpression, clients: Set<string>): boolean {
  if (!WRITE_VERBS.has(calleeName(call) ?? '')) return false
  return isClientRooted(call, clients) || chainCallNames(call).includes('from')
}

/** Is this member access the callee of its own call, rather than a value handed elsewhere? */
function isInvoked(access: ts.PropertyAccessExpression): boolean {
  const parent = access.parent
  return ts.isCallExpression(parent) && unwrapExpression(parent.expression) === access
}

/** The client may be `client.something`. Anything else moves it out of sight. */
function isClientReceiver(id: ts.Identifier): boolean {
  const parent = id.parent
  const access = ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)
  return access && parent.expression === id
}

/** The identifier in `import { supabase }` and `const supabase = …` is not a use of it. */
function isDeclarationName(id: ts.Identifier): boolean {
  const parent = id.parent
  if (ts.isVariableDeclaration(parent) || ts.isBindingElement(parent)) return parent.name === id
  return (
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent)
  )
}

/**
 * `import('ws')` is a call with no callee to name — but also no receiver, no chain and
 * no supabase client. It is the one nameless call shape that is not a hiding place.
 */
function isDynamicImport(call: ts.CallExpression): boolean {
  return call.expression.kind === ts.SyntaxKind.ImportKeyword
}

/**
 * A callee this file can name: `f(…)`, `x.f(…)`, or a function RETURNED by one of those
 * and invoked in place — `form.handleSubmit(onSubmit)(event)` is react-hook-form's
 * documented shape and appears in `src/routes/CreateDialog.tsx`. Allowing it is not a
 * hole in AC5: a returned function can only be a supabase method if the client was
 * handed somewhere as a value (check 3) or a write member was referenced rather than
 * called (check 2), and both of those are red on their own account.
 */
function isReadableCallee(call: ts.CallExpression): boolean {
  if (calleeName(call) !== null || isDynamicImport(call)) return true
  const callee = unwrapExpression(call.expression)
  return ts.isCallExpression(callee) && isReadableCallee(callee)
}

/** Every call whose callee cannot be named: `x[k](…)`, `(a ?? b)(…)`, `(() => f)()(…)`. */
const UNREADABLE_CALLS = SCANS.flatMap((scan) =>
  callsIn(scan).filter((call) => !isReadableCallee(call)),
)

/** Every `from`/`rpc`/`update`/`upsert` referenced without being called. */
const LOOSE_MEMBERS = SCANS.flatMap((scan) =>
  scan.nodes
    .filter((node): node is ts.PropertyAccessExpression => ts.isPropertyAccessExpression(node))
    .filter((access) => CALL_ONLY_MEMBERS.has(access.name.text) && !isInvoked(access)),
)

/** Every use of an imported client that is not `client.something`. */
const CLIENT_ESCAPES = SCANS.flatMap((scan) =>
  scan.nodes
    .filter((node): node is ts.Identifier => ts.isIdentifier(node))
    .filter((id) => scan.clients.has(id.text) && !isClientReceiver(id) && !isDeclarationName(id)),
)

/** Every write this guard considers a supabase write, whatever it turns out to act on. */
const WRITES = SCANS.flatMap((scan) =>
  callsIn(scan).filter((call) => isSupabaseWrite(call, scan.clients)),
)

/** Every `rpc(…)` in non-test source, reached through the client or through a bare name. */
const RPCS = SCANS.flatMap((scan) => callsIn(scan).filter((call) => calleeName(call) === 'rpc'))

/** Is this `from(…)` naming the one table AC5 is about? */
function isGuardedFrom(call: ts.CallExpression): boolean {
  return calleeName(call) === 'from' && literalText(call.arguments[0]) === GUARDED_TABLE
}

/**
 * The `from(…)` calls check 7 follows: those on an imported client, and — whatever they
 * start from — those naming `projects`. Two populations for the same reason check 4 has
 * two anchors. Requiring an imported client alone left a real hole, measured: re-export
 * the client under another module name and `const q = client.from('projects')` was
 * attributable to no client, so nothing followed it and `q.update({ project_type })`
 * resolved to no table. The table literal is provenance the second half cannot shed.
 */
const FROMS_TO_FOLLOW = SCANS.flatMap((scan) =>
  callsIn(scan).filter(
    (call) =>
      (calleeName(call) === 'from' && isClientRooted(call, scan.clients)) || isGuardedFrom(call),
  ),
)

/** `from('projects')` specifically, for the floor: it is the call site AC5 is about. */
const PROJECT_FROMS = SCANS.flatMap((scan) => callsIn(scan).filter(isGuardedFrom))

/** How many files bind the client at all — the population check 3 runs over. */
const CLIENT_FILES = SCANS.filter((scan) => scan.clients.size > 0).length

describe('nothing in src/ writes projects.project_type after insert (SPRIN-81 AC5)', () => {
  /**
   * The guard on the guard. A scanner that reports "no violations" having read nothing
   * looks identical to a clean tree — and this one resolves its own root and filters by
   * extension, so a moved file or a renamed directory could silently empty it. Floored
   * loosely (75 files today) so ordinary deletions cannot trip it.
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
      `Only ${WRITES.length} supabase update/upsert call(s) found in non-test source. There ` +
        'are seven legitimate ones (tickets, sprints, project_statuses), so a number this low ' +
        'means the AST walk stopped seeing writes, or the anchoring in isSupabaseWrite() ' +
        'stopped recognising them — and a guard that sees no writes approves every write. ' +
        'Fix the walk, do not lower the floor.',
    ).toBeGreaterThanOrEqual(5)
  })

  it('still finds the known rpc call site', () => {
    expect(
      RPCS.map(at),
      'Found no rpc(…) call in non-test source. reorder_project_statuses (SPRIN-77) is ' +
        'called from src/lib/project-statuses.ts, so zero means the walk no longer sees rpc ' +
        'calls — and the allowlist below then approves every RPC.',
    ).not.toHaveLength(0)
  })

  /**
   * Check 3, and the client-rooted half of check 7, only see files whose client this file
   * can name. If import detection broke — a moved module, a re-export everything routes
   * through — they would report a clean tree over an empty population.
   */
  it('still recognises the supabase client where it is imported', () => {
    expect(
      CLIENT_FILES,
      `Only ${CLIENT_FILES} file(s) under src/ were seen to import the supabase client. ` +
        'Eight do (four data-layer modules, the auth context, and three route ' +
        'components), so a number this low means clientImportNames() stopped matching ' +
        'the module specifier — and check 3 is then vacuous, as is half of check 7.',
    ).toBeGreaterThanOrEqual(6)
  })

  /**
   * Check 1 — SHAPE BEFORE MEANING. Every check that reads a method name is defeated by
   * a call that has none, so nothing may have none. This is the one that catches
   * `supabase['from']('projects')['update'](…)`, which passed all of its neighbours.
   */
  it('makes every call through a callee it can name', () => {
    const unreadable = UNREADABLE_CALLS.map(describeNode)

    expect(
      unreadable,
      'This call is made through something whose name this guard cannot read — bracket ' +
        "notation (`obj['method'](…)`), or an expression standing in for a method name. " +
        'Every other check here starts by reading a method name, so an ' +
        'unreadable callee is not one blind spot but all of them at once: ' +
        "`supabase['from']('projects')['update']({ project_type })` is a live write to the " +
        'column AC5 freezes, and it entered none of the sets below. Write the call as ' +
        '`obj.method(…)`. Do not teach this check to resolve the key.',
    ).toEqual([])
  })

  /**
   * Check 2 — a method that is referenced rather than called has left this file's sight
   * while still being perfectly callable somewhere else.
   */
  it('only ever calls from, rpc, update and upsert — never references them', () => {
    const loose = LOOSE_MEMBERS.map(describeNode)

    expect(
      loose,
      'This names a supabase write method without calling it, so the call happens ' +
        'somewhere this guard cannot follow: `const rpc = supabase.rpc.bind(supabase)` ' +
        "then `rpc('…', { … })` is an unrestricted RPC call that never meets the " +
        'allowlist. Call the method in place. If this is a legitimate non-supabase ' +
        'reference, narrow CALL_ONLY_MEMBERS to client-rooted receivers rather than ' +
        'deleting the check.',
    ).toEqual([])
  })

  /**
   * Check 3 — provenance. Checks 4 and 7 ask what an expression starts from, and every
   * answer they can give depends on the client still being where it was imported.
   */
  it('uses the supabase client only as a receiver', () => {
    const escapes = CLIENT_ESCAPES.map((id) => describeNode(id.parent))

    expect(
      escapes,
      'The supabase client is used here as a value rather than as `client.something`. ' +
        'Passing it (`Reflect.get(supabase, "from")`), aliasing it (`const db = supabase`) ' +
        'or destructuring it (`const { from } = supabase`) all move it somewhere this ' +
        'guard cannot trace, and a write through the moved copy resolves to no table and ' +
        'no client — a silent green on the one thing AC5 forbids.',
    ).toEqual([])
  })

  /**
   * Check 4 — UNKNOWN IS A FAILURE. This is the inversion the regex version lacked, and
   * it is what makes the other checks trustworthy: a write whose table cannot be named
   * cannot be cleared either.
   */
  it('resolves every supabase update and upsert to a named table', () => {
    const unresolved = WRITES.filter((call) => tableOf(call) === null).map(describeNode)

    expect(
      unresolved,
      'This update/upsert is on a supabase chain but cannot be traced back to a ' +
        'from(<string literal>), so this guard cannot tell whether it writes the projects ' +
        'table. That is a FAILURE, not a pass — the whole point of SPRIN-81 AC5 is that no ' +
        'unreadable write path exists. Write the table name as a plain literal in the same ' +
        'chain. Do not delete the call site from the walk.',
    ).toEqual([])
  })

  /** Check 5 — the actual AC. */
  it('makes no update or upsert call against the projects table', () => {
    const offenders = WRITES.filter((call) => tableOf(call) === GUARDED_TABLE).map(describeNode)

    expect(
      offenders,
      "SPRIN-81 AC5: a project's type is fixed at creation, and RLS does NOT enforce it — " +
        'the projects_owner policy is FOR ALL, so the database would accept this write. ' +
        'The absence of an update path is the whole control. If this update is legitimate, ' +
        'narrow this guard to inspect its payload for project_type; do not delete it.',
    ).toEqual([])
  })

  /**
   * Check 6 — an RPC is a write path with its body in the database. The name is all this
   * file can see, so the name is what it pins.
   */
  it('calls only allowlisted rpcs', () => {
    const offenders = RPCS.filter(
      (call) => !ALLOWED_RPCS.has(literalText(call.arguments[0]) ?? ''),
    ).map(describeNode)

    expect(
      offenders,
      'This rpc(…) is not on ALLOWED_RPCS (or its name is not a plain string literal, ' +
        'which is the same thing: unknown). An RPC runs SQL this guard cannot read, so it ' +
        'is a write path to every table including projects — which is exactly how a ' +
        'project_type update would arrive without a from(…) anywhere near it. Add the name ' +
        'to ALLOWED_RPCS once you have satisfied yourself it cannot write ' +
        "projects.project_type, and say so in the constant's comment.",
    ).toEqual([])
  })

  /**
   * Check 7 — a `from(…)` result is the one supabase builder that still exposes `.update`
   * and `.upsert`. If it escapes before a single method is chained onto it, everything
   * done with it afterwards is invisible to check 5 — a false green on exactly the thing
   * being guarded. Fail loudly instead and teach the parser the new shape.
   */
  it('can follow every from(…) it is asked to watch as a method chain', () => {
    const opaque = FROMS_TO_FOLLOW.filter((call) => chainedMethods(call) === null).map(describeNode)

    expect(
      opaque,
      'This from(…) is not continued by a chained `.method(`, so this guard cannot see ' +
        'what is done with it. Most likely the builder was assigned to a variable, ' +
        'destructured, or passed to a helper — and the value it binds is the one that still ' +
        'has .update() and .upsert() on it. Chain the call in place rather than accepting ' +
        'a blind spot.',
    ).toEqual([])
  })

  /**
   * The docblock is part of the control: it is where the argument for each red lives, and
   * a stale count is the first sign it has stopped being maintained alongside the code.
   * "THE THREE CHECKS" survived two of them being added.
   */
  it('has as many tests as its docblock claims', () => {
    const own = readFileSync(import.meta.filename, 'utf8')
    const declared = own.match(/^ {2}it\(/gm) ?? []

    expect(
      declared.length,
      `This file declares ${declared.length} test(s) but its docblock describes ` +
        `${DOCUMENTED_CHECKS} checks and ${DOCUMENTED_FLOORS} floors (plus this one). ` +
        'Update the prose and DOCUMENTED_CHECKS/DOCUMENTED_FLOORS together with the tests.',
    ).toBe(DOCUMENTED_CHECKS + DOCUMENTED_FLOORS + 1)
  })
})
