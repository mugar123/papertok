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
  // Comments are prose, not code: this file in particular carries long
  // explanatory comments right above this listener, and a decoy inside one
  // of them must never make this test see a brake that is not really there.
  // Strip them first, the same way analyticsPageviews.test.js does.
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  const handler = code.match(
    /window\.addEventListener\('vite:preloadError', \(event\) => \{[\s\S]*?\n\s*\}\)/,
  );
  assert.ok(handler, 'the vite:preloadError listener is gone');
  // The real listener is well under twenty lines. A much longer capture
  // means the regex ran past it into unrelated code below.
  const handlerLines = handler[0].split('\n');
  assert.ok(handlerLines.length <= 16, `listener capture spans ${handlerLines.length} lines, past the real handler`);

  const body = handler[0];
  // A handler that reloads on every failure, with no brake, used to satisfy
  // this test too: the three substrings it checked for all still appear
  // somewhere in a handler like that, and an unbraked reload loop is exactly
  // what this listener exists to prevent. Tie the threshold guard, the write
  // that remembers this attempt, and the reload it gates into one contiguous
  // match inside the SAME handler, in that order.
  assert.match(
    body,
    /if \(now - last < 60_000\) return\s*sessionStorage\.setItem\(PRELOAD_RELOAD_KEY, String\(now\)\)\s*\}[\s\S]*?event\.preventDefault\(\)\s*window\.location\.reload\(\)/,
    'a reload must be gated by the 60s threshold and follow the recorded attempt',
  );
  // ...and that the guarded pair is not ALSO reachable earlier, unconditionally:
  // tying the order proves a guarded path exists, not that it is the only one.
  const preventDefaultCalls = body.match(/event\.preventDefault\(\)/g) ?? [];
  assert.equal(preventDefaultCalls.length, 1, 'preventDefault must run on exactly one path: the guarded reload');
  const reloadCalls = body.match(/window\.location\.reload\(\)/g) ?? [];
  assert.equal(reloadCalls.length, 1, 'the tab must be reloaded from exactly one place in this handler');
});
