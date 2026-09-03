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
  assert.match(code, /initialMountWindow\(\{\s*total: papers\.length,\s*anchorIndex: resumeIndex\(\{ papers, savedPaperId: saved\.paperId, savedIndex: saved\.index \}\),/,
    'the first window is around the paper the feed was left on');
  assert.match(code, /growMountWindow\(anchoredWindow, papers\.length\)/, 'and grows in idle chunks');
  assert.match(code, /inMountWindow\(anchoredWindow, index\)[\s\S]*?feed-snap-item--pending/, 'cards outside it are full-height placeholders');
});

test('a feed resumes on the paper it was on, wherever that paper is now', async () => {
  const { resumeIndex } = await import('./feedMountWindow.js');
  const papers = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.equal(resumeIndex({ papers, savedPaperId: 'c', savedIndex: 2 }), 2);
  assert.equal(resumeIndex({ papers, savedPaperId: 'c', savedIndex: 0 }), 2, 'the id wins over a stale index');
  assert.equal(resumeIndex({ papers: [{ id: 'x' }, { id: 'c' }, { id: 'a' }], savedPaperId: 'c', savedIndex: 2 }), 1, 'the paper moved: follow it');
  assert.equal(resumeIndex({ papers, savedPaperId: 'gone', savedIndex: 3 }), 3, 'a paper the feed no longer has: the saved index');
  assert.equal(resumeIndex({ papers, savedPaperId: 'gone', savedIndex: 9 }), 3, 'clamped to the last card');
  assert.equal(resumeIndex({ papers, savedPaperId: null, savedIndex: 1 }), 1);
  assert.equal(resumeIndex({ papers: [], savedPaperId: 'a', savedIndex: 1 }), 0);
});

test('SOURCE: the container saves the paper it is on and restores by that paper', async () => {
  const code = await readFile(new URL('../components/Feed/FeedContainer.jsx', import.meta.url), 'utf8');
  // The place lives in utils/feedResumeMemory.js now (it survives the reload
  // the tab gives itself after a deploy); what is remembered is still the
  // paper's id, and what restores is still that paper.
  assert.match(code, /paperId: papersRef\.current\[index\]\?\.id \|\| resumeMemory\.get\(scrollKey\)\.paperId/);
  assert.match(code, /const index = resumeIndex\(\{ papers, savedPaperId: saved\.paperId, savedIndex: saved\.index \}\)/);
  assert.match(code, /el\.scrollTop = el\.clientHeight > 0 \? index \* el\.clientHeight/, 'restored to the card, not to a pixel offset from another order');
});
