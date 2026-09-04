import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.wrangler', 'scripts/diagnostics/**', 'video/**']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
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
    // Rules tests run under Node against the Firestore emulator, not in a page.
    files: ['tests/**/*.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // The Scopus egress runs on Deno Deploy; its tests run under Node.
    files: ['proxy/**/*.js'],
    languageOptions: { globals: { ...globals.node, Deno: 'readonly' } },
  },
])
