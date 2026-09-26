import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The SPA rewrite in vercel.json names the route prefixes App.jsx declares,
 * so an address nobody declared is a real HTTP 404 (public/404.html) instead
 * of the app answering 200 for anything (audit 2026-09-23, issue 12). The
 * danger of narrowing is the other way round, so this derives the routes from
 * App.jsx and checks each one still reaches the app.
 */

const VERCEL = new URL('../../vercel.json', import.meta.url);
const APP = new URL('../App.jsx', import.meta.url);
const NOT_FOUND = new URL('../../public/404.html', import.meta.url);

async function spaMatcher() {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  const spa = config.rewrites.find(rule => rule.source.startsWith('/:path('));
  assert.ok(spa, 'the SPA rewrite is gone');
  assert.equal(spa.destination, '/index.html');
  const pattern = spa.source.match(/^\/:path\((.+)\)$/)?.[1];
  assert.ok(pattern, `unexpected rewrite source ${spa.source}`);
  const regex = new RegExp(`^${pattern}$`);
  return path => regex.test(path.replace(/^\//, ''));
}

async function declaredRoutes() {
  const code = (await readFile(APP, 'utf8')).replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
  const routes = code.slice(code.indexOf('<Routes'), code.indexOf('</Routes>'));
  const paths = [...routes.matchAll(/<Route\s+path="([^"]+)"/g)].map(match => match[1]);
  assert.ok(paths.length >= 15, 'the route table did not parse');
  return paths.filter(path => path !== '*' && path !== '/');
}

// A route with its parameters filled the way real links fill them.
function sample(path) {
  return path
    .replace(':paperKey', 'ZG9pOjEwLjExNDUvMzU1NTE3NA')
    .replace(':shareId', '0123456789abcdef0123456789abcdef')
    .replace(':handle', 'ada_l')
    .replace(':type', 'author')
    .replace(':id', 'A5018713931');
}

test('every route App.jsx declares still reaches the app', async () => {
  const matches = await spaMatcher();
  for (const route of await declaredRoutes()) {
    const path = sample(route);
    assert.ok(matches(path), `${route} (${path}) would be a 404`);
    assert.ok(matches(`${path}/`), `${route} with a trailing slash would be a 404`);
  }
  // Query strings never reach the matcher; ids can carry encoded slashes.
  assert.ok(matches('/public/entity/institution/https%3A%2F%2Fror.org%2F02f40zc51'));
});

test('an address nobody declared is left to the 404 page', async () => {
  const matches = await spaMatcher();
  for (const path of ['/esto-no-existe', '/perfil-papertok.html', '/feeds', '/publico/paper/x', '/wp-login.php']) {
    assert.ok(!matches(path), `${path} still gets the app with a 200`);
  }
});

test('the 404 page is in English, has its own main and h1, and is not indexed', async () => {
  const html = await readFile(NOT_FOUND, 'utf8');
  assert.match(html, /<meta name="robots" content="noindex" \/>/);
  assert.match(html, /<html lang="en">/);
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<h1>We could not find this page<\/h1>/);
  assert.equal((html.match(/href="\/feed"/g) || []).length, 1, 'one way back');
  assert.doesNotMatch(html, /outline:\s*(?:none|0)\b/, 'focus stays visible');
});
