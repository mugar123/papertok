import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleFollowedAuthor } from './followedAuthors.js';

const transforms = {
  union: name => ({ op: 'union', name }),
  remove: name => ({ op: 'remove', name }),
};

test('following adds locally and sends a union, never the whole array', () => {
  const result = toggleFollowedAuthor(['Ada'], 'Grace', transforms);
  assert.deepEqual(result.next, ['Ada', 'Grace']);
  assert.deepEqual(result.patch, { followedAuthors: { op: 'union', name: 'Grace' } });
});

test('unfollowing removes locally and sends a remove', () => {
  const result = toggleFollowedAuthor(['Ada', 'Grace'], 'Ada', transforms);
  assert.deepEqual(result.next, ['Grace']);
  assert.deepEqual(result.patch, { followedAuthors: { op: 'remove', name: 'Ada' } });
});
