// Code Quality Standard — REPORT ONLY. Not the gate.
//
// `npm run lint:standards` runs this; `npm run lint` (and therefore
// `npm run verify`) does not. Adopted as a legacy retrofit per the
// audit-standards skill: the thresholds are visible from today so new code can
// be held to them, but they do not block a merge until the existing violations
// are worked off. See docs/standards-audit-2026-07-25.md for the baseline and
// docs/adr/ for the two overrides.
//
// Thresholds trace to /var/www/CodingStandards/core/THRESHOLDS.md (T1-T5).
// They are restated here rather than imported because
// `@codequalitystandards/eslint-config` is not published to a registry — see
// docs/adr/0003-vendor-the-threshold-config.md. Keep the numbers in sync.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import sonarjs from 'eslint-plugin-sonarjs'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  // Mirrors eslint.config.js: .claude/** holds subagent worktrees (full repo
  // copies), api/** is Python and is linted by ruff.
  { ignores: ['dist', 'coverage', 'node_modules', '.claude/**', 'api/**'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2023, globals: globals.browser },
    plugins: { sonarjs },
    rules: {
      // T1 Function length.
      'max-lines-per-function': ['error', { max: 30, skipBlankLines: true, skipComments: true }],
      // T2 Cyclomatic complexity.
      complexity: ['error', { max: 10 }],
      // T3 Cognitive complexity.
      'sonarjs/cognitive-complexity': ['error', 15],
      // T4 Parameters.
      'max-params': ['error', 4],
      // T5 File length.
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      // Error handling: no empty blocks, no swallowed errors.
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
  // In test files T1/T5 measure describe-block size, not design.
  {
    files: ['**/*.{test,spec}.{ts,tsx}', 'src/test/**', 'e2e/**'],
    rules: {
      'max-lines-per-function': 'off',
      'max-lines': 'off',
      'sonarjs/cognitive-complexity': 'off',
    },
  },
  // shadcn/ui components are vendored from the registry; we do not own their shape.
  {
    files: ['src/components/ui/**'],
    rules: { 'max-lines-per-function': 'off', 'max-lines': 'off', complexity: 'off' },
  },
  // Generated from the live schema — not hand-maintained code.
  {
    files: ['src/lib/database.types.ts'],
    rules: { 'max-lines': 'off' },
  },
  prettier,
)
