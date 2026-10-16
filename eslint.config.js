import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Worktrees live in `.claude/worktrees/`: full checkouts that git ignores,
  // but ESLint does not read .gitignore and linted them from the main tree.
  globalIgnores([
    'dist', '.wrangler', 'worker-configuration.d.ts', '.claude/**', 'scripts/diagnostics/**',
    // Vendored Impeccable scripts retain their upstream source and lint conventions.
    '.agents/skills/impeccable/scripts/**',
  ]),
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    files: ['**/*.{js,jsx}'],
    rules: {
      // A `const` read before its line runs is a crash the test suite can
      // miss entirely when `||` short-circuits past it — it shipped one to
      // production on 2026-08-29 (barVisible read isStreaming declared 250
      // lines further down; the first scroll was the first evaluation).
      // Variables only: hoisted function declarations are fine and common.
      'no-use-before-define': ['error', { functions: false, classes: false, variables: true }],
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.recommended],
    rules: {
      // Preserve the JavaScript TDZ check with the TypeScript-aware rule.
      '@typescript-eslint/no-use-before-define': ['error', { functions: false, classes: false, variables: true }],
    },
  },
  {
    // Rules tests run under Node against the Firestore emulator, not in a page.
    files: ['tests/**/*.{js,ts}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // The Scopus egress runs on Deno Deploy; its tests run under Node.
    files: ['proxy/**/*.{js,ts}'],
    languageOptions: { globals: { ...globals.node, Deno: 'readonly' } },
  },
])
