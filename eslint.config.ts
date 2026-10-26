import js from '@eslint/js'
import globals from 'globals'
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import type { Linter } from 'eslint'
import { defineConfig, globalIgnores } from 'eslint/config'
import css from '@eslint/css'
import papertok from './eslint-rules/index.ts'

// `as unknown as X` launders a value into a type it was never checked against.
const doubleCast = {
  selector: 'TSAsExpression > TSAsExpression.expression[typeAnnotation.type="TSUnknownKeyword"]',
  message: '`as unknown as` skips the type check. Parse the value at its boundary or take the type from its owner.',
}

// A test that reads a source file and matches its text passes while the behavior
// is broken and fails when equivalent code is rewritten. A `.tsx` or `.css` name,
// or a relative path to a script, in a test is how such a read starts.
const sourcePath = String.raw`/(\.(tsx|css)$)|(^(\.{1,2}\/|\/?(src|worker|proxy|scripts|public)\/).*\.[cm]?[jt]s$)/`
const sourceTextTest = {
  selector: `:matches(:not(ImportDeclaration, ImportExpression, ExportNamedDeclaration, ExportAllDeclaration, TSImportType, ImportExpression > MemberExpression > NewExpression, CallExpression[callee.property.name="module"]) > Literal[value=${sourcePath}], TemplateElement[value.cooked=${sourcePath}])`,
  message: 'Do not assert on source text. Import the module and assert its result, or express a structural rule in eslint.config.ts.',
}

// The shared Button writes its ring as a Tailwind utility, where no stylesheet rule can see it.
const brandOrangeRingUtility = {
  selector: String.raw`:matches(Literal[value=/outline-\[var\(--brand-orange\)\]/], TemplateElement[value.raw=/outline-\[var\(--brand-orange\)\]/])`,
  message: 'Use outline-[var(--focus-ring)]: --brand-orange is 2.08:1 on a white page, below the 3:1 a focus indicator needs (WCAG 1.4.11).',
}

const legacyPdfjsMessage = 'Import pdf.js from pdfjs-dist/legacy/…: the modern build calls Map.getOrInsertComputed and Math.sumPrecise, which the iPhones the touch viewer exists for do not have.'
const legacyPdfjs = [
  { selector: String.raw`ImportDeclaration[importKind="value"][source.value=/^pdfjs-dist(?!\/legacy\/)/]`, message: legacyPdfjsMessage },
  { selector: String.raw`ImportExpression[source.value=/^pdfjs-dist(?!\/legacy\/)/]`, message: legacyPdfjsMessage },
]

// Only native elements: `aria-modal` passed to a ui/ primitive is still the primitive.
const handRolledOverlayMessage = 'Use the Dialog, AlertDialog, Sheet or Drawer primitive from src/components/ui: it owns the focus trap, Escape, focus restoration and nesting.'
const handRolledOverlay = [
  { selector: 'JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name="aria-modal"]', message: handRolledOverlayMessage },
  {
    selector: 'JSXOpeningElement[name.name=/^[a-z]/] > JSXAttribute[name.name="role"]:matches([value.value=/^(alert)?dialog$/], [value.expression.value=/^(alert)?dialog$/])',
    message: handRolledOverlayMessage,
  },
  { selector: 'CallExpression[callee.name="useDialogFocus"]', message: handRolledOverlayMessage },
]

// Fast Refresh re-evaluates a module that defines a component, and a context
// created there becomes a new object that mounted consumers do not hold: they
// read the default, and a correctly nested provider reports "must be used within".
const contextInComponentModule = {
  selector: 'CallExpression:matches([callee.name="createContext"], [callee.property.name="createContext"])',
  message: 'Create the context in a component-free .ts module (src/context/contexts.ts) and import it here.',
}

const productionSources = ['src/**/*.{ts,tsx}', 'worker/**/*.ts', 'proxy/**/*.ts']
const testSources = ['**/*.test.ts']

// The frontend never imports Worker or proxy code (secrets, quotas and
// server-only runtimes), and draws icons from one library.
const frontendImports = {
  paths: [{ name: 'lucide-react', message: 'Icons come from @phosphor-icons/react (src/AGENTS.md).' }],
  patterns: [{
    group: ['**/worker/**', '**/proxy/**'],
    message: 'Frontend code cannot import Worker or proxy modules. Share browser-safe code from src/ instead.',
  }],
}

