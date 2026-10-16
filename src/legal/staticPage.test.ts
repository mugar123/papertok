import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');

test('static-page.css owns the faces, the tokens and the shared chrome', () => {
  const css = read('./static-page.css');
  for (const imp of [
    "@import '@fontsource-variable/newsreader/opsz.css'",
    "@import '@fontsource/inter/400.css'",
    "@import '@fontsource/ibm-plex-mono/400.css'",
    "@import '../styles/variables.css'",
  ]) assert.ok(css.includes(imp), imp);
  for (const cls of ['.lp-bar', '.lp-wordmark span', '.lp-btn', '.lp-footer', '.lp-visually-hidden', '.lp-skip', ':focus-visible']) {
    assert.ok(css.includes(cls), cls);
  }
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.doesNotMatch(css, /https?:\/\//);
});

test('privacy.css imports the shared sheet instead of repeating it', () => {
  const css = read('./privacy.css');
  assert.ok(css.includes("@import './static-page.css'"));
  assert.doesNotMatch(css, /@fontsource|variables\.css/);
  /* A bare redeclaration of shared chrome is the thing this forbids. A scoped
     override (`.lp-doc + .lp-footer`) is not one: the shared sheet still owns
     the rule, and this page narrows one value of it. */
  assert.doesNotMatch(css, /^\.lp-bar\s*\{/m);
  assert.doesNotMatch(css, /^\.lp-btn\s*\{/m);
  assert.doesNotMatch(css, /^\.lp-footer\s*\{/m);
});

test('the skip link is invisible until focused and then sits over everything', () => {
  const css = read('./static-page.css');
  const rule = css.match(/\.lp-skip\s*\{[^}]*\}/)?.[0] || '';
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /top:\s*-100px|transform:\s*translateY\(-200%\)/);
  const focused = css.match(/\.lp-skip:focus(-visible)?\s*\{[^}]*\}/)?.[0] || '';
  assert.match(focused, /top:\s*8px|transform:\s*none/);
  assert.match(focused, /z-index:\s*1100/);
});

test('every shared control clears 44px on phones', () => {
  const css = read('./static-page.css');
  const phone = css.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(phone, /\.lp-btn \{[^}]*min-height: 44px/);
  assert.match(css, /\.lp-bar__link \{[^}]*min-height: 44px/);
  assert.match(css, /\.lp-footer a \{[^}]*min-height: 44px/);
});
