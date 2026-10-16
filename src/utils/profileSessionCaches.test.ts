import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OWN_LISTS_FRESH_MS,
  forgetOwnLists,
  ownListsAreFresh,
  ownListsCache,
  rememberOwnLists,
  reviseOwnLists,
} from './profileSessionCaches.ts';

/**
 * The freshness window on the lists read. Saving fifty papers in a row opened
 * the save modal fifty times and re-read all sixty list documents each time,
 * which is what saturated into an endless skeleton.
 */

test('a lists read just taken is fresh, and an unknown account never is', () => {
  const now = 1_000_000;
  rememberOwnLists('uid-a', [{ id: 'l1', paperIds: [] }]);
  assert.equal(ownListsAreFresh('uid-a', now + 1), true);
  assert.equal(ownListsAreFresh('uid-b', now), false, 'nothing cached, nothing to trust');
  assert.equal(ownListsAreFresh(null, now), false);
  forgetOwnLists('uid-a');
});

test('freshness expires, and the read happens again', () => {
  rememberOwnLists('uid-c', [{ id: 'l1' }]);
  const readAt = Date.now();
  assert.equal(ownListsAreFresh('uid-c', readAt + OWN_LISTS_FRESH_MS - 1), true);
  assert.equal(ownListsAreFresh('uid-c', readAt + OWN_LISTS_FRESH_MS), false, 'the window is exclusive');
  assert.equal(ownListsAreFresh('uid-c', readAt + OWN_LISTS_FRESH_MS + 5_000), false);
  forgetOwnLists('uid-c');
});

test('a write-through updates the lists WITHOUT pretending they were re-read', () => {
  // Otherwise every save would renew the window and the lists could go stale
  // for as long as somebody kept saving.
  rememberOwnLists('uid-d', [{ id: 'l1', paperIds: [] }]);
  const readAt = Date.now();
  reviseOwnLists('uid-d', [{ id: 'l1', paperIds: ['p1'] }]);

  assert.deepEqual(ownListsCache.get('uid-d'), [{ id: 'l1', paperIds: ['p1'] }]);
  assert.equal(ownListsAreFresh('uid-d', readAt + OWN_LISTS_FRESH_MS + 1), false,
    'the clock still runs from the last real read');
  forgetOwnLists('uid-d');
});

test('forgetting an account leaves nothing behind for the next one', () => {
  rememberOwnLists('uid-e', [{ id: 'l1' }]);
  forgetOwnLists('uid-e');
  assert.equal(ownListsCache.get('uid-e'), undefined);
  assert.equal(ownListsAreFresh('uid-e', Date.now()), false);
});

test('rubbish is refused rather than cached', () => {
  rememberOwnLists('uid-f', null);
  rememberOwnLists(null, [{ id: 'l1' }]);
  assert.equal(ownListsCache.get('uid-f'), undefined);
  assert.equal(ownListsAreFresh('uid-f', Date.now()), false);
});

/* --- Both readers of the collection paint from the cache both of them stamp ---
   The lists page called `rememberOwnLists` on every visit and never read it
   back, which made it the one screen this cache was written for that did not
   use it. It was not a quiet inefficiency: Favorites, Read later and Reading
   history are synthesised from contexts already in memory, so three cards
   painted in the first frame and the owner's own lists dropped in seconds
   later, growing the grid under someone already reading it. The save modal has
   seeded from `ownListsCache.get(uid)` since it was written; the difference
   between the two files was the bug. */

const OWN_LISTS_READERS = [
  '../components/Lists/ListsPage.tsx',
  '../components/Lists/SaveToListModal.tsx',
];

test('SOURCE: every screen that reads the lists collection seeds from the session cache', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const path of OWN_LISTS_READERS) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');

    assert.ok(source.includes('rememberOwnLists'),
      `${path}: a screen that reads the collection must stamp the cache`);
    assert.ok(source.includes('ownListsCache.get'),
      `${path}: it must also PAINT from it — stamping a cache nobody reads is the bug`);
    assert.ok(source.includes('readStoredLists'),
      `${path}: a reload must seed from this device, not wait on a cold channel`);
    // Seeded in the initialiser, not in an effect: a seed that lands after the
    // first commit still paints the empty state for a frame, which is the
    // flicker this exists to remove.
    assert.match(source, /useState(?:<[^;\n]+>)?\(\(\)\s*=>\s*seededLists\s*\?\?\s*\[\]\)/,
      `${path}: the seed belongs in the useState initialiser`);
  }
});
