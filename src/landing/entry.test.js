// src/landing/entry.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const path = (rel) => fileURLToPath(new URL(rel, ROOT));
const read = (rel) => readFileSync(path(rel), 'utf8');
const noComments = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('the app is app.html and the landing is index.html', () => {
  assert.ok(existsSync(path('app.html')));
  assert.match(read('app.html'), /<div id="root"/);
  assert.match(read('index.html'), /<!--landing-html-->/);
  assert.doesNotMatch(read('index.html'), /<div id="root"/);
});

test('the Rollup input keeps the key `index` for the app and adds the landing', () => {
  const input = noComments(read('vite.config.js')).match(/input:\s*\{([\s\S]*?)\}/)?.[1] || '';
  assert.match(input, /\bindex:\s*fileURLToPath\(new URL\('\.\/app\.html'/);
  assert.match(input, /\blanding:\s*fileURLToPath\(new URL\('\.\/index\.html'/);
});

test('the boot-set transform reads the built app page, not the landing', () => {
  const config = noComments(read('vite.config.js'));
  assert.match(config, /readFileSync\(join\(distDir, 'app\.html'\)/);
});

test('the prerender plugin targets index.html and serves the app from app.html in dev and preview', () => {
  const config = noComments(read('vite.config.js'));
  assert.match(config, /ctx\.filename\.endsWith\('index\.html'\)/);
  assert.match(config, /configureServer/);
  assert.match(config, /configurePreviewServer/);
  assert.match(config, /req\.url = '\/app\.html'/);
});

/* The middleware is RUN, not read. A regex over its text can pin a literal
   `'/feed'` and still miss the thing that matters — which paths come out as
   app.html and which are left alone — and the routes stopped being one path
   the day they left the fragment. `new Function` gives it exactly the module
   scope it touches, the way landingHead.test.js runs index.html's gate. */
const runMiddleware = () => {
  const config = noComments(read('vite.config.js'));
  const roots = config.match(/const APP_ROUTE_ROOTS = \[[\s\S]*?\n\]/)?.[0];
  assert.ok(roots, 'APP_ROUTE_ROOTS is gone from vite.config.js');
  const fn = config.match(/function feedToApp\([\s\S]*?\n\}/)?.[0];
  assert.ok(fn, 'feedToApp is gone');
  const feedToApp = new Function(`${roots}\n${fn}\nreturn feedToApp;`)();
  return (url) => {
    const req = { url };
    let nexted = false;
    feedToApp(req, {}, () => { nexted = true; });
    assert.ok(nexted, `feedToApp swallowed ${url} instead of calling next()`);
    return req.url;
  };
};

test('dev and preview serve EVERY app route from app.html, not just /feed', () => {
  // Production settles this with vercel.json's catch-all. `vite dev` and `vite
  // preview` have no such rule, and their own SPA fallback hands index.html —
  // the LANDING — to anything it does not recognise. While the app lived
  // entirely in the fragment there was one path to rewrite; now there are as
  // many as there are routes, and a miss does not error, it quietly shows the
  // marketing page where the app should be.
  const rewrite = runMiddleware();
  for (const url of [
    '/feed', '/feed/', '/following', '/research', '/report', '/lists', '/search',
    '/profile', '/settings', '/settings/profile', '/onboarding', '/login',
    '/admin/moderation', '/explorer/author/A5023888391',
    '/public/paper/YXJ4aXY6MjQwMS4xMjM0NQ', '/public/user/ada', '/public/list/abc',
  ]) {
    assert.equal(rewrite(url), '/app.html', `${url} must be served by the app`);
  }
});

test('the middleware leaves the landing, the policy and every real file alone', () => {
  const rewrite = runMiddleware();
  for (const url of [
    '/',                       // the landing, which is the whole point of index.html
    '/privacy.html',           // its own page
    '/assets/index-DToPZZZM.js',
    '/favicon.svg', '/sw.js', '/manifest.webmanifest', '/og/papertok-share-0.2.png',
    '/@vite/client', '/src/main.jsx', '/node_modules/.vite/deps/react.js',
    '/feeds',                  // not a route: an exact root, not a prefix
    '/researchers',
  ]) {
    assert.equal(rewrite(url), url, `${url} must not be rewritten to the app`);
  }
});

test('the middleware carries a query string over to app.html instead of dropping it', () => {
  // Every `?probe=` cache-buster in scripts/diagnostics depends on this, and so
  // does the query half of index.html's own gate.
  const rewrite = runMiddleware();
  assert.equal(rewrite('/feed?probe=7'), '/app.html?probe=7');
  assert.equal(rewrite('/research?a=1&b=2'), '/app.html?a=1&b=2');
  assert.equal(rewrite('/search?q=a?b'), '/app.html?q=a?b', 'a question mark inside the query survives');
});

test('the middleware knows every route root App.jsx declares', () => {
  // The list is explicit because this middleware runs BEFORE Vite's own
  // (/@vite/, /src/, /node_modules/, HMR), so it cannot be a catch-all. That
  // makes it the kind of list that rots: a route added to App.jsx and not here
  // serves the landing in preview, silently. This is the reminder.
  const config = noComments(read('vite.config.js'));
  const roots = new Set(
    (config.match(/const APP_ROUTE_ROOTS = \[[\s\S]*?\n\]/)?.[0] || '')
      .matchAll(/'([^']+)'/g),
  );
  const declared = new Set(
    [...noComments(read('src/App.jsx')).matchAll(/<Route\s+path="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((path) => path !== '*')
      .map((path) => path.split('/')[1]),
  );
  assert.ok(declared.size > 5, 'no routes found in App.jsx — the regex stopped matching');
  const known = new Set([...roots].map((m) => m[1]));
  for (const root of declared) {
    assert.ok(known.has(root), `App.jsx routes /${root}/… but vite.config.js does not serve it`);
  }
});

test('Vercel sends /feed and every SPA path to app.html; a direct request for app.html is never cached', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const feed = vercel.rewrites.find((r) => r.source === '/feed');
  assert.equal(feed?.destination, '/app.html');
  const spa = vercel.rewrites.find((r) => r.source.startsWith('/:path('));
  assert.equal(spa?.destination, '/app.html');
  assert.ok(vercel.rewrites.indexOf(feed) < vercel.rewrites.indexOf(spa));
  const header = vercel.headers.find((h) => h.source === '/app.html');
  assert.equal(header?.headers[0].value, 'public, max-age=0, must-revalidate');
});

test('the PWA starts in the app and the service worker warms /feed, not the landing', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest'));
  assert.equal(manifest.start_url, './feed#/');
  const warm = noComments(read('public/sw-html-warm.js'));
  assert.match(warm, /new URL\('feed', self\.registration\.scope\)/);
  assert.doesNotMatch(warm, /cache\.add\(self\.registration\.scope\)/);
});

test('the app page is canonical at /feed', () => {
  const app = read('app.html');
  assert.match(app, /<link rel="canonical" href="https:\/\/papertok\.app\/feed" \/>/);
  assert.match(app, /<meta property="og:url" content="https:\/\/papertok\.app\/feed" \/>/);
  assert.match(app, /<meta name="twitter:url" content="https:\/\/papertok\.app\/feed" \/>/);
});

test('the "Open the feed" link in privacy.html points at /feed, not at the landing', () => {
  const privacy = read('privacy.html');
  const cta = privacy.match(/<a[^>]*class="lp-btn"[^>]*>[\s\S]*?<\/a>/)?.[0] || '';
  assert.match(cta, /href="\/feed"/, 'the privacy page CTA must reach the feed');
  assert.doesNotMatch(cta, /href="\/"/);
});
