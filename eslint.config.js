// The single lint configuration. `npm run lint` runs this, and `npm run verify`
// runs `npm run lint`, so these thresholds gate every merge.
//
// The T1-T5 thresholds trace to /var/www/CodingStandards/core/THRESHOLDS.md and
// are restated here rather than imported, because
// `@codequalitystandards/eslint-config` is not published to a registry — see
// docs/adr/0003-vendor-the-threshold-config.md. Keep the numbers in sync with the
// standard; nothing checks them for you.
//
// Adopted as a non-gating report in #42 and folded into the gate in SPRIN-50,
// once complexity findings and production duplication had both reached zero.
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
  // `api/**` is Python and is linted by ruff.
  { ignores: ['dist', 'coverage', 'node_modules', '.claude/**', 'api/**'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
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
  // In test files T1/T5 measure describe-block size, not design. T2 and T4 stay on.
  {
    files: ['**/*.{test,spec}.{ts,tsx}', 'src/test/**', 'e2e/**'],
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
