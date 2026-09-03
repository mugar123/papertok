import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { growMountWindow, inMountWindow, initialMountWindow, mountWindowCovers } from './feedMountWindow.js';

test('a feed opens on the card it was on, one neighbour either side', () => {
  assert.deepEqual(initialMountWindow({ total: 30, anchorIndex: 0 }), { lo: 0, hi: 2 });
  assert.deepEqual(initialMountWindow({ total: 30, anchorIndex: 20 }), { lo: 19, hi: 22 });
  assert.deepEqual(initialMountWindow({ total: 30, anchorIndex: 29 }), { lo: 28, hi: 30 });
  assert.deepEqual(initialMountWindow({ total: 30, anchorIndex: 99 }), { lo: 28, hi: 30 }, 'an anchor past the end is the last card');
  assert.deepEqual(initialMountWindow({ total: 0, anchorIndex: 3 }), { lo: 0, hi: 0 });
  assert.deepEqual(initialMountWindow({ total: 2, anchorIndex: 0 }), { lo: 0, hi: 2 });
});

test('the window grows outwards in steps, below first, until it covers the feed', () => {
  let window = initialMountWindow({ total: 10, anchorIndex: 4 });
  assert.deepEqual(window, { lo: 3, hi: 6 });
  window = growMountWindow(window, 10, 3);
  assert.deepEqual(window, { lo: 3, hi: 9 }, 'three more below');
  window = growMountWindow(window, 10, 3);
  assert.deepEqual(window, { lo: 1, hi: 10 }, 'one below is all that is left, the other two go above');
  window = growMountWindow(window, 10, 3);
  assert.deepEqual(window, { lo: 0, hi: 10 });
  assert.equal(mountWindowCovers(window, 10), true);
  assert.deepEqual(growMountWindow(window, 10, 3), { lo: 0, hi: 10 }, 'a covering window stays put');
  assert.deepEqual(growMountWindow(window, 14, 3), { lo: 0, hi: 13 }, 'and grows again when the feed appends a page');
});

test('membership and coverage are half-open on the high side', () => {
  const window = { lo: 2, hi: 5 };
  assert.equal(inMountWindow(window, 1), false);
  assert.equal(inMountWindow(window, 2), true);
  assert.equal(inMountWindow(window, 4), true);
  assert.equal(inMountWindow(window, 5), false);
  assert.equal(mountWindowCovers({ lo: 0, hi: 5 }, 5), true);
  assert.equal(mountWindowCovers({ lo: 1, hi: 5 }, 5), false);
  assert.equal(mountWindowCovers({ lo: 0, hi: 0 }, 0), true);
});

test('SOURCE: the container mounts a window and grows it off the critical path', async () => {
  const code = await readFile(new URL('../components/Feed/FeedContainer.jsx', import.meta.url), 'utf8');
  assert.match(code, /initialMountWindow\(\{ total: papers\.length, anchorIndex: savedIndexByKey\[scrollKey\] \|\| 0 \}\)/,
    'the first window is around the card the feed was left on');
  assert.match(code, /growMountWindow\(current, papers\.length\)/, 'and grows in idle chunks');
  assert.match(code, /inMountWindow\(mountWindow, index\)[\s\S]*?feed-snap-item--pending/, 'cards outside it are full-height placeholders');
});
