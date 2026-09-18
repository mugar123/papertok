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

test('the prerender plugin targets index.html and serves /feed from app.html in dev and preview', () => {
  const config = noComments(read('vite.config.js'));
  assert.match(config, /ctx\.filename\.endsWith\('index\.html'\)/);
  assert.match(config, /configureServer/);
  assert.match(config, /configurePreviewServer/);
  // Pins the real pathname: without this, narrowing feedToApp's condition to
  // (say) '/feeds' would still satisfy every other assertion here while vite
  // dev/preview quietly served the LANDING at /feed instead of the app.
  assert.match(config, /pathname === '\/feed'/);
  assert.match(config, /req\.url = '\/app\.html'/);
});

test('the /feed middleware carries a query string over to app.html instead of dropping it', () => {
  const config = noComments(read('vite.config.js'));
  const middleware = config.match(/function feedToApp\([\s\S]*?\n\}/)?.[0] || '';
  assert.ok(middleware, 'feedToApp is gone');
  // The pathname/query split must keep the query half, not just the pathname
  // (a `.split('?')[0]` would already have thrown it away here).
  assert.match(middleware, /const \[pathname, \.\.\.query\] = \(req\.url \|\| ''\)\.split\('\?'\)/);
  // And the query, once kept, has to actually be re-attached to req.url.
  assert.match(middleware, /if \(query\.length\) req\.url \+= `\?\$\{query\.join\('\?'\)\}`/);
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
