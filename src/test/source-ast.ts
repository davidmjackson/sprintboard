import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

/**
 * TypeScript-AST plumbing for the source-tree guards in this directory —
 * `project-type-immutability.test.ts` today, and anything later that needs to assert a
 * property of the code rather than of its behaviour.
 *
 * It lives beside the guard rather than inside it because the guard's own file is where
 * the ARGUMENT lives: which shapes are forbidden, and why each red means what it says.
 * That argument is long, and burying it under 150 lines of parser mechanics is how it
 * stops being read. Nothing here decides anything — every function answers a question
 * ("what does this chain call?", "which identifier does it start from?") and returns
 * null when it cannot, so that the caller can treat null as a FAILURE. Do not add a
 * default, a fallback or a "probably fine" to any of them: an unreadable answer is the
 * signal the guards are built on.
 *
 * This file is itself scanned by that guard (it is under `src/` and is not a `.test.`
 * file), which is deliberate — a helper is not a blind spot.
 */

/** `src/`, resolved from this file rather than the CWD. */
export const SRC_ROOT = join(import.meta.dirname, '..')

/**
 * Every non-test source file under `dir`, recursively.
 *
 * The extension list is `{ts,tsx,js,jsx,mjs,cjs}` and not a bare `{ts,tsx}` for the reason
 * SPRIN-60 widened the lint glob: an exemption shaped like a file extension is still an
 * exemption, and "add the write in a `.js` file" is the cheapest bypass there is. `src/`
 * holds no JavaScript today, so this costs nothing and closes that door.
 *
 * Test files are excluded on purpose: the RLS suite deliberately attempts a cross-tenant
 * `projects.update` to prove the policy refuses it, and a guard file names the forbidden
 * shapes in order to forbid them. Scanning them would be a permanent red.
 */
export function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry)) return []
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
 * A parsed source file, with parent links — the chain walks go UP the tree, and the
 * position helpers need the file. `.ts` is parsed as TS and `.tsx` as TSX deliberately:
 * parsing a `.ts` file as TSX misreads `<T>(x: T) => x` as JSX and loses the rest of it.
 */
export function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  )
}

/** Every node in a file, in source order. Comments are trivia and never appear. */
export function nodesOf(source: ts.SourceFile): ts.Node[] {
  const found: ts.Node[] = []
  const visit = (node: ts.Node): void => {
    found.push(node)
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)
  return found
}

/**
 * The text of a plain string argument — `'x'`, `"x"` and `` `x` `` all count, which is the
 * hole a regex over two quote characters had. Anything computed (a variable, a call, a
 * concatenation, a template with a substitution) returns null, and null means "unknown".
 */
export function literalText(node: ts.Node | undefined): string | null {
  if (node === undefined) return null
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

/**
 * Strips the wrappers that change an expression's type but not the value it evaluates to,
 * so `(supabase as any).from(…)` and `supabase!.from(…)` read as the chains they are.
 * `await` is deliberately NOT stripped: awaiting a supabase builder yields a response
 * object, not the builder, and treating the two as one thing would make
 * `const { data } = await supabase.from('x').select()` look like a builder escaping.
 */
export function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression
    else if (ts.isAsExpression(current)) current = current.expression
    else if (ts.isSatisfiesExpression(current)) current = current.expression
    else if (ts.isNonNullExpression(current)) current = current.expression
    else if (ts.isTypeAssertionExpression(current)) current = current.expression
    else return current
  }
}

/**
 * What a call names: `x.foo(…)` is `foo` and a bare `foo(…)` is also `foo`, so a client
 * method reached by destructuring (`const { from } = supabase`) reads the same as one
 * reached through the client. Null for anything the name of which cannot be read —
 * `x[expr](…)`, `f()(…)`, `(cond ? a : b)(…)` — which is "unknown", never "fine".
 */
export function calleeName(call: ts.CallExpression): string | null {
  const callee = unwrapExpression(call.expression)
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  if (ts.isIdentifier(callee)) return callee.text
  return null
}

/** The expression a call is chained onto: `a.b(…).c(…)` gives `a.b(…)` from the `.c(` node. */
function receiverOf(call: ts.CallExpression): ts.Expression | null {
  const callee = unwrapExpression(call.expression)
  if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
    return unwrapExpression(callee.expression)
  }
  return null
}

/** A call and every call it is chained onto, outermost first. */
export function chainCalls(call: ts.CallExpression): ts.CallExpression[] {
  const links: ts.CallExpression[] = []
  let node: ts.Expression | null = call
  while (node !== null && ts.isCallExpression(node)) {
    links.push(node)
    node = receiverOf(node)
  }
  return links
}

