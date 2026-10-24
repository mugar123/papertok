import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const VERCEL = new URL('../../vercel.json', import.meta.url);

test('the SPA rewrite never answers a missing chunk with the app document', async () => {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  // Matched by its `/:path(...)` source, not by destination alone: a second
  // rule sharing this destination has existed before (the `/feed` one, while
  // the app lived at app.html), and destination-only lookup would silently
  // grab that one instead of the catch-all this test means.
  const spa = config.rewrites.find((rule: { source: string; }) => rule.source.startsWith('/:path('));
  assert.ok(spa, 'the SPA rewrite is gone');
  assert.equal(spa.destination, '/index.html');
  // Vercel compiles `/:path(<pattern>)` with path-to-regexp; the custom
  // pattern inside the parentheses is a plain regex, which is what this runs.
  const pattern = spa.source.match(/^\/:path\((.+)\)$/)?.[1];
  assert.ok(pattern, `unexpected rewrite source ${spa.source}`);
  const matches = (value: string) => new RegExp(`^${pattern}$`).test(value);
  assert.ok(matches('lists'));
  assert.ok(matches('public/paper/10.1234%2Fabc'));
  assert.ok(!matches('_vercel/insights/script.js'));
  assert.ok(!matches('ingest/e/'));
  // A tab that outlives a deploy asks for a chunk by its old hash. That has to
  // be a 404 Vite can report, not HTML served as JavaScript with a 200.
  assert.ok(!matches('assets/index-DToPZZZM.js'));
  // Firebase's sign-in handler is proxied, not part of the SPA: answered with
  // the app document it would hand Google an HTML page instead of the handler
  // and every sign-in would hang on a blank popup.
  assert.ok(!matches('__/auth/handler'));
});

test('the sign-in handler reaches Firebase ahead of the SPA rewrite', async () => {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  const proxy = config.rewrites.find((rule: { source: string; }) => rule.source.startsWith('/__/auth/'));
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
  // Matched by source, not destination: a rule sharing the SPA catch-all's
  // own destination has sat before it before, and would be found first.
  const spa = config.rewrites.findIndex((rule: { source: string; }) => rule.source.startsWith('/:path('));
  assert.ok(
    config.rewrites.indexOf(proxy) < spa,
    'the proxy must come before the SPA rewrite',
  );
});

test('analytics sent to our own /ingest reaches PostHog\'s EU host', async () => {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  // The `api_host` that analytics-service.ts gives PostHog. A rule missing here sends
  // every event to a 404, and nothing in the app would notice: PostHog's
  // requests fail silently.
  const apiHost = '/ingest';
  const proxy = config.rewrites.find((rule: { source: string; }) => rule.source === `${apiHost}/:path(.*)`);
  assert.ok(proxy, `no rewrite forwards ${apiHost}/* to PostHog`);
  assert.equal(proxy.destination, 'https://eu.i.posthog.com/:path');
  const spa = config.rewrites.findIndex((rule: { source: string; }) => rule.source.startsWith('/:path('));
  assert.ok(config.rewrites.indexOf(proxy) < spa, 'the proxy must come before the SPA rewrite');

  // Replay, surveys and the other lazily loaded scripts, and the remote
  // config, come from PostHog's asset host. Behind the catch-all they would be
  // sent to the ingestion host instead and never load.
  for (const kind of ['static', 'array']) {
    const assets = config.rewrites.find((rule: { source: string; }) => rule.source === `${apiHost}/${kind}/:path(.*)`);
    assert.equal(assets?.destination, `https://eu-assets.i.posthog.com/${kind}/:path`);
    assert.ok(config.rewrites.indexOf(assets) < config.rewrites.indexOf(proxy), `${kind} must come before the catch-all proxy`);
  }
});

// Vercel applies every header rule whose source matches the requested path.
// This models the two source forms vercel.json uses for site-wide rules: a
// literal path, and `/:path(<pattern>)`, whose pattern is a plain regex over
// the path without its leading slash. The second is taken not to match `/`:
// measured on 2026-09-01, Vercel's router did not match `/:path*` against the
// root, so the root needs a literal rule of its own.
type HeaderRule = { source: string; headers: { key: string; value: string }[] };

function headersFor(config: { headers: HeaderRule[] }, path: string) {
  const applied: Record<string, string> = {};
  for (const rule of config.headers) {
    const pattern = rule.source.match(/^\/:path\((.+)\)$/)?.[1];
    const matches = pattern
      ? path !== '/' && new RegExp(`^${pattern}$`).test(path.slice(1))
      : rule.source === path;
    if (!matches) continue;
    for (const { key, value } of rule.headers) applied[key.toLowerCase()] = value;
  }
  return applied;
}

test('every page refuses framing by other sites, MIME sniffing and referrers that reveal a path', async () => {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  const paths = ['/', '/feed', '/privacy.html', '/assets/pdf.worker.min-Bx1c2d3e.mjs', '/no-such-page'];
  for (const path of paths) {
    const headers = headersFor(config, path);
    const frameAncestors = (headers['content-security-policy'] ?? '')
      .split(';')
      .map(directive => directive.trim())
      .find(directive => directive.startsWith('frame-ancestors '));
    assert.equal(frameAncestors, "frame-ancestors 'self'", `${path} can be framed by another site`);
    // For browsers that predate frame-ancestors.
    assert.equal(headers['x-frame-options'], 'SAMEORIGIN', path);
    assert.equal(headers['x-content-type-options'], 'nosniff', path);
    // The same rule as the referrer meta in index.html: `strict-origin-when-cross-origin` sends the
    // full URL to our own origin, which put /public/paper/<key> in a header.
    assert.ok(
      ['strict-origin', 'origin', 'no-referrer'].includes(headers['referrer-policy']),
      `${path} gets referrer policy ${JSON.stringify(headers['referrer-policy'])}, which can send its path`,
    );
  }
});

test('Firebase\'s sign-in handler keeps its own headers', async () => {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  // The popup, the redirect and the iframe the SDK opens on our pages are all
  // served by Firebase through the /__/auth/ proxy, so vercel.json leaves
  // their framing and referrer rules to Firebase.
  const keys = ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'referrer-policy'];
  for (const path of ['/__/auth/handler', '/__/auth/iframe', '/__/auth/handler.js']) {
    const headers = headersFor(config, path);
    for (const key of keys) {
      assert.equal(headers[key], undefined, `${path} gets ${key} from vercel.json`);
    }
  }
});
