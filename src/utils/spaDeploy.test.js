import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const VERCEL = new URL('../../vercel.json', import.meta.url);
const MAIN = new URL('../main.jsx', import.meta.url);
const FIREBASE = new URL('../services/firebase.js', import.meta.url);

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
  // Firebase's sign-in handler is proxied, not part of the SPA: answered with
  // index.html it would hand Google an HTML page instead of the handler and
  // every sign-in would hang on a blank popup.
  assert.ok(!matches('__/auth/handler'));
});

test('sign-in redirects to our own domain, and its handler reaches Firebase', async () => {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  const proxy = config.rewrites.find(rule => rule.source.startsWith('/__/auth/'));
  assert.ok(proxy, 'the auth handler proxy is gone');
  assert.equal(proxy.source, '/__/auth/:path*');
  // `handler` pulls `handler.js` and `experiments.js` as relative paths, so the
  // whole subtree has to be proxied, not just the handler document.
  assert.equal(
    proxy.destination,
    'https://papertok-168df.firebaseapp.com/__/auth/:path*',
  );
  // Vercel takes the first rewrite that matches. Behind the SPA catch-all this
  // rule would never run, and the exclusion above would be the only guard.
  const spa = config.rewrites.findIndex(rule => rule.destination === '/index.html');
  assert.ok(
    config.rewrites.indexOf(proxy) < spa,
    'the proxy must come before the SPA rewrite',
  );

  // The proxy is only half of it: unless the SDK is told to use our domain,
  // Google keeps redirecting to the firebaseapp.com host and keeps announcing
  // it on the sign-in page. Strip comments first so prose above this line
  // cannot pass for config, but leave `//` inside URLs alone.
  const code = (await readFile(FIREBASE, 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const authDomain = code.match(/authDomain:\s*['"]([^'"]+)['"]/)?.[1];
  assert.equal(authDomain, 'papertok.app');
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
  //
  // Counted as CODE lines, not raw ones: stripping a comment above leaves the
  // blank line behind, so a comment added to the handler used to spend the
  // budget this guard exists to protect. What it is watching for is a capture
  // that ran into unrelated statements, and blank lines are not statements.
  const handlerLines = handler[0].split('\n').filter((line) => line.trim() !== '');
  assert.ok(handlerLines.length <= 16, `listener capture spans ${handlerLines.length} code lines, past the real handler`);

  const body = handler[0];
  // `markAppForcedReload()` is part of the sequence, not incidental: a reload
  // this handler performs is one the reader did not ask for, and an unmarked
  // one would make the feed start fresh underneath them (utils/appReload.js).
  //
  // A handler that reloads on every failure, with no brake, used to satisfy
  // this test too: the three substrings it checked for all still appear
  // somewhere in a handler like that, and an unbraked reload loop is exactly
  // what this listener exists to prevent. Tie the threshold guard, the write
  // that remembers this attempt, and the reload it gates into one contiguous
  // match inside the SAME handler, in that order.
  assert.match(
    body,
    /if \(now - last < 60_000\) return\s*sessionStorage\.setItem\(PRELOAD_RELOAD_KEY, String\(now\)\)\s*\}[\s\S]*?event\.preventDefault\(\)\s*markAppForcedReload\(\)\s*window\.location\.reload\(\)/,
    'a reload must be gated by the 60s threshold, follow the recorded attempt, and be marked as the app\'s own',
  );
  // ...and that the guarded pair is not ALSO reachable earlier, unconditionally:
  // tying the order proves a guarded path exists, not that it is the only one.
  const preventDefaultCalls = body.match(/event\.preventDefault\(\)/g) ?? [];
  assert.equal(preventDefaultCalls.length, 1, 'preventDefault must run on exactly one path: the guarded reload');
  const reloadCalls = body.match(/window\.location\.reload\(\)/g) ?? [];
  assert.equal(reloadCalls.length, 1, 'the tab must be reloaded from exactly one place in this handler');
});
