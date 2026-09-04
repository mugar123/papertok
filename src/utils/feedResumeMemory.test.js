import test from 'node:test';
import assert from 'node:assert/strict';
import { createFeedResumeMemory, FEED_RESUME_STORAGE_PREFIX } from './feedResumeMemory.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
  };
}

test('remembers the card each surface was left on, per surface', () => {
  const memory = createFeedResumeMemory({ storage: fakeStorage() });
  memory.remember('forYou', { scrollTop: 1992, index: 3, paperId: 'p3' });
  memory.remember('following', { scrollTop: 664, index: 1, paperId: 'f1' });
  assert.deepEqual(memory.get('forYou'), { scrollTop: 1992, index: 3, paperId: 'p3' });
  assert.deepEqual(memory.get('following'), { scrollTop: 664, index: 1, paperId: 'f1' });
  assert.deepEqual(memory.get('guest'), { scrollTop: 0, index: 0, paperId: null });
});

test('persists only when asked, and a fresh module seeds from what was persisted', () => {
  const storage = fakeStorage();
  const memory = createFeedResumeMemory({ storage });
  memory.remember('forYou', { scrollTop: 1992, index: 3, paperId: 'p3' });
  assert.equal(storage.getItem(`${FEED_RESUME_STORAGE_PREFIX}forYou`), null, 'a scroll event costs no storage write');
  memory.persist('forYou');
  assert.deepEqual(JSON.parse(storage.getItem(`${FEED_RESUME_STORAGE_PREFIX}forYou`)), { index: 3, paperId: 'p3' });

  // The reload: a new memory over the same storage.
  const reloaded = createFeedResumeMemory({ storage });
  const entry = reloaded.get('forYou');
  assert.equal(entry.paperId, 'p3');
  assert.equal(entry.index, 3);
  assert.ok(entry.scrollTop > 0, 'a restored place still reads as somewhere to go back to');
  assert.deepEqual(reloaded.get('following'), { scrollTop: 0, index: 0, paperId: null });
});

test('what was stored is validated, and a storage that throws is a memory that only forgets on reload', () => {
  const broken = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
    removeItem: () => {},
  };
  const memory = createFeedResumeMemory({ storage: broken });
  assert.deepEqual(memory.get('forYou'), { scrollTop: 0, index: 0, paperId: null });
  memory.remember('forYou', { scrollTop: 10, index: 1, paperId: 'x' });
  assert.doesNotThrow(() => memory.persist('forYou'));
  assert.equal(memory.get('forYou').paperId, 'x');

  const garbage = fakeStorage({
    [`${FEED_RESUME_STORAGE_PREFIX}forYou`]: '{"index":"three","paperId":"p"}',
    [`${FEED_RESUME_STORAGE_PREFIX}following`]: 'not json',
    [`${FEED_RESUME_STORAGE_PREFIX}guest`]: '{"index":2}',
  });
  const fromGarbage = createFeedResumeMemory({ storage: garbage });
  assert.deepEqual(fromGarbage.get('forYou'), { scrollTop: 0, index: 0, paperId: null });
  assert.deepEqual(fromGarbage.get('following'), { scrollTop: 0, index: 0, paperId: null });
  assert.deepEqual(fromGarbage.get('guest'), { scrollTop: 0, index: 0, paperId: null }, 'an index without a paper is no place to return to');
});

test('no storage at all is a plain in-memory memory', () => {
  const memory = createFeedResumeMemory({ storage: null });
  memory.remember('forYou', { scrollTop: 5, index: 0, paperId: 'p0' });
  assert.doesNotThrow(() => memory.persist('forYou'));
  assert.equal(memory.get('forYou').paperId, 'p0');
});
