import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const VERCEL = new URL('../../vercel.json', import.meta.url);
const MAIN = new URL('../main.jsx', import.meta.url);

test('the SPA rewrite never answers a missing chunk with index.html', async () => {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  const spa = config.rewrites.find(rule => rule.destination === '/index.html');
  assert.ok(spa, 'the SPA rewrite is gone');
  // Vercel compiles `/:path(<pattern>)` with path-to-regexp; the custom
  // pattern inside the parentheses is a plain regex, which is what this runs.
  const pattern = spa.source.match(/^\/:path\((.+)\)$/)?.[1];
  assert.ok(pattern, `unexpected rewrite source ${spa.source}`);
  const matches = value => new RegExp(`^${pattern}$`).test(value);
  assert.ok(matches('lists'));
  assert.ok(matches('public/paper/10.1234%2Fabc'));
  assert.ok(!matches('_vercel/insights/script.js'));
  // A tab that outlives a deploy asks for a chunk by its old hash. That has to
  // be a 404 Vite can report, not HTML served as JavaScript with a 200.
  assert.ok(!matches('assets/index-DToPZZZM.js'));
  assert.ok(!matches('assets/CommentsSheet-Da9L05_h.css'));
});

test('SOURCE: a failed chunk load reloads the tab once a minute at most', async () => {
  const source = await readFile(MAIN, 'utf8');
  assert.match(source, /addEventListener\('vite:preloadError'/);
  assert.match(source, /sessionStorage/);
  assert.match(source, /window\.location\.reload\(\)/);
});
