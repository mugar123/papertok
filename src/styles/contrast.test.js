// Guards the palette against WCAG 2.2 regressions: normal text needs 4.5:1,
// UI indicators (focus ring) need 3:1. Parses variables.css directly so the
// test fails the moment a token value drops below threshold.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./variables.css', import.meta.url), 'utf8')
const darkStart = css.indexOf(":root[data-theme='dark']")
assert.ok(darkStart > 0, 'dark theme block not found in variables.css')
const blocks = { light: css.slice(0, darkStart), dark: css.slice(darkStart) }

function token(theme, name) {
  const own = blocks[theme].match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  if (own) return own[1]
  // Dark redefines only what changes; anything else falls through to light.
  const base = blocks.light.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))
  assert.ok(base, `token ${name} not found`)
  return base[1]
}

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const TEXT_PAIRS = [
  ['--text-primary', '--bg-primary'],
  ['--text-primary', '--bg-secondary'],
  ['--text-secondary', '--bg-primary'],
  ['--text-secondary', '--bg-secondary'],
  ['--text-tertiary', '--bg-primary'],
  ['--text-tertiary', '--bg-secondary'],
  ['--text-on-brand', '--brand-yellow'],
  // The soft yellow flips with the theme, so its ink is its own token.
  ['--text-on-brand-soft', '--brand-yellow-soft'],
]

for (const theme of ['light', 'dark']) {
  test(`normal text meets 4.5:1 (${theme})`, () => {
    for (const [fg, bg] of TEXT_PAIRS) {
      const r = ratio(token(theme, fg), token(theme, bg))
      assert.ok(r >= 4.5, `${theme} ${fg} on ${bg}: ${r.toFixed(2)}:1 < 4.5:1`)
    }
  })

  test(`focus ring meets 3:1 against surfaces (${theme})`, () => {
    for (const bg of ['--bg-primary', '--bg-secondary', '--bg-card']) {
      const r = ratio(token(theme, '--focus-ring'), token(theme, bg))
      assert.ok(r >= 3, `${theme} --focus-ring on ${bg}: ${r.toFixed(2)}:1 < 3:1`)
    }
  })
}
