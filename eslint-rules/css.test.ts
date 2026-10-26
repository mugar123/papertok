import { describe, it } from 'node:test'
import { RuleTester } from 'eslint'
import css from '@eslint/css'
import {
  darkThemeParity, definedCustomProperties, focusRingUnlayered, noBareSpanHiding, noBrandOrangeFocusRing,
  noExternalCssUrls, noFocusRingRemoval, noRetiredColours, tokenContrast,
} from './css.ts'

RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({ plugins: { css }, language: 'css/css' })

tester.run('no-focus-ring-removal', noFocusRingRemoval, {
  valid: [
    '.btn:focus-visible { outline: 2px solid var(--focus-ring); }',
    {
      code: '.pin:focus-visible,\n  .dot:focus-visible { outline: none; }',
      options: [{ allowed: [{ selector: '.pin:focus-visible, .dot:focus-visible', reason: 'the ::before draws the ring' }] }],
    },
  ],
  invalid: [
    { code: '.btn:focus { outline: none; }', errors: [{ messageId: 'removed', data: { selector: '.btn:focus' } }] },
    { code: '.btn:focus { outline: 0 !important; }', errors: [{ messageId: 'removed' }] },
    { code: '@media (hover: hover) { .btn:focus { outline-style: none; } }', errors: [{ messageId: 'removed' }] },
  ],
})

tester.run('no-bare-span-hiding', noBareSpanHiding, {
  valid: [
    '.brand-label { display: none; }',
    '.brand span.label { display: none; }',
    '.brand span { color: red; }',
    '.brand .spanner { display: none; }',
  ],
  invalid: [
    { code: '.brand span { display: none; }', errors: [{ messageId: 'hidden', data: { selector: '.brand span' } }] },
    { code: '@media (max-width: 600px) { .brand span { display: none; } }', errors: [{ messageId: 'hidden' }] },
    { code: '.brand > span { visibility: hidden; }', errors: [{ messageId: 'hidden' }] },
    { code: '.a, .brand SPAN { display: NONE !important; }', errors: [{ messageId: 'hidden' }] },
    { code: '.brand span:first-child { display: none; }', errors: [{ messageId: 'hidden' }] },
  ],
})

tester.run('no-brand-orange-focus-ring', noBrandOrangeFocusRing, {
  valid: ['.btn:hover { border-color: var(--brand-orange); outline: 2px solid var(--focus-ring); }'],
  invalid: [
    { code: '.btn:focus-visible { outline: 2px solid var(--brand-orange); }', errors: [{ messageId: 'brandOrange' }] },
    { code: '.btn:focus-visible { outline-color: var( --brand-orange ); }', errors: [{ messageId: 'brandOrange' }] },
  ],
})

tester.run('focus-ring-unlayered', focusRingUnlayered, {
  valid: [':focus-visible { outline: 2px solid var(--focus-ring); }', '@layer base { a:focus-visible { color: red; } }'],
  invalid: [
    { code: '@layer base { :focus-visible { outline: 2px solid var(--focus-ring); } }', errors: [{ messageId: 'layered' }] },
    { code: '@layer base { @media (hover: hover) { :focus-visible { outline: none; } } }', errors: [{ messageId: 'layered' }] },
  ],
})

const pairs = [{ checks: [{ ratio: 4.5, pairs: [['--fg', '--bg']] as Array<[string, string]> }] }] as const

tester.run('token-contrast', tokenContrast, {
  valid: [
    { code: ":root { --fg: #000000; --bg: #ffffff; } :root[data-theme='dark'] { --fg: #ffffff; --bg: #000000; }", options: [...pairs] },
  ],
  invalid: [
    {
      // The dark block keeps the light ink, which then sits on a dark page.
      code: ":root { --fg: #000000; --bg: #ffffff; } :root[data-theme='dark'] { --bg: #111111; }",
      options: [...pairs],
      errors: [{ messageId: 'low', data: { theme: ":root[data-theme='dark']", foreground: '--fg', background: '--bg', actual: '1.11', required: '4.5' } }],
    },
    {
      code: ":root { --fg: var(--ink); --bg: #ffffff; } :root[data-theme='dark'] { --fg: #ffffff; --bg: #000000; }",
      options: [...pairs],
      errors: [{ messageId: 'unmeasurable', data: { token: '--fg', theme: ':root' } }],
    },
    { code: ':root { --fg: #000000; --bg: #ffffff; }', options: [...pairs], errors: [{ messageId: 'missingBlock' }] },
  ],
})

