// The single lint configuration. `npm run lint` runs this, and `npm run verify`
// runs `npm run lint`, so these rules gate every merge.
//
// SPRIN-55 (pivot slice 3) removed the T1-T5 size and complexity thresholds that
// SPRIN-50 had folded in here, along with the duplication gate and the ADRs that
// existed only to justify their overrides. The thresholds were ceremony for a
// project this size; the gate is not. What is left is the ordinary correctness
// lint — recommended JS/TypeScript rules, the React hook rules, and no swallowed
// errors — and it stays inside `verify`.
//
// This project is deliberately NOT wired to /var/www/CodingStandards. That is a
// decision, not an oversight: do not re-add the profile, the threshold rules or
// a `lint:standards` script without being asked.
import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
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
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      // Error handling: no empty blocks, no swallowed errors. Stated explicitly
      // rather than left to `js.configs.recommended`'s default, because a
      // swallowed error is the failure mode this codebase actually has — a
      // rejected Supabase call that renders nothing.
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  // shadcn/ui components are vendored from the registry. Lint them for real
  // errors but do not fight their house style.
  {
    files: ['src/components/ui/**'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  prettier,
)
