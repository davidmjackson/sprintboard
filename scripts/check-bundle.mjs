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
 * The only files this check can meaningfully read: text the bundler emits, into
 * which Vite substitutes `VITE_*` values. Everything else under `dist/` —
 * fonts, images, `public/` passthroughs — is opaque binary or copied verbatim.
 */
const SCANNABLE = /\.(js|mjs|cjs|css|html|map)$/

/**
 * IMPORTANT 9: a `dist/` that exists but is empty — or nearly so — reports
 * "no privileged credentials found" having scanned nothing, the exact
 * "cannot tell clean from did-not-look" gap that any scanning gate has to close.
 * A control that reports success while having measured nothing is worse than no
 * control, because the green tells you it looked. This is the control that stops
 * a service-role key shipping to every visitor, so it fails closed instead.
 *
 * BLOCKER: the floor counts the files actually READ, never everything `walk()`
 * returns, and the success line reports that same number. The first cut of this
 * floor got both wrong, and each half was demonstrated:
 *
 *   - It gated `files.length` at 10, and a real build emits exactly 10 — zero
 *     headroom. Seven of those ten are incidental: five per-unicode-range
 *     `.woff2` font subsets and two `public/` passthroughs. Deleting an unused
 *     `public/icons.svg`, ordinary cleanup, produced `BUILD REJECTED — only 9
 *     file(s) found under dist/` and reddened the required check on a
 *     legitimate diff, with a security-flavoured message pointing nowhere.
 *   - It floored a number the scan loop did not use. Of those 10 files only 3
 *     match `SCANNABLE`, so a `dist/` of 10 `.woff2` files each containing a
 *     literal `sb_secret_…` key printed `check-bundle: 10 files scanned, no
 *     privileged credentials found.` and exited 0, having read zero bytes —
 *     the very gap the floor was added to close.
 *
 * Counting reads fixes both at once: the number is stable (an HTML entry, a JS
 * chunk and a CSS chunk — 3 today), so routine asset changes cannot trip it,
 * and it cannot claim to have scanned a file it never opened. A floor of 2
 * leaves headroom for the only plausible honest shrink (the CSS chunk
 * disappearing) while still refusing the shapes that mean the build did not
 * look. It is a tripwire, not a target to track dist/ growth against: raising it
 * to follow the bundle's size defeats the point.
 */
export const MIN_SCANNED_FILES = 2

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

  const scannable = files.filter((file) => SCANNABLE.test(file))

  if (scannable.length < MIN_SCANNED_FILES) {
    console.error(
      `\n  BUILD REJECTED — only ${scannable.length} readable file(s) under ${DIST}/, below the ` +
        `floor of ${MIN_SCANNED_FILES}.\n\n` +
        '    Bundled js/css/html/map files are the only ones this check reads; fonts and\n' +
        '    other assets are counted by neither the floor nor the summary. A dist/ with\n' +
        '    fewer than the floor reports "no privileged credentials found" having read\n' +
        '    almost nothing — that is not a clean result, it is a build that did not look.\n' +
        '    Run the real build, or investigate why it emitted so little.\n',
    )
    process.exit(1)
  }

  const violations = []
  for (const file of scannable) {
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

  console.log(`check-bundle: ${scannable.length} files scanned, no privileged credentials found.`)
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
 * `realOrSelf` on BOTH sides closes a second gap, measured directly: invoking
 * this script through a symlink — the exact shape `npm` uses for installed bin
 * scripts — made `main()` silently never run, because `import.meta.url` resolves
 * to the symlink's REAL target while `argv[1]` stays the symlink path. Resolving
 * both sides through `realpathSync` (when the path exists on disk; unchanged
 * otherwise) took this guard from 8-of-9 to 9-of-9 invocation shapes caught in
 * review. Exported so the fix can be pinned with plain strings, without needing
 * a real path on disk.
 */
export function isEntryPoint(moduleUrl, argv1) {
  if (argv1 === undefined) return false
  return realOrSelf(fileURLToPath(moduleUrl)) === realOrSelf(resolve(argv1))
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  main()
}
