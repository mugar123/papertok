import test from 'node:test';
import assert from 'node:assert/strict';
import { growMountWindow, inMountWindow, initialMountWindow, mountWindowCovers, windowReachingReader } from './feedMountWindow.ts';

test('a feed opens on the card it was on, one neighbour either side', () => {
  assert.deepEqual(initialMountWindow({ total: 30, anchorIndex: 0 }), { lo: 0, hi: 2 });
  assert.deepEqual(initialMountWindow({ total: 30, anchorIndex: 20 }), { lo: 19, hi: 22 });
  assert.deepEqual(initialMountWindow({ total: 30, anchorIndex: 29 }), { lo: 28, hi: 30 });
  assert.deepEqual(initialMountWindow({ total: 30, anchorIndex: 99 }), { lo: 28, hi: 30 }, 'an anchor past the end is the last card');
  assert.deepEqual(initialMountWindow({ total: 0, anchorIndex: 3 }), { lo: 0, hi: 0 });
  assert.deepEqual(initialMountWindow({ total: 2, anchorIndex: 0 }), { lo: 0, hi: 2 });
});

test('a resumed feed opens on its card alone; a fresh one keeps a neighbour', async () => {
  const { MOUNT_WINDOW_RADIUS, MOUNT_WINDOW_RESUME_RADIUS, MOUNT_WINDOW_STEP, MOUNT_WINDOW_SETTLE_MS } = await import('./feedMountWindow.ts');
  assert.equal(MOUNT_WINDOW_RESUME_RADIUS, 0);
  assert.equal(MOUNT_WINDOW_RADIUS, 1);
  assert.deepEqual(initialMountWindow({ total: 30, anchorIndex: 20, radius: MOUNT_WINDOW_RESUME_RADIUS }), { lo: 20, hi: 21 });
  assert.equal(MOUNT_WINDOW_STEP, 2, 'two cards a chunk: three were a 211 ms task at a quarter of the CPU');
  assert.ok(MOUNT_WINDOW_SETTLE_MS >= 300, 'the first chunk waits out the page transition (0.3 s)');
  assert.deepEqual(growMountWindow({ lo: 20, hi: 21 }, 30), { lo: 20, hi: 23 }, 'the default step');
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

test('a page that lands under the reader is mounted at once, not left to the idle growth', () => {
  // The window covered the 15 papers it had; the reader is on the loading
  // slot below them (index 15) when 14 more arrive.
  assert.deepEqual(windowReachingReader({ lo: 0, hi: 15 }, 15, 29), { lo: 0, hi: 17 },
    'the paper taking the slot the reader is on, and the next one');
  assert.deepEqual(windowReachingReader({ lo: 0, hi: 15 }, 14, 29), { lo: 0, hi: 16 },
    'on the last mounted card, the one below it is mounted before the swipe');
  assert.deepEqual(windowReachingReader({ lo: 0, hi: 15 }, 16, 29), { lo: 0, hi: 18 },
    'a reader still swiping past the stretched edge, before the idle growth has written it');
  assert.deepEqual(windowReachingReader({ lo: 0, hi: 15 }, 25, 29), { lo: 0, hi: 15 },
    'a far jump does not mount the run of cards in between');
  assert.deepEqual(windowReachingReader({ lo: 0, hi: 15 }, 12, 29), { lo: 0, hi: 15 },
    'a reader away from the edge leaves the window to the idle growth');
  assert.deepEqual(windowReachingReader({ lo: 0, hi: 15 }, 15, 16), { lo: 0, hi: 16 }, 'never past the end');
  assert.deepEqual(windowReachingReader({ lo: 0, hi: 15 }, 15, 15), { lo: 0, hi: 15 }, 'nothing new, nothing to mount');
  assert.deepEqual(windowReachingReader({ lo: 0, hi: 0 }, 0, 0), { lo: 0, hi: 0 });
});

test('a feed resumes on the paper it was on, wherever that paper is now', async () => {
  const { resumeIndex } = await import('./feedMountWindow.ts');
  const papers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.equal(resumeIndex({ papers, savedPaperId: 'c', savedIndex: 2 }), 2);
  assert.equal(resumeIndex({ papers, savedPaperId: 'c', savedIndex: 0 }), 2, 'the id wins over a stale index');
  assert.equal(resumeIndex({ papers: [{ id: 'x' }, { id: 'c' }, { id: 'a' }], savedPaperId: 'c', savedIndex: 2 }), 1, 'the paper moved: follow it');
  assert.equal(resumeIndex({ papers, savedPaperId: 'gone', savedIndex: 3 }), 3, 'a paper the feed no longer has: the saved index');
  assert.equal(resumeIndex({ papers, savedPaperId: 'gone', savedIndex: 9 }), 3, 'clamped to the last card');
  assert.equal(resumeIndex({ papers, savedPaperId: null, savedIndex: 1 }), 1);
  assert.equal(resumeIndex({ papers: [], savedPaperId: 'a', savedIndex: 1 }), 0);
});
