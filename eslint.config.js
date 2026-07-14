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
