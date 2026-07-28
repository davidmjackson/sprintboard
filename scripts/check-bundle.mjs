#!/usr/bin/env node
/**
 * Fail the build if a privileged credential was inlined into the bundle.
 *
 * Vite substitutes `VITE_*` variables into the emitted JavaScript at build time.
 * The runtime guard in src/lib/env.ts therefore cannot prevent a service-role key
 * leaking — by the time it runs, the key is already in dist/ and served to every
 * visitor. This is the check that can actually stop it, which is why it runs as
 * part of `npm run build` rather than as an optional script.
 *
 * Greps the built output, not the source: what ships is the only thing that counts.
 */
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = 'dist'

/**
 * IMPORTANT 9: a `dist/` that exists but is empty — or nearly so — reports
 * "no privileged credentials found" having scanned nothing, the exact
 * "cannot tell clean from did-not-look" gap `check-duplication.mjs`'s floors
 * exist to close, on the more important control: this is what stops a
 * service-role key shipping to every visitor. A real `npm run build` of this
 * repo emits 10 files under `dist/`. `MIN_SCANNED_FILES` is a tripwire against
 * a broken build step or an emptied output directory, the same reasoning as
 * `LIMITS.minSources` in `scripts/check-duplication.mjs` — not a target to
 * track dist/ growth against.
 */
export const MIN_SCANNED_FILES = 10

/**
 * Fixed-shape patterns: things that are the same bytes wherever they appear,
 * so a regex is a legitimate check for them.
 */
const TEXT_PATTERNS = [
  { pattern: /sb_secret_[A-Za-z0-9_-]+/, what: 'a modern service-role key (sb_secret_…)' },
  { pattern: /"role"\s*:\s*"service_role"/, what: 'a decoded service_role JWT payload' },
  { pattern: /SUPABASE_SERVICE_ROLE_KEY/, what: 'a service-role key environment variable' },
  {
    pattern: /VITE_RLS_TEST_[A-Z_]+/,
    what: 'an RLS test-user credential (must never be VITE_-prefixed — Vite inlines it into the bundle)',
  },
]

/**
 * A legacy (JWT) service-role key is NOT a fixed byte pattern once encoded.
 * Base64 packs 3 bytes into 4 characters, so where the `"role":"service_role"`
 * substring falls inside that 3-byte grouping — its offset mod 3 — determines
 * which characters it encodes to. There are three possible alignments, and a
 * single fixed base64 fragment can only ever match one of them: a legacy key
 * with the role claim at a different offset (e.g. `role` listed first instead
 * of last) encodes completely differently and would slip past every pattern
 * above. Regexing the encoding is therefore not viable — the fix is to decode
 * it, the same way src/lib/env.ts's `readJwtRole` does.
 */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+/g

/** Defensive: a malformed or non-JSON payload must never throw. It simply isn't a match. */
function decodedJwtRole(payloadSegment) {
  try {
    const json = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'))
    if (json !== null && typeof json === 'object' && typeof json.role === 'string') {
      return json.role
    }
  } catch {
    // Not a decodable JWT payload — fall through and treat as no match.
  }
  return undefined
}

/**
 * Scans a bundle file's contents for privileged Supabase credentials.
 * Exported so it can be tested directly, without a real dist/ build.
 */
export function findPrivilegedCredentials(contents) {
  const violations = []

  for (const { pattern, what } of TEXT_PATTERNS) {
    if (pattern.test(contents)) violations.push({ what })
  }

  for (const match of contents.matchAll(JWT_PATTERN)) {
    const [, payloadSegment] = match[0].split('.')
    if (decodedJwtRole(payloadSegment) === 'service_role') {
      violations.push({ what: 'a legacy service-role JWT (decoded payload)' })
    }
  }

  return violations
}

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function main() {
  let files
  try {
    files = walk(DIST)
  } catch {
    console.error(`check-bundle: no ${DIST}/ directory. Run the build first.`)
    process.exit(1)
  }

  if (files.length < MIN_SCANNED_FILES) {
    console.error(
      `\n  BUILD REJECTED — only ${files.length} file(s) found under ${DIST}/, below the floor ` +
        `of ${MIN_SCANNED_FILES}.\n\n` +
        '    A near-empty or empty dist/ reports "no privileged credentials found" having\n' +
        '    scanned almost nothing — that is not a clean result, it is a build that did not\n' +
        '    look. Run the real build, or investigate why it emitted so little.\n',
    )
    process.exit(1)
  }

  const violations = []
  for (const file of files) {
    if (!/\.(js|mjs|cjs|css|html|map)$/.test(file)) continue
    const contents = readFileSync(file, 'utf8')
    for (const violation of findPrivilegedCredentials(contents)) {
      violations.push({ file, ...violation })
    }
  }

  if (violations.length > 0) {
    console.error('\n  BUILD REJECTED — a privileged credential is in the bundle.\n')
    for (const { file, what } of violations) {
      console.error(`    ${file}\n      contains ${what}`)
    }
    console.error(
      '\n  This bundle would hand every visitor a key that bypasses RLS.\n' +
        '  ROTATE THE KEY in the Supabase dashboard — it must be treated as compromised\n' +
        '  the moment it was written to disk — then remove it from the environment.\n' +
        '  Only VITE_SUPABASE_ANON_KEY (publishable) belongs in the browser.\n',
    )
    process.exit(1)
  }

  console.log(`check-bundle: ${files.length} files scanned, no privileged credentials found.`)
}

/**
 * Resolves a path through the filesystem's real, symlink-free form when the
 * path exists on disk; returns it unchanged otherwise. Never throws — a
 * fabricated path used only in a unit test, or a real `argv[1]` that no
 * longer exists on disk by the time this runs, both fall back to plain string
 * comparison rather than crashing the entry-point check.
 */
function realOrSelf(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Path-safe entry-point check, guarding so importing this module (e.g. from the
 * test file) does not also run the CLI walk over dist/. Compares resolved
 * filesystem paths, not a percent-encoded URL against a raw path — the naive
 * `import.meta.url === \`file://${process.argv[1]}\`` silently fails (and never
 * runs main()) on any checkout path containing a space, `#`, `?` or non-ASCII
 * character, because import.meta.url percent-encodes those and process.argv[1]
 * never does.
 *
 * `realOrSelf` on BOTH sides closes a second gap, measured directly on
 * `scripts/check-duplication.mjs`'s identical guard (see its comment): invoking
 * this script through a symlink — the exact shape `npm` uses for installed bin
 * scripts — made `main()` silently never run, because `import.meta.url` resolves
 * to the symlink's REAL target while `argv[1]` stays the symlink path. Resolving
 * both sides through `realpathSync` (when the path exists on disk; unchanged
 * otherwise) took this guard from 8-of-9 to 9-of-9 invocation shapes caught in
 * review. Exported so the fix can be pinned with plain strings, without needing
 * a real path on disk, and mirrors `isEntryPoint` in check-duplication.mjs.
 */
export function isEntryPoint(moduleUrl, argv1) {
  if (argv1 === undefined) return false
  return realOrSelf(fileURLToPath(moduleUrl)) === realOrSelf(resolve(argv1))
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main()
}
