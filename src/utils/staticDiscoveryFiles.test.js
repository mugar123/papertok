import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * public/sitemap.xml and public/robots.txt against the routes App.jsx
 * declares. The sitemap listed /, /following and /research: / is not
 * canonical (the shell's canonical is /feed), and the other two send a
 * visitor, and so a crawler, back to /feed (audit 2026-09-23, issue 5).
 */

const APP = new URL('../App.jsx', import.meta.url);
const SITEMAP = new URL('../../public/sitemap.xml', import.meta.url);
const ROBOTS = new URL('../../public/robots.txt', import.meta.url);

async function protectedPaths() {
  const code = (await readFile(APP, 'utf8')).replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
  const routes = code.slice(code.indexOf('<Routes'), code.indexOf('</Routes>'));
  assert.ok(routes.length > 0, 'the route table is gone');
  const chunks = routes.split('<Route').slice(1);
  // Guarded only when the element IS the guard: /feed wraps it in one branch
  // of a ternary, for a session, and is the guest's own page otherwise.
  const paths = chunks
    .map(chunk => ({
      path: chunk.match(/^\s+path="([^"]+)"/)?.[1],
      guarded: /element=\{\s*(?:<PageTransition>\s*)?<ProtectedRoute\b/.test(chunk),
    }))
    .filter(route => route.path);
  assert.ok(paths.length >= 10, 'the route table did not parse');
  return paths.filter(route => route.guarded).map(route => route.path);
}

test('the sitemap lists canonical pages only', async () => {
  const sitemap = await readFile(SITEMAP, 'utf8');
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
  assert.ok(locations.includes('https://papertok.app/feed'));
  assert.ok(!locations.includes('https://papertok.app/'), 'the root is not canonical: the shell names /feed');
  const guarded = await protectedPaths();
  for (const location of locations) {
    const path = new URL(location).pathname;
    assert.equal(new URL(location).origin, 'https://papertok.app');
    assert.ok(!guarded.some(route => path === route || path.startsWith(`${route}/`)), `${path} sends a visitor to /feed`);
  }
});

test('robots.txt keeps crawlers out of every page that needs an account', async () => {
  const robots = await readFile(ROBOTS, 'utf8');
  const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)\s*$/gm)].map(match => match[1]);
  for (const route of await protectedPaths()) {
    const root = `/${route.split('/')[1]}`;
    assert.ok(disallowed.includes(root), `${route} is not disallowed`);
  }
  assert.ok(!disallowed.some(path => '/public/paper/x'.startsWith(path) || '/feed'.startsWith(path)), 'the public pages stay open');
  assert.match(robots, /^Sitemap: https:\/\/papertok\.app\/sitemap\.xml$/m);
});