tester.run('dark-theme-parity', darkThemeParity, {
  valid: [
    {
      code: ":root { --ink: #111111; --mark: #ffd400; --wash: var(--ink); --gap: 4px; } :root[data-theme='dark'] { --ink: #f4ecd8; }",
      options: [{ shared: [{ name: '--mark', reason: 'the brand mark reads the same on both' }] }],
    },
  ],
  invalid: [
    {
      code: ":root { --ink: #111111; --tint: rgba(0, 0, 0, 0.1); } :root[data-theme='dark'] { --ink: #f4ecd8; }",
      errors: [{ messageId: 'noDarkValue', data: { name: '--tint' } }],
    },
    { code: ":root { --ink: #111111; } :root[data-theme='dark'] { --ink: #f4ecd8; --extra: #222222; }", errors: [{ messageId: 'darkOnly' }] },
    {
      code: ":root { --mark: #ffd400; } :root[data-theme='dark'] { --mark: #ffe000; }",
      options: [{ shared: [{ name: '--mark', reason: 'the brand mark' }] }],
      errors: [{ messageId: 'sharedRedefined' }],
    },
  ],
})

// Reads the real stylesheets under src/: --bg-primary is defined in src/styles/variables.css.
tester.run('defined-custom-properties', definedCustomProperties, {
  valid: [
    'a { color: var(--bg-primary); }',
    'a { color: var(--nowhere, red); }',
    'a { --local: 1px; width: var(--local); }',
    { code: 'a { height: var(--cmdk-list-height); }', options: [{ injected: [{ name: '--cmdk-list-height', setBy: 'cmdk', reason: 'cmdk measures its list' }] }] },
  ],
  invalid: [
    { code: 'a { font-size: var(--fs-nowhere); }', errors: [{ messageId: 'undefined', data: { name: '--fs-nowhere' } }] },
    {
      code: 'a { color: var(--claimed); }',
      options: [{ injected: [{ name: '--claimed', setBy: 'src/styles/variables.css', reason: 'a stale entry' }] }],
      errors: [{ messageId: 'notInjected' }],
    },
  ],
})

const retired = [{ retired: [{ hex: '#7c3aed', reason: 'the old violet' }] }]

tester.run('no-retired-colours', noRetiredColours, {
  valid: [{ code: 'a { color: #7c3aee; background: rgba(124, 58, 238, 0.2); }', options: retired }],
  invalid: [
    { code: 'a { color: #7C3AED; }', options: retired, errors: [{ messageId: 'retired', data: { colour: '#7C3AED', reason: 'the old violet' } }] },
    { code: 'a { box-shadow: 0 0 4px rgba(124, 58, 237, 0.3); }', options: retired, errors: [{ messageId: 'retired' }] },
  ],
})

tester.run('no-external-css-urls', noExternalCssUrls, {
  valid: [
    "@import '@fontsource/inter/400.css';",
    "a { background: url('/icons/a.svg'), url(data:image/svg+xml;utf8,<svg/>); }",
    '/* fonts once came from https://fonts.googleapis.com */ a { color: red; }',
  ],
  invalid: [
    { code: '@font-face { src: url(https://fonts.gstatic.com/a.woff2); }', errors: [{ messageId: 'external' }] },
    { code: "@import '//cdn.example.com/a.css';", errors: [{ messageId: 'external' }] },
    { code: '@import url("http://example.com/a.css");', errors: [{ messageId: 'external' }] },
  ],
})
