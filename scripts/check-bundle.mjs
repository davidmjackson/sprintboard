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
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'

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

// Guard so importing this module (e.g. from the test file) does not also run
// the CLI walk over dist/.
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
