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

/** Each pattern is a shape a privileged Supabase credential takes in a bundle. */
const FORBIDDEN = [
  { pattern: /sb_secret_[A-Za-z0-9_-]+/, what: 'a modern service-role key (sb_secret_…)' },
  { pattern: /"role"\s*:\s*"service_role"/, what: 'a decoded service_role JWT payload' },
  // A legacy service-role JWT is base64url, so the claim appears encoded. This is
  // the encoding of {"role":"service_role" — the fragment survives regardless of
  // surrounding claims, because base64 aligns every 3 bytes / 4 chars.
  { pattern: /cm9sZSI6InNlcnZpY2Vfcm9sZS/, what: 'a base64-encoded service_role JWT claim' },
  { pattern: /SUPABASE_SERVICE_ROLE_KEY/, what: 'a service-role key environment variable' },
]

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

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
  for (const { pattern, what } of FORBIDDEN) {
    if (pattern.test(contents)) violations.push({ file, what })
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