/** The readable names in a call's chain, outermost first. Unreadable links are dropped. */
export function chainCallNames(call: ts.CallExpression): string[] {
  return chainCalls(call)
    .map(calleeName)
    .filter((name): name is string => name !== null)
}

/**
 * The identifier a whole expression starts from — `supabase` in `supabase.from('x').eq(…)`,
 * `from` in `from('x').update(…)`, `cache` in `cache.update(…)`. Null when the head of the
 * expression is not an identifier at all (`Reflect.get(a, b)('x')`, `f()()`), which is the
 * answer this file exists to make visible rather than to guess at.
 */
export function rootIdentifier(expr: ts.Expression): string | null {
  let node = unwrapExpression(expr)
  for (;;) {
    if (ts.isIdentifier(node)) return node.text
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      node = unwrapExpression(node.expression)
    } else if (ts.isCallExpression(node)) {
      const receiver = receiverOf(node)
      if (receiver === null) return calleeName(node)
      node = receiver
    } else return null
  }
}

/**
 * The table a chained call acts on, found by walking BACK down its own receiver chain to
 * the `from(…)` that started it. `supabase.from('tickets').update(p).eq('id', x)` resolves
 * to `tickets` from the `.update(` node. Null when the chain holds no `from(`, or when the
 * table name is not a plain string literal — both of which are "unknown", never "fine".
 */
export function tableOf(call: ts.CallExpression): string | null {
  for (const link of chainCalls(call)) {
    if (calleeName(link) === 'from') return literalText(link.arguments[0])
  }
  return null
}

/**
 * The methods chained onto a call, in order, or null if the chain cannot be followed at
 * all — `const q = supabase.from('projects')` binds the one builder that still exposes
 * `.update`, and everything done to `q` afterwards is invisible from here.
 */
export function chainedMethods(call: ts.CallExpression): string[] | null {
  const methods: string[] = []
  let node: ts.Node = call
  for (;;) {
    const access = node.parent
    if (!ts.isPropertyAccessExpression(access) || access.expression !== node) {
      return methods.length === 0 ? null : methods
    }
    const next = access.parent
    if (!ts.isCallExpression(next) || next.expression !== access) return null
    methods.push(access.name.text)
    node = next
  }
}

/**
 * A module specifier that resolves to the browser supabase client — `./supabase`,
 * `../lib/supabase`, `@/lib/supabase`. Matched on the specifier's last segment, so the
 * path a file happens to sit at does not matter.
 */
const CLIENT_MODULE = /(?:^|[/\\])supabase$/

/** The local names an import clause binds, whether default, namespace or named. */
function importedNames(clause: ts.ImportClause | undefined): string[] {
  if (clause === undefined) return []
  const direct = clause.name === undefined ? [] : [clause.name.text]
  const bindings = clause.namedBindings
  if (bindings === undefined) return direct
  if (ts.isNamespaceImport(bindings)) return [...direct, bindings.name.text]
  return [...direct, ...bindings.elements.map((element) => element.name.text)]
}

/**
 * The names this file binds the supabase client to. Renaming on import is covered
 * (`import { supabase as db }` yields `db`), because the guards ask what an expression
 * STARTS from rather than what it is spelled.
 *
 * A client obtained some other way — returned by a factory, re-exported under a new
 * module name — yields nothing here, which is why no guard may rest on this alone.
 */
export function clientImportNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()
  for (const node of nodesOf(source)) {
    if (!ts.isImportDeclaration(node)) continue
    if (!ts.isStringLiteral(node.moduleSpecifier)) continue
    if (!CLIENT_MODULE.test(node.moduleSpecifier.text)) continue
    for (const name of importedNames(node.importClause)) names.add(name)
  }
  return names
}

/** `src/<path>:<line>` for a node, for a message someone can act on without grepping. */
export function at(node: ts.Node): string {
  const file = node.getSourceFile()
  const { line } = file.getLineAndCharacterOfPosition(node.getStart(file))
  return `src/${relative(SRC_ROOT, file.fileName)}:${line + 1}`
}

/** `src/<path>:<line> — <the offending source, on one line>`. */
export function describeNode(node: ts.Node): string {
  const text = node.getText().replace(/\s+/g, ' ')
  return `${at(node)} — ${text.length > 90 ? `${text.slice(0, 89)}…` : text}`
}
