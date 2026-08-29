// The single lint configuration. `npm run lint` runs this, and `npm run verify`
// runs `npm run lint`, so these rules gate every merge.
//
// The T1-T5 thresholds trace to /var/www/CodingStandards/core/THRESHOLDS.md and are
// restated here rather than imported, because `@codequalitystandards/eslint-config`
// is not published to a registry. Keep the numbers in sync with the standard;
// nothing checks them for you, but verify-gate.test.mjs pins each one at its
// boundary, so widening a max here turns the suite red.
//
// History, because the round trip matters: adopted as a non-gating report in #42,
// folded into the gate in SPRIN-50, removed in SPRIN-55 as part of the pivot, and
// restored in SPRIN-59 on David's direction — "coding standards are the hallmark of
// quality... garbage in, garbage out". Restoring cost nothing: with these rules on,
// the tree at a812570 reported 122 files, 0 errors, 0 warnings.
//
// What did NOT come back, and must not be re-added without being asked: the
// duplication gate (`lint:duplication`, scripts/check-duplication.mjs, `jscpd`,
// ADRs 0003/0005) and any `lint:standards` script. The thresholds live inside
// `npm run lint`; that is the whole enforcement surface. See docs/adr/0006.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  // `.claude/**`: Claude Code puts subagent git worktrees under .claude/worktrees/ —
  // full repo copies, inside the repo. Without this, ESLint lints their .ts files with
  // this project's tsconfig and every one fails to resolve, so a worktree agent running
  // in the background turns `npm run lint` red with dozens of bogus parse errors.
  // vite.config.ts already excludes the same path from vitest, for the same reason.
  { ignores: ['dist', 'coverage', 'node_modules', '.claude/**'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    // `.mjs` and `.js` are in scope deliberately — SPRIN-60. This glob read
    // `'**/*.{ts,tsx}'`, which left every non-TypeScript file in the repo outside
    // T1-T5 *and* outside the presets above: scripts/check-bundle.mjs (the control
    // that stops a service-role key reaching the browser), scripts/check-bundle.test.mjs,
    // verify-gate.test.mjs (the guard on this very gate) and this file. `eslint .`
    // exited 0 across all four while CLAUDE.md described the thresholds as the whole
    // enforcement surface. Measured on a scratch branch before widening: one violation
    // repo-wide, check-bundle.mjs's 43-line `main()`, since split.
    files: ['**/*.{ts,tsx,mjs,js}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
      sonarjs,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // T1 Function length.
      'max-lines-per-function': ['error', { max: 30, skipBlankLines: true, skipComments: true }],
      // T2 Cyclomatic complexity. Raised 10 -> 15 on 2026-08-24: at 10, several
      // functions were split to satisfy the gate rather than for clarity, and said
      // so in their own docblocks. The boundary pin in verify-gate.test.mjs moves
      // with this number, or the suite goes red.
      complexity: ['error', { max: 15 }],
      // T3 Cognitive complexity.
      'sonarjs/cognitive-complexity': ['error', 15],
      // T4 Parameters.
      'max-params': ['error', 4],
      // T5 File length.
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      // Error handling: no empty blocks, no swallowed errors. Stated explicitly
      // rather than left to `js.configs.recommended`'s default, because a
      // swallowed error is the failure mode this codebase actually has — a
      // rejected Supabase call that renders nothing.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  // OVERRIDE 1 — docs/adr/0001-function-length-does-not-apply-to-components.md
  // T1 counts JSX as lines, so it fires on ordinary React components (18 of 19
  // baseline hits). It stays on for src/lib/**, where it measures real logic.
  {
    files: ['**/*.tsx'],
    rules: { 'max-lines-per-function': 'off' },
  },
  // OVERRIDE 2 — docs/adr/0002-thresholds-are-for-production-code.md
  // In test files T1/T5 measure describe-block size, not design. T2 and T4 stay on.
  // `.mjs` joined this list with SPRIN-60, for the reason ADR 0002 already gives:
  // check-bundle.test.mjs and verify-gate.test.mjs are tests, and their long
  // `it` blocks are block size, not design. Note the extension list here is
  // `{ts,tsx,mjs}` and NOT a bare `'**/*.mjs'` — the latter would read as tidier
  // and would hand scripts/check-bundle.mjs back the exemption SPRIN-60 removed.
  {
    files: ['**/*.{test,spec}.{ts,tsx,mjs}', 'src/test/**', 'e2e/**'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      'sonarjs/cognitive-complexity': 'off',
    },
  },
  // shadcn/ui components are vendored from the registry. Lint them for real
  // errors but do not fight their house style, and do not hold code we did not
  // write to our size thresholds.
  {
    files: ['src/components/ui/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      complexity: 'off',
    },
  },
  // Generated from the live schema — not hand-maintained code.
  {
    files: ['src/lib/database.types.ts'],
    rules: { 'max-lines': 'off' },
  },
  prettier,
)
