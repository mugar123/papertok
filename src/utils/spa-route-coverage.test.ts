import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * The SPA rewrite in vercel.json names the route prefixes app.tsx declares,
 * so an address nobody declared is a real HTTP 404 (public/404.html) instead
 * of the app answering 200 for anything (audit 2026-09-23, issue 12).
 */

const VERCEL = new URL('../../vercel.json', import.meta.url);

async function spaMatcher() {
  const config = JSON.parse(await readFile(VERCEL, 'utf8'));
  const spa = config.rewrites.find((rule: { source: string; }) => rule.source.startsWith('/:path('));
  assert.ok(spa, 'the SPA rewrite is gone');
  assert.equal(spa.destination, '/index.html');
  const pattern = spa.source.match(/^\/:path\((.+)\)$/)?.[1];
  assert.ok(pattern, `unexpected rewrite source ${spa.source}`);
  const regex = new RegExp(`^${pattern}$`);
  return (path: string) => regex.test(path.replace(/^\//, ''));
}

test('an address nobody declared is left to the 404 page', async () => {
  const matches = await spaMatcher();
  for (const path of ['/esto-no-existe', '/perfil-papertok.html', '/feeds', '/publico/paper/x', '/wp-login.php', '/admin/moderation']) {
    assert.ok(!matches(path), `${path} still gets the app with a 200`);
  }
});
