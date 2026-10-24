import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ESLint } from 'eslint'

// The real eslint.config.ts: proves the rules are wired to the files they guard.
const eslint = new ESLint({ flags: ['unstable_native_nodejs_ts_config'] })

async function findings(code: string, filePath: string, prefix: RegExp) {
  const [result] = await eslint.lintText(code, { filePath })
  // A file the config cannot parse reports no rule at all; say why instead.
  const fatal = result.messages.filter(message => message.fatal)
  assert.deepEqual(fatal.map(message => message.message), [], `${filePath} did not parse`)
  return result.messages
    .filter(message => message.ruleId && prefix.test(message.ruleId))
    .map(message => `${message.line} ${message.ruleId}`)
    .sort()
}

test('the stylesheet rules run on a component stylesheet under src/', async () => {
  const code = [
    '.card:focus { outline: none; }',
    '.card:hover { color: #7c3aed; background: url(https://example.com/a.png); }',
    '.card { border-color: var(--no-such-token); outline-color: var(--brand-orange); }',
    '@layer base { :focus-visible { outline: 2px solid var(--focus-ring); } }',
  ].join('\n')
  assert.deepEqual(await findings(code, 'src/components/Feed/Probe.css', /^papertok\//), [
    '1 papertok/no-focus-ring-removal',
    '2 papertok/no-external-css-urls',
    '2 papertok/no-retired-colours',
    '3 papertok/defined-custom-properties',
    '3 papertok/no-brand-orange-focus-ring',
    '4 papertok/focus-ring-unlayered',
  ])
})

test('the theme rules run on variables.css', async () => {
  const code = ":root {\n  --text-primary: #777777;\n  --bg-primary: #ffffff;\n}\n:root[data-theme='dark'] {\n  --bg-primary: #000000;\n}"
  const ids = await findings(code, 'src/styles/variables.css', /^papertok\/(token-contrast|dark-theme-parity)$/)
  assert.ok(ids.includes('2 papertok/dark-theme-parity'), '--text-primary has no dark value')
  assert.ok(ids.includes('2 papertok/token-contrast'), '#777777 on white is 4.48:1')
})

test('a component outside ui/ cannot hand-roll an overlay; a primitive in ui/ can', async () => {
  const code = [
    "import 'pdfjs-dist/build/pdf.mjs'",
    'export const Probe = () => (',
    '  <div role="dialog" aria-modal="true" className="focus-visible:outline-[var(--brand-orange)]">',
    '    <Button variant="halftone" />',
    '  </div>',
    ')',
  ].join('\n')
  // Existing files, so the type-aware rules find them in their project.
  assert.deepEqual(await findings(code, 'src/App.tsx', /^(no-restricted-syntax|papertok\/)/), [
    '1 no-restricted-syntax',
    '3 no-restricted-syntax',
    '3 no-restricted-syntax',
    '3 no-restricted-syntax',
    '4 papertok/patterned-buttons',
  ])
  assert.deepEqual(await findings(code, 'src/components/ui/dialog.tsx', /^(no-restricted-syntax|papertok\/)/), [
    '1 no-restricted-syntax',
    '3 no-restricted-syntax',
    '4 papertok/patterned-buttons',
  ])
})

test('the frontend imports one icon library, and the feed path stays off the identity service', async () => {
  const code = "import { X } from 'lucide-react'\nimport { linkAccount } from '../../services/authIdentityService.ts'\nexport const probe = [X, linkAccount]"
  assert.deepEqual(await findings(code, 'src/components/Feed/PaperCard.tsx', /^no-restricted-imports$/), [
    '1 no-restricted-imports',
    '2 no-restricted-imports',
  ])
  assert.deepEqual(await findings(code, 'src/components/Settings/SettingsPage.tsx', /^no-restricted-imports$/), [
    '1 no-restricted-imports',
  ])
})

test('a context created in a component module is rejected; mock.module paths are not source reads', async () => {
  const component = "import { createContext } from 'react'\nexport const Ctx = createContext(null)\nexport const Probe = () => <div />"
  assert.deepEqual(await findings(component, 'src/App.tsx', /^no-restricted-syntax$/), ['2 no-restricted-syntax'])
  assert.deepEqual(await findings("import { createContext } from 'react'\nexport const Ctx = createContext(null)", 'src/context/contexts.ts', /^no-restricted-syntax$/), [])
  const mocked = "import { mock } from 'node:test'\nmock.module('./paperSeed.ts', { namedExports: {} })"
  assert.deepEqual(await findings(mocked, 'src/utils/paperSeed.test.ts', /^no-restricted-syntax$/), [])
})