// worker/tsconfig.test.json compiles these frontend tests because they import Worker modules.
const workerImportingFrontendTests = [
  'src/services/paper-figure-service.test.ts',
  'src/utils/ai-explanation.test.ts',
]

// Type-aware rules for the defects type information can prove: a dropped
// promise loses its rejection, and an assertion the type already satisfies
// hides the next real type change. Later entries take precedence for a file.
function typeAware(scopes: Array<{ files: string[]; project: string }>): Linter.Config[] {
  return scopes.map(({ files, project }) => ({
    files,
    languageOptions: { parserOptions: { project, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/await-thenable': 'error',
      // node:test runs each registered test; the promise `test()` returns is not a dropped one.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: ['test', 'it', 'describe', 'suite'] }],
      }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': ['error', { considerDefaultExhaustiveForUnions: true }],
    },
  }))
}

export default defineConfig([
  // Worktrees live in `.claude/worktrees/`: full checkouts that git ignores,
  // but ESLint does not read .gitignore and linted them from the main tree.
  globalIgnores([
    'dist', '.wrangler', 'worker-configuration.d.ts', '.claude/**', 'scripts/diagnostics/**',
  ]),
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    plugins: { css, papertok },
  },
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      eslintComments.recommended,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // A file-scoped directive placed after the imports is deliberate in the context modules.
      '@eslint-community/eslint-comments/disable-enable-pair': 'off',
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: ['eslint-enable'] }],
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
    // Tests may cast a partial platform fake (D1, KV, a Durable Object
    // namespace) to the binding it stands in for; the fake is the fixture boundary.
    files: productionSources,
    ignores: [...testSources, '**/test-support/**'],
    rules: {
      'no-restricted-syntax': ['error', doubleCast],
    },
  },
  {
    // Application tests. Tooling tests under scripts/ pass repository paths as data.
    files: ['src/**/*.test.ts', 'worker/**/*.test.ts', 'proxy/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', sourceTextTest],
    },
  },
  {
    // A later `no-restricted-syntax` replaces an earlier one for the same file, so
    // the frontend's list repeats doubleCast.
    files: ['src/**/*.{ts,tsx}'],
    ignores: [...testSources, '**/test-support/**'],
    rules: {
      'no-restricted-syntax': ['error', doubleCast, brandOrangeRingUtility, ...legacyPdfjs, ...handRolledOverlay],
    },
  },
  {
    files: ['src/**/*.tsx'],
    ignores: ['src/components/ui/**'],
    rules: {
      'no-restricted-syntax': ['error', doubleCast, brandOrangeRingUtility, ...legacyPdfjs, ...handRolledOverlay, contextInComponentModule],
    },
  },
  {
    // The primitives are where an overlay's dialog role and focus handling belong.
    files: ['src/components/ui/**/*.{ts,tsx}'],
    ignores: [...testSources, '**/test-support/**'],
    rules: {
      'no-restricted-syntax': ['error', doubleCast, brandOrangeRingUtility, ...legacyPdfjs],
    },
  },
  {
    files: ['src/components/ui/**/*.tsx'],
    ignores: [...testSources, '**/test-support/**'],
    rules: {
      'no-restricted-syntax': ['error', doubleCast, brandOrangeRingUtility, ...legacyPdfjs, contextInComponentModule],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: testSources,
    rules: {
      // A pattern on every screen stops being one: `outline` turned halftone once
      // and was on 56 buttons within a day. A new place is a design decision:
      // allow it here and in design.md together.
      'papertok/patterned-buttons': ['error', {
        variants: {
          engraved: ['src/components/public/guest-welcome.tsx', 'src/components/public/welcome-shell.tsx'],
          halftone: ['src/components/public/guest-welcome.tsx'],
        },
        classes: {
          'btn-halftone': ['src/components/public/guest-welcome.tsx', 'src/components/public/welcome-shell.tsx', 'src/components/ui/button-variants.ts'],
        },
      }],
    },
  },
  ...typeAware([
    // Each file is checked against the configuration that compiles it.
    { files: ['src/**/*.{ts,tsx}'], project: './tsconfig.json' },
    { files: ['src/**/*.test.ts'], project: './tsconfig.test.json' },
    { files: workerImportingFrontendTests, project: './worker/tsconfig.test.json' },
    { files: ['worker/**/*.ts'], project: './worker/tsconfig.json' },
    { files: ['worker/**/*.test.ts', 'worker/test-support/**/*.ts'], project: './worker/tsconfig.test.json' },
    { files: ['proxy/**/*.ts'], project: './proxy/tsconfig.json' },
    { files: ['proxy/**/*.test.ts'], project: './proxy/tsconfig.test.json' },
  ]),
  {
    // The frontend never imports Worker or proxy code: those hold secrets,
    // quotas and server-only runtimes.
    files: ['src/**/*.{ts,tsx}'],
    ignores: testSources,
    rules: {
      'no-restricted-imports': ['error', frontendImports],
    },
  },
  {
    // The feed loads with one profile read; the identity service reads and
    // links accounts, and must stay off that path.
    files: [
      'src/context/feed-context.tsx', 'src/components/feed/feed-container.tsx', 'src/components/feed/paper-card.tsx',
      'src/utils/interaction-profile-loader.ts', 'src/services/interaction-profile-store.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        ...frontendImports,
        patterns: [...frontendImports.patterns, {
          group: ['**/auth-identity-service*'],
          message: 'The feed path must not import the identity service: it adds reads to the feed load.',
        }],
      }],
    },
  },
  {
    // The Worker may reuse browser-safe normalization from src/, never UI,
    // browser state or the client SDKs.
    files: ['worker/**/*.ts'],
    ignores: testSources,
    rules: {
      'no-restricted-imports': ['error', { patterns: [{
        group: [
          'react', 'react-dom', 'react-dom/*', 'react-router-dom', 'firebase/*', 'posthog-js', '@sentry/react',
          '**/src/components/**', '**/src/context/**', '**/src/hooks/**', '**/src/lib/**', '**/*.css',
        ],
        message: 'The Worker cannot import browser-only modules. Move the browser-safe part to src/services, src/utils or src/models.',
      }] }],
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
  {
    files: ['src/**/*.css'],
    language: 'css/css',
    // Tailwind's `@import … layer() source()` and `@custom-variant` are not standard CSS.
    languageOptions: { tolerant: true },
    rules: {
      // @eslint/css's recommended rules that hold on the tree as it stands.
      'css/no-duplicate-keyframe-selectors': 'error',
      'css/no-empty-blocks': 'error',
      'css/no-invalid-at-rule-placement': 'error',
      'css/no-invalid-named-grid-areas': 'error',
      'css/no-unmatchable-selectors': 'error',
      'papertok/no-focus-ring-removal': ['error', { allowed: [
        {
          selector: '.rd-pin:focus-visible',
          reason: 'the pin is a zero-size anchor so it never moves the paragraph; the visible number is its ::before, and .rd-pin:focus-visible::before draws the 2px --focus-ring on it',
        },
        {
          selector: '.account-menu',
          reason: 'the popup is a container, not a control: Base UI moves focus on to its items as soon as it opens, and the items keep the global :focus-visible ring. A ring round the whole panel would read as a second, wrong focus',
        },
        {
          selector: '#main-content:focus',
          reason: 'not a control and never a tab stop: the skip link and RouteAnnouncer move focus here programmatically, and a ring round the whole page region reads as a rendering bug rather than as focus',
        },
        {
          selector: '.gw-title:focus-visible',
          reason: 'WelcomeShell moves focus to each step’s h1 (tabIndex={-1}) so a screen reader starts reading the new step and Tab starts from its top. It is never a tab stop of its own; a ring round a headline would read as a rendering bug',
        },
        {
          selector: '.institution-sheet h2:focus-visible',
          reason: 'the phone-only Your university sheet opens with focus on its h2 (tabIndex={-1}, initialFocus) so a screen reader starts at the title and the keyboard does not rise over the sheet. It is never a tab stop of its own',
        },
        {
          selector: "input:not([type='checkbox']):not([type='radio']):not([type='range']):focus-visible, textarea:focus-visible, [contenteditable='true']:focus-visible",
          reason: 'the same rule draws the replacement: border to ink plus an inset ink hairline. Text fields match :focus-visible even on a mouse click, so the ring boxed every clicked search field; the ink border is the same indicator for keyboard and mouse',
        },
      ] }],
      'papertok/no-brand-orange-focus-ring': 'error',
      'papertok/focus-ring-unlayered': 'error',
      'papertok/no-bare-span-hiding': 'error',
      'papertok/defined-custom-properties': ['error', { injected: [
        { name: '--area-accent', setBy: 'src/components/lists/list-row.tsx', reason: 'a row, card or entity header takes the research field of its paper, so its rules are tinted by the data' },
        { name: '--prop-fill', setBy: 'src/components/onboarding/petri-flask.tsx', reason: 'each onboarding illustration fills its props with the colour of the topic it shows' },
        { name: '--bubble', setBy: 'src/components/onboarding/petri-flask.tsx', reason: 'each bubble’s place in the sequence offsets its animation' },
        { name: '--line', setBy: 'src/components/onboarding/petri-download.tsx', reason: 'each line’s place in the sequence delays its animation' },
        { name: '--swatch', setBy: 'src/components/lists/create-list-dialog.tsx', reason: 'each swatch shows one of the list colours the owner can pick' },
        { name: '--abstract-motion', setBy: 'src/components/feed/paper-card.tsx', reason: 'the abstract’s expand duration scales with the height it travels' },
        { name: '--i', setBy: 'src/components/feed/paper-card.tsx', reason: 'a staggered item’s index in its list; also set by the explorer, the skeleton, the reader and the author dots' },
        { name: '--similar-origin', setBy: 'src/components/feed/similar-feed-layer.tsx', reason: 'the Similar layer opens from the card that was pressed' },
        { name: '--timeline-progress', setBy: 'src/components/explorer/entity-explorer.tsx', reason: 'how far the author timeline has been drawn' },
        { name: '--v', setBy: 'src/components/explorer/entity-explorer.tsx', reason: 'a chart bar’s value as a fraction of the tallest' },
        { name: '--total-scale-factor', setBy: 'src/components/pdf/pdf-pages.tsx', reason: 'pdf.js’s text layer is sized by the page’s render scale' },
        { name: '--available-height', setBy: '@base-ui/react', reason: 'Base UI’s positioner sets the space left in the viewport on its popup' },
        { name: '--transform-origin', setBy: '@base-ui/react', reason: 'Base UI’s positioner sets the anchor side a popup grows from' },
        { name: '--collapsible-panel-height', setBy: '@base-ui/react', reason: 'Base UI’s Collapsible panel measures its content' },
        { name: '--cmdk-list-height', setBy: 'cmdk', reason: 'cmdk measures the result list after each change' },
      ] }],
      'papertok/no-retired-colours': ['error', { retired: [
        { hex: '#7c3aed', reason: 'the violet accent before the light design system (e56a7ea), when --accent-primary became ink' },
        { hex: '#8b4af2', reason: 'the lighter hover of that violet; a black button turned violet under the mouse' },
      ] }],
      'papertok/no-external-css-urls': 'error',
    },
  },
  {
    files: ['src/styles/variables.css'],
    rules: {
      'papertok/token-contrast': ['error', { checks: [
        {
          // Normal text (WCAG 1.4.3).
          ratio: 4.5,
          pairs: [
            ['--text-primary', '--bg-primary'],
            ['--text-primary', '--bg-secondary'],
            ['--text-secondary', '--bg-primary'],
            ['--text-secondary', '--bg-secondary'],
            ['--text-tertiary', '--bg-primary'],
            ['--text-tertiary', '--bg-secondary'],
            ['--text-on-brand', '--brand-yellow'],
            // The soft yellow flips with the theme, so its ink is its own token.
            ['--text-on-brand-soft', '--brand-yellow-soft'],
          ],
        },
        {
          // The focus indicator against every surface (WCAG 1.4.11).
          ratio: 3,
          pairs: [['--focus-ring', '--bg-primary'], ['--focus-ring', '--bg-secondary'], ['--focus-ring', '--bg-card']],
        },
      ] }],
      'papertok/dark-theme-parity': ['error', { shared: [
        { name: '--brand-yellow', reason: 'the mark itself: it reads the same on paper and on ink' },
        { name: '--brand-orange', reason: 'a brand accent, not the focus ring, which flips with the theme to hold 3:1 on both a white page and an ink one' },
        { name: '--text-on-brand', reason: 'ink by definition: it exists to sit on the yellow' },
        { name: '--bg-figure-plate', reason: 'paper for figures from the papers themselves, which arrive with no background and black ink drawn for a white page' },
      ] }],
    },
  },
])
