import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const PACKAGE = new URL('../../package.json', import.meta.url);
const LOCK = new URL('../../package-lock.json', import.meta.url);

// "0.35.4" -> [0, 35, 4]; enough for the two exact versions compared here.
const triple = (version) => version.replace(/^[^\d]*/, '').split('.').map(Number);
const compare = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};

/**
 * wrangler (pinned exactly, it is the CLI the Worker is deployed with) pulls
 * miniflare, and miniflare pinned sharp@0.35.2 — the version `npm audit` flags
 * (GHSA-rgj7-g3m4-5g8c, libheif). The override lifts sharp without moving
 * wrangler. It is dead weight the day miniflare asks for that version itself,
 * and harmful the day it asks for a newer one, so the test says which.
 */
test('sharp is held at 0.35.4 under miniflare, and the lockfile agrees', async () => {
  const pkg = JSON.parse(await readFile(PACKAGE, 'utf8'));
  assert.equal(pkg.overrides?.sharp, '0.35.4', 'package.json has no sharp override');

  const lock = JSON.parse(await readFile(LOCK, 'utf8'));
  assert.equal(lock.packages['node_modules/sharp']?.version, '0.35.4',
    'package-lock.json was not regenerated after the override (run npm install)');

  const miniflare = lock.packages['node_modules/miniflare'];
  assert.ok(miniflare?.dependencies?.sharp, 'miniflare is what pulls sharp in; if that changed, the override may be pointless');
  assert.ok(compare(triple(pkg.overrides.sharp), triple(miniflare.dependencies.sharp)) > 0,
    `miniflare asks for sharp ${miniflare.dependencies.sharp} on its own: the override no longer raises anything, remove it`);
});
