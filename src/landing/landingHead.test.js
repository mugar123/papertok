import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('the session gate is the first script in the head, before any stylesheet', () => {
  assert.match(scripts[0], /localStorage\.getItem\('papertok_signed_in'\) === '1'/);
  assert.match(scripts[0], /location\.replace\('\/feed'\)/);
  assert.ok(html.indexOf('<script>') < html.indexOf('<link rel="stylesheet"'));
});
test('a deep link keeps its hash on the way to the app', () => {
  assert.match(scripts[0], /hash\.indexOf\('#\/'\) === 0/);
  assert.match(scripts[0], /location\.replace\('\/feed' \+ hash\)/);
});
test('the theme and motion gates are still there after the session gate', () => {
  assert.match(scripts[1], /papertok_theme/);
  assert.match(scripts[2], /data-motion/);
});
test('AuthContext writes the mark on sign-in and clears it on sign-out', () => {
  const ctx = readFileSync(fileURLToPath(new URL('../context/AuthContext.jsx', import.meta.url)), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(ctx, /import \{ markSignedIn, clearSignedIn \} from '\.\.\/utils\/sessionMark\.js'/);
  assert.match(ctx, /currentUser \? markSignedIn\(\) : clearSignedIn\(\)/);
});
